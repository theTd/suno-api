import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { Browser, BrowserContext, Page } from 'rebrowser-playwright-core';

const logger = pino();

export const PAGE_FETCH_DEFAULT_TIMEOUT_MS = 15000;

export interface PageFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Caller already holds withRead/withWrite; do not acquire again. */
  locked?: boolean;
}

export interface PageFetchResult {
  status: number;
  ok: boolean;
  text: string;
  json: any;
}

export interface EnsurePageResult {
  page: Page;
  /** Same Page object is still open. */
  reused: boolean;
  /** Had to call launch(); TLS session is brand new. */
  newBrowser: boolean;
}

export interface SunoBrowserSessionOptions {
  launch: () => Promise<{ browser: Browser; context: BrowserContext }>;
  dispose: (browser: Browser, context: BrowserContext) => Promise<void>;
}

/**
 * Readers (in-page fetch) may overlap. Writers (goto / captcha UI / invalidate)
 * are exclusive of readers and of each other. Broadcast wake so waiters re-check.
 */
class PageRwLock {
  private readers = 0;
  private writer = false;
  private writeWaiters = 0;
  private waiters: Array<() => void> = [];

  private waitTurn(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private kick(): void {
    const waiting = this.waiters.splice(0, this.waiters.length);
    for (const waiter of waiting)
      waiter();
  }

  async withRead<T>(fn: () => Promise<T>): Promise<T> {
    for (;;) {
      if (!this.writer && this.writeWaiters === 0) {
        this.readers++;
        break;
      }
      await this.waitTurn();
    }
    try {
      return await fn();
    } finally {
      this.readers--;
      if (this.readers === 0)
        this.kick();
    }
  }

  async withWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.writeWaiters++;
    try {
      for (;;) {
        if (!this.writer && this.readers === 0) {
          this.writer = true;
          break;
        }
        await this.waitTurn();
      }
    } finally {
      this.writeWaiters--;
    }
    try {
      return await fn();
    } finally {
      this.writer = false;
      this.kick();
    }
  }
}

/**
 * One long-lived Chromium browser/context/page per Suno account.
 * generate /api/c/check and /api/generate/v2-web/ must go through this page
 * (page.evaluate fetch) so TLS, cookies, and JWT stay on the same client.
 * Playwright APIRequestContext is a different HTTP stack — do not use it here.
 */
export class SunoBrowserSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private ensureInflight?: Promise<EnsurePageResult>;
  private teardownInflight?: Promise<void>;
  private readonly lock = new PageRwLock();

  constructor(private readonly opts: SunoBrowserSessionOptions) {}

  isAlive(): boolean {
    return !!(this.page && !this.page.isClosed() && this.browser?.isConnected());
  }

  withRead<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock.withRead(fn);
  }

  withWrite<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock.withWrite(fn);
  }

  async ensurePage(onNewPage?: (page: Page) => Promise<void>): Promise<EnsurePageResult> {
    if (this.teardownInflight)
      await this.teardownInflight;
    if (this.ensureInflight) {
      const result = await this.ensureInflight;
      return { page: result.page, reused: true, newBrowser: false };
    }
    if (this.isAlive())
      return { page: this.page!, reused: true, newBrowser: false };

    const run = this.openPage(onNewPage);
    this.ensureInflight = run;
    try {
      return await run;
    } finally {
      if (this.ensureInflight === run)
        this.ensureInflight = undefined;
    }
  }

  /**
   * In-page fetch so the request uses Chromium TLS/cookies/client hints.
   * The page must already be alive on a suno.com origin.
   */
  async pageFetch(url: string, init: PageFetchInit = {}): Promise<PageFetchResult> {
    const run = () => this.pageFetchUnlocked(url, init);
    if (init.locked)
      return run();
    return this.lock.withRead(run);
  }

  async getClerkToken(locked = false): Promise<string | undefined> {
    const run = () => this.getClerkTokenUnlocked();
    if (locked)
      return run();
    return this.lock.withRead(run);
  }

  async readCookies(): Promise<Array<{ name: string; value: string }>> {
    if (this.teardownInflight)
      await this.teardownInflight;
    if (!this.context)
      return [];
    const cookies = await this.context.cookies();
    return cookies.map((item) => ({ name: item.name, value: item.value }));
  }

  async invalidate(): Promise<void> {
    let run: Promise<void> | undefined;
    await this.lock.withWrite(async () => {
      if (this.teardownInflight)
        await this.teardownInflight;
      const browser = this.browser;
      const context = this.context;
      this.browser = undefined;
      this.context = undefined;
      this.page = undefined;
      if (!browser)
        return;
      run = (async () => {
        if (context)
          await this.opts.dispose(browser, context);
        else
          await browser.close().catch(() => {});
      })();
      this.teardownInflight = run;
    });
    if (!run)
      return;
    try {
      await run;
    } finally {
      if (this.teardownInflight === run)
        this.teardownInflight = undefined;
    }
  }

  private bindPage(page: Page): void {
    page.on('close', () => {
      if (this.page === page)
        this.page = undefined;
    });
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted)
      throw new Error('The operation was aborted');
  }

  private async getClerkTokenUnlocked(): Promise<string | undefined> {
    if (!this.isAlive())
      return undefined;
    return this.page!.evaluate(async () => {
      const w = window as any;
      try {
        const token = await w.Clerk?.session?.getToken?.();
        if (typeof token === 'string' && token.length > 0)
          return token;
      } catch {
        // fall through to cookie
      }
      const match = document.cookie.match(/(?:^|; )__session=([^;]*)/);
      return match ? decodeURIComponent(match[1]) : undefined;
    });
  }

  private async pageFetchUnlocked(url: string, init: PageFetchInit): Promise<PageFetchResult> {
    this.throwIfAborted(init.signal);
    if (!this.isAlive())
      throw new Error('Chromium session page is not alive');
    const page = this.page!;
    const timeoutMs = init.timeoutMs ?? PAGE_FETCH_DEFAULT_TIMEOUT_MS;
    const signal = init.signal;
    const fetchId = randomUUID();
    let callerAborted = false;

    const abortInPage = () => {
      callerAborted = true;
      page.evaluate((id) => {
        const w = window as any;
        (w.__sunoPageFetchCancel ||= {})[id] = true;
        const entry = w.__sunoPageFetches?.[id];
        if (entry) {
          entry.reason = 'caller';
          entry.controller.abort();
        }
      }, fetchId).catch(() => {});
    };

    if (signal) {
      if (signal.aborted) {
        abortInPage();
        throw new Error('The operation was aborted');
      }
      signal.addEventListener('abort', abortInPage, { once: true });
    }

    const evalPromise = page.evaluate(async ({ url, method, headers, body, timeoutMs, fetchId }) => {
      const w = window as any;
      const cancel = (w.__sunoPageFetchCancel ||= {});
      const store = (w.__sunoPageFetches ||= {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (cancel[fetchId])
          throw new Error('The operation was aborted');
        const entry = { controller: new AbortController(), reason: null as string | null };
        store[fetchId] = entry;
        if (cancel[fetchId]) {
          entry.reason = 'caller';
          entry.controller.abort();
        }
        timer = setTimeout(() => {
          if (!entry.reason)
            entry.reason = 'timeout';
          entry.controller.abort();
        }, timeoutMs);
        const requestInit: RequestInit = {
          method,
          credentials: 'include',
          headers,
          signal: entry.controller.signal
        };
        if (body != null && method !== 'GET' && method !== 'HEAD')
          requestInit.body = body;
        const resp = await fetch(url, requestInit);
        const text = await resp.text();
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        return { status: resp.status, ok: resp.ok, text, json };
      } catch (err: any) {
        const entry = store[fetchId];
        if (err?.name === 'AbortError' || entry?.reason) {
          if (entry?.reason === 'caller' || cancel[fetchId])
            throw new Error('The operation was aborted');
          throw new Error('pageFetch timed out after ' + timeoutMs + 'ms');
        }
        throw err;
      } finally {
        if (timer)
          clearTimeout(timer);
        delete store[fetchId];
        delete cancel[fetchId];
      }
    }, {
      url,
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body ?? null,
      timeoutMs,
      fetchId
    });

    try {
      const result = await evalPromise;
      if (callerAborted || signal?.aborted)
        throw new Error('The operation was aborted');
      return result;
    } catch (err: any) {
      if (callerAborted || signal?.aborted)
        throw new Error('The operation was aborted');
      throw err;
    } finally {
      signal?.removeEventListener('abort', abortInPage);
    }
  }

  private async openPage(onNewPage?: (page: Page) => Promise<void>): Promise<EnsurePageResult> {
    if (this.teardownInflight)
      await this.teardownInflight;
    if (this.browser?.isConnected() && this.context) {
      try {
        const page = await this.context.newPage();
        this.bindPage(page);
        this.page = page;
        await onNewPage?.(page);
        return { page, reused: false, newBrowser: false };
      } catch (err) {
        logger.warn(
          'Failed to open page on existing Chromium, relaunching: ' + (err as Error).message
        );
        await this.invalidate();
      }
    }

    const { browser, context } = await this.opts.launch();
    this.browser = browser;
    this.context = context;
    browser.on('disconnected', () => {
      if (this.browser === browser) {
        logger.info('Chromium session disconnected');
        this.browser = undefined;
        this.context = undefined;
        this.page = undefined;
      }
    });
    const page = await context.newPage();
    this.bindPage(page);
    this.page = page;
    await onNewPage?.(page);
    return { page, reused: false, newBrowser: true };
  }
}
