import { emitPreviewLiveEvent } from '@/lib/preview-live/preview-live-events';

/**
 * Preview-page unlock consent. Clicking 「解锁母带」 only records permission;
 * Premier download credit is spent later by getPlayableAudio when an MCP
 * download tool actually fetches the master. Download tools refuse until
 * this flag is set for the clip.
 */
const globalForUnlock = globalThis as unknown as {
  sunoUnlockConsent?: Set<string>;
};

function consentSet(): Set<string> {
  if (!globalForUnlock.sunoUnlockConsent)
    globalForUnlock.sunoUnlockConsent = new Set();
  return globalForUnlock.sunoUnlockConsent;
}

export function grantUnlockConsent(clipId: string): void {
  consentSet().add(clipId);
  emitPreviewLiveEvent({ type: 'unlock-status', clipId, unlocked: true });
}

export function hasUnlockConsent(clipId: string): boolean {
  return consentSet().has(clipId);
}
