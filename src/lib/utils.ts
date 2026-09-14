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

/**
 * Waits for an hCaptcha image requests and then waits for all of them to end
 * @param page
 * @param signal `const controller = new AbortController(); controller.status`
 * @returns {Promise<void>} 
 */
export const waitForRequests = (
  page: Page,
  signal: AbortSignal,
  hardDeadlineMs: number = 45000
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const urlPattern = /^https:\/\/(img[a-zA-Z0-9]*\.hcaptcha\.com|hcaptcha-assets-prod\.suno\.com|hcaptcha-imgs-prod\.suno\.com)\/.*$/;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let activeRequestCount = 0;
    let requestCount = 0;
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
      clearTimeout(initialTimeout);
      clearTimeout(hardDeadlineTimer);
      if (timeoutHandle)
        clearTimeout(timeoutHandle);
      if (err) reject(err); else resolve();
    };

    const resetTimeout = () => {
      if (timeoutHandle)
        clearTimeout(timeoutHandle);
      if (activeRequestCount === 0) {
        timeoutHandle = setTimeout(() => {
          logger.info(`hCaptcha image requests settled (${requestCount} seen)`);
          finish();
        }, 1000); // 1 second of no requests
      }
    };

    const onRequest = (request: { url: () => string }) => {
      if (urlPattern.test(request.url())) {
        requestCount++;
        activeRequestCount++;
        if (timeoutHandle)
          clearTimeout(timeoutHandle);
        clearTimeout(initialTimeout);
      }
    };

    const onRequestFinished = (request: { url: () => string }) => {
      if (urlPattern.test(request.url())) {
        activeRequestCount--;
        resetTimeout();
      }
    };

    // Wait for an hCaptcha request for up to 30 seconds
    const initialTimeout = setTimeout(() => {
      if (requestCount === 0) {
        finish(new Error('No hCaptcha request occurred within 30 seconds.'));
      } else {
        // Requests started but never quiesced; proceed with whatever has loaded
        logger.info(`hCaptcha requests seen but never quiesced (${requestCount} total); proceeding`);
        finish();
      }
    }, 30000);

    // Absolute cap: never wait longer than hardDeadlineMs, no matter what
    const hardDeadlineTimer = setTimeout(() => {
      logger.info(`hCaptcha wait hit hard deadline after ${hardDeadlineMs}ms (${requestCount} requests)`);
      finish();
    }, hardDeadlineMs);

    page.on('request', onRequest);
    page.on('requestfinished', onRequestFinished);
    page.on('requestfailed', onRequestFinished);

    const onAbort = () => {
      finish(new Error('AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
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

