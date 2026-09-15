'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';

/**
 * 用 Media Source Extensions 接管 <audio> 的串流渐进回放。
 *
 * 串流响应是 Accept-Ranges: none 的线性直播流，浏览器视其为直播：
 * 原生播放时 seekable 为空，即便数据已缓冲也无法回跳。MSE 把渐进
 * chunk 追加进 SourceBuffer 后，媒体元素的 seekable 等于已缓冲区间，
 * 已捕获部分（如捕获 60% 时 60% 之前）即可自由定位；读到 EOF（捕获
 * 完成或缓存重放结束）后 endOfStream() 收尾，全长可定位。
 *
 * 任一步不可恢复（无 MSE / Content-Type 不受支持 / SourceBuffer 追加
 * 错误）都回退到直接 audio.src = url 的原生渐进播放，行为与旧实现一致。
 */

interface MseSession {
  abort: AbortController;
  mediaSource: MediaSource;
  objectUrl: string;
}

function waitSourceOpen(mediaSource: MediaSource, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (mediaSource.readyState === 'open') {
      resolve();
      return;
    }
    const cleanup = () => {
      mediaSource.removeEventListener('sourceopen', onOpen);
      signal.removeEventListener('abort', onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('preview stream aborted', 'AbortError'));
    };
    mediaSource.addEventListener('sourceopen', onOpen);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 容器 → 候选 MSE MIME（按可能性排序）。
 * 服务端 Content-Type 是不带 codecs 的裸类型（如 audio/mp4），多数浏览器
 * 的 isTypeSupported 对裸类型直接返回 false；而捕获内容实测为 opus-in-fMP4，
 * codec 声明错误会在首个 chunk append 时报错。因此按容器枚举常见 codecs，
 * 用真实首 chunk 逐个探测（见 openSourceBuffer）。
 */
const MIME_CANDIDATES: Record<string, string[]> = {
  'audio/mp4': ['audio/mp4; codecs="opus"', 'audio/mp4; codecs="mp4a.40.2"', 'audio/mp4'],
  'audio/webm': ['audio/webm; codecs="opus"', 'audio/webm; codecs="vorbis"', 'audio/webm'],
  'audio/ogg': ['audio/ogg; codecs="opus"', 'audio/ogg; codecs="vorbis"']
};

/** append 的异步结果：updateend=成功，error=解析/不支持/会话中止。 */
function appendOutcome(
  sourceBuffer: SourceBuffer,
  chunk: Uint8Array,
  signal: AbortSignal
): Promise<'ok' | 'error'> {
  return new Promise((resolve) => {
    const onEnd = () => {
      cleanup();
      resolve('ok');
    };
    const onErr = () => {
      cleanup();
      resolve('error');
    };
    const onAbort = () => {
      cleanup();
      resolve('error');
    };
    const cleanup = () => {
      sourceBuffer.removeEventListener('updateend', onEnd);
      sourceBuffer.removeEventListener('error', onErr);
      signal.removeEventListener('abort', onAbort);
    };
    sourceBuffer.addEventListener('updateend', onEnd);
    sourceBuffer.addEventListener('error', onErr);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      sourceBuffer.appendBuffer(chunk);
    } catch {
      cleanup();
      resolve('error');
    }
  });
}

/**
 * 用首 chunk 实测选出可用的 SourceBuffer：逐候选 isTypeSupported →
 * addSourceBuffer → append 首 chunk，首个成功的即返回（其内容已入缓冲）；
 * 失败的立即 removeSourceBuffer 试下一候选。全部失败抛错，由调用方回退。
 */
async function openSourceBuffer(
  mediaSource: MediaSource,
  baseType: string,
  initChunk: Uint8Array,
  signal: AbortSignal
): Promise<SourceBuffer> {
  const candidates = MIME_CANDIDATES[baseType] ?? [baseType];
  for (const mime of candidates) {
    if (!MediaSource.isTypeSupported(mime)) continue;
    let sourceBuffer: SourceBuffer;
    try {
      sourceBuffer = mediaSource.addSourceBuffer(mime);
    } catch {
      continue;
    }
    if ((await appendOutcome(sourceBuffer, initChunk, signal)) === 'ok') return sourceBuffer;
    try {
      mediaSource.removeSourceBuffer(sourceBuffer);
    } catch {
      // 已 detached 等极端情况，继续试下一候选
    }
  }
  throw new Error(`no MSE-compatible type for preview stream: ${baseType}`);
}

/** 把 ?stream=1 的渐进响应逐 chunk 追加进 SourceBuffer；EOF 后收尾。 */
async function pipeStream(
  audio: HTMLAudioElement,
  session: MseSession,
  url: string
): Promise<void> {
  const { mediaSource, abort } = session;
  await waitSourceOpen(mediaSource, abort.signal);

  const resp = await fetch(url, { signal: abort.signal });
  if (!resp.ok || !resp.body) throw new Error(`preview stream HTTP ${resp.status}`);
  const baseType = (resp.headers.get('content-type') || '').split(';')[0].trim();
  if (!baseType) throw new Error('preview stream missing content-type');

  const reader = resp.body.getReader();
  const first = await reader.read();
  if (first.done || !first.value?.length) throw new Error('preview stream closed without data');

  // 探测期间吞掉 element error：探测性 append 失败会同步派发 MEDIA_ERR_
  // SRC_NOT_SUPPORTED，若冒泡到 PreviewDeck 的 handleAudioError 会 stopMse
  // +复位 UI，杀死本会话与后续候选探测。捕获阶段先于 React root 委派。
  // 全部候选失败时 pipeStream 照常抛错走直接 src 回退，真实加载错误仍能
  // 经 element error 上报（此时 src 已非 blob，不会被吞）。
  const swallowProbeError = (e: Event) => e.stopImmediatePropagation();
  audio.addEventListener('error', swallowProbeError, true);
  let sourceBuffer: SourceBuffer;
  try {
    sourceBuffer = await openSourceBuffer(mediaSource, baseType, first.value, abort.signal);
  } finally {
    audio.removeEventListener('error', swallowProbeError, true);
  }

  const queue: Uint8Array[] = [];
  let sourceEnded = false;

  // 配额耗尽时清掉播放位置 30s 之前的旧数据（回跳需要的数据仍在缓冲内）
  const evictOldData = (): boolean => {
    if (!sourceBuffer.buffered.length) return false;
    const start = sourceBuffer.buffered.start(0);
    const keepFrom = audio.currentTime - 30;
    if (keepFrom <= start) return false;
    sourceBuffer.remove(start, keepFrom);
    return true;
  };

  const drain = () => {
    while (queue.length && !sourceBuffer.updating) {
      const chunk = queue.shift()!;
      try {
        sourceBuffer.appendBuffer(chunk);
      } catch (err) {
        if ((err as DOMException)?.name === 'QuotaExceededError' && evictOldData()) {
          // remove 完成后 updateend 会再次 drain，chunk 放回队首重试
          queue.unshift(chunk);
          return;
        }
        throw err;
      }
    }
    if (sourceEnded && !queue.length && !sourceBuffer.updating && mediaSource.readyState === 'open') {
      try {
        mediaSource.endOfStream();
      } catch {
        // 收尾失败不影响已缓冲可播内容
      }
    }
  };

  const readLoop = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        sourceEnded = true;
        drain();
        return;
      }
      if (value?.length) {
        queue.push(value);
        drain();
      }
    }
  };

  await new Promise<void>((resolve, reject) => {
    sourceBuffer.addEventListener('updateend', drain);
    sourceBuffer.addEventListener('error', () => reject(new Error('SourceBuffer append error')));
    readLoop().then(resolve, reject);
  });
}

export function useMseAudio(audioRef: RefObject<HTMLAudioElement | null>) {
  const sessionRef = useRef<MseSession | null>(null);

  /** 中止当前 MSE 会话（abort 拉流 + 回收 blob URL）；不动 audio.src，由调用方负责。 */
  const stop = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session) return;
    session.abort.abort();
    URL.revokeObjectURL(session.objectUrl);
  }, []);

  /**
   * 用 MSE 接管 url 的渐进播放：同步置换 audio.src 为 blob URL（保持
   * 用户手势内可 play()），后台 fetch 追加；失败时回退为直接 src。
   */
  const start = useCallback(
    (url: string) => {
      const audio = audioRef.current;
      if (!audio) return;
      stop();
      if (!('MediaSource' in window)) {
        audio.src = url;
        return;
      }
      const abort = new AbortController();
      const mediaSource = new MediaSource();
      const objectUrl = URL.createObjectURL(mediaSource);
      const session: MseSession = { abort, mediaSource, objectUrl };
      sessionRef.current = session;
      audio.src = objectUrl;
      void pipeStream(audio, session, url).catch(() => {
        // 仅当仍是当前会话、且 element 仍指向本会话 blob（用户未切走、
        // 未被 handleAudioError 复位）时才回退；否则静默让位
        if (sessionRef.current !== session) return;
        if (audio.getAttribute('src') !== session.objectUrl) return;
        stop();
        audio.src = url;
        // 回退源通常可播，尝试恢复播放意图（paused 仍忠实反映用户暂停
        // 态，暂停中不回播）；手势激活可能已过期则静默，真实加载失败
        // 会由 element error 路径提示
        if (!audio.paused) void audio.play().catch(() => {});
      });
    },
    [audioRef, stop]
  );

  // 组件卸载时清理在途会话
  useEffect(() => () => stop(), [stop]);

  return { start, stop };
}
