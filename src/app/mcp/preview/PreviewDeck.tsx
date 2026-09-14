'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Preview 试听台（协议层消费者）：
 * - 轮询 /api/get 第一时间发现新的可 preview 音轨（status = complete | streaming）
 * - 对最新几条音轨探测 /api/preview/{id}，区分三态：
 *     capturing → 正在串流的 preview（可渐进试听）
 *     ready     → 已缓存完整（立即完整回放）
 *     pending   → 待捕获（点击后才开始捕获并渐进试听）
 * - 试听一律走 /api/preview/{id}?stream=1（chunked 渐进流），三种状态同一入口
 *
 * 注意：探测 /api/preview/{id} 会为从未捕获过的音轨启动后台浏览器捕获，
 * 因此只对最新的 PROBE_TOP_N 条做自动探测，避免占满全局串行捕获队列。
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
/** 自动探测（可能触发捕获）的最新音轨条数上限 */
const PROBE_TOP_N = 3;

const PREVIEW_LABEL: Record<PreviewState, string> = {
  generating: '生成中',
  pending: '待捕获',
  capturing: '串流中',
  ready: '已缓存完整',
  error: '捕获失败'
};

async function fetchRecentTracks(): Promise<TrackView[]> {
  const res = await fetch('/api/get?page=1', { cache: 'no-store' });
  if (!res.ok) return [];
  const data: any[] = await res.json().catch(() => []);
  return data.map((c: any) => ({
    id: String(c.id),
    title: c.title || String(c.id),
    status: String(c.status || ''),
    createdAt: c.created_at ? String(c.created_at) : undefined,
    preview: 'generating' as PreviewState,
    progressPercent: null,
    currentSec: 0,
    durationSec: Number(c.duration) || 0,
    error: null
  }));
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
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playerAnchorRef = useRef<HTMLDivElement | null>(null);
  const [playerDocked, setPlayerDocked] = useState(false);
  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = currentId;
  const tracksRef = useRef<TrackView[]>([]);
  tracksRef.current = tracks;

  const refresh = useCallback(async () => {
    try {
      const fresh = await fetchRecentTracks();
      setTracks((prev) => {
        const prevById = new Map(prev.map((t) => [t.id, t]));
        return fresh.map((t) => {
          const old = prevById.get(t.id);
          if (!old) return t;
          // 保留已有 preview 状态，仅刷新曲目元数据；error 状态允许重探测覆盖
          return {
            ...old,
            title: t.title,
            status: t.status,
            createdAt: t.createdAt ?? old.createdAt,
            durationSec: t.durationSec || old.durationSec
          };
        });
      });
      setLastRefresh(new Date());

      // 仅对最新且可 preview 的几条做自动探测（探测会触发后台捕获，见文件头注释）。
      // error 轨道排除：服务端 errored job 30s 后删除，再探测会重启完整浏览器
      // 捕获，持久失败的 clip 不应被自动探测无限重试（点击播放仍是手动重试入口）。
      const knownById = new Map(tracksRef.current.map((t) => [t.id, t]));
      const probeable = fresh.filter((t) => t.status === 'complete' || t.status === 'streaming');
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
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // 播放器滚出视口时浮动到底部（保持同一 <audio> 元素，避免重载）
  useEffect(() => {
    const el = playerAnchorRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setPlayerDocked(!entry.isIntersecting),
      { threshold: 0 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 播放中音轨的捕获进度细粒度轮询
  useEffect(() => {
    if (!currentId) return;
    const timer = setInterval(async () => {
      const probe = await probePreview(currentId);
      setTracks((prev) => prev.map((t) => (t.id === currentId ? applyProbe(t, probe) : t)));
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [currentId]);

  const play = useCallback((track: TrackView) => {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrentId(track.id);
    setNotice(null);
    // ready：完整缓存，普通 URL 支持 Range seek；其余：渐进流（线性直播式播放）
    audio.src =
      track.preview === 'ready'
        ? `/api/preview/${track.id}`
        : `/api/preview/${track.id}?stream=1`;
    audio
      .play()
      .then(() => setPlaying(true))
      .catch(() => {
        setPlaying(false);
        setNotice(`《${track.title}》播放失败：捕获可能尚未开始或已失败，稍后重试`);
      });
  }, []);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    setCurrentId(null);
    setPlaying(false);
  }, []);

  // 媒体错误（如流在首个 chunk 前 502）：复位播放态并提示。
  // 以 src 是否仍存在区分正常路径（stop() 清源）与真实错误。
  const handleAudioError = useCallback(() => {
    const audio = audioRef.current;
    if (!audio?.getAttribute('src')) return;
    setPlaying(false);
    setCurrentId(null);
    setNotice('播放失败：preview 流不可用（捕获失败或已被取消），可稍后重新点击');
  }, []);

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
            // error 也保留点击入口：点击即重试（服务端会清掉残留 error job 并重启捕获）
            const clickable =
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

        {/* 原位锚点：滚过它之后播放器浮动到底部 */}
        <div ref={playerAnchorRef} className="mt-6 h-px" aria-hidden="true" />
        <div
          className={
            playerDocked
              ? 'fixed bottom-0 left-0 right-0 z-50 border-t border-zinc-800 bg-zinc-950/95 p-3 backdrop-blur'
              : 'mt-4'
          }
        >
          {playerDocked && (
            <div className="mb-1 truncate text-xs text-zinc-400">
              {currentId ? `正在试听：${tracks.find((t) => t.id === currentId)?.title ?? currentId}` : '试听台'}
            </div>
          )}
          <audio
            ref={audioRef}
            className="w-full"
            controls
            onEnded={() => setPlaying(false)}
            onError={handleAudioError}
          />
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
