import { envInt } from '@/lib/suno-browser-fingerprint';

/** After a successful check/solve, keep the Chromium page so hCaptcha can pass through. */
export const DEFAULT_CAPTCHA_PASS_GRACE_MS = 3 * 60 * 1000;

/** Wait for the widget after one Create click before any retry. */
export const CREATE_WIDGET_WAIT_MS = 3500;

export function captchaPassGraceMs(): number {
  return envInt('CAPTCHA_PASS_GRACE_MS', DEFAULT_CAPTCHA_PASS_GRACE_MS);
}

/**
 * Verified-session reuse, not replay of the one-time generate token string.
 * Suno mints `token` against a single v2-web POST; the pass we keep is the
 * long-lived Chromium document + create_session_token.
 */
export function isVerifiedSessionFresh(
  lastPassAt: number,
  now = Date.now(),
  graceMs = captchaPassGraceMs()
): boolean {
  return lastPassAt > 0 && now - lastPassAt < graceMs;
}

/**
 * Full /create navigation is for a lost page, missing editor, or a stuck
 * image-challenge overlay. Checkbox-only hCaptcha must not reload.
 * A just-accepted generate keeps the document even if the overlay still
 * covers the textarea while it closes.
 */
export function shouldReloadCreatePage(state: {
  onCreate: boolean;
  challengeOpen: boolean;
  textareaVisible: boolean;
  generateAccepted?: boolean;
}): boolean {
  if (!state.onCreate)
    return true;
  if (state.generateAccepted)
    return false;
  if (!state.textareaVisible)
    return true;
  return state.challengeOpen;
}

/**
 * Homepage `Create` is a different control and often navigates. Never use it
 * when the editor on /create is already the click target.
 */
export function shouldClickHomepageCreateFallback(state: {
  onCreate: boolean;
  widgetOrToken: boolean;
}): boolean {
  if (state.onCreate || state.widgetOrToken)
    return false;
  return true;
}

/**
 * Solver / viewport-fallback click target. On /create this is always the
 * Create song control, even if Playwright has not counted it yet.
 */
export function captchaSolverClickTarget(state: {
  onCreate: boolean;
  createSongAvailable: boolean;
}): 'create-song' | 'homepage-create' {
  if (state.onCreate || state.createSongAvailable)
    return 'create-song';
  return 'homepage-create';
}

/** Fill the real prompt so the click looks like the official create flow. */
export function captchaTriggerPrompt(prompt?: string): string {
  const text = (prompt || '').trim();
  if (text)
    return text.slice(0, 500);
  return 'a short original melody';
}

/**
 * Custom headers the official web client sends to studio-api (Device-Id,
 * Affiliate-Id, x-suno-client). Cookie / Origin / Referer / UA stay on the
 * Chromium fetch; do not override those here.
 */
export function studioWebApiHeaders(
  token: string | undefined,
  deviceId: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-suno-client': 'suno-web',
    'Affiliate-Id': 'undefined',
    'Device-Id': `"${deviceId}"`
  };
  if (token)
    headers.Authorization = `Bearer ${token}`;
  return headers;
}
