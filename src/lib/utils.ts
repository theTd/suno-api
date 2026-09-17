import { NextRequest } from "next/server";
import pino from "pino";
import { Page } from "rebrowser-playwright-core";

const logger = pino();

/**
 * Pause for a specified number of seconds.
 * @param x Minimum number of seconds.
 * @param y Maximum number of seconds (optional).
 */
export const sleep = (x: number, y?: number): Promise<void> => {
  let timeout = x * 1000;
  if (y !== undefined && y !== x) {
    const min = Math.min(x, y);
    const max = Math.max(x, y);
    timeout = Math.floor(Math.random() * (max - min + 1) + min) * 1000;
  }
  // console.log(`Sleeping for ${timeout / 1000} seconds`);
  logger.info(`Sleeping for ${timeout / 1000} seconds`);

  return new Promise(resolve => setTimeout(resolve, timeout));
}

/**
 * @param target A Locator or a page
 * @returns {boolean} 
 */
export const isPage = (target: any): target is Page => {
  return target.constructor.name === 'Page';
}

export const HCAPTCHA_ASSET_URL =
  /^https:\/\/(img[a-zA-Z0-9]*\.hcaptcha\.com|hcaptcha-assets-prod\.suno\.com|hcaptcha-imgs-prod\.suno\.com)\/.*$/;

/**
 * Tracks only requests whose `start` was observed. Finishes for in-flight
 * requests that began before the listener attached are ignored, so the idle
 * counter cannot go negative and stall until the hard deadline.
 */
export class StartedRequestSet {
  private inflight = new Set<object>();
  seen = 0;

  start(req: object): void {
    if (this.inflight.has(req))
      return;
    this.inflight.add(req);
    this.seen++;
  }

  /** Returns true when the tracked set is idle after this finish. */
  end(req: object): boolean {
    if (!this.inflight.has(req))
      return this.inflight.size === 0;
    this.inflight.delete(req);
    return this.inflight.size === 0;
  }

  get idle(): boolean {
    return this.inflight.size === 0;
  }
}

export interface WaitForRequestsOptions {
  hardDeadlineMs?: number;
  /** When true, wait briefly for at least one new image request. Never throws if none arrive. */
  requireRequests?: boolean;
  idleMs?: number;
  firstRequestTimeoutMs?: number;
}

/**
 * Waits for hCaptcha image requests started *after* this call to settle.
 * Zero new requests is not a failure: the challenge tiles may already be loaded
 * (retry / late attach). Only AbortSignal rejects.
 */
export const waitForRequests = (
  page: Page,
  signal: AbortSignal,
  hardDeadlineMsOrOptions: number | WaitForRequestsOptions = 20000
): Promise<void> => {
  const options: WaitForRequestsOptions = typeof hardDeadlineMsOrOptions === 'number'
    ? { hardDeadlineMs: hardDeadlineMsOrOptions }
    : (hardDeadlineMsOrOptions || {});
  const hardDeadlineMs = options.hardDeadlineMs ?? 20000;
  const requireRequests = options.requireRequests ?? true;
  const idleMs = options.idleMs ?? 1000;
  const firstRequestTimeoutMs = options.firstRequestTimeoutMs ?? 8000;

  return new Promise((resolve, reject) => {
    const tracker = new StartedRequestSet();
    let timeoutHandle: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanupListeners = () => {
      page.off('request', onRequest);
      page.off('requestfinished', onRequestFinished);
      page.off('requestfailed', onRequestFinished);
      signal.removeEventListener('abort', onAbort);
    };

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      clearTimeout(firstTimer);
      clearTimeout(hardDeadlineTimer);
      if (timeoutHandle)
        clearTimeout(timeoutHandle);
      if (err) reject(err); else resolve();
    };

    const armIdle = () => {
      if (timeoutHandle)
        clearTimeout(timeoutHandle);
      if (!tracker.idle)
        return;
      timeoutHandle = setTimeout(() => {
        logger.info(`hCaptcha image requests settled (${tracker.seen} seen)`);
        finish();
      }, idleMs);
    };

    const onRequest = (request: { url: () => string }) => {
      if (!HCAPTCHA_ASSET_URL.test(request.url()))
        return;
      tracker.start(request as object);
      if (timeoutHandle)
        clearTimeout(timeoutHandle);
      clearTimeout(firstTimer);
    };

    const onRequestFinished = (request: { url: () => string }) => {
      if (!HCAPTCHA_ASSET_URL.test(request.url()))
        return;
      if (tracker.end(request as object) && tracker.seen > 0)
        armIdle();
    };

    const firstTimer = setTimeout(() => {
      if (tracker.seen === 0) {
        logger.info('No new hCaptcha image requests; proceeding with current challenge');
        finish();
      } else if (tracker.idle) {
        armIdle();
      }
    }, requireRequests ? firstRequestTimeoutMs : Math.min(firstRequestTimeoutMs, idleMs));

    const hardDeadlineTimer = setTimeout(() => {
      logger.info(`hCaptcha wait hit hard deadline after ${hardDeadlineMs}ms (${tracker.seen} requests)`);
      finish();
    }, hardDeadlineMs);

    page.on('request', onRequest);
    page.on('requestfinished', onRequestFinished);
    page.on('requestfailed', onRequestFinished);

    const onAbort = () => {
      finish(new Error('AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    if (!requireRequests && tracker.idle)
      armIdle();
  });
}

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * Build CORS headers with credentials support.
 * When req is provided, uses the request's Origin header for Access-Control-Allow-Origin
 * and sets Access-Control-Allow-Credentials to support cookie-based auth.
 */
export function buildCorsHeaders(req?: NextRequest): Record<string, string> {
  if (!req) {
    return corsHeaders;
  }
  const origin = req.headers.get("origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
    "Access-Control-Allow-Credentials": "true",
  };
}

