import { EventEmitter } from 'node:events';

/**
 * In-process preview-live bus. SunoApi emits; the WS hub listens.
 * No WebSocket / HTTP here — that stays in preview-live-hub.
 */

export type PreviewLiveJobState = 'waiting_clip' | 'queued' | 'capturing' | 'error';

export type PreviewLiveEvent =
  | { type: 'feed-invalidated'; cookieKey: string }
  | {
      type: 'preview-job';
      clipId: string;
      state: PreviewLiveJobState;
      queuePosition: number;
      progressPercent: number | null;
      currentSec: number;
      durationSec: number;
      error: string | null;
    }
  | { type: 'preview-ready'; clipId: string }
  | { type: 'preview-error'; clipId: string; error: string }
  | {
      type: 'clip-status';
      clipId: string;
      status: string;
      title?: string;
      durationSec?: number;
      createdAt?: string;
    }
  | { type: 'unlock-status'; clipId: string; unlocked: boolean };

const globalForPreviewLive = globalThis as unknown as {
  sunoPreviewLiveBus?: EventEmitter;
};

function bus(): EventEmitter {
  if (!globalForPreviewLive.sunoPreviewLiveBus) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    globalForPreviewLive.sunoPreviewLiveBus = emitter;
  }
  return globalForPreviewLive.sunoPreviewLiveBus;
}

export function emitPreviewLiveEvent(event: PreviewLiveEvent): void {
  bus().emit('event', event);
}

export function onPreviewLiveEvent(fn: (event: PreviewLiveEvent) => void): () => void {
  bus().on('event', fn);
  return () => {
    bus().off('event', fn);
  };
}
