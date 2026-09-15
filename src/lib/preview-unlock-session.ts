import { randomBytes } from "node:crypto";

export const PREVIEW_UNLOCK_COOKIE = "suno_preview_unlock";
const MAX_AGE_S = 12 * 60 * 60;

const globalForPreviewUnlock = globalThis as unknown as {
  sunoPreviewUnlockTokens?: Set<string>;
};

function tokenSet(): Set<string> {
  if (!globalForPreviewUnlock.sunoPreviewUnlockTokens)
    globalForPreviewUnlock.sunoPreviewUnlockTokens = new Set();
  return globalForPreviewUnlock.sunoPreviewUnlockTokens;
}

export function issuePreviewUnlockToken(): string {
  const token = randomBytes(24).toString("hex");
  tokenSet().add(token);
  return token;
}

export function verifyPreviewUnlockToken(token: string | undefined): boolean {
  return !!token && tokenSet().has(token);
}

export function previewUnlockSetCookie(token: string): string {
  return `${PREVIEW_UNLOCK_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}`;
}

/** True when the request looks like a same-origin call from the preview page. */
export function isPreviewPageUnlockRequest(input: {
  cookie?: string;
  origin?: string | null;
  host?: string | null;
}): boolean {
  if (!verifyPreviewUnlockToken(input.cookie)) return false;
  const origin = input.origin ?? "";
  const host = (input.host || "").split(",")[0].trim();
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}


