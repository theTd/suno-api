import axios, { AxiosInstance } from 'axios';
import UserAgent from 'user-agents';
import pino from 'pino';
import yn from 'yn';
import { isPage, sleep, waitForRequests } from '@/lib/utils';
import * as cookie from 'cookie';
import { randomUUID } from 'node:crypto';
import { Solver } from '@2captcha/captcha-solver';
import { paramsCoordinates } from '@2captcha/captcha-solver/dist/structs/2captcha';
import { Browser, BrowserContext, Page, Locator, chromium, firefox } from 'rebrowser-playwright-core';
import { createCursor, Cursor } from 'ghost-cursor-playwright';
import { promises as fs } from 'fs';
import path from 'node:path';
import os from 'node:os';

// sunoApi instance caching
const globalForSunoApi = global as unknown as { sunoApiCache?: Map<string, SunoApi> };
const cache = globalForSunoApi.sunoApiCache || new Map<string, SunoApi>();
globalForSunoApi.sunoApiCache = cache;

const logger = pino();
export const DEFAULT_MODEL = 'chirp-hawk';
const AUDIO_CACHE_DIR = path.join(os.tmpdir(), 'suno-audio-cache');
const PREVIEW_CACHE_DIR = path.join(os.tmpdir(), 'suno-preview-cache');
const globalForHarvest = global as unknown as {
  sunoAudioHarvest?: Map<string, Promise<Buffer>>;
  sunoPreviewHarvest?: Map<string, Promise<Buffer>>;
  sunoPlaywrightHarvest?: Promise<unknown>;
};
const harvestLocks = globalForHarvest.sunoAudioHarvest || new Map<string, Promise<Buffer>>();
globalForHarvest.sunoAudioHarvest = harvestLocks;
const previewLocks = globalForHarvest.sunoPreviewHarvest || new Map<string, Promise<Buffer>>();
globalForHarvest.sunoPreviewHarvest = previewLocks;
if (!globalForHarvest.sunoPlaywrightHarvest)
  globalForHarvest.sunoPlaywrightHarvest = Promise.resolve();

export class ClipAudioNotReadyError extends Error {
  statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'ClipAudioNotReadyError';
  }
}

export function isUnusableAudioUrl(url?: string): boolean {
  return !url || url.includes('/api/forbidden');
}

export function rewriteForbiddenAudioUrls<T>(data: T, origin: string): T {
  const base = (origin || '').replace(/\/$/, '');
  if (!base) return data;
  const rewriteClip = (clip: any) => {
    if (!clip || typeof clip !== 'object' || !clip.id) return clip;
    const ready = clip.status === 'complete' || clip.status === 'streaming';
    if (ready && isUnusableAudioUrl(clip.audio_url))
      return { ...clip, audio_url: `${base}/api/preview/${clip.id}` };
    return clip;
  };
  if (Array.isArray(data)) return data.map(rewriteClip) as T;
  return rewriteClip(data) as T;
}

function looksLikeAudio(buf: Buffer): boolean {
  if (buf.length < 16) return false;
  if (buf.subarray(0, 3).toString() === 'ID3') return true;
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;
  const head = buf.subarray(0, 32);
  if (head.includes(Buffer.from('ftyp')) || head.includes(Buffer.from('moov'))) return true;
  if (head.includes(Buffer.from('RIFF')) && head.includes(Buffer.from('WAVE'))) return true;
  if (head.includes(Buffer.from('webm')) || head.includes(Buffer.from('Opus'))) return true;
  return false;
}

function audioCachePath(clipId: string): string {
  return path.join(AUDIO_CACHE_DIR, `${clipId}.bin`);
}

function previewCachePath(clipId: string): string {
  return path.join(PREVIEW_CACHE_DIR, `${clipId}.bin`);
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBare(url: string): Promise<Buffer> {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
  return Buffer.from(resp.data);
}

export interface AudioInfo {
  id: string; // Unique identifier for the audio
  title?: string; // Title of the audio
  image_url?: string; // URL of the image associated with the audio
  lyric?: string; // Lyrics of the audio
  audio_url?: string; // URL of the audio file
  video_url?: string; // URL of the video associated with the audio
  created_at: string; // Date and time when the audio was created
  model_name: string; // Name of the model used for audio generation
  gpt_description_prompt?: string; // Prompt for GPT description
  prompt?: string; // Prompt for audio generation
  status: string; // Status
  type?: string;
  tags?: string; // Genre of music.
  negative_tags?: string; // Negative tags of music.
  duration?: string; // Duration of the audio
  error_message?: string; // Error message if any
}

interface PersonaResponse {
  persona: {
    id: string;
    name: string;
    description: string;
    image_s3_id: string;
    root_clip_id: string;
    clip: any; // You can define a more specific type if needed
    user_display_name: string;
    user_handle: string;
    user_image_url: string;
    persona_clips: Array<{
      clip: any; // You can define a more specific type if needed
    }>;
    is_suno_persona: boolean;
    is_trashed: boolean;
    is_owned: boolean;
    is_public: boolean;
    is_public_approved: boolean;
    is_loved: boolean;
    upvote_count: number;
    clip_count: number;
  };
  total_results: number;
  current_page: number;
  is_following: boolean;
}

class SunoApi {
  private static BASE_URL: string = 'https://studio-api-prod.suno.com';
  private static CLERK_BASE_URL: string = 'https://auth.suno.com';
  private static CLERK_VERSION = '5.117.0';

  private readonly client: AxiosInstance;
  private sid?: string;
  private currentToken?: string;
  private captchaTokenProvider?: string;
  private deviceId?: string;
  private userAgent?: string;
  private cookies: Record<string, string | undefined>;
  private solver = new Solver(process.env.TWOCAPTCHA_KEY + '');
  private ghostCursorEnabled = yn(process.env.BROWSER_GHOST_CURSOR, { default: false });
  private cursor?: Cursor;

  constructor(cookies: string) {
    this.userAgent = new UserAgent(/Macintosh/).random().toString(); // Usually Mac systems get less amount of CAPTCHAs
    this.cookies = cookie.parse(cookies);
    this.deviceId = this.cookies.ajs_anonymous_id || randomUUID();
    this.client = axios.create({
      withCredentials: true,
      headers: {
        'Affiliate-Id': 'undefined',
        'Device-Id': `"${this.deviceId}"`,
        'x-suno-client': 'Android prerelease-4nt180t 1.0.42',
        'X-Requested-With': 'com.suno.android',
        'sec-ch-ua': '"Chromium";v="130", "Android WebView";v="130", "Not?A_Brand";v="99"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'User-Agent': this.userAgent
      }
    });
    this.client.interceptors.request.use(config => {
      if (this.currentToken && !config.headers.Authorization)
        config.headers.Authorization = `Bearer ${this.currentToken}`;
      const cookiesArray = Object.entries(this.cookies).map(([key, value]) => 
        cookie.serialize(key, value as string)
      );
      config.headers.Cookie = cookiesArray.join('; ');
      return config;
    });
    this.client.interceptors.response.use(resp => {
      const setCookieHeader = resp.headers['set-cookie'];
      if (Array.isArray(setCookieHeader)) {
        const newCookies = cookie.parse(setCookieHeader.join('; '));
        for (const [key, value] of Object.entries(newCookies)) {
          this.cookies[key] = value;
        }
      }
      return resp;
    })
  }

  public async init(): Promise<SunoApi> {
    //await this.getClerkLatestVersion();
    await this.getAuthToken();
    await this.keepAlive();
    return this;
  }

  /**
   * Get the clerk package latest version id.
   * This method is commented because we are now using a hard-coded Clerk version, hence this method is not needed.
   
  private async getClerkLatestVersion() {
    // URL to get clerk version ID
    const getClerkVersionUrl = `${SunoApi.JSDELIVR_BASE_URL}/v1/package/npm/@clerk/clerk-js`;
    // Get clerk version ID
    const versionListResponse = await this.client.get(getClerkVersionUrl);
    if (!versionListResponse?.data?.['tags']['latest']) {
      throw new Error(
        'Failed to get clerk version info, Please try again later'
      );
    }
    // Save clerk version ID for auth
    SunoApi.clerkVersion = versionListResponse?.data?.['tags']['latest'];
  }
  */

  /**
   * Get the session ID and save it for later use.
   */
  private async getAuthToken() {
    logger.info('Getting the session ID');
    // URL to get session ID
    const getSessionUrl = `${SunoApi.CLERK_BASE_URL}/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=${SunoApi.CLERK_VERSION}`;
    // Get session ID
    const sessionResponse = await this.client.get(getSessionUrl, {
      headers: { Authorization: this.cookies.__client }
    });
    if (!sessionResponse?.data?.response?.last_active_session_id) {
      throw new Error(
        'Failed to get session id, you may need to update the SUNO_COOKIE'
      );
    }
    // Save session ID for later use
    this.sid = sessionResponse.data.response.last_active_session_id;
  }

  /**
   * Keep the session alive.
   * @param isWait Indicates if the method should wait for the session to be fully renewed before returning.
   */
  public async keepAlive(isWait?: boolean): Promise<void> {
    if (!this.sid) {
      throw new Error('Session ID is not set. Cannot renew token.');
    }
    // URL to renew session token
    const renewUrl = `${SunoApi.CLERK_BASE_URL}/v1/client/sessions/${this.sid}/tokens?__clerk_api_version=2025-11-10&_clerk_js_version=${SunoApi.CLERK_VERSION}`;
    // Renew session token
    logger.info('KeepAlive...\n');
    const renewResponse = await this.client.post(renewUrl, {}, {
      headers: { Authorization: this.cookies.__client }
    });
    if (isWait) {
      await sleep(1, 2);
    }
    const newToken = renewResponse.data.jwt;
    // Update Authorization field in request header with the new JWT token
    this.currentToken = newToken;
  }

  /**
   * Get the session token (not to be confused with session ID) and save it for later use.
   */
  private async getSessionToken() {
    const tokenResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/user/create_session_id/`,
      {
        session_properties: JSON.stringify({ deviceId: this.deviceId }),
        session_type: 1
      }
    );
    return tokenResponse.data.session_id;
  }

  private async captchaRequired(): Promise<boolean> {
    const resp = await this.client.post(`${SunoApi.BASE_URL}/api/c/check`, {
      ctype: 'generation'
    });
    logger.info(resp.data);
    return resp.data.required;
  }

  /**
   * Clicks on a locator or XY vector. This method is made because of the difference between ghost-cursor-playwright and Playwright methods
   */
  private async click(target: Locator|Page, position?: { x: number, y: number }): Promise<void> {
    if (this.ghostCursorEnabled) {
      let pos: any = isPage(target) ? { x: 0, y: 0 } : await target.boundingBox();
      if (position) 
        pos = {
          ...pos,
          x: pos.x + position.x,
          y: pos.y + position.y,
          width: null,
          height: null,
        };
      return this.cursor?.actions.click({
        target: pos
      });
    } else {
      if (isPage(target))
        return target.mouse.click(position?.x ?? 0, position?.y ?? 0);
      else
        return target.click({ force: true, position });
    }
  }

  /**
   * Get the BrowserType from the `BROWSER` environment variable.
   * @returns {BrowserType} chromium, firefox or webkit. Default is chromium
   */
  private getBrowserType() {
    const browser = process.env.BROWSER?.toLowerCase();
    switch (browser) {
      case 'firefox':
        return firefox;
      /*case 'webkit': ** doesn't work with rebrowser-patches
      case 'safari':
        return webkit;*/
      default:
        return chromium;
    }
  }

  /**
   * Launches a browser with the necessary cookies
   */
  private async launchBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=site-per-process',
      '--disable-features=IsolateOrigins',
      '--disable-extensions',
      '--disable-infobars'
    ];
    // Check for GPU acceleration, as it is recommended to turn it off for Docker
    if (yn(process.env.BROWSER_DISABLE_GPU, { default: false }))
      args.push('--enable-unsafe-swiftshader',
        '--disable-gpu',
        '--disable-setuid-sandbox');
    const browser = await this.getBrowserType().launch({
      args,
      headless: yn(process.env.BROWSER_HEADLESS, { default: true })
    });
    const context = await browser.newContext({
      userAgent: this.userAgent,
      locale: process.env.BROWSER_LOCALE,
      viewport: null,
      acceptDownloads: true
    });
    const cookies = [];
    const lax: 'Lax' | 'Strict' | 'None' = 'Lax';
    cookies.push({
      name: '__session',
      value: this.currentToken+'',
      domain: '.suno.com',
      path: '/',
      sameSite: lax,
      secure: true,
    });
    for (const key in this.cookies) {
      if (key === '__session') continue; // Already added with refreshed token above
      cookies.push({
        name: key,
        value: this.cookies[key]+'',
        domain: '.suno.com',
        path: '/',
        sameSite: lax,
        secure: true,
      })
    }
    await context.addCookies(cookies);
    return { browser, context };
  }

  /**
   * Checks for CAPTCHA verification and solves the CAPTCHA if needed.
   * Suno currently serves Cloudflare Turnstile (captcha_version 2) and may
   * still fall back to hCaptcha (version 1).
   * @returns {string|null} Captcha token. If no verification is required, returns null
   */
  public async getCaptcha(): Promise<string|null> {
    this.captchaTokenProvider = undefined;
    if (!await this.captchaRequired())
      return null;

    logger.info('CAPTCHA required. Launching browser...');
    const { browser, context } = await this.launchBrowser();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);
    let page!: Page;
    let routeHandler: ((route: any) => Promise<void>) | null = null;
    const generateRoute = /\/api\/generate\/v2/;

    try {
      page = await context.newPage();
      await this.installTurnstileHook(page);
      await page.goto('https://suno.com/', { referer: 'https://www.google.com/', waitUntil: 'domcontentloaded', timeout: 0 });

      logger.info('Waiting for Suno interface to load');
      // New Suno UI no longer calls /api/project/; wait for a known API and a short render delay
      try {
        await page.waitForResponse('**/api/billing/usage-plan-descriptions/**', { timeout: 30000 });
      } catch {
        // Fallback: some regions/users may not hit this endpoint; continue after delay
      }
      // Skeleton textarea is visible before hydration; wait for the logged-in shell.
      await page.getByRole('link', { name: 'Home' }).waitFor({ timeout: 30000 });
      await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 15000 });
      await sleep(1, 1);

      if (this.ghostCursorEnabled)
        this.cursor = await createCursor(page);

      logger.info('Triggering the CAPTCHA');
      await this.dismissOverlays(page);

      const textarea = page.locator('textarea').first();
      await this.click(textarea);
      await textarea.fill('Lorem ipsum');

      const button = page.locator('button:has-text("Create")').first();
      await page.waitForFunction(() => {
        const btn = [...document.querySelectorAll('button')].find((el) =>
          (el.textContent || '').replace(/\s+/g, ' ').trim() === 'Create'
        ) as HTMLButtonElement | undefined;
        return !!btn && !btn.disabled && !btn.hasAttribute('data-disabled');
      }, { timeout: 20000 });

      let tokenSettled = false;
      const tokenPromise = new Promise<string>((resolve, reject) => {
        const onAbort = () => {
          if (!tokenSettled) { tokenSettled = true; reject(new Error('Captcha timeout')); }
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
        routeHandler = async (route: any) => {
          if (tokenSettled) {
            route.abort();
            return;
          }
          try {
            const request = route.request();
            let postData: any;
            try {
              postData = request.postDataJSON();
            } catch {
              route.abort();
              return;
            }
            const token = postData?.token;
            if (!token) {
              logger.info('Dropping generate request without captcha token');
              route.abort();
              return;
            }
            if (postData?.token_provider)
              this.captchaTokenProvider = postData.token_provider;
            this.currentToken = request.headers().authorization?.split('Bearer ').pop();
            logger.info('Captured generate captcha token from ' + request.url());
            controller.signal.removeEventListener('abort', onAbort);
            tokenSettled = true;
            resolve(token);
            route.abort();
          } catch(err) {
            route.abort().catch(() => {});
            logger.warn('Generate intercept error: ' + (err as Error).message);
          }
        };
        page.route(generateRoute, routeHandler);
      });

      await this.click(button);

      // New Suno UI navigates to /create after clicking Create
      logger.info('Waiting for navigation to /create');
      try {
        await page.waitForFunction(() => location.pathname.includes('/create'), { timeout: 30000 });
        logger.info('Navigated to /create');
      } catch {
        logger.warn('Did not navigate to /create, url=' + page.url());
      }
      await this.dismissOverlays(page);
      await this.triggerCreateOnCreatePage(page);

      const captchaPromise = this.solveDetectedCaptcha(page, button, controller.signal)
        .then(() => ({ type: 'solved' as const }))
        .catch((err: any) => ({ type: 'solver_failed' as const, err }));
      const raced = await Promise.race([
        tokenPromise.then((token) => ({ type: 'token' as const, token })),
        captchaPromise,
      ]);
      if (raced.type === 'token')
        return raced.token;
      if (raced.type === 'solver_failed')
        logger.warn('CAPTCHA solver error: ' + raced.err?.message);
      else if (!tokenSettled)
        await this.triggerCreateOnCreatePage(page);
      return await tokenPromise;
    } finally {
      clearTimeout(timeoutId);
      controller.abort();
      if (page && routeHandler) await page.unroute(generateRoute, routeHandler);
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  /**
   * Capture Turnstile render params (sitekey / callback) before the widget mounts.
   */
  private async installTurnstileHook(page: Page): Promise<void> {
    await page.addInitScript(() => {
      const w = window as any;
      const patch = (ts: any) => {
        if (!ts?.render || ts.__sunoPatched) return ts;
        ts.__sunoPatched = true;
        const originalRender = ts.render.bind(ts);
        ts.render = (container: any, params: any) => {
          w.__sunoTurnstile = {
            sitekey: params?.sitekey,
            action: params?.action,
            data: params?.cData || params?.data,
            pagedata: params?.chlPageData,
            callback: params?.callback,
          };
          return originalRender(container, params);
        };
        return ts;
      };
      if (w.turnstile)
        patch(w.turnstile);
      try {
        let current = w.turnstile;
        Object.defineProperty(w, 'turnstile', {
          configurable: true,
          get() { return current; },
          set(value) { current = patch(value); },
        });
      } catch {
        const id = window.setInterval(() => {
          if (w.turnstile) {
            patch(w.turnstile);
            window.clearInterval(id);
          }
        }, 20);
      }
    });
  }

  /**
   * If Turnstile is not already on screen, click Create song on /create.
   * Homepage Create usually submits after routing; this covers the case where
   * it only navigated and the generate control is still idle.
   */
  private async isTurnstileVisible(page: Page): Promise<boolean> {
    for (const frame of page.frames()) {
      if (!/challenges\.cloudflare\.com/i.test(frame.url()))
        continue;
      try {
        const box = await (await frame.frameElement()).boundingBox();
        if (box && box.width > 40 && box.height > 40)
          return true;
      } catch {}
    }
    return page.getByText('Verify you are human').isVisible().catch(() => false);
  }

  private async triggerCreateOnCreatePage(page: Page): Promise<void> {
    if (await this.isTurnstileVisible(page))
      return;
    const createSong = page.locator('button[aria-label="Create song"]');
    try {
      await createSong.first().waitFor({ state: 'visible', timeout: 20000 });
    } catch {
      return;
    }
    if (await this.isTurnstileVisible(page))
      return;
    if (await createSong.first().isEnabled().catch(() => false)) {
      logger.info('Clicking Create on /create');
      await this.click(createSong.first());
    }
  }

  private async dismissOverlays(page: Page): Promise<void> {
    try {
      const acceptCookies = page.locator('button:has-text("Accept All Cookies")');
      if (await acceptCookies.count() > 0 && await acceptCookies.first().isVisible({ timeout: 2000 }))
        await acceptCookies.first().click({ timeout: 2000 });
    } catch(e: any) {
      if (e.name !== 'TimeoutError') logger.info('Cookie banner dismiss failed: ' + e.message);
    }
    try {
      const closeBtn = page.getByLabel('Close');
      const closeCount = await closeBtn.count();
      if (closeCount > 0) {
        for (let i = 0; i < closeCount; i++) {
          const btn = closeBtn.nth(i);
          if (await btn.isVisible({ timeout: 2000 })) {
            await btn.click({ timeout: 2000 });
            break;
          }
        }
      }
    } catch(e: any) {
      if (e.name !== 'TimeoutError') logger.info('Close button click failed: ' + e.message);
    }
  }

  private async solveDetectedCaptcha(
    page: Page,
    button: Locator,
    signal: AbortSignal
  ): Promise<void> {
    const kind = await this.waitForCaptchaKind(page, signal);
    logger.info('Detected CAPTCHA kind: ' + kind);
    if (kind === 'turnstile')
      await this.solveTurnstileChallenge(page, signal);
    else if (kind === 'hcaptcha')
      await this.solveHcaptchaChallenge(page, button, signal);
    else
      throw new Error('CAPTCHA required but no widget appeared');
  }

  private async waitForCaptchaKind(
    page: Page,
    signal: AbortSignal,
    timeoutMs: number = 60000
  ): Promise<'turnstile' | 'hcaptcha' | 'none'> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted)
        throw new Error('AbortError');
      if (await this.isTurnstileVisible(page))
        return 'turnstile';
      const hcaptchaIframe = page.locator('iframe[title*="hCaptcha"]');
      if (await hcaptchaIframe.count() > 0) {
        const visible = await hcaptchaIframe.first().isVisible().catch(() => false);
        if (visible)
          return 'hcaptcha';
      }
      await sleep(0.4, 0.4);
    }
    return 'none';
  }

  private async extractTurnstileParams(page: Page): Promise<{ sitekey: string; action?: string; data?: string; pagedata?: string }> {
    await page.waitForFunction(() => !!(window as any).__sunoTurnstile?.sitekey, { timeout: 10000 }).catch(() => {});
    const hooked = await page.evaluate(() => {
      const params = (window as any).__sunoTurnstile;
      if (!params?.sitekey) return null;
      return {
        sitekey: String(params.sitekey),
        action: params.action ? String(params.action) : undefined,
        data: params.data ? String(params.data) : undefined,
        pagedata: params.pagedata ? String(params.pagedata) : undefined,
      };
    });
    if (hooked?.sitekey)
      return hooked;
    throw new Error('Turnstile sitekey not captured from turnstile.render');
  }

  private turnstileFrame(page: Page) {
    return page.frames().find((item) => /challenges\.cloudflare\.com/i.test(item.url()));
  }

  private async solveTurnstileChallenge(page: Page, signal: AbortSignal): Promise<void> {
    if (signal.aborted)
      throw new Error('AbortError');

    // Managed widgets sometimes pass after a real click; skip 2Captcha when that happens.
    const checkboxFrame = this.turnstileFrame(page);
    if (checkboxFrame) {
      await checkboxFrame.locator('body').click({ timeout: 3000 }).catch(() => {});
      await sleep(3, 3);
      if (!this.turnstileFrame(page)) {
        logger.info('Turnstile passed after checkbox click');
        return;
      }
    }

    const params = await this.extractTurnstileParams(page);
    const payload: { pageurl: string; sitekey: string; action?: string; data?: string; pagedata?: string } = {
      pageurl: page.url(),
      sitekey: params.sitekey,
    };
    if (params.action)
      payload.action = params.action;
    if (params.data)
      payload.data = params.data;
    if (params.pagedata)
      payload.pagedata = params.pagedata;

    let result: { data: string } | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted)
        throw new Error('AbortError');
      try {
        logger.info('Sending Turnstile to 2Captcha, sitekey=' + params.sitekey);
        result = await this.solver.cloudflareTurnstile(payload);
        break;
      } catch (err: any) {
        logger.info(err.message);
        if (attempt === 2) throw err;
        logger.info('Retrying Turnstile...');
      }
    }
    if (!result)
      throw new Error('Turnstile solver returned no token');
    if (signal.aborted)
      throw new Error('AbortError');

    logger.info('Turnstile solved, injecting token');
    const injected = await page.evaluate((token: string) => {
      const w = window as any;
      const nodes = document.querySelectorAll(
        'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], input[name="g-recaptcha-response"], textarea[name="g-recaptcha-response"]'
      );
      nodes.forEach((node) => {
        const input = node as HTMLInputElement;
        input.value = token;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      if (typeof w.__sunoTurnstile?.callback === 'function') {
        w.__sunoTurnstile.callback(token);
        return 'callback';
      }
      return nodes.length ? 'input' : 'none';
    }, result.data);
    logger.info('Turnstile inject path: ' + injected);
    if (injected === 'none')
      throw new Error('Turnstile callback was not captured; cannot inject token');
    await sleep(2, 2);
  }

  private async solveHcaptchaChallenge(
    page: Page,
    button: Locator,
    signal: AbortSignal
  ): Promise<void> {
    const frame = page.frameLocator('iframe[title*="hCaptcha"]');
    const challenge = frame.locator('.challenge-container');
    const MAX_CAPTCHA_ATTEMPTS = 5;

    for (let attempt = 0; attempt < MAX_CAPTCHA_ATTEMPTS; attempt++) {
      await waitForRequests(page, signal);
      await sleep(2, 3); // Allow challenge images to fully render before screenshot

      const promptText = await challenge.locator('.prompt-text')
        .first().innerText().catch(() => '');
      const drag = promptText.toLowerCase().includes('drag');

      let captcha: any;
      for (let j = 0; j < 3; j++) {
        try {
          logger.info('Sending the CAPTCHA to 2Captcha');
          const payload: paramsCoordinates = {
            body: (await challenge.screenshot({ timeout: 5000 })).toString('base64'),
            lang: process.env.BROWSER_LOCALE
          };
          if (drag) {
            payload.textinstructions = 'CLICK on the shapes at their edge or center as shown above—please be precise!';
            payload.imginstructions = (await fs.readFile(
              path.join(process.cwd(), 'public', 'drag-instructions.jpg')
            )).toString('base64');
          }
          captcha = await this.solver.coordinates(payload);
          break;
        } catch(err: any) {
          logger.info(err.message);
          if (j === 2) throw err;
          logger.info('Retrying...');
        }
      }

      if (drag) {
        const challengeBox = await challenge.boundingBox();
        if (challengeBox == null)
          throw new Error('.challenge-container boundingBox is null!');
        if (captcha.data.length % 2) {
          logger.info('Solution does not have even amount of points required for dragging. Requesting new solution...');
          await this.solver.badReport(captcha.id).catch((e: any) => {
            logger.warn('badReport failed: ' + e.message);
          });
          continue;
        }
        for (let i = 0; i < captcha.data.length; i += 2) {
          const data1 = captcha.data[i];
          const data2 = captcha.data[i+1];
          logger.info(JSON.stringify(data1) + JSON.stringify(data2));
          await page.mouse.move(challengeBox.x + +data1.x, challengeBox.y + +data1.y);
          await page.mouse.down();
          await sleep(1.1);
          await page.mouse.move(challengeBox.x + +data2.x, challengeBox.y + +data2.y, { steps: 30 });
          await page.mouse.up();
        }
      } else {
        for (const data of captcha.data) {
          logger.info(data);
          await this.click(challenge, { x: +data.x, y: +data.y });
        }
      }

      try {
        await this.click(frame.locator('.button-submit'));
      } catch (e: any) {
        if (e.message.includes('viewport')) {
          await this.click(button);
        } else {
          throw e;
        }
      }
    }

    throw new Error('hCaptcha max attempts exceeded');
  }

  /**
   * Imitates Cloudflare Turnstile loading error. Unused right now, left for future
   */
  private async getTurnstile() {
    return this.client.post(
      `https://clerk.suno.com/v1/client?__clerk_api_version=2021-02-05&_clerk_js_version=${SunoApi.CLERK_VERSION}&_method=PATCH`,
      { captcha_error: '300030,300030,300030' },
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }

  /**
   * Generate a song based on the prompt.
   * @param prompt The text prompt to generate audio from.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @returns
   */
  public async generate(
    prompt: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const startTime = Date.now();
    const audios = await this.generateSongs(
      prompt,
      false,
      undefined,
      undefined,
      make_instrumental,
      model,
      wait_audio
    );
    const costTime = Date.now() - startTime;
    logger.info('Generate Response:\n' + JSON.stringify(audios, null, 2));
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  /**
   * Calls the concatenate endpoint for a clip to generate the whole song.
   * @param clip_id The ID of the audio clip to concatenate.
   * @returns A promise that resolves to an AudioInfo object representing the concatenated audio.
   * @throws Error if the response status is not 200.
   */
  public async concatenate(clip_id: string): Promise<AudioInfo> {
    await this.keepAlive(false);
    const payload: any = { clip_id: clip_id };

    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/concat/v2/`,
      payload,
      {
        timeout: 10000 // 10 seconds timeout
      }
    );
    if (response.status !== 200) {
      throw new Error('Error response:' + response.statusText);
    }
    return response.data;
  }

  /**
   * Generates custom audio based on provided parameters.
   *
   * @param prompt The text prompt to generate audio from.
   * @param tags Tags to categorize the generated audio.
   * @param title The title for the generated audio.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated audios.
   */
  public async custom_generate(
    prompt: string,
    tags: string,
    title: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();
    const audios = await this.generateSongs(
      prompt,
      true,
      tags,
      title,
      make_instrumental,
      model,
      wait_audio,
      negative_tags
    );
    const costTime = Date.now() - startTime;
    logger.info(
      'Custom Generate Response:\n' + JSON.stringify(audios, null, 2)
    );
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  /**
   * Generates songs based on the provided parameters.
   *
   * @param prompt The text prompt to generate songs from.
   * @param isCustom Indicates if the generation should consider custom parameters like tags and title.
   * @param tags Optional tags to categorize the song, used only if isCustom is true.
   * @param title Optional title for the song, used only if isCustom is true.
   * @param make_instrumental Indicates if the generated song should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @param task Optional indication of what to do. Enter 'extend' if extending an audio, otherwise specify null.
   * @param continue_clip_id 
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated songs.
   */
  private async generateSongs(
    prompt: string,
    isCustom: boolean,
    tags?: string,
    title?: string,
    make_instrumental?: boolean,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
    task?: string,
    continue_clip_id?: string,
    continue_at?: number,
    sound_loop?: boolean,
    sound_tempo?: number,
    sound_key?: string
  ): Promise<AudioInfo[]> {
    await this.keepAlive();
    const captchaToken = await this.getCaptcha();
    const payload: any = {
      token: captchaToken,
      generation_type: 'TEXT',
      mv: model || DEFAULT_MODEL,
      prompt: '',
      gpt_description_prompt: '',
      make_instrumental: make_instrumental ?? false,
      user_uploaded_images_b64: null,
      metadata: {
        web_client_pathname: '/create',
        is_max_mode: false,
        is_mumble: false,
        create_mode: isCustom ? 'custom' : 'simple',
        disable_volume_normalization: false,
        lyrics_model: 'default'
      },
      override_fields: [],
      cover_clip_id: null,
      cover_start_s: null,
      cover_end_s: null,
      persona_id: null,
      artist_clip_id: null,
      artist_start_s: null,
      artist_end_s: null,
      continue_clip_id: continue_clip_id ?? null,
      continued_aligned_prompt: null,
      continue_at: continue_at ?? null,
      task: task ?? null,
      transaction_uuid: randomUUID()
    };
    if (this.captchaTokenProvider)
      payload.token_provider = this.captchaTokenProvider;
    if (task === 'sound') {
      payload.metadata.sound_configs = { user_loop: sound_loop ?? false };
      if (sound_tempo !== undefined) {
        payload.metadata.sound_configs.user_tempo = sound_tempo;
      }
      if (sound_key !== undefined && sound_key !== '') {
        payload.metadata.sound_configs.user_key = sound_key;
      }
    }
    if (isCustom) {
      payload.tags = tags;
      payload.title = title;
      payload.negative_tags = negative_tags;
      payload.prompt = task === 'sound' ? '' : prompt;
      payload.gpt_description_prompt = '';
    } else {
      payload.gpt_description_prompt = prompt;
    }
    logger.info(
      'generateSongs payload:\n' +
        JSON.stringify(
          {
            prompt: prompt,
            isCustom: isCustom,
            tags: tags,
            title: title,
            make_instrumental: make_instrumental,
            wait_audio: wait_audio,
            negative_tags: negative_tags,
            payload: payload
          },
          null,
          2
        )
    );
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/v2-web/`,
      payload,
      {
        timeout: 10000 // 10 seconds timeout
      }
    );
    if (response.status !== 200) {
      throw new Error('Error response:' + response.statusText);
    }
    const songIds = response.data.clips.map((audio: any) => audio.id);
    //Want to wait for music file generation
    if (wait_audio) {
      const startTime = Date.now();
      let lastResponse: AudioInfo[] = [];
      await sleep(5, 5);
      while (Date.now() - startTime < 100000) {
        const response = await this.get(songIds);
        const allCompleted = response.every(
          (audio) => audio.status === 'streaming' || audio.status === 'complete'
        );
        const allError = response.every((audio) => audio.status === 'error');
        if (allCompleted || allError) {
          return response;
        }
        lastResponse = response;
        await sleep(3, 6);
        await this.keepAlive(true);
      }
      return lastResponse;
    } else {
      return response.data.clips.map((audio: any) => ({
        id: audio.id,
        title: audio.title,
        image_url: audio.image_url,
        lyric: audio.metadata.prompt,
        audio_url: audio.audio_url,
        video_url: audio.video_url,
        created_at: audio.created_at,
        model_name: audio.model_name,
        status: audio.status,
        gpt_description_prompt: audio.metadata.gpt_description_prompt,
        prompt: audio.metadata.prompt,
        type: audio.metadata.type,
        tags: audio.metadata.tags,
        negative_tags: audio.metadata.negative_tags,
        duration: audio.metadata.duration
      }));
    }
  }

  /**
   * Generates lyrics based on a given prompt.
   * @param prompt The prompt for generating lyrics.
   * @returns The generated lyrics text.
   */
  public async generateLyrics(prompt: string): Promise<string> {
    await this.keepAlive(false);
    // Initiate lyrics generation
    const generateResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/lyrics/`,
      { prompt }
    );
    const generateId = generateResponse.data.id;

    // Poll for lyrics completion
    let lyricsResponse = await this.client.get(
      `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
    );
    while (lyricsResponse?.data?.status !== 'complete') {
      await sleep(2); // Wait for 2 seconds before polling again
      lyricsResponse = await this.client.get(
        `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
      );
    }

    // Return the generated lyrics text
    return lyricsResponse.data;
  }

  /**
   * Extends an existing audio clip by generating additional content based on the provided prompt.
   *
   * @param audioId The ID of the audio clip to extend.
   * @param prompt The prompt for generating additional content.
   * @param continueAt Extend a new clip from a song at mm:ss(e.g. 00:30). Default extends from the end of the song.
   * @param tags Style of Music.
   * @param title Title of the song.
   * @returns A promise that resolves to an AudioInfo object representing the extended audio clip.
   */
  public async extendAudio(
    audioId: string,
    prompt: string = '',
    continueAt: number,
    tags: string = '',
    negative_tags: string = '',
    title: string = '',
    model?: string,
    wait_audio?: boolean
  ): Promise<AudioInfo[]> {
    return this.generateSongs(prompt, true, tags, title, false, model, wait_audio, negative_tags, 'extend', audioId, continueAt);
  }

  /**
   * Generate stems for a song.
   * @param song_id The ID of the song to generate stems for.
   * @returns A promise that resolves to an AudioInfo object representing the generated stems.
   */
  public async generateStems(song_id: string): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/edit/stems/${song_id}`, {}
    );

    console.log('generateStems response:\n', response?.data);
    return response.data.clips.map((clip: any) => ({
      id: clip.id,
      status: clip.status,
      created_at: clip.created_at,
      title: clip.title,
      stem_from_id: clip.metadata.stem_from_id,
      duration: clip.metadata.duration
    }));
  }


  /**
   * Generate a sound effect based on the prompt.
   * @param prompt The text prompt to generate the sound effect from.
   * @param loop Whether the generated sound should be a loop.
   * @param model The model to use for generation.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param tempo BPM of the generated sound effect.
   * @param key Musical key of the generated sound effect.
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated sound effects.
   */
  public async generateSound(
    prompt: string,
    loop: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    tempo?: number,
    key?: string
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();
    // Title is title-cased and truncated to ~100 chars to match official web behavior
    const title = prompt
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
      .slice(0, 100)
      .replace(/\s+$/, '');
    const audios = await this.generateSongs(
      prompt,
      true,
      prompt,
      title,
      true,
      model,
      wait_audio,
      undefined,
      'sound',
      undefined,
      undefined,
      loop,
      tempo,
      key
    );
    const costTime = Date.now() - startTime;
    logger.info('Generate Sound Response:\n' + JSON.stringify(audios, null, 2));
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  /**
   * Get the lyric alignment for a song.
   * @param song_id The ID of the song to get the lyric alignment for.
   * @returns A promise that resolves to an object containing the lyric alignment.
   */
  public async getLyricAlignment(song_id: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(`${SunoApi.BASE_URL}/api/gen/${song_id}/aligned_lyrics/v2/`);

    console.log(`getLyricAlignment ~ response:`, response.data);
    return response.data?.aligned_words.map((transcribedWord: any) => ({
      word: transcribedWord.word,
      start_s: transcribedWord.start_s,
      end_s: transcribedWord.end_s,
      success: transcribedWord.success,
      p_align: transcribedWord.p_align
    }));
  }

  /**
   * Processes the lyrics (prompt) from the audio metadata into a more readable format.
   * @param prompt The original lyrics text.
   * @returns The processed lyrics text.
   */
  private parseLyrics(prompt: string): string {
    // Assuming the original lyrics are separated by a specific delimiter (e.g., newline), we can convert it into a more readable format.
    // The implementation here can be adjusted according to the actual lyrics format.
    // For example, if the lyrics exist as continuous text, it might be necessary to split them based on specific markers (such as periods, commas, etc.).
    // The following implementation assumes that the lyrics are already separated by newlines.

    // Split the lyrics using newline and ensure to remove empty lines.
    const lines = prompt.split('\n').filter((line) => line.trim() !== '');

    // Reassemble the processed lyrics lines into a single string, separated by newlines between each line.
    // Additional formatting logic can be added here, such as adding specific markers or handling special lines.
    return lines.join('\n');
  }

  /**
   * Retrieves audio information for the given song IDs.
   * @param songIds An optional array of song IDs to retrieve information for.
   * @param page An optional page number to retrieve audio information from.
   * @returns A promise that resolves to an array of AudioInfo objects.
   */
  public async get(
    songIds?: string[],
    page?: string | null
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    let url = new URL(`${SunoApi.BASE_URL}/api/feed/v2`);
    if (songIds) {
      url.searchParams.append('ids', songIds.join(','));
    }
    if (page) {
      url.searchParams.append('page', page);
    }
    logger.info('Get audio status: ' + url.href);
    const response = await this.client.get(url.href, {
      // 10 seconds timeout
      timeout: 10000
    });

    const audios = response.data.clips;

    return audios.map((audio: any) => ({
      id: audio.id,
      title: audio.title,
      image_url: audio.image_url,
      lyric: audio.metadata.prompt
        ? this.parseLyrics(audio.metadata.prompt)
        : '',
      audio_url: audio.audio_url,
      video_url: audio.video_url,
      created_at: audio.created_at,
      model_name: audio.model_name,
      status: audio.status,
      gpt_description_prompt: audio.metadata.gpt_description_prompt,
      prompt: audio.metadata.prompt,
      type: audio.metadata.type,
      tags: audio.metadata.tags,
      duration: audio.metadata.duration,
      error_message: audio.metadata.error_message
    }));
  }

  /**
   * Retrieves information for a specific audio clip.
   * @param clipId The ID of the audio clip to retrieve information for.
   * @returns A promise that resolves to an object containing the audio clip information.
   */
  public async getClip(clipId: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/clip/${clipId}`
    );
    return response.data;
  }

  public async get_credits(): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/billing/info/`
    );
    return {
      credits_left: response.data.total_credits_left,
      period: response.data.period,
      monthly_limit: response.data.monthly_limit,
      monthly_usage: response.data.monthly_usage
    };
  }

  /**
   * Return a playable audio buffer for a completed clip.
   * Suno now redacts audio_url to /api/forbidden and serves DRM-wrapped media_urls.
   * Try the official download API first, then harvest a file from the Studio UI.
   */
  public async getPlayableAudio(clipId: string): Promise<{ buffer: Buffer; contentType: string }> {
    let pending = harvestLocks.get(clipId);
    if (!pending) {
      pending = (async () => {
        const cached = await this.readAudioCache(clipId);
        if (cached) return cached.buffer;
        return this.harvestPlayableAudio(clipId);
      })();
      harvestLocks.set(clipId, pending);
    }
    try {
      const buffer = await pending;
      return { buffer, contentType: this.sniffAudioType(buffer) };
    } finally {
      if (harvestLocks.get(clipId) === pending)
        harvestLocks.delete(clipId);
    }
  }

  /**
   * Capture the in-player preview (no Premier unlock / no download credit).
   * Hooks MSE appendBuffer while the Studio page plays the clip.
   */
  public async getPreviewAudio(clipId: string): Promise<{ buffer: Buffer; contentType: string }> {
    let pending = previewLocks.get(clipId);
    if (!pending) {
      pending = (async () => {
        const cached = await this.readPreviewCache(clipId);
        if (cached) return cached.buffer;
        return this.harvestPreviewAudio(clipId);
      })();
      previewLocks.set(clipId, pending);
    }
    try {
      const buffer = await pending;
      return { buffer, contentType: this.sniffAudioType(buffer) };
    } finally {
      if (previewLocks.get(clipId) === pending)
        previewLocks.delete(clipId);
    }
  }

  private sniffAudioType(buffer: Buffer): string {
    if (buffer.subarray(0, 3).toString() === 'ID3') return 'audio/mpeg';
    if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'audio/mpeg';
    if (buffer.subarray(0, 4).toString() === 'RIFF') return 'audio/wav';
    const head = buffer.subarray(0, 32);
    if (head.includes(Buffer.from('webm')) || head.includes(Buffer.from('Opus'))) return 'audio/webm';
    if (head.includes(Buffer.from('ftyp'))) return 'audio/mp4';
    return 'application/octet-stream';
  }

  private async readAudioCache(clipId: string): Promise<{ buffer: Buffer; contentType: string } | null> {
    try {
      const buffer = await fs.readFile(audioCachePath(clipId));
      if (!looksLikeAudio(buffer)) return null;
      return { buffer, contentType: this.sniffAudioType(buffer) };
    } catch {
      return null;
    }
  }

  private async writeAudioCache(clipId: string, buffer: Buffer): Promise<void> {
    await fs.mkdir(AUDIO_CACHE_DIR, { recursive: true });
    const dest = audioCachePath(clipId);
    const tmp = dest + '.tmp';
    await fs.writeFile(tmp, buffer);
    await fs.rename(tmp, dest);
  }

  private async readPreviewCache(clipId: string): Promise<{ buffer: Buffer; contentType: string } | null> {
    try {
      const buffer = await fs.readFile(previewCachePath(clipId));
      if (!looksLikeAudio(buffer)) return null;
      return { buffer, contentType: this.sniffAudioType(buffer) };
    } catch {
      return null;
    }
  }

  private async writePreviewCache(clipId: string, buffer: Buffer): Promise<void> {
    await fs.mkdir(PREVIEW_CACHE_DIR, { recursive: true });
    const dest = previewCachePath(clipId);
    const tmp = dest + '.tmp';
    await fs.writeFile(tmp, buffer);
    await fs.rename(tmp, dest);
  }

  private async harvestPreviewAudio(clipId: string): Promise<Buffer> {
    let clipStatus: string | undefined;
    let durationSec: number | undefined;
    try {
      const clips = await this.get([clipId]);
      clipStatus = clips[0]?.status;
      const rawDuration = Number(clips[0]?.duration);
      if (Number.isFinite(rawDuration) && rawDuration > 0)
        durationSec = rawDuration;
    } catch (err: any) {
      throw new ClipAudioNotReadyError('Clip status unavailable');
    }
    if (clipStatus !== 'complete' && clipStatus !== 'streaming')
      throw new ClipAudioNotReadyError('Clip is not ready for preview');
    logger.info('Capturing in-player preview (no unlock): ' + clipId);
    const previous = globalForHarvest.sunoPlaywrightHarvest || Promise.resolve();
    let release!: () => void;
    globalForHarvest.sunoPlaywrightHarvest = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try {
      const harvested = await this.capturePreviewViaBrowser(
        clipId,
        durationSec
      );
      if (clipStatus === 'complete')
        await this.writePreviewCache(clipId, harvested);
      return harvested;
    } finally {
      release();
    }
  }

  private async capturePreviewViaBrowser(clipId: string, clipDurationSec?: number): Promise<Buffer> {
    const { browser, context } = await this.launchBrowser();
    try {
      await context.addInitScript(() => {
        (window as any).__sunoMse = { chunks: [] as number[][], bytes: 0, hooked: false };
        const hook = () => {
          const store = (window as any).__sunoMse;
          if (!store || store.hooked || !(window as any).MediaSource) return;
          store.hooked = true;
          const origAdd = MediaSource.prototype.addSourceBuffer;
          MediaSource.prototype.addSourceBuffer = function (mime: string) {
            const sb = origAdd.call(this, mime);
            if (!/audio/i.test(mime || '')) return sb;
            const origAppend = sb.appendBuffer;
            sb.appendBuffer = function (data: BufferSource) {
              try {
                const src = data instanceof ArrayBuffer
                  ? new Uint8Array(data)
                  : new Uint8Array((data as Uint8Array).buffer, (data as Uint8Array).byteOffset, (data as Uint8Array).byteLength);
                store.chunks.push(Array.from(src));
                store.bytes += src.length;
              } catch {
                // ignore copy failures; still append
              }
              return origAppend.call(this, data);
            };
            return sb;
          };
        };
        hook();
        document.addEventListener('DOMContentLoaded', hook);
      });
      const page = await context.newPage();
      await page.goto(`https://suno.com/song/${clipId}`, {
        referer: 'https://suno.com/',
        waitUntil: 'domcontentloaded',
        timeout: 20000
      });
      await this.dismissOverlays(page);
      await page.getByRole('button', { name: 'Edit', exact: true }).waitFor({ timeout: 20000 }).catch(() => {});
      await this.dismissOverlays(page);

      const startedPlayback = await page.evaluate(async () => {
        const media = [...document.querySelectorAll('audio, video')] as HTMLMediaElement[];
        for (const a of media) {
          try { await a.play(); } catch { /* autoplay may be blocked until a gesture */ }
        }
        return media.some((a) => !a.paused);
      }).catch(() => false);
      if (!startedPlayback) {
        await page.getByRole('button', { name: /play/i }).first().click({ timeout: 5000 }).catch(() => {});
        await page.keyboard.press('Space').catch(() => {});
      }

      const targetSec = Math.min(clipDurationSec && clipDurationSec > 0 ? clipDurationSec : 20, 20);
      const deadline = Date.now() + Math.min(90000, targetSec * 1000 + 15000);
      let playback: { t: number; d: number; ended: boolean; paused: boolean; bytes: number } | null = null;
      while (Date.now() < deadline) {
        playback = await page.evaluate(() => {
          const store = (window as any).__sunoMse;
          const media = [...document.querySelectorAll('audio, video')] as HTMLMediaElement[];
          const a = media.find((el) => el.currentTime > 0 || !el.paused) || media[0];
          return {
            t: a ? a.currentTime : 0,
            d: a && Number.isFinite(a.duration) ? a.duration : 0,
            ended: !!(a && a.ended),
            paused: !a || a.paused,
            bytes: store?.bytes || 0
          };
        }).catch(() => null);
        if (playback && playback.t > 0.2 && playback.paused)
          await page.evaluate(async () => {
            for (const a of document.querySelectorAll('audio, video') as NodeListOf<HTMLMediaElement>) {
              try { await a.play(); } catch {}
            }
          }).catch(() => {});
        if (playback && playback.bytes > 3000 && (playback.ended || playback.t >= targetSec * 0.9))
          break;
        await waitMs(500);
      }
      if (!playback || playback.t < 0.2 || playback.bytes < 3000)
        throw new Error('Preview playback never started or captured too little audio');
      if (!playback.ended && playback.t < targetSec * 0.9)
        throw new Error('Preview capture stopped before end of listen window');

      const packed = await page.evaluate(() => {
        const store = (window as any).__sunoMse || { chunks: [] as number[][] };
        const chunks: number[][] = store.chunks || [];
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) {
          out.set(c, o);
          o += c.length;
        }
        let bin = '';
        for (let i = 0; i < out.length; i += 0x8000)
          bin += String.fromCharCode.apply(null, Array.from(out.subarray(i, i + 0x8000)));
        return { total, b64: btoa(bin) };
      });
      const buffer = Buffer.from(packed.b64, 'base64');
      if (!looksLikeAudio(buffer))
        throw new Error('Preview capture did not produce playable audio');
      return buffer;
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  private async harvestPlayableAudio(clipId: string): Promise<Buffer> {
    let clipStatus: string | undefined;
    try {
      const clips = await this.get([clipId]);
      clipStatus = clips[0]?.status;
    } catch (err: any) {
      throw new ClipAudioNotReadyError('Clip status unavailable');
    }
    if (clipStatus !== 'complete')
      throw new ClipAudioNotReadyError('Clip is not ready for download');

    const official = await this.downloadClipOfficial(clipId);
    if (official) {
      await this.writeAudioCache(clipId, official);
      return official;
    }

    logger.info('Official clip download unavailable, harvesting via Playwright: ' + clipId);
    const previous = globalForHarvest.sunoPlaywrightHarvest || Promise.resolve();
    let release!: () => void;
    globalForHarvest.sunoPlaywrightHarvest = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try {
      const harvested = await this.downloadClipViaBrowser(clipId);
      await this.writeAudioCache(clipId, harvested);
      return harvested;
    } finally {
      release();
    }
  }

  private async downloadClipOfficial(clipId: string): Promise<Buffer | null> {
    try {
      await this.keepAlive(false);
      const webHeaders = {
        'x-suno-client': 'suno-web',
        Origin: 'https://suno.com',
        Referer: 'https://suno.com/'
      };
      const pollDownload = async (): Promise<{ data: any } | null> => {
        const started = Date.now();
        while (Date.now() - started < 15000) {
          const resp = await this.client.get(`${SunoApi.BASE_URL}/api/download/clip/${clipId}`, {
            params: { format: 'mp3' },
            timeout: 15000,
            validateStatus: () => true,
            headers: webHeaders
          });
          const data = resp.data || {};
          if (data.download_url) return { data };
          if (data.status === 'processing' || data.reason === 'rate_limited') {
            await waitMs(2000);
            continue;
          }
          return { data };
        }
        return null;
      };

      const first = await pollDownload();
      if (first?.data?.download_url) {
        const buffer = await fetchBare(first.data.download_url);
        if (looksLikeAudio(buffer)) return buffer;
        logger.info('Official download_url was not playable audio');
        return null;
      }

      if (!first)
        return null;
      const needsAuth = first.data?.reason === 'not_authorized';
      if (!needsAuth) {
        logger.info(
          'Official download skipped: ' +
            JSON.stringify({ ok: first.data?.ok, reason: first.data?.reason, status: first.data?.status })
        );
        return null;
      }

      const auth = await this.client.post(
        `${SunoApi.BASE_URL}/api/download/authorize`,
        { item_id: clipId, item_type: 'clip' },
        { timeout: 15000, validateStatus: () => true, headers: webHeaders }
      );
      logger.info(
        'Download authorize: ' +
          JSON.stringify({
            status: auth.status,
            ok: auth.data?.ok,
            already_unlocked: auth.data?.already_unlocked,
            credit_deducted: auth.data?.credit_deducted,
            reason: auth.data?.reason
          })
      );
      if (auth.status >= 400 || auth.data?.ok !== true)
        return null;

      const second = await pollDownload();
      if (second?.data?.download_url) {
        const buffer = await fetchBare(second.data.download_url);
        if (looksLikeAudio(buffer)) return buffer;
        logger.info('Official download_url was not playable audio');
      } else {
        logger.info(
          'Official download skipped: ' +
            JSON.stringify({ ok: second?.data?.ok, reason: second?.data?.reason, status: second?.data?.status })
        );
      }
      return null;
    } catch (err: any) {
      logger.info('Official download failed: ' + err?.message);
      return null;
    }
  }

  private async downloadClipViaBrowser(clipId: string): Promise<Buffer> {
    const { browser, context } = await this.launchBrowser();
    let closed = false;
    try {
      const page = await context.newPage();
      const harvested: { signedUrl?: string; download?: { saveAs: (dest: string) => Promise<void> } } = {};
      const onResponse = async (res: { url: () => string; json: () => Promise<any> }) => {
        if (closed) return;
        try {
          const url = res.url();
          if (!url.includes('/api/download/clip') || url.includes('/cover')) return;
          const data = await res.json();
          if (closed) return;
          if (data && typeof data.download_url === 'string')
            harvested.signedUrl = data.download_url;
        } catch {
          // ignore non-JSON download responses
        }
      };
      page.on('response', onResponse);
      page.on('download', (d: any) => { harvested.download = d; });
      await page.goto(`https://suno.com/song/${clipId}`, {
        referer: 'https://suno.com/',
        waitUntil: 'domcontentloaded',
        timeout: 20000
      });
      await this.dismissOverlays(page);
      const more = page.getByRole('button', { name: 'More menu contents' });
      await more.first().waitFor({ timeout: 15000 });
      await this.dismissOverlays(page);
      const editBox = await page.getByRole('button', { name: 'Edit', exact: true }).boundingBox().catch(() => null);
      const n = await more.count();
      let idx = 0;
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < n; i++) {
        const box = await more.nth(i).boundingBox();
        if (!box || box.y < 80) continue;
        const dist = editBox
          ? Math.abs(box.y - editBox.y) + Math.abs(box.x - editBox.x)
          : box.y;
        if (dist < best) {
          best = dist;
          idx = i;
        }
      }
      await more.nth(idx).click();
      const downloadItem = page.getByRole('menuitem', { name: 'Download' })
        .or(page.getByText('Download', { exact: true }))
        .last();
      await downloadItem.waitFor({ timeout: 8000 });
      await downloadItem.hover().catch(() => {});
      await downloadItem.click();
      const mp3 = page.getByText('MP3 Audio', { exact: true });
      try {
        await mp3.waitFor({ timeout: 8000 });
        await waitMs(2000);
        await mp3.click({ timeout: 5000 });
      } catch {
        logger.info('MP3 Audio flyout not shown; waiting for download or signed URL');
      }

      const started = Date.now();
      while (Date.now() - started < 20000) {
        if (harvested.download) {
          const dest = audioCachePath(clipId + '.part');
          await fs.mkdir(AUDIO_CACHE_DIR, { recursive: true });
          await harvested.download.saveAs(dest);
          const buffer = await fs.readFile(dest);
          await fs.unlink(dest).catch(() => {});
          harvested.download = undefined;
          if (looksLikeAudio(buffer)) return buffer;
          logger.info('Browser download was not playable audio, continuing');
        }
        if (harvested.signedUrl) {
          const url = harvested.signedUrl;
          harvested.signedUrl = undefined;
          try {
            const buffer = await fetchBare(url);
            if (looksLikeAudio(buffer)) return buffer;
          } catch (err: any) {
            logger.info('Signed URL fetch failed: ' + err?.message);
          }
        }
        await waitMs(1000);
      }
      throw new Error('Playwright harvest did not receive a playable audio file');
    } finally {
      closed = true;
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  public async getPersonaPaginated(personaId: string, page: number = 1): Promise<PersonaResponse> {
    await this.keepAlive(false);
    
    const url = `${SunoApi.BASE_URL}/api/persona/get-persona-paginated/${personaId}/?page=${page}`;
    
    logger.info(`Fetching persona data: ${url}`);
    
    const response = await this.client.get(url, {
      timeout: 10000 // 10 seconds timeout
    });

    if (response.status !== 200) {
      throw new Error('Error response: ' + response.statusText);
    }

    return response.data;
  }
}

export const sunoApi = async (cookie?: string) => {
  const resolvedCookie = cookie && cookie.includes('__client') ? cookie : process.env.SUNO_COOKIE; // Check for bad `Cookie` header (It's too expensive to actually parse the cookies *here*)
  if (!resolvedCookie) {
    logger.info('No cookie provided! Aborting...\nPlease provide a cookie either in the .env file or in the Cookie header of your request.')
    throw new Error('Please provide a cookie either in the .env file or in the Cookie header of your request.');
  }

  // Check if the instance for this cookie already exists in the cache
  const cachedInstance = cache.get(resolvedCookie);
  if (cachedInstance)
    return cachedInstance;

  // If not, create a new instance and initialize it
  const instance = await new SunoApi(resolvedCookie).init();
  // Cache the initialized instance
  cache.set(resolvedCookie, instance);

  return instance;
};