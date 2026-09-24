/** Shared WebSocket control-plane types for the preview deck. No I/O. */

export const PREVIEW_LIVE_PATH = '/mcp/preview/live';

export type PreviewState =
  | 'generating'
  | 'pending'
  | 'waiting_clip'
  | 'queued'
  | 'capturing'
  | 'ready'
  | 'error';

export interface PreviewTrack {
  id: string;
  title: string;
  status: string;
  /** Song vs SFX, resolved server-side via clipKind(). */
  kind: 'song' | 'sound';
  createdAt?: string;
  preview: PreviewState;
  progressPercent: number | null;
  currentSec: number;
  durationSec: number;
  queuePosition: number;
  error: string | null;
  /** User clicked 「解锁母带」 on this preview page; MCP may download the master. */
  unlocked: boolean;
}

export type PreviewLiveClientMessage =
  | { type: 'load_page'; requestId: string; page: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'ping' };

export type PreviewLiveServerMessage =
  | { type: 'hello'; tracks: PreviewTrack[] }
  | { type: 'page'; requestId: string; page: number; tracks: PreviewTrack[] }
  | { type: 'page_error'; requestId: string; message: string }
  | { type: 'page1'; tracks: PreviewTrack[] }
  | {
      type: 'preview_status';
      clipId: string;
      preview: PreviewState;
      progressPercent: number | null;
      currentSec: number;
      durationSec: number;
      queuePosition: number;
      error: string | null;
    }
  | {
      type: 'clip_status';
      clipId: string;
      status: string;
      title?: string;
      durationSec?: number;
      createdAt?: string;
    }
  | { type: 'unlock_status'; clipId: string; unlocked: boolean }
  | { type: 'pong' };
