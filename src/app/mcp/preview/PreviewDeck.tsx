'use client';

import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { PreviewLiveServerMessage, PreviewState, PreviewTrack } from '@/lib/preview-live/preview-live-protocol';
import { mergeUnlocked } from '@/lib/preview-unlock-flags';
import { useMseAudio } from './useMseAudio';
import { usePreviewLive } from './usePreviewLive';

/**
 * Preview 试听台（协议层消费者）：
 * - WebSocket `/mcp/preview/live` 推送第一页与捕获状态；浏览器不再轮询 /api/get 或探测 /api/preview/{id}
 * - 历史音轨按页增量加载：滚到列表底部再经 WS 请求下一页，page1 推送只合并第一页、不丢已加载页
 * - 翻页尽头只认空页，或连续两页/与第一页 id 集相同（page 参数被忽略）
 * - 整页 duplicate 但与第一页不同 = feed 窗口滑动，继续翻；若曾翻到空页则视为补洞追上、停止
 * - 第一页出现从未见过的 id 且曾经以为翻完时，重开翻页（loadedPage 回到 1，下一拍拉 page=2）补中间页
 * - clip 一旦 complete/streaming，立即标 pending 并可点
 * - 试听一律走 /api/preview/{id}?stream=1（chunked 渐进流）；ready 走完整缓存 URL
 * - 播放器为自绘控件：串流经 MSE（useMseAudio）接管
 *
 * 捕获仍只在真正试听（?stream=1）时启动；实时通道只推状态，不替用户开播。
 */

type TrackView = PreviewTrack;

/** 下一页加载失败后的冷却，避免 sentinel 仍在视口内时对错误页空转。 */
const LOAD_MORE_ERROR_COOLDOWN_MS = 2000;

const PREVIEW_LABEL: Record<PreviewState, string> = {
  generating: '生成中',
  pending: '待捕获',
  waiting_clip: '等待就绪',
  queued: '排队中',
  capturing: '串流中',
  ready: '已缓存完整',
  error: '捕获失败'
};

function isPreviewableStatus(status: string): boolean {
  return status === 'complete' || status === 'streaming';
}

/** page1 快照可能早于刚到的 preview_status；不要把进行中的捕获打回 pending。 */
function mergePreview(old: PreviewState | undefined, incoming: PreviewState): PreviewState {
  if (!old) return incoming;
  if (incoming === 'ready' || incoming === 'error') return incoming;
  if (incoming === 'capturing' || incoming === 'queued' || incoming === 'waiting_clip') return incoming;
  if (old === 'waiting_clip' || old === 'queued' || old === 'capturing' || old === 'ready') return old;
  return incoming;
}

function mergeClip(old: TrackView | undefined, incoming: TrackView): TrackView {
  if (!old) return incoming;
  const preview = mergePreview(old.preview, incoming.preview);
  const keepOldHarvest = preview !== incoming.preview;
  return {
    ...incoming,
    preview,
    durationSec: incoming.durationSec || old.durationSec,
    createdAt: incoming.createdAt ?? old.createdAt,
    progressPercent: keepOldHarvest ? old.progressPercent : incoming.progressPercent,
    currentSec: keepOldHarvest ? old.currentSec : incoming.currentSec,
    queuePosition: keepOldHarvest ? old.queuePosition : incoming.queuePosition,
    error: keepOldHarvest ? old.error : incoming.error,
    unlocked: mergeUnlocked(incoming.unlocked)
  };
}

/** 第一页是最新窗口：放在列表头；已加载的更旧页接到后面，避免 page1 推送冲掉翻页结果。最终按 createdAt 倒序。 */
function mergePage1(prev: TrackView[], fresh: TrackView[]): TrackView[] {
  const prevById = new Map(prev.map((t) => [t.id, t]));
  const freshIds = new Set(fresh.map((t) => t.id));
  const head = fresh.map((t) => mergeClip(prevById.get(t.id), t));
  const tail = prev.filter((t) => !freshIds.has(t.id));
  return sortTracksNewest([...head, ...tail]);
}

function sameIdSet(ids: string[], set: Set<string>): boolean {
  if (ids.length !== set.size) return false;
  return ids.every((id) => set.has(id));
}

/** Strict newest-first (`createdAt` desc, missing = oldest), same rule as Suno Library. */
function trackCreatedAtMs(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function sortTracksNewest(tracks: TrackView[]): TrackView[] {
  return tracks.sort((a, b) => trackCreatedAtMs(b.createdAt) - trackCreatedAtMs(a.createdAt));
}

function applyPreviewStatus(
  view: TrackView,
  msg: Extract<PreviewLiveServerMessage, { type: 'preview_status' }>
): TrackView {
  return {
    ...view,
    preview: msg.preview,
    progressPercent: msg.progressPercent,
    currentSec: msg.currentSec,
    durationSec: msg.durationSec || view.durationSec,
    queuePosition: msg.queuePosition,
    error: msg.error
  };
}

function applyClipStatus(
  view: TrackView,
  msg: Extract<PreviewLiveServerMessage, { type: 'clip_status' }>
): TrackView {
  const status = msg.status;
  let preview = view.preview;
  if (isPreviewableStatus(status) && preview === 'generating') preview = 'pending';
  return {
    ...view,
    status,
    preview,
    title: msg.title || view.title,
    durationSec: msg.durationSec || view.durationSec,
    createdAt: msg.createdAt ?? view.createdAt,
    unlocked: view.unlocked === true
  };
}

function badgeClass(preview: PreviewState): string {
  switch (preview) {
    case 'ready':
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    case 'capturing':
      return 'bg-sky-500/15 text-sky-300 border-sky-500/30';
    case 'pending':
    case 'waiting_clip':
    case 'queued':
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
  const [notice, setNotice] = useState<string | null>(null);
  const [posSec, setPosSec] = useState(0);
  const [bufferedSec, setBufferedSec] = useState(0);
  const [mediaDurationSec, setMediaDurationSec] = useState(0);
  const [volume, setVolume] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unlockingId, setUnlockingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const tracksRef = useRef<TrackView[]>([]);
  tracksRef.current = tracks;
  const loadedPageRef = useRef(1);
  const hasMoreRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const bootstrappedRef = useRef(false);
  const loadMoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const page1IdsRef = useRef<Set<string>>(new Set());
  const lastLoadedPageIdsRef = useRef<Set<string>>(new Set());
  /** 曾经拿到过空页，列表在当时已覆盖到 feed 尽头；之后的整页 duplicate 视为补洞追上。 */
  const reachedEndRef = useRef(false);

  useEffect(() => {
    fetch('/api/preview-unlock-session', { credentials: 'same-origin', cache: 'no-store' }).catch(() => {});
  }, []);

  const currentTrack = tracks.find((t) => t.id === currentId) ?? null;
  // 串流是线性直播流，浏览器读不到 duration；优先用曲目元数据里的已知时长
  const durationSec = currentTrack ? currentTrack.durationSec || mediaDurationSec : 0;
  const playedPct = durationSec > 0 ? Math.min(100, (posSec / durationSec) * 100) : 0;
  const bufferedPct = durationSec > 0 ? Math.min(100, (bufferedSec / durationSec) * 100) : 0;

  const applyPage1 = useCallback((fresh: TrackView[]) => {
    page1IdsRef.current = new Set(fresh.map((t) => t.id));
    const prevIds = new Set(tracksRef.current.map((t) => t.id));
    const hasUnseen = fresh.some((t) => !prevIds.has(t.id));
    if (fresh.length === 0 && loadedPageRef.current === 1 && prevIds.size === 0) {
      hasMoreRef.current = false;
      setHasMore(false);
      reachedEndRef.current = true;
    } else if (
      hasUnseen &&
      (reachedEndRef.current || !hasMoreRef.current) &&
      !loadingMoreRef.current
    ) {
      // 第一页冒出从未见过的 id，且曾经以为翻完：从 page=2 补中间被滑走的页
      loadedPageRef.current = 1;
      lastLoadedPageIdsRef.current = new Set(fresh.map((t) => t.id));
      hasMoreRef.current = true;
      setHasMore(true);
    } else if (loadedPageRef.current === 1 && !reachedEndRef.current) {
      const more = fresh.length > 0;
      hasMoreRef.current = more;
      setHasMore(more);
    }
    setTracks((prev) => mergePage1(prev, fresh));
    bootstrappedRef.current = true;
  }, []);

  const { connection, lastPush, loadPage } = usePreviewLive({
    onHello: applyPage1,
    onPage1: applyPage1,
    onPreviewStatus: (msg) => {
      setTracks((prev) => prev.map((t) => (t.id === msg.clipId ? applyPreviewStatus(t, msg) : t)));
    },
    onClipStatus: (msg) => {
      // createdAt 可能随状态到达/修正：保持严格 newest 排序。
      setTracks((prev) =>
        sortTracksNewest(prev.map((t) => (t.id === msg.clipId ? applyClipStatus(t, msg) : t)))
      );
    },
    onUnlockStatus: (msg) => {
      setTracks((prev) =>
        prev.map((t) => (t.id === msg.clipId ? { ...t, unlocked: msg.unlocked } : t))
      );
    }
  });

  const unlockLoadMore = useCallback((delayMs = 0) => {
    if (loadMoreTimerRef.current) {
      clearTimeout(loadMoreTimerRef.current);
      loadMoreTimerRef.current = null;
    }
    const apply = () => {
      loadMoreTimerRef.current = null;
      loadingMoreRef.current = false;
      setLoadingMore(false);
    };
    if (delayMs <= 0) {
      apply();
      return;
    }
    loadMoreTimerRef.current = setTimeout(apply, delayMs);
  }, []);

  const loadMore = useCallback(async () => {
    if (!bootstrappedRef.current || loadingMoreRef.current || !hasMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const nextPage = loadedPageRef.current + 1;
    try {
      const page = await loadPage(nextPage);
      if (!page) {
        unlockLoadMore(LOAD_MORE_ERROR_COOLDOWN_MS);
        return;
      }
      loadedPageRef.current = nextPage;
      if (page.length === 0) {
        reachedEndRef.current = true;
        hasMoreRef.current = false;
        setHasMore(false);
        unlockLoadMore();
        return;
      }
      const pageIds = page.map((t) => t.id);
      const sameAsPage1 = sameIdSet(pageIds, page1IdsRef.current);
      const sameAsLast = sameIdSet(pageIds, lastLoadedPageIdsRef.current);
      lastLoadedPageIdsRef.current = new Set(pageIds);
      const seen = new Set(tracksRef.current.map((t) => t.id));
      const unique = page.filter((t) => !seen.has(t.id));
      setTracks((prev) => {
        const seenNow = new Set(prev.map((t) => t.id));
        const next = page.filter((t) => !seenNow.has(t.id));
        return next.length ? sortTracksNewest([...prev, ...next]) : prev;
      });
      if (sameAsPage1 || sameAsLast) {
        // page 参数被忽略，或服务端把末页原样重复返回
        if (sameAsLast && !sameAsPage1) reachedEndRef.current = true;
        hasMoreRef.current = false;
        setHasMore(false);
        unlockLoadMore();
        return;
      }
      if (unique.length > 0) {
        hasMoreRef.current = true;
        setHasMore(true);
      } else if (reachedEndRef.current) {
        // 曾翻到空页：整页都是已有 id，说明补洞已追上旧列表
        hasMoreRef.current = false;
        setHasMore(false);
      } else {
        // feed 窗口滑动：本页是 tail 里的旧第一页，后面可能还有更旧页
        hasMoreRef.current = true;
        setHasMore(true);
      }
      unlockLoadMore();
    } catch {
      unlockLoadMore(LOAD_MORE_ERROR_COOLDOWN_MS);
    }
  }, [unlockLoadMore, loadPage]);

  useEffect(() => {
    return () => {
      if (loadMoreTimerRef.current) clearTimeout(loadMoreTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!lastPush || !hasMore || loadingMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root: null, rootMargin: '0px 0px 120px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [lastPush, hasMore, loadingMore, loadMore, tracks.length]);

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
  const requestUnlock = useCallback(async (track: TrackView, e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (track.unlocked || unlockingId) return;
    if (track.status !== 'complete') {
      setNotice(`《${track.title}》还不能解锁：需要等到生成完成（complete），试听可以继续`);
      return;
    }
    const ok = window.confirm(
      `解锁《${track.title}》将授权 agent 下载成品母带（可能消耗一次 Premier 下载额度）。确认？`
    );
    if (!ok) return;
    setUnlockingId(track.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/unlock/${track.id}`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `解锁失败 (${res.status})`);
      setTracks((prev) => prev.map((t) => (t.id === track.id ? { ...t, unlocked: true } : t)));
    } catch (err: any) {
      setNotice(`解锁《${track.title}》失败：${err?.message || err}`);
    } finally {
      setUnlockingId(null);
    }
  }, [unlockingId]);

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
              实时发现可 preview 的音轨 · 点击即渐进试听 · 解锁母带后 agent 才能下载成品
            </p>
          </div>
          <div className="text-xs text-zinc-500">
            {connection === 'connected'
              ? lastPush
                ? `实时 ${lastPush.toLocaleTimeString()}`
                : '已连接'
              : connection === 'reconnecting'
                ? '重连中…'
                : '连接中…'}
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
              t.preview === 'waiting_clip' ||
              t.preview === 'queued' ||
              t.preview === 'error';
            const canUnlock = t.status === 'complete';
            return (
              <li key={t.id}>
                <div
                  className={`flex items-stretch gap-2 rounded-lg border ${
                    active ? 'border-sky-500/50 bg-sky-500/10' : 'border-zinc-800 bg-zinc-900'
                  }`}
                >
                  <button
                    type="button"
                    disabled={!clickable}
                    onClick={() => (active ? stop() : play(t))}
                    className={`min-w-0 flex-1 flex items-center justify-between gap-3 px-4 py-3 text-left transition-colors ${
                      clickable ? 'cursor-pointer hover:bg-zinc-800/40' : 'cursor-not-allowed opacity-60'
                    }`}
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
                        {t.preview === 'waiting_clip' && '等待 clip 可试听'}
                        {t.preview === 'queued' &&
                          (t.queuePosition > 0 ? `排队第 ${t.queuePosition} 位` : '排队等待捕获')}
                        {t.preview === 'ready' && '可完整回放'}
                        {t.preview === 'error' && (t.error || '捕获失败')}
                        {t.preview === 'generating' && 'Suno 侧生成中，暂不可 preview'}
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs ${badgeClass(t.preview)}`}>
                      {PREVIEW_LABEL[t.preview]}
                    </span>
                    {t.kind === 'sound' ? (
                      <span className="shrink-0 rounded-full border border-amber-500/40 px-2.5 py-1 text-xs text-amber-200">
                        SOUND
                      </span>
                    ) : (
                      <span className="shrink-0 rounded-full border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400">
                        SONG
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={!canUnlock || t.unlocked || unlockingId === t.id}
                    onClick={(e) => requestUnlock(t, e)}
                    className={`shrink-0 self-center mr-2 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      t.unlocked
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                        : canUnlock
                          ? 'border-amber-500/40 text-amber-200 hover:bg-amber-500/10'
                          : 'border-zinc-700 text-zinc-500 cursor-not-allowed'
                    }`}
                  >
                    {t.unlocked ? '已解锁' : unlockingId === t.id ? '解锁中…' : '解锁母带'}
                  </button>
                </div>
              </li>
            );
          })}
          {tracks.length === 0 && (
            <li className="rounded-lg border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
              暂无音轨。生成音乐后此处会自动出现可 preview 的条目。
            </li>
          )}
          {tracks.length > 0 && (
            <li>
              <div ref={sentinelRef} className="py-3 text-center text-xs text-zinc-500">
                {loadingMore ? (
                  '正在加载更多音轨…'
                ) : hasMore ? (
                  <button
                    type="button"
                    onClick={() => loadMore()}
                    className="text-zinc-500 hover:text-zinc-300"
                  >
                    滚到底部加载更多
                  </button>
                ) : (
                  '已加载全部音轨'
                )}
              </div>
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
          实时通道 /mcp/preview/live · 滚到底部加载下一页 · 播放 /api/preview/{'{id}'}?stream=1
        </p>
      </div>
    </main>
  );
}
