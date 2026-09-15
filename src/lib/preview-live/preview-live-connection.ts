import type { IncomingMessage } from 'node:http';
import type { RawData, WebSocket } from 'ws';
import { sunoApi } from '@/lib/SunoApi';
import type { PreviewLiveClientMessage } from '@/lib/preview-live/preview-live-protocol';
import { clipsToPreviewTracks } from '@/lib/preview-live/preview-live-track-state';
import {
  getPreviewLiveHub,
  sendPreviewLive,
  type PreviewLiveSocket
} from '@/lib/preview-live/preview-live-hub';

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function parseClientMessage(raw: string): PreviewLiveClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const type = (parsed as { type?: unknown }).type;
  if (type === 'ping' || type === 'pause' || type === 'resume') {
    return { type };
  }
  if (type === 'load_page') {
    const requestId = (parsed as { requestId?: unknown }).requestId;
    const page = (parsed as { page?: unknown }).page;
    if (typeof requestId !== 'string' || !requestId) return null;
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return null;
    return { type: 'load_page', requestId, page };
  }
  return null;
}

async function handleLoadPage(sock: PreviewLiveSocket, requestId: string, page: number): Promise<void> {
  if (sock.loadInFlight) {
    sendPreviewLive(sock.ws, { type: 'page_error', requestId, message: 'load already in flight' });
    return;
  }
  sock.loadInFlight = true;
  try {
    await sock.api.ensurePreviewCacheIndex();
    const clips = await sock.api.get(undefined, String(page), page === 1 ? { fresh: true } : undefined);
    const tracks = clipsToPreviewTracks(clips, sock.api);
    sendPreviewLive(sock.ws, { type: 'page', requestId, page, tracks });
  } catch (err: any) {
    sendPreviewLive(sock.ws, {
      type: 'page_error',
      requestId,
      message: err?.message || 'Failed to load page'
    });
  } finally {
    sock.loadInFlight = false;
  }
}

export async function onPreviewLiveConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const cookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
  let api: Awaited<ReturnType<typeof sunoApi>>;
  try {
    api = await sunoApi(cookieHeader);
  } catch {
    ws.close(4001, 'no cookie');
    return;
  }

  const hub = getPreviewLiveHub();
  const sock: PreviewLiveSocket = {
    ws,
    cookieKey: api.getCookieKey(),
    api,
    paused: true,
    gotHello: false,
    lastMessageAt: Date.now(),
    loadInFlight: false
  };
  hub.addSocket(sock);

  const onMessage = (data: RawData, isBinary: boolean) => {
    sock.lastMessageAt = Date.now();
    if (isBinary) return;
    const raw = rawDataToString(data);
    const msg = parseClientMessage(raw);
    if (!msg) return;
    if (msg.type === 'ping') {
      sendPreviewLive(ws, { type: 'pong' });
      return;
    }
    if (msg.type === 'pause') {
      hub.setPaused(sock, true);
      return;
    }
    if (msg.type === 'resume') {
      hub.setPaused(sock, false);
      return;
    }
    void handleLoadPage(sock, msg.requestId, msg.page);
  };

  const onClose = () => {
    ws.off('message', onMessage);
    ws.off('close', onClose);
    ws.off('error', onClose);
    hub.removeSocket(sock);
  };

  ws.on('message', onMessage);
  ws.on('close', onClose);
  ws.on('error', onClose);
}
