import { onPreviewLiveConnection } from '@/lib/preview-live/preview-live-connection';
import { getPreviewLiveHub } from '@/lib/preview-live/preview-live-hub';

/**
 * Node-only bootstrap for the preview-live WebSocket handler.
 * Imported from instrumentation after a NEXT_RUNTIME === 'nodejs' check;
 * the edge compiler must not follow this module (see next.config.mjs).
 */
export function registerPreviewLive(): void {
  getPreviewLiveHub();
  (
    globalThis as unknown as {
      __onPreviewLiveConnection?: typeof onPreviewLiveConnection;
    }
  ).__onPreviewLiveConnection = onPreviewLiveConnection;
}
