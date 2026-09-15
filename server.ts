import { createServer, type IncomingMessage, type Server } from 'node:http';
import { parse } from 'node:url';
import type { Duplex } from 'node:stream';
import next from 'next';
import { WebSocketServer } from 'ws';
import { onPreviewLiveConnection } from './src/lib/preview-live/preview-live-connection';
import { PREVIEW_LIVE_PATH } from './src/lib/preview-live/preview-live-protocol';
import { registerPreviewLive } from './src/lib/preview-live/preview-live-register';

type NextCustomApp = ReturnType<typeof next> & {
  upgradeHandler?: (req: IncomingMessage, socket: Duplex, head: Buffer) => unknown;
  didWebSocketSetup?: boolean;
};

async function main(): Promise<void> {
  const dev = !process.argv.includes('--prod') && process.env.NODE_ENV !== 'production';
  const hostname = process.env.HOSTNAME || '0.0.0.0';
  const port = Number(process.env.PORT || 3000);

  registerPreviewLive();

  const app = next({ dev, hostname, port }) as NextCustomApp;
  await app.prepare();
  const handle = app.getRequestHandler();
  const routerUpgrade = app.upgradeHandler;

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req) => {
    void onPreviewLiveConnection(ws, req);
  });

  const server: Server = createServer((req, res) => {
    handle(req, res, parse(req.url ?? '', true));
  });

  // NextCustomServer.getRequestHandler() otherwise attaches a second upgrade
  // listener via setupWebSocketHandler on the first HTTP request. Own the
  // chain: preview WS here, everything else (HMR) via prepare()'s router handler.
  app.didWebSocketSetup = true;

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url ?? '', true);
    if (pathname === PREVIEW_LIVE_PATH) {
      wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client, req));
      return;
    }
    if (routerUpgrade) {
      void routerUpgrade(req, socket, head);
      return;
    }
    socket.destroy();
  });

  server.listen(port, hostname, () => {
    console.log(`Ready on http://${hostname}:${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
