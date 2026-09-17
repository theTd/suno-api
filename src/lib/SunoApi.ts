import axios, { AxiosInstance } from 'axios';
import pino from 'pino';
import yn from 'yn';
import { isPage, sleep, waitForRequests } from '@/lib/utils';
import { CaptchaGate, ClientGoneError } from '@/lib/captcha-gate';
import { PAGE_FETCH_DEFAULT_TIMEOUT_MS, SunoBrowserSession } from '@/lib/suno-browser-session';
import {
  applyChromiumUserAgentOverride,
  applyStealthInit,
  buildChromeMacFingerprint,
  captchaWorkerLang,
  contextOptionsFromFingerprint,
  envInt,
  fingerprintHttpHeaders,
  stealthInitPayload,
  type ChromeMacFingerprint
} from '@/lib/suno-browser-fingerprint';
import * as cookie from 'cookie';
import { randomUUID } from 'node:crypto';
import { Solver } from '@2captcha/captcha-solver';
import { paramsCoordinates } from '@2captcha/captcha-solver/dist/structs/2captcha';
import { Browser, BrowserContext, Page, Locator, chromium, firefox } from 'rebrowser-playwright-core';
import { createCursor, Cursor } from 'ghost-cursor-playwright';
import { promises as fs } from 'fs';
import { Readable } from 'stream';
import path from 'node:path';
import os from 'node:os';
import { emitPreviewLiveEvent } from '@/lib/preview-live/preview-live-events';

// sunoApi instance caching
const globalForSunoApi = global as unknown as { sunoApiCache?: Map<string, SunoApi> };
const cache = globalForSunoApi.sunoApiCache || new Map<string, SunoApi>();
globalForSunoApi.sunoApiCache = cache;

const logger = pino();
export const DEFAULT_MODEL = 'chirp-hawk';
const AUDIO_CACHE_DIR = path.join(os.tmpdir(), 'suno-audio-cache');
const PREVIEW_CACHE_DIR = path.join(os.tmpdir(), 'suno-preview-cache');
// How long a background preview job waits for the clip to become ready.
const PREVIEW_READY_TIMEOUT_MS = 10 * 60 * 1000;
// Hard cap for a single in-browser capture (full-song playback + slack).
const PREVIEW_CAPTURE_MAX_MS = 12 * 60 * 1000;
// Keep a failed job visible to status pollers before allowing a retry.
const PREVIEW_ERROR_TTL_MS = 30 * 1000;
// Keep a successfully captured preview in memory so reconnecting stream
// clients replay it instead of re-running a full browser capture. Only
// 'complete' clips are written to the on-disk cache; 'streaming' clips live
// here for this TTL instead.
const PREVIEW_RESULT_TTL_MS = 10 * 60 * 1000;
/** Reuse a Clerk JWT until this close to expiry instead of POSTing tokens every call. */
const KEEPALIVE_RENEW_SKEW_MS = 15 * 1000;
/** Feed listing (`get()` without ids): short TTL coalesces HTTP / MCP callers. The preview-live watch uses `{ fresh: true }`. */
const FEED_LIST_TTL_MS = 10 * 1000;

export type PreviewJobPhase = 'waiting_clip' | 'queued' | 'capturing' | 'error';

export interface PreviewJobSnapshot {
  state: PreviewJobPhase;
  /** 1-based position in the browser-harvest wait list; 0 when not queued. */
  queuePosition: number;
  /** 0-100 while capturing; null otherwise. */
  progressPercent: number | null;
  currentSec: number;
  durationSec: number;
  bytes: number;
  error: string | null;
}

interface PreviewJob {
  promise: Promise<Buffer>;
  phase: PreviewJobPhase;
  error?: string;
  currentSec: number;
  durationSec: number;
  bytes: number;
  /**
   * Every chunk captured so far, in append order. Index IS the sequence
   * number handed to chunk subscribers, so late joiners can replay the
   * prefix (including the container init segment) before joining the live
   * tail. Bounded by one song (~10-20MB) per active job.
   */
  chunkLog: Buffer[];
  /** Progressive-capture subscribers (protocol-layer streaming). */
  chunkSubs?: Set<(chunk: Buffer, seq: number) => void>;
  endSubs?: Set<() => void>;
  errSubs?: Set<(err: Error) => void>;
}

const globalForHarvest = global as unknown as {
  sunoAudioHarvest?: Map<string, Promise<Buffer>>;
  sunoPreviewJobs?: Map<string, PreviewJob>;
  sunoPreviewResults?: Map<string, { buffer: Buffer; expiresAt: number }>;
  sunoPlaywrightHarvest?: Promise<unknown>;
  sunoHarvestWaitList?: string[];
  sunoPreviewCacheIndex?: Set<string>;
  sunoPreviewCacheIndexLoaded?: boolean;
  sunoPreviewCacheIndexPromise?: Promise<void>;
};
const harvestLocks = globalForHarvest.sunoAudioHarvest || new Map<string, Promise<Buffer>>();
globalForHarvest.sunoAudioHarvest = harvestLocks;
const previewJobs = globalForHarvest.sunoPreviewJobs || new Map<string, PreviewJob>();
globalForHarvest.sunoPreviewJobs = previewJobs;
const previewResults = globalForHarvest.sunoPreviewResults || new Map<string, { buffer: Buffer; expiresAt: number }>();
globalForHarvest.sunoPreviewResults = previewResults;
if (!globalForHarvest.sunoPlaywrightHarvest)
  globalForHarvest.sunoPlaywrightHarvest = Promise.resolve();
const previewCacheIndex = globalForHarvest.sunoPreviewCacheIndex || new Set<string>();
globalForHarvest.sunoPreviewCacheIndex = previewCacheIndex;

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

/**
 * Browser-side drain of audio chunks captured by the MSE appendBuffer hook.
 * Splices new chunks out of the store (store.bytes stays cumulative) and packs
 * them as base64. Runs inside page.evaluate — must stay closure-free.
 */
function drainMseChunkPayload(): { total: number; b64: string } | null {
  const store = (window as any).__sunoMse;
  const chunks: number[][] = store?.chunks;
  if (!chunks || chunks.length === 0) return null;
  const taken = chunks.splice(0, chunks.length);
  const total = taken.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of taken) {
    out.set(c, o);
    o += c.length;
  }
  let bin = '';
  for (let i = 0; i < out.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, Array.from(out.subarray(i, i + 0x8000)));
  return { total, b64: btoa(bin) };
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

/**
 * Optional generation tuning knobs exposed by the official Suno web client
 * (measured from the /create UI). All fields are optional; when absent the
 * payload matches the official defaults.
 */
export interface GenerationExtras {
  /** Weirdness slider, UI scale 0-100 (default 50). Sent as weirdness_constraint 0.0-1.0;
   * omitted from the payload when it equals the default 50. */
  weirdness?: number;
  /** Style Influence slider, UI scale 0-100 (default 50). Sent as style_weight 0.0-1.0;
   * omitted when it equals the default 50. */
  style_influence?: number;
  /** Variety slider, integer 0-4 (default 1). Sent as aug_creativity; always present. */
  variety?: number;
  /** Fixed song length in seconds, 10-360. Omit for the model default length. */
  duration?: number;
  /** Vocal gender constraint. Omit to let the model decide. */
  vocal_gender?: 'm' | 'f';
  /** Max mode toggle (Pro feature on the official client). */
  is_max_mode?: boolean;
  /** Personalize with "My Taste". Only sent when enabled. */
  use_personalization?: boolean;
}

/** Throws a descriptive Error when any GenerationExtras field is out of range. */
export function validateGenerationExtras(extras: GenerationExtras): void {
  const checkNumber = (name: string, value: number | undefined, min: number, max: number) => {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
      throw new Error(`${name} must be a number between ${min} and ${max}`);
  };
  checkNumber('weirdness', extras.weirdness, 0, 100);
  checkNumber('style_influence', extras.style_influence, 0, 100);
  if (extras.variety !== undefined && (!Number.isInteger(extras.variety) || extras.variety < 0 || extras.variety > 4))
    throw new Error('variety must be an integer between 0 and 4');
  if (extras.duration !== undefined && (!Number.isInteger(extras.duration) || extras.duration < 10 || extras.duration > 360))
    throw new Error('duration must be an integer between 10 and 360');
  if (extras.vocal_gender !== undefined && extras.vocal_gender !== 'm' && extras.vocal_gender !== 'f')
    throw new Error("vocal_gender must be 'm' or 'f'");
}

/** Internal options for one generate/v2-web call. */
export interface GenerateSongsOptions {
  prompt: string;
  isCustom: boolean;
  tags?: string;
  title?: string;
  make_instrumental?: boolean;
  model?: string;
  wait_audio?: boolean;
  negative_tags?: string;
  task?: string;
  continue_clip_id?: string;
  continue_at?: number;
  sound_loop?: boolean;
  sound_tempo?: number;
  sound_key?: string;
  extras?: GenerationExtras;
  signal?: AbortSignal;
}

/** Context values resolved by the SunoApi instance at request time. */
export interface GeneratePayloadContext {
  captchaToken: string | null;
  captchaTokenProvider?: string | number;
  /** plan id from the Clerk session JWT (without the ':interval' suffix). */
  userTier?: string;
  /** Stable per-instance UUID mimicking the web client's create_session_token. */
  createSessionToken: string;
  /** Reuse the browser generate request's transaction id when a captcha token was minted against it. */
  transactionUuid?: string;
}

/**
 * Extracts the plan id (user_tier) from a Clerk session JWT's `plan` claim.
 * Returns undefined when the token is missing or undecodable.
 */
function decodeJwtPayload(token?: string): Record<string, unknown> | undefined {
  if (!token) return undefined;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return undefined;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

export function extractUserTierFromJwt(token?: string): string | undefined {
  const payload = decodeJwtPayload(token);
  const plan = payload?.plan;
  if (typeof plan !== 'string' || plan.length === 0) return undefined;
  return plan.split(':')[0];
}

/** Remaining JWT lifetime in ms; undefined if `exp` is missing. */
function jwtRemainingMs(token?: string): number | undefined {
  const exp = decodeJwtPayload(token)?.exp;
  if (typeof exp !== 'number') return undefined;
  return exp * 1000 - Date.now();
}

/**
 * Builds the official POST /api/generate/v2-web/ request body.
 * Pure function; every rule here was measured from the Suno web client.
 */
export function buildGenerateV2Payload(options: GenerateSongsOptions, ctx: GeneratePayloadContext): any {
  const extras = options.extras || {};
  validateGenerationExtras(extras);

  const isSound = options.task === 'sound';
  const controlSliders: Record<string, number> = {
    aug_creativity: extras.variety ?? 1
  };
  if (extras.weirdness !== undefined && extras.weirdness !== 50)
    controlSliders.weirdness_constraint = extras.weirdness / 100;
  if (extras.style_influence !== undefined && extras.style_influence !== 50)
    controlSliders.style_weight = extras.style_influence / 100;

  const payload: any = {
    token: ctx.captchaToken ?? null,
    generation_type: 'TEXT',
    mv: options.model || DEFAULT_MODEL,
    prompt: '',
    gpt_description_prompt: '',
    make_instrumental: options.make_instrumental ?? false,
    user_uploaded_images_b64: null,
    metadata: {
      web_client_pathname: '/create',
      create_surface: 'desktop_create_form',
      is_max_mode: extras.is_max_mode ?? false,
      is_mumble: false,
      create_mode: options.isCustom ? 'custom' : 'simple',
      disable_volume_normalization: false,
      control_sliders: controlSliders,
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
    continue_clip_id: options.continue_clip_id ?? null,
    continued_aligned_prompt: null,
    continue_at: options.continue_at ?? null,
    transaction_uuid: ctx.transactionUuid || randomUUID(),
    token_provider: ctx.captchaTokenProvider ?? null
  };
  // The official client only sends `task` for non-custom generations.
  if (options.task)
    payload.task = options.task;
  if (ctx.userTier)
    payload.metadata.user_tier = ctx.userTier;
  payload.metadata.create_session_token = ctx.createSessionToken;
  if (extras.duration !== undefined)
    payload.duration = Math.round(extras.duration);
  if (extras.vocal_gender)
    payload.metadata.vocal_gender = extras.vocal_gender;
  if (extras.use_personalization)
    payload.use_personalization = true;
  if (isSound) {
    payload.metadata.sound_configs = { user_loop: options.sound_loop ?? false };
    if (options.sound_tempo !== undefined)
      payload.metadata.sound_configs.user_tempo = options.sound_tempo;
    if (options.sound_key)
      payload.metadata.sound_configs.user_key = options.sound_key;
  }
  if (options.isCustom) {
    payload.tags = options.tags;
    payload.title = options.title;
    payload.negative_tags = options.negative_tags ?? '';
    payload.prompt = isSound ? '' : options.prompt;
    payload.gpt_description_prompt = '';
  } else {
    payload.gpt_description_prompt = options.prompt;
  }
  return payload;
}

/**
 * Overlay captcha-bound fields from the browser's intercepted generate POST
 * onto a freshly built v2-web payload. The widget token is minted against
 * that browser request's session/transaction, not a later Node axios replay.
 */
export function bindCaptchaGeneratePayload(payload: any, intercepted: any): any {
  if (!payload || typeof payload !== 'object')
    return payload;
  const next = {
    ...payload,
    metadata: { ...(payload.metadata || {}) }
  };
  if (intercepted?.token)
    next.token = intercepted.token;
  if (intercepted?.token_provider != null)
    next.token_provider = intercepted.token_provider;
  if (typeof intercepted?.transaction_uuid === 'string' && intercepted.transaction_uuid)
    next.transaction_uuid = intercepted.transaction_uuid;
  const sessionToken = intercepted?.metadata?.create_session_token;
  if (typeof sessionToken === 'string' && sessionToken)
    next.metadata.create_session_token = sessionToken;
  return next;
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
  private captchaTokenProvider?: string | number;
  private createSessionToken?: string;
  private captchaTransactionUuid?: string;
  private captchaBrowserClips?: any[];
  private captchaBrowserError?: string;
  private deviceId?: string;
  private userAgent?: string;
  private cookies: Record<string, string | undefined>;
  private solver = new Solver(process.env.TWOCAPTCHA_KEY + '');
  private captchaGate = new CaptchaGate();
  private browserSession: SunoBrowserSession;
  private generatePageInflight?: Promise<Page>;
  private captchaRouteEpoch = 0;
  private generateRoutePages = new WeakSet<Page>();
  private activeCaptchaSolve: {
    page: Page;
    submitOptions?: GenerateSongsOptions;
    tokenSettled: boolean;
    capturedToken?: string;
    resolveToken: (token: string) => void;
  } | null = null;
  private fingerprint: ChromeMacFingerprint = buildChromeMacFingerprint();
  private browserSessionStartedAt = 0;
  private captchaSolveCount = 0;
  private ghostCursorEnabled = yn(process.env.BROWSER_GHOST_CURSOR, { default: false });
  private cursor?: Cursor;
  private feedListCache?: { key: string; at: number; data: AudioInfo[] };
  private feedListEpoch = 0;
  private feedInflight = new Map<string, Promise<AudioInfo[]>>();
  private readonly cookieKey: string;

  /** Drop cached feed pages so the next list poll hits Suno after a create. */
  private invalidateFeedListCache() {
    this.feedListCache = undefined;
    this.feedListEpoch++;
    for (const key of [...this.feedInflight.keys()]) {
      // list keys are `${page}\0` with empty ids
      if (key.endsWith('\0')) this.feedInflight.delete(key);
    }
    emitPreviewLiveEvent({ type: 'feed-invalidated', cookieKey: this.cookieKey });
  }

  public getCookieKey(): string {
    return this.cookieKey;
  }

  constructor(cookies: string) {
    this.cookieKey = cookies;
    this.userAgent = this.fingerprint.userAgent;
    this.cookies = cookie.parse(cookies);
    this.deviceId = this.cookies.ajs_anonymous_id || randomUUID();
    this.client = axios.create({
      withCredentials: true,
      headers: {
        'Affiliate-Id': 'undefined',
        'Device-Id': `"${this.deviceId}"`,
        'x-suno-client': 'suno-web',
        ...fingerprintHttpHeaders(this.fingerprint)
      }
    });
    this.client.interceptors.request.use(config => {
      if (this.currentToken && !config.headers.Authorization)
        config.headers.Authorization = `Bearer ${this.currentToken}`;
      Object.assign(config.headers, fingerprintHttpHeaders(this.fingerprint));
      config.headers['x-suno-client'] = 'suno-web';
      const cookiesArray = Object.entries(this.cookies).map(([key, value]) => 
        cookie.serialize(key, value as string)
      );
      config.headers.Cookie = cookiesArray.join('; ');
      return config;
    });
    this.client.interceptors.response.use(resp => {
      const setCookieHeader = resp.headers['set-cookie'];
      if (Array.isArray(setCookieHeader)) {
        for (const header of setCookieHeader) {
          const pair = String(header).split(';')[0];
          if (!pair)
            continue;
          const parsed = cookie.parse(pair);
          for (const [key, value] of Object.entries(parsed)) {
            if (value !== undefined)
              this.cookies[key] = value;
          }
        }
      }
      return resp;
    });
    this.browserSession = new SunoBrowserSession({
      launch: () => this.launchBrowser(),
      dispose: (browser, context) => this.disposeBrowser(browser, context)
    });
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
  /**
   * @param isWait Sleep after renew (legacy generate wait_audio pacing).
   * @param reuseIfFresh When true, skip the Clerk POST if the current JWT
   *   still has more than KEEPALIVE_RENEW_SKEW_MS left. Only the feed-list
   *   poller should pass this; generate/captcha must always renew.
   */
  public async keepAlive(isWait?: boolean, reuseIfFresh?: boolean): Promise<void> {
    if (!this.sid) {
      throw new Error('Session ID is not set. Cannot renew token.');
    }
    if (reuseIfFresh) {
      const remaining = jwtRemainingMs(this.currentToken);
      if (remaining !== undefined && remaining > KEEPALIVE_RENEW_SKEW_MS) {
        return;
      }
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

  private async captchaRequired(signal?: AbortSignal): Promise<boolean> {
    try {
      return await this.captchaCheckOnce(signal);
    } catch (err: any) {
      if (signal?.aborted || err instanceof ClientGoneError)
        throw new ClientGoneError();
      logger.warn('CAPTCHA check via Chromium session failed: ' + err.message);
      if (!this.browserSession.isAlive())
        await this.browserSession.invalidate();
      return await this.captchaCheckOnce(signal);
    }
  }

  private async captchaCheckOnce(signal?: AbortSignal): Promise<boolean> {
    await this.ensureGeneratePage(signal);
    const resp = await this.browserSession.withRead(async () => {
      return this.browserSession.pageFetch(`${SunoApi.BASE_URL}/api/c/check`, {
        method: 'POST',
        headers: await this.browserGenerateHeaders(true),
        body: JSON.stringify({ ctype: 'generation' }),
        timeoutMs: PAGE_FETCH_DEFAULT_TIMEOUT_MS,
        signal,
        locked: true
      });
    });
    logger.info(resp.json ?? { status: resp.status, snippet: resp.text.slice(0, 200) });
    if (!resp.ok)
      throw new Error('captcha check HTTP ' + resp.status);
    if (!resp.json || typeof resp.json.required !== 'boolean')
      throw new Error('captcha check returned no required field');
    return resp.json.required;
  }

  private async browserGenerateHeaders(locked = false): Promise<Record<string, string>> {
    const token = await this.browserSession.getClerkToken(locked);
    if (token)
      this.currentToken = token;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-suno-client': 'suno-web'
    };
    if (token)
      headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  private async syncAuthFromBrowser(): Promise<void> {
    const token = await this.browserSession.getClerkToken().catch(() => undefined);
    if (token)
      this.currentToken = token;
    const cookies = await this.browserSession.readCookies().catch(() => []);
    for (const item of cookies) {
      if (item.name && item.value)
        this.cookies[item.name] = item.value;
    }
  }

  private async ensureGeneratePage(signal?: AbortSignal): Promise<Page> {
    if (signal?.aborted)
      throw new ClientGoneError();
    if (!this.generatePageInflight)
      this.generatePageInflight = this.ensureGeneratePageUnqueued();
    const run = this.generatePageInflight;
    try {
      const page = await run;
      if (signal?.aborted)
        throw new ClientGoneError();
      return page;
    } finally {
      if (this.generatePageInflight === run)
        this.generatePageInflight = undefined;
    }
  }

  private async ensureGeneratePageUnqueued(): Promise<Page> {
    const { page, reused, newBrowser } = await this.browserSession.ensurePage(async (next) => {
      await applyChromiumUserAgentOverride(next, this.fingerprint);
      await this.installTurnstileHook(next);
      await this.ensureGenerateRoute(next);
    });
    if (newBrowser) {
      this.browserSessionStartedAt = Date.now();
      this.captchaSolveCount = 0;
      logger.info('Launching browser... (new session)');
    }
    else if (!reused)
      logger.info('Chromium session: new page on existing browser');
    else
      logger.info('Reusing Chromium session');

    await this.ensureGenerateRoute(page);

    if (this.ghostCursorEnabled && !reused)
      this.cursor = await createCursor(page);

    await this.browserSession.withWrite(async () => {
      if (reused)
        await this.ensureOnCreatePage(page, false);
      else
        await this.warmCreatePage(page);
    });
    return page;
  }

  private async warmCreatePage(page: Page): Promise<void> {
    await page.goto('https://suno.com/create', {
      referer: 'https://www.google.com/',
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    logger.info('Waiting for Suno interface to load');
    try {
      await page.waitForResponse('**/api/billing/usage-plan-descriptions/**', { timeout: 30000 });
    } catch {
      // some accounts never hit this endpoint
    }
    await page.getByRole('link', { name: 'Home' }).waitFor({ timeout: 30000 });
    await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 15000 });
    await sleep(1, 1);
    await this.dismissOverlays(page);
  }

  private async ensureOnCreatePage(page: Page, resetWidget = false): Promise<void> {
    if (page.isClosed())
      throw new Error('Chromium session page is closed');
    const widgetUp = resetWidget
      && ((await this.isTurnstileVisible(page)) || (await this.isHcaptchaVisible(page)));
    const onCreate = /suno\.com\/create/.test(page.url());
    if (!onCreate || widgetUp) {
      logger.info('Resetting Chromium session to /create');
      await this.warmCreatePage(page);
      return;
    }
    await this.dismissOverlays(page);
    const visible = await page.locator('textarea').first().isVisible().catch(() => false);
    if (!visible)
      await this.warmCreatePage(page);
  }

  private async isHcaptchaVisible(page: Page): Promise<boolean> {
    const iframe = page.locator('iframe[title*="hCaptcha"]');
    if (await iframe.count() === 0)
      return false;
    return iframe.first().isVisible().catch(() => false);
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
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions'
    ];
    // Check for GPU acceleration, as it is recommended to turn it off for Docker
    if (yn(process.env.BROWSER_DISABLE_GPU, { default: false }))
      args.push('--enable-unsafe-swiftshader',
        '--disable-gpu',
        '--disable-setuid-sandbox');
    const browserType = this.getBrowserType();
    const isChromium = browserType === chromium;
    process.env.PLAYWRIGHT_CHROMIUM_USE_HEADLESS_SHELL = '0';
    const headless = yn(process.env.BROWSER_HEADLESS, { default: false });
    let browser: Browser;
    if (isChromium) {
      const stealthLaunch = {
        args,
        headless,
        ignoreDefaultArgs: ['--enable-automation'] as string[]
      };
      try {
        // executablePath() is the full chrome binary, not chromium-headless-shell.
        browser = await chromium.launch({
          ...stealthLaunch,
          executablePath: chromium.executablePath()
        });
      } catch (err: any) {
        logger.warn('Full Chromium executablePath launch failed: ' + err.message);
        browser = await chromium.launch(stealthLaunch);
      }
    } else {
      browser = await browserType.launch({ args, headless });
    }
    const major = (browser.version() || '').split('.')[0];
    if (major && major !== this.fingerprint.chromeMajor) {
      this.fingerprint = buildChromeMacFingerprint(major);
      this.userAgent = this.fingerprint.userAgent;
      logger.info('Chromium ' + browser.version() + '; fingerprint Chrome/' + major);
    }
    const context = await browser.newContext({
      ...contextOptionsFromFingerprint(this.fingerprint),
      acceptDownloads: true
    });
    await context.addInitScript(applyStealthInit, stealthInitPayload(this.fingerprint));
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

  private captchaTokenCaptured(): boolean {
    return !!this.activeCaptchaSolve?.tokenSettled;
  }

  private shouldRecycleBrowserSession(): boolean {
    const maxAge = envInt('BROWSER_SESSION_MAX_AGE_MS', 2 * 60 * 60 * 1000);
    const maxSolves = envInt('BROWSER_SESSION_MAX_SOLVES', 20);
    if (!this.browserSession.isAlive())
      return false;
    if (this.browserSessionStartedAt > 0 && Date.now() - this.browserSessionStartedAt >= maxAge)
      return true;
    return this.captchaSolveCount >= maxSolves;
  }

  private async recycleBrowserSession(reason: string): Promise<void> {
    logger.info('Recycling Chromium session: ' + reason);
    await this.browserSession.invalidate().catch(() => {});
    this.captchaSolveCount = 0;
    this.browserSessionStartedAt = 0;
  }

  private async ensureGenerateRoute(page: Page): Promise<void> {
    if (page.isClosed() || this.generateRoutePages.has(page))
      return;
    this.generateRoutePages.add(page);
    await page.route(/\/api\/generate\/v2/, (route) => this.onGenerateRoute(route, page));
  }

  private async onGenerateRoute(route: any, page: Page): Promise<void> {
    const solve = this.activeCaptchaSolve;
    if (!solve || solve.page !== page) {
      await route.continue();
      return;
    }
    if (solve.tokenSettled) {
      await route.abort().catch(() => {});
      return;
    }
    try {
      const request = route.request();
      let postData: any;
      try {
        postData = request.postDataJSON();
      } catch {
        await route.abort();
        return;
      }
      const token = postData?.token;
      if (!token) {
        logger.info('Dropping generate request without captcha token');
        await route.abort();
        return;
      }
      solve.capturedToken = token;
      solve.tokenSettled = true;
      if (postData?.token_provider != null)
        this.captchaTokenProvider = postData.token_provider;
      const bearer = request.headers().authorization?.split('Bearer ').pop();
      if (bearer)
        this.currentToken = bearer;
      logger.info('Captured generate captcha token from ' + request.url());

      if (!solve.submitOptions) {
        solve.resolveToken(token);
        await route.abort();
        return;
      }

      const sessionToken =
        postData?.metadata?.create_session_token
        || this.createSessionToken
        || randomUUID();
      const payload = bindCaptchaGeneratePayload(
        buildGenerateV2Payload(solve.submitOptions, {
          captchaToken: token,
          captchaTokenProvider: this.captchaTokenProvider,
          userTier: extractUserTierFromJwt(this.currentToken),
          createSessionToken: sessionToken,
          transactionUuid: postData?.transaction_uuid
        }),
        postData
      );
      this.createSessionToken = payload.metadata?.create_session_token || sessionToken;
      this.captchaTransactionUuid = payload.transaction_uuid;
      logger.info('Submitting generate via browser intercept (same TLS/JWT as captcha)');
      const responsePromise = page.waitForResponse(
        (resp) => resp.request() === request,
        { timeout: 20000 }
      );
      const pendingResponse = responsePromise.catch(() => null);
      await route.continue({ postData: JSON.stringify(payload) });
      const response = await pendingResponse;
      if (!response)
        throw new Error('Browser generate produced no response');
      const body = await response.text();
      let clips: any[] | undefined;
      try {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed?.clips))
          clips = parsed.clips;
      } catch {}
      if (clips && clips.length > 0) {
        this.captchaBrowserClips = clips;
        logger.info('Browser generate accepted ' + clips.length + ' clip(s)');
      } else {
        const snippet = body.replace(/\s+/g, ' ').slice(0, 240);
        this.captchaBrowserError =
          'Suno rejected the captcha-backed generate (' + response.status() + '): ' + snippet;
        logger.warn(this.captchaBrowserError);
      }
      solve.resolveToken(token);
    } catch (err) {
      await route.abort().catch(() => {});
      logger.warn('Generate intercept error: ' + (err as Error).message);
      if (solve.tokenSettled) {
        if (!this.captchaBrowserClips && !this.captchaBrowserError)
          this.captchaBrowserError = 'Browser generate fetch failed: ' + (err as Error).message;
        if (solve.capturedToken)
          solve.resolveToken(solve.capturedToken);
      }
    }
  }

  /**
   * Checks for CAPTCHA verification and solves the CAPTCHA if needed.
   * Suno currently serves hCaptcha and may also show a Clerk Turnstile widget
   * on /create; widget kind is sniffed, with hCaptcha preferred.
   *
   * Check and solve both run on the long-lived Chromium session page.
   * When `submitOptions` is provided, the intercepted browser generate is
   * rewritten to the real payload and sent from that same page (same TLS/JWT
   * as the widget). Axios must not replay that one-time token afterwards.
   * The Chromium process is kept alive after the solve.
   * @returns {string|null} Captcha token. If no verification is required, returns null
   */
  public async getCaptcha(
    engage: () => void = () => {},
    signal?: AbortSignal,
    submitOptions?: GenerateSongsOptions
  ): Promise<string|null> {
    this.captchaTokenProvider = undefined;
    this.captchaTransactionUuid = undefined;
    this.captchaBrowserClips = undefined;
    this.captchaBrowserError = undefined;
    if (!await this.captchaRequired(signal))
      return null;

    // Becoming the solver engages the per-account soft lock so concurrent
    // requests queue up instead of each launching their own browser + 2Captcha solve.
    engage();
    this.captchaSolveCount++;
    logger.info('CAPTCHA required. Using Chromium session...');
    const page = await this.ensureGeneratePage(signal);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);
    const onExternalAbort = () => controller.abort();
    if (signal)
      signal.addEventListener('abort', onExternalAbort, { once: true });

    try {
      return await this.browserSession.withWrite(async () => {
      logger.info('Triggering the CAPTCHA');
      await this.dismissOverlays(page);
      await this.ensureGenerateRoute(page);

      const textarea = page.locator('textarea').first();
      await this.click(textarea);
      await textarea.fill('Lorem ipsum');

      const createSong = page.locator('button[aria-label="Create song"]');
      const homepageCreate = page.locator('button:has-text("Create")').first();
      const button = (await createSong.count()) > 0 ? createSong.first() : homepageCreate;

      const tokenPromise = new Promise<string>((resolve, reject) => {
        this.activeCaptchaSolve = {
          page,
          submitOptions,
          tokenSettled: false,
          resolveToken: resolve
        };
        const onAbort = () => {
          const solve = this.activeCaptchaSolve;
          if (solve && !solve.tokenSettled) {
            solve.tokenSettled = true;
            reject(signal?.aborted ? new ClientGoneError() : new Error('Captcha timeout'));
          }
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });

      await this.triggerCreateOnCreatePage(page);
      if (!(await this.isTurnstileVisible(page)) && !(await this.isHcaptchaVisible(page))) {
        const homepageCreateVisible = await homepageCreate.isVisible().catch(() => false);
        if (homepageCreateVisible && await homepageCreate.isEnabled().catch(() => false)) {
          logger.info('Clicking homepage Create as fallback');
          await this.click(homepageCreate);
        }
      }

      const captchaPromise = this.solveDetectedCaptcha(page, button, controller.signal)
        .then(() => ({ type: 'solved' as const }))
        .catch((err: any) => ({ type: 'solver_failed' as const, err }));
      const raced = await Promise.race([
        tokenPromise.then((token) => ({ type: 'token' as const, token })),
        captchaPromise,
      ]);
      if (raced.type === 'token')
        return raced.token;
      if (raced.type === 'solver_failed') {
        // Grace window: managed Turnstile can pass silently right as the kind-poll expires
        const lateToken = await Promise.race([
          tokenPromise,
          waitMs(5000).then(() => null)
        ]).catch(() => null);
        if (lateToken)
          return lateToken;
        throw new Error('CAPTCHA solver failed: ' + (raced.err?.message || 'unknown'));
      }
      if (!this.captchaTokenCaptured())
        await this.triggerCreateOnCreatePage(page);
      return await tokenPromise;
      });
    } catch (err) {
      if (!this.browserSession.isAlive()) {
        logger.warn('CAPTCHA failed and Chromium session is dead; invalidating');
        await this.browserSession.invalidate().catch(() => {});
      } else {
        logger.warn(
          'CAPTCHA session solve failed; keeping Chromium session: ' + (err as Error).message
        );
      }
      throw err;
    } finally {
      this.activeCaptchaSolve = null;
      this.captchaRouteEpoch++;
      clearTimeout(timeoutId);
      controller.abort();
      if (signal)
        signal.removeEventListener('abort', onExternalAbort);
      const recycle = this.shouldRecycleBrowserSession();
      if (recycle) {
        const ageMin = this.browserSessionStartedAt
          ? Math.round((Date.now() - this.browserSessionStartedAt) / 60000)
          : 0;
        await this.recycleBrowserSession(
          `age=${ageMin}m solves=${this.captchaSolveCount}`
        );
      } else if (this.browserSession.isAlive()) {
        await this.browserSession.withWrite(() => this.ensureOnCreatePage(page, true)).catch((e: any) => {
          logger.info('Post-captcha /create reset failed: ' + e.message);
        });
      }
    }
  }

  /**
   * Close a browser with a hard cap: a wedged renderer can make CDP close calls
   * hang forever, which would leak the chromium process and the caller's request.
   */
  private async disposeBrowser(browser: Browser, context: BrowserContext): Promise<void> {
    const proc = (browser as any).process?.() as { kill: (signal: string) => void } | null;
    let closed = false;
    await Promise.race([
      (async () => {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        closed = true;
      })(),
      waitMs(10000).then(() => {
        if (closed) return;
        logger.info('Browser teardown timed out; killing chromium');
        try {
          proc?.kill('SIGKILL');
        } catch {
          // ignore kill errors
        }
      })
    ]).catch(() => {});
  }

  /**
   * Race a browser-bound operation against a hard cap. On timeout the operation
   * throws, the caller's finally runs, and disposeBrowser SIGKILLs the wedged browser.
   */
  private async withBrowserWatchdog<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      promise,
      waitMs(ms).then(() => {
        throw new Error(label + ' timed out after ' + Math.round(ms / 1000) + 's');
      })
    ]);
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
    if (kind === 'passed')
      return;
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
  ): Promise<'turnstile' | 'hcaptcha' | 'none' | 'passed'> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted)
        throw new Error('AbortError');
      if (this.captchaTokenCaptured())
        return 'passed';
      // Generation captcha is hCaptcha; Clerk may also mount a Turnstile on /create.
      if (await this.isHcaptchaVisible(page))
        return 'hcaptcha';
      if (await this.isTurnstileVisible(page))
        return 'turnstile';
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
    if (this.captchaTokenCaptured())
      return;

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
    const MAX_CAPTCHA_ATTEMPTS = 3;

    for (let attempt = 0; attempt < MAX_CAPTCHA_ATTEMPTS; attempt++) {
      if (signal.aborted)
        throw new Error('AbortError');
      if (this.captchaTokenCaptured())
        return;
      logger.info(`hCaptcha attempt ${attempt + 1}/${MAX_CAPTCHA_ATTEMPTS}`);
      const visible = await challenge.isVisible({ timeout: 4000 }).catch(() => false);
      if (!visible) {
        if (attempt > 0 || this.captchaTokenCaptured() || !(await this.isHcaptchaVisible(page))) {
          logger.info('hCaptcha challenge gone after previous submit');
          return;
        }
        logger.info('hCaptcha challenge not open; clicking checkbox');
        const checkbox = frame.locator('#checkbox, .checkbox');
        await checkbox.first().click({ timeout: 8000 }).catch((e: any) => {
          logger.info('hCaptcha checkbox click failed: ' + e.message);
        });
        try {
          await challenge.waitFor({ state: 'visible', timeout: 15000 });
        } catch {
          if (this.captchaTokenCaptured() || !(await this.isHcaptchaVisible(page)))
            return;
          throw new Error('hCaptcha challenge did not open within 15s');
        }
      }
      if (attempt === 0) {
        await waitForRequests(page, signal, {
          hardDeadlineMs: 20000,
          requireRequests: true,
          firstRequestTimeoutMs: 8000
        });
      } else {
        const promptReady = await challenge.locator('.prompt-text').first().isVisible().catch(() => false);
        if (!promptReady) {
          await waitForRequests(page, signal, {
            hardDeadlineMs: 4000,
            requireRequests: false,
            idleMs: 400,
            firstRequestTimeoutMs: 1500
          });
        }
      }
      await sleep(1, 1);

      if (this.captchaTokenCaptured())
        return;

      const promptText = await challenge.locator('.prompt-text')
        .first().innerText().catch(() => '');
      logger.info('hCaptcha prompt: ' + (promptText.slice(0, 80) || '(empty)'));
      const drag = promptText.toLowerCase().includes('drag');

      let captcha: any;
      for (let j = 0; j < 3; j++) {
        try {
          logger.info('Sending the CAPTCHA to 2Captcha');
          const payload: paramsCoordinates = {
            body: (await challenge.screenshot({ timeout: 5000 })).toString('base64'),
            lang: captchaWorkerLang()
          };
          if (drag) {
            payload.textinstructions = 'CLICK on the shapes at their edge or center as shown above—please be precise!';
            payload.imginstructions = (await fs.readFile(
              path.join(process.cwd(), 'public', 'drag-instructions.jpg')
            )).toString('base64');
          }
          const solved = await Promise.race([
            this.solver.coordinates(payload).then((data) => ({ type: 'captcha' as const, data })),
            waitMs(90000).then(() => ({ type: 'timeout' as const })),
            this.waitUntilTokenOrAbort(signal).then((kind) =>
              kind === 'token' ? { type: 'token' as const } : { type: 'abort' as const }
            )
          ]);
          if (solved.type === 'token')
            return;
          if (solved.type === 'abort')
            throw new Error('AbortError');
          if (solved.type === 'timeout')
            throw new Error('2Captcha coordinates timed out after 90s');
          captcha = solved.data;
          break;
        } catch(err: any) {
          if (this.captchaTokenCaptured())
            return;
          logger.info(err.message);
          if (j === 2) throw err;
          logger.info('Retrying...');
        }
      }

      if (this.captchaTokenCaptured())
        return;

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
        } else if (!await challenge.isVisible().catch(() => false) || this.captchaTokenCaptured()) {
          logger.info('hCaptcha submit skipped; challenge already closed');
          return;
        } else {
          throw e;
        }
      }

      const outcome = await this.waitForHcaptchaOutcome(page, challenge, signal, 8000);
      if (outcome === 'passed') {
        logger.info('hCaptcha passed after attempt ' + (attempt + 1));
        return;
      }
      logger.info('hCaptcha still visible after submit; retrying');
    }

    if (this.captchaTokenCaptured())
      return;
    throw new Error('hCaptcha max attempts exceeded');
  }

  private async waitUntilTokenOrAbort(signal: AbortSignal): Promise<'token' | 'abort'> {
    while (!signal.aborted && !this.captchaTokenCaptured())
      await waitMs(200);
    if (this.captchaTokenCaptured())
      return 'token';
    return 'abort';
  }

  private async waitForHcaptchaOutcome(
    page: Page,
    challenge: Locator,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<'passed' | 'retry'> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted)
        throw new Error('AbortError');
      if (this.captchaTokenCaptured())
        return 'passed';
      if (!(await this.isHcaptchaVisible(page)))
        return 'passed';
      const checked = await page.frameLocator('iframe[title*="hCaptcha"]')
        .locator('[aria-checked="true"]').count().catch(() => 0);
      const challengeVisible = await challenge.isVisible().catch(() => false);
      if (checked > 0 && !challengeVisible)
        return 'passed';
      if (!challengeVisible)
        return 'passed';
      await sleep(0.4, 0.4);
    }
    if (this.captchaTokenCaptured() || !(await this.isHcaptchaVisible(page)))
      return 'passed';
    return 'retry';
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
    wait_audio: boolean = false,
    signal?: AbortSignal,
    extras?: GenerationExtras
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();
    const audios = await this.generateSongs({
      prompt,
      isCustom: false,
      make_instrumental,
      model,
      wait_audio,
      task: 'agentic_thinking',
      extras,
      signal
    });
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
    this.invalidateFeedListCache();
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
    negative_tags?: string,
    signal?: AbortSignal,
    extras?: GenerationExtras
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();
    const audios = await this.generateSongs({
      prompt,
      isCustom: true,
      tags,
      title,
      make_instrumental,
      model,
      wait_audio,
      negative_tags,
      extras,
      signal
    });
    const costTime = Date.now() - startTime;
    logger.info(
      'Custom Generate Response:\n' + JSON.stringify(audios, null, 2)
    );
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  /**
   * Generates songs based on the provided options.
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated songs.
   */
  private async generateSongs(options: GenerateSongsOptions): Promise<AudioInfo[]> {
    // The gated section is kept short on purpose: Chromium-session captcha
    // check/solve + the generate POST. The wait_audio polling runs outside the
    // gate so queued requests are only blocked by the solver's submission, not
    // by its audio rendering.
    const clips = await this.captchaGate.run(async (engage) => {
      try {
        const captchaToken = await this.getCaptcha(engage, options.signal, options);
        if (this.captchaBrowserClips) {
          this.invalidateFeedListCache();
          await this.syncAuthFromBrowser();
          return this.captchaBrowserClips;
        }
        if (this.captchaBrowserError)
          throw new Error(this.captchaBrowserError);
        if (captchaToken)
          throw new Error('Captcha token captured but browser generate did not complete');
        const created = await this.postGenerateViaPage({ ...options, captchaToken: null });
        await this.syncAuthFromBrowser();
        return created;
      } catch (e) {
        // A disconnected client must not fail the queued backlog: map any
        // in-flight failure to ClientGoneError so the gate treats it neutrally.
        if (options.signal?.aborted)
          throw new ClientGoneError();
        throw e;
      }
    }, options.signal);
    const waitAudio = options.wait_audio ?? false;
    const songIds = clips.map((audio: any) => audio.id);
    //Want to wait for music file generation
    if (waitAudio) {
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
    }
    return clips.map((audio: any) => ({
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

  /**
   * Submit generate from the long-lived Chromium page (same TLS as /api/c/check).
   * Do not call axios postGenerate for this — Node TLS is a different client.
   */
  private async postGenerateViaPage(
    options: GenerateSongsOptions & { captchaToken: string | null }
  ): Promise<any[]> {
    await this.ensureGeneratePage(options.signal);
    const payload = buildGenerateV2Payload(options, {
      captchaToken: options.captchaToken,
      captchaTokenProvider: this.captchaTokenProvider,
      userTier: extractUserTierFromJwt(this.currentToken),
      createSessionToken: this.createSessionToken ??= randomUUID(),
      transactionUuid: this.captchaTransactionUuid
    });
    logger.info(
      'generateSongs payload:\n' +
        JSON.stringify(
          {
            prompt: options.prompt,
            isCustom: options.isCustom,
            tags: options.tags,
            title: options.title,
            make_instrumental: options.make_instrumental,
            negative_tags: options.negative_tags,
            extras: options.extras,
            payload: payload
          },
          null,
          2
        )
    );
    const result = await this.browserSession.withRead(async () => {
      return this.browserSession.pageFetch(
        `${SunoApi.BASE_URL}/api/generate/v2-web/`,
        {
          method: 'POST',
          headers: await this.browserGenerateHeaders(true),
          body: JSON.stringify(payload),
          timeoutMs: 20000,
          signal: options.signal,
          locked: true
        }
      );
    });
    if (result.status !== 200) {
      const snippet = (result.text || '').replace(/\s+/g, ' ').slice(0, 240);
      throw new Error('Error response:' + result.status + (snippet ? ' ' + snippet : ''));
    }
    const clips = result.json?.clips;
    if (!Array.isArray(clips) || clips.length === 0)
      throw new Error('Browser generate produced no clips');
    this.invalidateFeedListCache();
    return clips;
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
    wait_audio?: boolean,
    signal?: AbortSignal
  ): Promise<AudioInfo[]> {
    return this.generateSongs({
      prompt,
      isCustom: true,
      tags,
      title,
      make_instrumental: false,
      model,
      wait_audio,
      negative_tags,
      task: 'extend',
      continue_clip_id: audioId,
      continue_at: continueAt,
      signal
    });
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
    this.invalidateFeedListCache();
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
    key?: string,
    signal?: AbortSignal,
    extras?: GenerationExtras
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();
    // Title is title-cased and truncated to ~100 chars to match official web behavior
    const title = prompt
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
      .slice(0, 100)
      .replace(/\s+$/, '');
    const audios = await this.generateSongs({
      prompt,
      isCustom: true,
      tags: prompt,
      title,
      make_instrumental: true,
      model,
      wait_audio,
      task: 'sound',
      sound_loop: loop,
      sound_tempo: tempo,
      sound_key: key,
      extras,
      signal
    });
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
    page?: string | null,
    opts?: { fresh?: boolean }
  ): Promise<AudioInfo[]> {
    const key = `${page ?? ''}\0${(songIds ?? []).join(',')}`;
    const listMode = !songIds?.length;
    const epoch = this.feedListEpoch;
    if (listMode && !opts?.fresh) {
      const hit = this.feedListCache;
      if (hit && hit.key === key && Date.now() - hit.at < FEED_LIST_TTL_MS) {
        return hit.data;
      }
    }
    const pending = this.feedInflight.get(key);
    if (pending) return pending;

    const fetchFeed = async (): Promise<AudioInfo[]> => {
      await this.keepAlive(false, listMode);
      const url = new URL(`${SunoApi.BASE_URL}/api/feed/v2`);
      if (songIds) {
        url.searchParams.append('ids', songIds.join(','));
      }
      if (page) {
        url.searchParams.append('page', page);
      }
      logger.info('Get audio status: ' + url.href);
      const response = await this.client.get(url.href, {
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
    };

    const promise = fetchFeed().finally(() => {
      if (this.feedInflight.get(key) === promise) this.feedInflight.delete(key);
    });
    this.feedInflight.set(key, promise);
    const data = await promise;
    if (listMode && epoch === this.feedListEpoch) {
      this.feedListCache = { key, at: Date.now(), data };
    }
    return data;
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

  /** Return the cached preview file, or null when not captured yet. */
  public async getCachedPreview(clipId: string): Promise<{ buffer: Buffer; contentType: string } | null> {
    const cached = await this.readPreviewCache(clipId);
    if (cached) return cached;
    return this.readPreviewResult(clipId);
  }

  /** Cheap ready check for the live deck; does not read the audio bytes. */
  public hasCachedPreview(clipId: string): boolean {
    const entry = previewResults.get(clipId);
    if (entry && entry.expiresAt > Date.now()) return true;
    return previewCacheIndex.has(clipId);
  }

  public async ensurePreviewCacheIndex(): Promise<void> {
    if (globalForHarvest.sunoPreviewCacheIndexLoaded) return;
    if (!globalForHarvest.sunoPreviewCacheIndexPromise) {
      globalForHarvest.sunoPreviewCacheIndexPromise = (async () => {
        try {
          const names = await fs.readdir(PREVIEW_CACHE_DIR);
          for (const name of names) {
            if (name.endsWith('.bin')) previewCacheIndex.add(name.slice(0, -'.bin'.length));
          }
        } catch {
          // cache dir may not exist yet
        }
        globalForHarvest.sunoPreviewCacheIndexLoaded = true;
      })();
    }
    await globalForHarvest.sunoPreviewCacheIndexPromise;
  }

  private emitPreviewJob(clipId: string): void {
    const snap = this.previewJobStatus(clipId);
    if (!snap) return;
    emitPreviewLiveEvent({
      type: 'preview-job',
      clipId,
      state: snap.state,
      queuePosition: snap.queuePosition,
      progressPercent: snap.progressPercent,
      currentSec: snap.currentSec,
      durationSec: snap.durationSec,
      error: snap.error
    });
  }

  private emitQueuedJobPositions(): void {
    const waitList = globalForHarvest.sunoHarvestWaitList || [];
    for (const id of waitList) this.emitPreviewJob(id);
  }

  /** In-memory result of a recently completed capture (see PREVIEW_RESULT_TTL_MS). */
  private readPreviewResult(clipId: string): { buffer: Buffer; contentType: string } | null {
    const entry = previewResults.get(clipId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      previewResults.delete(clipId);
      return null;
    }
    return { buffer: entry.buffer, contentType: this.sniffAudioType(entry.buffer) };
  }

  /**
   * Start (or join) the background preview harvest for a clip.
   * Never blocks and never throws: failures land in the job's error state.
   */
  public beginPreviewHarvest(clipId: string): PreviewJob {
    const existing = previewJobs.get(clipId);
    if (existing) return existing;
    const job: PreviewJob = {
      promise: null as unknown as Promise<Buffer>,
      phase: 'waiting_clip',
      currentSec: 0,
      durationSec: 0,
      bytes: 0,
      chunkLog: []
    };
    job.promise = this.runPreviewJob(clipId, job);
    // Errors are surfaced through previewJobStatus(); never crash the process.
    job.promise.catch(() => {});
    previewJobs.set(clipId, job);
    this.emitPreviewJob(clipId);
    return job;
  }

  /** Live status of a running (or recently failed) preview harvest. */
  public previewJobStatus(clipId: string): PreviewJobSnapshot | null {
    const job = previewJobs.get(clipId);
    if (!job) return null;
    const waitList = globalForHarvest.sunoHarvestWaitList || [];
    const idx = job.phase === 'queued' ? waitList.indexOf(clipId) : -1;
    const progressPercent =
      job.phase === 'capturing' && job.durationSec > 0
        ? Math.min(100, Math.round((job.currentSec / job.durationSec) * 1000) / 10)
        : null;
    return {
      state: job.phase,
      queuePosition: idx >= 0 ? idx + 1 : 0,
      progressPercent,
      currentSec: Math.round(job.currentSec * 10) / 10,
      durationSec: Math.round(job.durationSec * 10) / 10,
      bytes: job.bytes,
      error: job.error ?? null
    };
  }

  // ─── Progressive Preview Streaming (protocol layer) ─────────────────

  private emitPreviewChunk(job: PreviewJob, chunk: Buffer, seq: number): void {
    for (const fn of job.chunkSubs ?? []) {
      try {
        fn(chunk, seq);
      } catch {
        // A misbehaving subscriber must never break the capture.
      }
    }
  }

  private emitPreviewEnd(job: PreviewJob): void {
    for (const fn of job.endSubs ?? []) {
      try {
        fn();
      } catch {
        // ignore subscriber errors
      }
    }
  }

  private emitPreviewError(job: PreviewJob, err: any): void {
    const error = err instanceof Error ? err : new Error(String(err));
    for (const fn of job.errSubs ?? []) {
      try {
        fn(error);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  /**
   * Begin or join the harvest for a clip, dropping a stale errored job first
   * (a failed job is kept visible to status pollers for PREVIEW_ERROR_TTL_MS;
   * a fresh subscriber wants a retry, not the stale error).
   */
  private acquirePreviewJob(clipId: string): PreviewJob {
    const stale = previewJobs.get(clipId);
    if (stale && stale.phase === 'error' && previewJobs.get(clipId) === stale)
      previewJobs.delete(clipId);
    return this.beginPreviewHarvest(clipId);
  }

  /**
   * Subscribe to progressively captured preview chunks.
   * `onChunk` fires in capture order as MSE segments are appended (before the
   * capture as a whole finishes); `onEnd` when the capture completed; `onError`
   * on failure. Chunks already captured before subscribing are NOT replayed —
   * use openPreviewStream() (cache-first) for a complete progressive stream.
   * Returns an unsubscribe function. Never throws.
   */
  public subscribePreviewChunks(
    clipId: string,
    onChunk: (chunk: Buffer) => void,
    onEnd: () => void,
    onError: (err: Error) => void
  ): () => void {
    const job = this.acquirePreviewJob(clipId);
    const wrapped = (chunk: Buffer) => onChunk(chunk);
    (job.chunkSubs ??= new Set()).add(wrapped);
    (job.endSubs ??= new Set()).add(onEnd);
    (job.errSubs ??= new Set()).add(onError);
    return () => {
      job.chunkSubs?.delete(wrapped);
      job.endSubs?.delete(onEnd);
      job.errSubs?.delete(onError);
    };
  }

  /**
   * Open a progressive preview stream: playable bytes flow out while the
   * in-browser capture is still running, so an unfinished track can be
   * previewed immediately. Cache hits (disk or recent in-memory result)
   * replay instantly; otherwise the promise resolves as soon as the first
   * captured chunk arrives (its bytes sniff the Content-Type). Rejects when
   * the harvest fails before any chunk, or when `signal` aborts while waiting.
   */
  public async openPreviewStream(
    clipId: string,
    signal?: AbortSignal
  ): Promise<{ stream: Readable; contentType: string }> {
    const cached = await this.readPreviewCache(clipId);
    const replay = cached ?? this.readPreviewResult(clipId);
    if (replay) {
      const stream = new Readable({
        read() {
          this.push(replay.buffer);
          this.push(null);
        }
      });
      if (signal) signal.addEventListener('abort', () => stream.destroy(), { once: true });
      return { stream, contentType: replay.contentType };
    }
    if (signal?.aborted) throw new Error('Preview stream request aborted');

    return new Promise((resolve, reject) => {
      let settled = false;
      // Push-driven: chunks arrive from the capture loop at ~500ms cadence,
      // so read() backpressure is irrelevant at this rate.
      const stream = new Readable({ read() {} });
      const job = this.acquirePreviewJob(clipId);
      // Sequence number of the next chunk the stream must deliver. Chunks
      // with a lower seq were already delivered via the log replay below.
      let nextSeq = 0;
      const onChunk = (chunk: Buffer, seq: number) => {
        if (seq < nextSeq) return;
        nextSeq = seq + 1;
        if (!settled) {
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve({ stream, contentType: this.sniffAudioType(chunk) });
        }
        stream.push(chunk);
      };
      const onEnd = () => {
        signal?.removeEventListener('abort', onAbort);
        if (!settled) {
          // Capture ended without emitting any chunk (harvest normally
          // throws in that case, so this is just a defensive fallback).
          settled = true;
          resolve({ stream, contentType: 'application/octet-stream' });
        }
        stream.push(null);
      };
      const onError = (err: Error) => {
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
        if (!settled) {
          settled = true;
          reject(err);
        } else {
          stream.destroy(err);
        }
      };
      const onAbort = () => {
        unsubscribe();
        if (!settled) {
          settled = true;
          reject(new Error('Preview stream request aborted'));
        } else {
          stream.destroy();
        }
      };
      (job.chunkSubs ??= new Set()).add(onChunk);
      (job.endSubs ??= new Set()).add(onEnd);
      (job.errSubs ??= new Set()).add(onError);
      const unsubscribe = () => {
        job.chunkSubs?.delete(onChunk);
        job.endSubs?.delete(onEnd);
        job.errSubs?.delete(onError);
      };
      // Late join: replay the prefix captured before we attached so the
      // stream starts with the container init segment and is demuxable.
      // The loop is synchronous, so no live emit can interleave with it.
      for (let i = 0; i < job.chunkLog.length; i++) onChunk(job.chunkLog[i], i);
      signal?.addEventListener('abort', onAbort, { once: true });
      // Drop the job subscription when the consumer (HTTP client) goes away.
      stream.once('close', unsubscribe);
    });
  }

  private async runPreviewJob(clipId: string, job: PreviewJob): Promise<Buffer> {
    try {
      const buffer = await this.harvestPreviewAudio(clipId, job);
      // Success: retain the result in memory for a short TTL so reconnecting
      // stream clients replay it instead of re-running a full browser capture
      // ('complete' clips also get the durable on-disk cache below).
      const now = Date.now();
      for (const [id, entry] of previewResults) {
        if (entry.expiresAt <= now) previewResults.delete(id);
      }
      previewResults.set(clipId, { buffer, expiresAt: now + PREVIEW_RESULT_TTL_MS });
      if (previewJobs.get(clipId) === job) previewJobs.delete(clipId);
      this.emitPreviewEnd(job);
      emitPreviewLiveEvent({ type: 'preview-ready', clipId });
      return buffer;
    } catch (err: any) {
      job.phase = 'error';
      const message = err?.message || String(err);
      job.error = message;
      this.emitPreviewError(job, err);
      emitPreviewLiveEvent({ type: 'preview-error', clipId, error: message });
      logger.warn({ clipId, err: message }, 'Preview harvest failed');
      const timer = setTimeout(() => {
        if (previewJobs.get(clipId) === job) previewJobs.delete(clipId);
      }, PREVIEW_ERROR_TTL_MS);
      timer.unref();
      throw err;
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
      previewCacheIndex.add(clipId);
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
    previewCacheIndex.add(clipId);
  }

  /**
   * Serialize all Playwright harvests (preview captures and master downloads)
   * through a single global chain. While waiting, the clip id sits in
   * sunoHarvestWaitList so status pollers can report the queue position.
   */
  private async acquireHarvestSlot(clipId: string): Promise<() => void> {
    const g = globalForHarvest;
    const waitList = (g.sunoHarvestWaitList ||= []);
    waitList.push(clipId);
    this.emitQueuedJobPositions();
    const previous = g.sunoPlaywrightHarvest || Promise.resolve();
    let release!: () => void;
    g.sunoPlaywrightHarvest = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    const idx = waitList.indexOf(clipId);
    if (idx >= 0) waitList.splice(idx, 1);
    this.emitQueuedJobPositions();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  /** Poll the clip until it can be previewed (complete or streaming). */
  private async waitForPreviewReady(
    clipId: string,
    job: PreviewJob
  ): Promise<{ status: string; durationSec?: number }> {
    const deadline = Date.now() + PREVIEW_READY_TIMEOUT_MS;
    let sawTransientError = false;
    while (Date.now() < deadline) {
      try {
        const clips = await this.get([clipId]);
        const clip = clips[0];
        const status = clip?.status;
        if (status === 'complete' || status === 'streaming') {
          const rawDuration = Number(clip?.duration);
          const durationSec = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : undefined;
          emitPreviewLiveEvent({
            type: 'clip-status',
            clipId,
            status,
            title: clip?.title,
            durationSec,
            createdAt: clip?.created_at
          });
          return { status, durationSec };
        }
        if (status === 'error')
          throw new ClipAudioNotReadyError('Clip generation failed');
        job.phase = 'waiting_clip';
        this.emitPreviewJob(clipId);
      } catch (err: any) {
        if (err instanceof ClipAudioNotReadyError) throw err;
        sawTransientError = true;
        logger.warn({ clipId, err: err?.message }, 'Preview readiness poll failed; retrying');
      }
      await waitMs(3000);
      await this.keepAlive(true).catch(() => {});
    }
    throw new ClipAudioNotReadyError(
      sawTransientError ? 'Clip status unavailable' : 'Clip not ready for preview within time limit'
    );
  }

  private async harvestPreviewAudio(clipId: string, job: PreviewJob): Promise<Buffer> {
    const ready = await this.waitForPreviewReady(clipId, job);
    logger.info('Capturing in-player preview (no unlock): ' + clipId);
    job.phase = 'queued';
    this.emitPreviewJob(clipId);
    const release = await this.acquireHarvestSlot(clipId);
    job.phase = 'capturing';
    this.emitPreviewJob(clipId);
    try {
      const watchdogMs = Math.min(
        PREVIEW_CAPTURE_MAX_MS,
        (ready.durationSec ?? 20) * 1000 + 120000
      );
      const harvested = await this.withBrowserWatchdog(
        this.capturePreviewViaBrowser(clipId, ready.durationSec, job),
        watchdogMs,
        'Preview capture'
      );
      job.currentSec = job.durationSec || job.currentSec;
      job.bytes = harvested.length;
      if (ready.status === 'complete')
        await this.writePreviewCache(clipId, harvested);
      return harvested;
    } finally {
      release();
    }
  }

  private async capturePreviewViaBrowser(
    clipId: string,
    clipDurationSec?: number,
    job?: PreviewJob
  ): Promise<Buffer> {
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
      await applyChromiumUserAgentOverride(page, this.fingerprint);
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

      const targetSec = clipDurationSec && clipDurationSec > 0 ? clipDurationSec : 20;
      const deadline = Date.now() + Math.min(PREVIEW_CAPTURE_MAX_MS, targetSec * 1000 + 60000);
      const collected: Buffer[] = [];
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
        // Incremental drain: push freshly appended MSE chunks to progressive
        // stream subscribers while playback is still running.
        const drained = await page.evaluate(drainMseChunkPayload).catch(() => null);
        if (drained && drained.total > 0) {
          const chunk = Buffer.from(drained.b64, 'base64');
          collected.push(chunk);
          if (job) {
            job.chunkLog.push(chunk);
            this.emitPreviewChunk(job, chunk, job.chunkLog.length - 1);
          }
        }
        if (playback && job) {
          job.currentSec = playback.t;
          if (playback.d > 0) job.durationSec = playback.d;
          job.bytes = playback.bytes;
          this.emitPreviewJob(clipId);
        }
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

      const packed = await page.evaluate(drainMseChunkPayload).catch(() => null);
      if (packed && packed.total > 0) {
        const chunk = Buffer.from(packed.b64, 'base64');
        collected.push(chunk);
        if (job) {
          job.chunkLog.push(chunk);
          this.emitPreviewChunk(job, chunk, job.chunkLog.length - 1);
        }
      }
      const buffer = Buffer.concat(collected);
      if (!looksLikeAudio(buffer))
        throw new Error('Preview capture did not produce playable audio');
      return buffer;
    } finally {
      await this.disposeBrowser(browser, context);
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
    const release = await this.acquireHarvestSlot(clipId);
    try {
      const harvested = await this.withBrowserWatchdog(
        this.downloadClipViaBrowser(clipId),
        150000,
        'Browser download harvest'
      );
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
      await applyChromiumUserAgentOverride(page, this.fingerprint);
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
      await this.disposeBrowser(browser, context);
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

/**
 * Same serialization as Next `cookies().toString()`: decode then
 * encodeURIComponent each value so WS Cookie headers and HTTP route
 * cookies share one sunoApi cache / preview-live room key.
 */
export function normalizeCookieHeader(cookie?: string): string | undefined {
  if (!cookie) return cookie;
  const pairs: { name: string; encoded: string }[] = [];
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    let value = part.slice(idx + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // already raw
    }
    pairs.push({ name, encoded: `${name}=${encodeURIComponent(value)}` });
  }
  pairs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return pairs.map((p) => p.encoded).join('; ');
}

export const sunoApi = async (cookie?: string) => {
  const normalized = normalizeCookieHeader(cookie);
  const resolvedCookie = normalized && normalized.includes('__client') ? normalized : process.env.SUNO_COOKIE;
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