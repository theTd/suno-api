'use client';

import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useMseAudio } from './useMseAudio';

/**
 * Preview 试听台（协议层消费者）：
 * - 轮询 /api/get 第一时间发现新的可 preview 音轨（status = complete | streaming）
 * - clip 一旦 complete/streaming，立即标 pending 并可点（不依赖探测）
 * - 对可 preview 音轨探测 /api/preview/{id}，细化三态：
 *     capturing → 正在串流的 preview（可渐进试听）
 *     ready     → 已缓存完整（立即完整回放）
 *     pending   → 待捕获（点击后才开始捕获并渐进试听）
 * - 试听一律走 /api/preview/{id}?stream=1（chunked 渐进流），三种状态同一入口
 * - 播放器为自绘控件：串流是线性直播流（Accept-Ranges: none），浏览器读不到
 *   duration、原生 <audio controls> 不显示进度且不可定位；这里改用已知音轨时长
 *   绘制进度/缓冲条。串流经 MSE（useMseAudio）接管：chunk 追加进 SourceBuffer
 *   后，已捕获部分（如捕获 60% 时其之前）可自由回跳，EOF 后全长可定位；MSE
 *   不可用/类型不支持时回退直接 src（浏览器视为直播，seek 不生效）。ready 音轨
 *   走支持 Range 的完整缓存 URL，可完整 seek（回退路径捕获完成后仍热切换升级）
 *
 * 注意：探测 /api/preview/{id} 是只读的，不会启动后台捕获——缓冲只在真正
 * 试听（?stream=1）时触发。探测只细化 pending/capturing/ready/error 徽章，
 * 不得把未探测到的 complete 音轨当成「生成中」禁用点击。
 */

type PreviewState = 'generating' | 'pending' | 'capturing' | 'ready' | 'error';

interface TrackView {
  id: string;
  title: string;
  status: string;
  createdAt?: string;
  preview: PreviewState;
  progressPercent: number | null;
  currentSec: number;
  durationSec: number;
  error: string | null;
}

const POLL_MS = 5000;
const STATUS_POLL_MS = 3000;
/** 自动探测条数上限。探测已缓存音轨会收到 200 二进制体再 cancel，不能对整页狂打。
 *  未探测到的 complete 音轨仍是 pending、可点，不依赖这个上限。 */
const PROBE_TOP_N = 3;

const PREVIEW_LABEL: Record<PreviewState, string> = {
  generating: '生成中',
  pending: '待捕获',
  capturing: '串流中',
  ready: '已缓存完整',
  error: '捕获失败'
};

function isPreviewableStatus(status: string): boolean {
  return status === 'complete' || status === 'streaming';
}

function previewFromClipStatus(status: string): PreviewState {
  return isPreviewableStatus(status) ? 'pending' : 'generating';
}

/** Keep probe-refined badges; never leave a complete clip stuck as generating. */
function retainPreview(old: TrackView, status: string): PreviewState {
  if (!isPreviewableStatus(status)) return 'generating';
  if (old.preview === 'generating') return 'pending';
  return old.preview;
}

async function fetchRecentTracks(): Promise<TrackView[]> {
  const res = await fetch('/api/get?page=1', { cache: 'no-store' });
  if (!res.ok) return [];
  const data: any[] = await res.json().catch(() => []);
  return data.map((c: any) => {
    const status = String(c.status || '');
    return {
      id: String(c.id),
      title: c.title || String(c.id),
      status,
      createdAt: c.created_at ? String(c.created_at) : undefined,
      preview: previewFromClipStatus(status),
      progressPercent: null,
      currentSec: 0,
      durationSec: Number(c.duration) || 0,
      error: null
    };
  });
}

type ProbeResult =
  | { kind: 'cached' }
  | { kind: 'status'; state: string; progressPercent: number | null; currentSec: number; durationSec: number; error: string | null }
  | { kind: 'failed'; error: string }
  | { kind: 'error' };

/** 探测 preview 状态；只读状态码/JSON，200 的二进制体立即取消，不下载。 */
async function probePreview(clipId: string): Promise<ProbeResult> {
  try {
    const res = await fetch(`/api/preview/${clipId}`, { cache: 'no-store' });
    if (res.status === 200) {
      await res.body?.cancel();
      return { kind: 'cached' };
    }
    if (res.status === 202) {
      const j = await res.json().catch(() => null);
      if (!j) return { kind: 'error' };
      return {
        kind: 'status',
        state: String(j.state || ''),
        progressPercent: typeof j.progressPercent === 'number' ? j.progressPercent : null,
        currentSec: Number(j.currentSec) || 0,
        durationSec: Number(j.durationSec) || 0,
        error: j.error ? String(j.error) : null
      };
    }
    // 502 等错误响应携带 { error } JSON（服务端 harvest 失败详情），尽量保留
    const j = await res.json().catch(() => null);
    if (!res.bodyUsed) await res.body?.cancel().catch(() => {});
    return { kind: 'failed', error: j?.error ? String(j.error) : `HTTP ${res.status}` };
  } catch {
    return { kind: 'error' };
  }
}

function applyProbe(view: TrackView, probe: ProbeResult): TrackView {
  if (probe.kind === 'cached') {
    return { ...view, preview: 'ready', progressPercent: null, error: null };
  }
  if (probe.kind === 'failed') {
    return { ...view, preview: 'error', error: probe.error };
  }
  if (probe.kind === 'status') {
    if (probe.error) return { ...view, preview: 'error', error: probe.error };
    if (probe.state === 'capturing') {
      return {
        ...view,
        preview: 'capturing',
        progressPercent: probe.progressPercent,
        currentSec: probe.currentSec,
        durationSec: probe.durationSec,
        error: null
      };
    }
    // waiting_clip / queued：捕获尚未开始
    return { ...view, preview: 'pending', progressPercent: null, error: null };
  }
  return { ...view, preview: 'error', error: '预览探测失败' };
}

function badgeClass(preview: PreviewState): string {
  switch (preview) {
    case 'ready':
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    case 'capturing':
      return 'bg-sky-500/15 text-sky-300 border-sky-500/30';
    case 'pending':
      return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    case 'error':
      return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
    default:
      return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30';
  }
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function PreviewDeck() {
  const [tracks, setTracks] = useState<TrackView[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [posSec, setPosSec] = useState(0);
  const [bufferedSec, setBufferedSec] = useState(0);
  const [mediaDurationSec, setMediaDurationSec] = useState(0);
  const [volume, setVolume] = useState(1);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = currentId;
  const tracksRef = useRef<TrackView[]>([]);
  tracksRef.current = tracks;

  const currentTrack = tracks.find((t) => t.id === currentId) ?? null;
  // 串流是线性直播流，浏览器读不到 duration；优先用曲目元数据里的已知时长
  const durationSec = currentTrack ? currentTrack.durationSec || mediaDurationSec : 0;
  const playedPct = durationSec > 0 ? Math.min(100, (posSec / durationSec) * 100) : 0;
  const bufferedPct = durationSec > 0 ? Math.min(100, (bufferedSec / durationSec) * 100) : 0;

  const refresh = useCallback(async () => {
    try {
      const fresh = await fetchRecentTracks();
      setTracks((prev) => {
        const prevById = new Map(prev.map((t) => [t.id, t]));
        return fresh.map((t) => {
          const old = prevById.get(t.id);
          if (!old) return t;
          // 刷新曲目元数据；Suno 侧完成后从 generating 升为 pending。
          // capturing/ready/pending/error 由探测覆盖，这里只避免 stale generating。
          return {
            ...old,
            title: t.title,
            status: t.status,
            createdAt: t.createdAt ?? old.createdAt,
            durationSec: t.durationSec || old.durationSec,
            preview: retainPreview(old, t.status)
          };
        });
      });
      setLastRefresh(new Date());

      // 只读探测最新几条，细化 pending/capturing/ready 徽章（不会触发捕获）。
      // error 轨道排除：服务端对 errored job 只保留 30s 即删除，之后探测只会
      // 再拿到 502，对持久失败的 clip 自动轮询没有意义（点击播放仍是手动重试入口）。
      const knownById = new Map(tracksRef.current.map((t) => [t.id, t]));
      const probeable = fresh.filter((t) => isPreviewableStatus(t.status));
      const targets = new Set(
        probeable
          .slice(0, PROBE_TOP_N)
          .filter((t) => knownById.get(t.id)?.preview !== 'error')
          .map((t) => t.id)
      );
      if (currentIdRef.current) targets.add(currentIdRef.current);
      await Promise.all(
        [...targets].map(async (id) => {
          const probe = await probePreview(id);
          setTracks((prev) => prev.map((t) => (t.id === id ? applyProbe(t, probe) : t)));
        })
      );
    } catch {
      // 单次刷新失败可容忍，下个周期重试
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      refresh();
      timer = setInterval(refresh, POLL_MS);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [refresh]);

  // 播放中音轨的捕获进度细粒度轮询（本机 preview 状态，不打 Suno）
  useEffect(() => {
    if (!currentId) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      const probe = await probePreview(currentId);
      setTracks((prev) => prev.map((t) => (t.id === currentId ? applyProbe(t, probe) : t)));
    };
    const start = () => {
      if (timer) return;
      tick();
      timer = setInterval(tick, STATUS_POLL_MS);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [currentId]);

  // 自绘进度条数据源：原生控件对线性直播流不显示时长/进度
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const syncPosition = () => {
      setPosSec(audio.currentTime || 0);
      setBufferedSec(audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0);
      setMediaDurationSec(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    audio.addEventListener('timeupdate', syncPosition);
    audio.addEventListener('durationchange', syncPosition);
    audio.addEventListener('progress', syncPosition);
    audio.addEventListener('loadedmetadata', syncPosition);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    return () => {
      audio.removeEventListener('timeupdate', syncPosition);
      audio.removeEventListener('durationchange', syncPosition);
      audio.removeEventListener('progress', syncPosition);
      audio.removeEventListener('loadedmetadata', syncPosition);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
    };
  }, []);

  // 正在串流试听的音轨捕获完成后，热切换到支持 Range 的完整缓存 URL：
  // 从线性直播升级成可完整 seek 的回放（保留播放位置与播放状态）。
  // 新 URL 加载失败时由 handleAudioError 复位播放态；不回退旧流（旧流已废弃）。
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentId) return;
    const track = tracks.find((t) => t.id === currentId);
    if (!track || track.preview !== 'ready') return;
    const src = audio.getAttribute('src');
    if (!src || !src.includes('stream=1')) return;
    const nextUrl = `/api/preview/${track.id}`;
    // 已听到结尾时从头回放（升级后可自由定位）；否则保留播放位置
    const pos = audio.ended ? 0 : audio.currentTime;
    const resume = !audio.paused && !audio.ended;
    const onMeta = () => {
      audio.removeEventListener('loadedmetadata', onMeta);
      // src 已被后续操作（切曲/停止/再次热切换）替换时，不施加旧位置
      if (audio.getAttribute('src') !== nextUrl) return;
      try {
        audio.currentTime = pos;
      } catch {
        // 元数据未就绪等极端情况：放弃位置恢复，从头播放
      }
      if (resume) audio.play().catch(() => setPlaying(false));
    };
    audio.addEventListener('loadedmetadata', onMeta);
    audio.src = nextUrl;
    audio.load();
    // 依赖重触发/卸载时，仅当 src 已被切走（切曲/停止）才移除监听器；
    // 升级在途（src 仍指向 nextUrl）时保留，避免 loadedmetadata 晚于轮询
    // 触发的重跑到达，导致位置恢复/续播被静默丢弃。onMeta 触发时自移除。
    return () => {
      if (audio.getAttribute('src') !== nextUrl) audio.removeEventListener('loadedmetadata', onMeta);
    };
  }, [tracks, currentId]);

  const { start: startMse, stop: stopMse } = useMseAudio(audioRef);

  const play = useCallback((track: TrackView) => {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrentId(track.id);
    setNotice(null);
    // 切轨时清零进度显示，避免新曲 loadedmetadata 前残留上一曲位置
    setPosSec(0);
    setBufferedSec(0);
    setMediaDurationSec(0);
    // ready：完整缓存，普通 URL 支持 Range seek；其余：MSE 接管渐进流
    // （SourceBuffer 的 seekable=已缓冲区间，已捕获部分可回跳；失败时
    // start 内部回退为直接 src，行为等同旧线性直播播放）
    if (track.preview === 'ready') {
      stopMse();
      audio.src = `/api/preview/${track.id}`;
    } else {
      startMse(`/api/preview/${track.id}?stream=1`);
    }
    const srcAtPlay = audio.getAttribute('src');
    audio
      .play()
      .then(() => setPlaying(true))
      .catch(() => {
        // src 被后续操作替换（MSE 回退/热切换/停止）会使 pending 的 play
        // promise 以 AbortError 拒绝，非真实播放失败，不提示
        if (audio.getAttribute('src') !== srcAtPlay) return;
        setPlaying(false);
        setNotice(`《${track.title}》播放失败：捕获可能尚未开始或已失败，稍后重试`);
      });
  }, [startMse, stopMse]);

  const stop = useCallback(() => {
    stopMse();
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    setCurrentId(null);
    setPlaying(false);
    setPosSec(0);
    setBufferedSec(0);
    setMediaDurationSec(0);
  }, [stopMse]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;
    if (audio.paused) {
      audio.play().catch(() => {
        setPlaying(false);
        setNotice(`《${currentTrack.title}》播放失败：捕获可能尚未开始或已失败，稍后重试`);
      });
    } else {
      audio.pause();
    }
  };

  const seekTo = (sec: number) => {
    const audio = audioRef.current;
    if (!audio || !currentTrack || !Number.isFinite(sec)) return;
    const target = durationSec > 0 ? Math.min(Math.max(sec, 0), durationSec) : Math.max(sec, 0);
    // 串流为线性直播（Accept-Ranges: none）：只能回跳到已缓冲区间；完整定位需等捕获完成
    if (currentTrack.preview !== 'ready') {
      const end = audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0;
      if (target > end + 0.3) {
        setNotice('串流为线性直播：仅可回跳到已缓冲部分，前进定位需等捕获完成');
        return;
      }
    }
    audio.currentTime = target;
    setPosSec(target);
  };

  const onBarClick = (e: MouseEvent<HTMLDivElement>) => {
    const el = barRef.current;
    if (!el || !currentTrack || durationSec <= 0) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    seekTo(ratio * durationSec);
  };

  // 媒体错误（如流在首个 chunk 前 502）：复位播放态并提示。
  // 以 src 是否仍存在区分正常路径（stop() 清源）与真实错误。
  const handleAudioError = useCallback(() => {
    const audio = audioRef.current;
    if (!audio?.getAttribute('src')) return;
    // 先停 MSE 会话：否则随后的回退/重试可能为一个 UI 已标失败的音轨
    // 重启服务端捕获
    stopMse();
    setPlaying(false);
    setCurrentId(null);
    setNotice('播放失败：preview 流不可用（捕获失败或已被取消），可稍后重新点击');
  }, [stopMse]);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-bold">Suno Preview 试听台</h1>
            <p className="mt-1 text-sm text-zinc-400">
              实时发现可 preview 的音轨 · 点击即渐进试听（无需 unlock）
            </p>
          </div>
          <div className="text-xs text-zinc-500">
            {lastRefresh ? `上次刷新 ${lastRefresh.toLocaleTimeString()}` : '加载中…'}
          </div>
        </header>

        <ul className="space-y-2">
          {tracks.map((t) => {
            const active = t.id === currentId;
            // complete/streaming 即可点（pending）；error 点击即重试捕获
            const clickable =
              isPreviewableStatus(t.status) ||
              t.preview === 'capturing' ||
              t.preview === 'ready' ||
              t.preview === 'pending' ||
              t.preview === 'error';
            return (
              <li key={t.id}>
                <button
                  type="button"
                  disabled={!clickable}
                  onClick={() => (active ? stop() : play(t))}
                  className={`w-full flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
                    active
                      ? 'border-sky-500/50 bg-sky-500/10'
                      : 'border-zinc-800 bg-zinc-900 hover:border-zinc-600'
                  } ${clickable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{t.title}</div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {active && playing ? '▶ ' : ''}
                      {t.preview === 'capturing' &&
                        (t.progressPercent != null
                          ? `捕获中 ${t.progressPercent.toFixed(1)}%（${fmtTime(t.currentSec)}/${fmtTime(t.durationSec)}）`
                          : `捕获中 ${fmtTime(t.currentSec)} 已播放`)}
                      {t.preview === 'capturing' && ' · 可渐进试听'}
                      {t.preview === 'pending' && '点击后开始捕获并渐进试听'}
                      {t.preview === 'ready' && '可完整回放'}
                      {t.preview === 'error' && (t.error || '捕获失败')}
                      {t.preview === 'generating' && 'Suno 侧生成中，暂不可 preview'}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs ${badgeClass(t.preview)}`}>
                    {PREVIEW_LABEL[t.preview]}
                  </span>
                </button>
              </li>
            );
          })}
          {tracks.length === 0 && (
            <li className="rounded-lg border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
              暂无音轨。生成音乐后此处会自动出现可 preview 的条目。
            </li>
          )}
        </ul>

        {/* sticky：只改定位，宽高与原位一致，子树不因浮动增删（reuse 同一控件） */}
        <div className="sticky bottom-0 z-50 mt-6 w-full bg-zinc-950">
          <audio ref={audioRef} onEnded={() => setPlaying(false)} onError={handleAudioError} preload="metadata" />
          <div className="mt-1 flex items-center gap-3">
            <button
              type="button"
              onClick={togglePlay}
              disabled={!currentTrack}
              className="shrink-0 rounded-full border border-zinc-700 px-3 py-1 text-sm text-zinc-200 transition-colors hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {playing ? '⏸ 暂停' : '▶ 播放'}
            </button>
            <div
              ref={barRef}
              role="slider"
              aria-label="播放进度"
              aria-valuemin={0}
              aria-valuemax={Math.round(durationSec)}
              aria-valuenow={Math.round(posSec)}
              onClick={onBarClick}
              className={`relative h-2 flex-1 overflow-hidden rounded-full bg-zinc-800 ${
                currentTrack && durationSec > 0 ? 'cursor-pointer' : 'opacity-60'
              }`}
            >
              <div className="absolute inset-y-0 left-0 bg-zinc-600" style={{ width: `${bufferedPct}%` }} />
              <div className="absolute inset-y-0 left-0 bg-sky-500" style={{ width: `${playedPct}%` }} />
            </div>
            <span className="w-28 shrink-0 text-right text-xs tabular-nums text-zinc-400">
              {currentTrack
                ? durationSec > 0
                  ? `${fmtTime(posSec)} / ${fmtTime(durationSec)}`
                  : `${fmtTime(posSec)} / …`
                : '--:-- / --:--'}
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              aria-label="音量"
              onChange={(e) => {
                const v = Number(e.target.value);
                setVolume(v);
                if (audioRef.current) audioRef.current.volume = v;
              }}
              className="w-20 shrink-0 accent-sky-500"
            />
          </div>
          {notice && (
            <p className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              {notice}
            </p>
          )}
        </div>
        <p className="mt-2 text-xs text-zinc-600">
          音轨来源 /api/get?page=1 · 流式播放 /api/preview/{'{id}'}?stream=1 · 探测 /api/preview/{'{id}'}
        </p>
      </div>
    </main>
  );
}
