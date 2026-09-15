import type { WebSocket } from 'ws';
import { onPreviewLiveEvent, type PreviewLiveEvent } from '@/lib/preview-live/preview-live-events';
import type { PreviewLiveServerMessage, PreviewTrack } from '@/lib/preview-live/preview-live-protocol';
import { startPreviewLiveFeedWatch, type PreviewLiveFeedWatch } from '@/lib/preview-live/preview-live-feed-watch';
import { previewStateFromJob, type PreviewLiveApi } from '@/lib/preview-live/preview-live-track-state';

const HEARTBEAT_MS = 60_000;
const HEARTBEAT_SWEEP_MS = 15_000;

export interface PreviewLiveSocket {
  ws: WebSocket;
  cookieKey: string;
  api: PreviewLiveApi;
  paused: boolean;
  gotHello: boolean;
  lastMessageAt: number;
  loadInFlight: boolean;
}

interface Room {
  cookieKey: string;
  sockets: Set<PreviewLiveSocket>;
  watch: PreviewLiveFeedWatch | null;
  lastPage1: PreviewTrack[] | null;
}

export function sendPreviewLive(ws: WebSocket, message: PreviewLiveServerMessage): void {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(message));
}

const globalForHub = globalThis as unknown as {
  sunoPreviewLiveHub?: PreviewLiveHub;
};

class PreviewLiveHub {
  private rooms = new Map<string, Room>();
  private unsubscribe: (() => void) | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = onPreviewLiveEvent((event) => this.onEvent(event));
    this.sweepTimer = setInterval(() => this.sweepHeartbeats(), HEARTBEAT_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  addSocket(sock: PreviewLiveSocket): void {
    let room = this.rooms.get(sock.cookieKey);
    if (!room) {
      room = { cookieKey: sock.cookieKey, sockets: new Set(), watch: null, lastPage1: null };
      this.rooms.set(sock.cookieKey, room);
    }
    room.sockets.add(sock);
    if (room.lastPage1 && !sock.gotHello) {
      sendPreviewLive(sock.ws, { type: 'hello', tracks: room.lastPage1 });
      sock.gotHello = true;
    }
    const hadWatch = !!room.watch;
    this.syncWatch(room);
    // New watch already fetches immediately; only nudge an existing sleeper.
    if (!sock.paused && hadWatch) room.watch?.nudge();
  }

  removeSocket(sock: PreviewLiveSocket): void {
    const room = this.rooms.get(sock.cookieKey);
    if (!room) return;
    room.sockets.delete(sock);
    if (room.sockets.size === 0) {
      room.watch?.stop();
      this.rooms.delete(sock.cookieKey);
      return;
    }
    this.syncWatch(room);
  }

  setPaused(sock: PreviewLiveSocket, paused: boolean): void {
    sock.paused = paused;
    const room = this.rooms.get(sock.cookieKey);
    const hadWatch = !!room?.watch;
    if (room) this.syncWatch(room);
    if (!paused && hadWatch) room?.watch?.nudge();
  }

  private syncWatch(room: Room): void {
    const visible = [...room.sockets].some((s) => !s.paused);
    if (visible && !room.watch) {
      const api = [...room.sockets][0]?.api;
      if (!api) return;
      room.watch = startPreviewLiveFeedWatch({
        api,
        onPage1: (tracks) => this.onPage1(room, tracks)
      });
    } else if (!visible && room.watch) {
      room.watch.stop();
      room.watch = null;
    }
  }

  private onPage1(room: Room, tracks: PreviewTrack[]): void {
    room.lastPage1 = tracks;
    for (const sock of room.sockets) {
      if (!sock.gotHello) {
        sendPreviewLive(sock.ws, { type: 'hello', tracks });
        sock.gotHello = true;
      } else {
        sendPreviewLive(sock.ws, { type: 'page1', tracks });
      }
    }
  }

  private onEvent(event: PreviewLiveEvent): void {
    if (event.type === 'feed-invalidated') {
      const matched = this.rooms.get(event.cookieKey);
      if (matched) matched.watch?.nudge();
      else {
        // Cookie serialization can differ between HTTP cookies().toString()
        // and the WS Cookie header; don't drop a generate just because the
        // room key did not match.
        for (const room of this.rooms.values()) room.watch?.nudge();
      }
      return;
    }
    if (event.type === 'preview-job') {
      this.broadcastAll({
        type: 'preview_status',
        clipId: event.clipId,
        preview: previewStateFromJob(event.state),
        progressPercent: event.progressPercent,
        currentSec: event.currentSec,
        durationSec: event.durationSec,
        queuePosition: event.queuePosition,
        error: event.error
      });
      return;
    }
    if (event.type === 'preview-ready') {
      this.broadcastAll({
        type: 'preview_status',
        clipId: event.clipId,
        preview: 'ready',
        progressPercent: null,
        currentSec: 0,
        durationSec: 0,
        queuePosition: 0,
        error: null
      });
      return;
    }
    if (event.type === 'preview-error') {
      this.broadcastAll({
        type: 'preview_status',
        clipId: event.clipId,
        preview: 'error',
        progressPercent: null,
        currentSec: 0,
        durationSec: 0,
        queuePosition: 0,
        error: event.error
      });
      return;
    }
    if (event.type === 'clip-status') {
      this.broadcastAll({
        type: 'clip_status',
        clipId: event.clipId,
        status: event.status,
        title: event.title,
        durationSec: event.durationSec,
        createdAt: event.createdAt
      });
      return;
    }
    if (event.type === 'unlock-status') {
      this.broadcastAll({
        type: 'unlock_status',
        clipId: event.clipId,
        unlocked: event.unlocked
      });
    }
  }

  private broadcastAll(message: PreviewLiveServerMessage): void {
    for (const room of this.rooms.values()) {
      for (const sock of room.sockets) sendPreviewLive(sock.ws, message);
    }
  }

  private sweepHeartbeats(): void {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      for (const sock of [...room.sockets]) {
        if (now - sock.lastMessageAt > HEARTBEAT_MS) {
          try {
            sock.ws.close(4000, 'heartbeat timeout');
          } catch {
            // ignore
          }
          this.removeSocket(sock);
        }
      }
    }
  }
}

export function getPreviewLiveHub(): PreviewLiveHub {
  if (!globalForHub.sunoPreviewLiveHub) {
    const hub = new PreviewLiveHub();
    hub.start();
    globalForHub.sunoPreviewLiveHub = hub;
  }
  return globalForHub.sunoPreviewLiveHub;
}
