'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PREVIEW_LIVE_PATH,
  type PreviewLiveServerMessage,
  type PreviewTrack
} from '@/lib/preview-live/preview-live-protocol';

export type PreviewLiveConnectionState = 'connecting' | 'connected' | 'reconnecting';

const PING_MS = 25_000;
const RECONNECT_CAP_MS = 8_000;
const LOAD_PAGE_TIMEOUT_MS = 15_000;

type PreviewStatusMessage = Extract<PreviewLiveServerMessage, { type: 'preview_status' }>;
type ClipStatusMessage = Extract<PreviewLiveServerMessage, { type: 'clip_status' }>;
type UnlockStatusMessage = Extract<PreviewLiveServerMessage, { type: 'unlock_status' }>;

export function usePreviewLive(handlers: {
  onHello: (tracks: PreviewTrack[]) => void;
  onPage1: (tracks: PreviewTrack[]) => void;
  onPreviewStatus: (msg: PreviewStatusMessage) => void;
  onClipStatus: (msg: ClipStatusMessage) => void;
  onUnlockStatus?: (msg: UnlockStatusMessage) => void;
}) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [connection, setConnection] = useState<PreviewLiveConnectionState>('connecting');
  const [lastPush, setLastPush] = useState<Date | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<string, (tracks: PreviewTrack[] | null) => void>());
  const reconnectAttemptRef = useRef(0);

  useEffect(() => {
    let unmounted = false;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;

    const clearPing = () => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
    };

    const failPending = () => {
      for (const resolve of pendingRef.current.values()) resolve(null);
      pendingRef.current.clear();
    };

    const connect = () => {
      if (unmounted) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}${PREVIEW_LIVE_PATH}`;
      setConnection(reconnectAttemptRef.current > 0 ? 'reconnecting' : 'connecting');
      socket = new WebSocket(url);
      wsRef.current = socket;

      socket.onopen = () => {
        reconnectAttemptRef.current = 0;
        setConnection('connected');
        socket?.send(JSON.stringify({ type: document.hidden ? 'pause' : 'resume' }));
        clearPing();
        pingTimer = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
        }, PING_MS);
      };

      socket.onmessage = (ev) => {
        let msg: PreviewLiveServerMessage;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
        if (msg.type === 'pong') return;
        setLastPush(new Date());
        if (msg.type === 'hello') handlersRef.current.onHello(msg.tracks);
        else if (msg.type === 'page1') handlersRef.current.onPage1(msg.tracks);
        else if (msg.type === 'page') {
          const resolve = pendingRef.current.get(msg.requestId);
          pendingRef.current.delete(msg.requestId);
          resolve?.(msg.tracks);
        } else if (msg.type === 'page_error') {
          const resolve = pendingRef.current.get(msg.requestId);
          pendingRef.current.delete(msg.requestId);
          resolve?.(null);
        } else if (msg.type === 'preview_status') handlersRef.current.onPreviewStatus(msg);
        else if (msg.type === 'clip_status') handlersRef.current.onClipStatus(msg);
        else if (msg.type === 'unlock_status') handlersRef.current.onUnlockStatus?.(msg);
      };

      socket.onclose = () => {
        clearPing();
        wsRef.current = null;
        failPending();
        if (unmounted) return;
        setConnection('reconnecting');
        const delay = Math.min(RECONNECT_CAP_MS, 1000 * 2 ** reconnectAttemptRef.current);
        reconnectAttemptRef.current += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    const onVisibility = () => {
      const open = wsRef.current;
      if (!open || open.readyState !== WebSocket.OPEN) return;
      open.send(JSON.stringify({ type: document.hidden ? 'pause' : 'resume' }));
    };

    connect();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      unmounted = true;
      document.removeEventListener('visibilitychange', onVisibility);
      clearPing();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      failPending();
      socket?.close();
      wsRef.current = null;
    };
  }, []);

  const loadPage = useCallback((page: number): Promise<PreviewTrack[] | null> => {
    const open = wsRef.current;
    if (!open || open.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingRef.current.delete(requestId);
        resolve(null);
      }, LOAD_PAGE_TIMEOUT_MS);
      pendingRef.current.set(requestId, (tracks) => {
        clearTimeout(timer);
        resolve(tracks);
      });
      open.send(JSON.stringify({ type: 'load_page', requestId, page }));
    });
  }, []);

  return { connection, lastPush, loadPage };
}
