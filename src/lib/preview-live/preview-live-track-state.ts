import type { AudioInfo, PreviewJobSnapshot } from '@/lib/SunoApi';
import type { PreviewState, PreviewTrack } from '@/lib/preview-live/preview-live-protocol';
import { hasUnlockConsent } from '@/lib/unlock-consent';

export type PreviewTrackLookup = {
  hasCachedPreview(clipId: string): boolean;
  previewJobStatus(clipId: string): PreviewJobSnapshot | null;
};

export type PreviewLiveApi = PreviewTrackLookup & {
  ensurePreviewCacheIndex(): Promise<void>;
  get(songIds?: string[], page?: string | null, opts?: { fresh?: boolean }): Promise<AudioInfo[]>;
  getCookieKey(): string;
};

function isPreviewableStatus(status: string): boolean {
  return status === 'complete' || status === 'streaming';
}

export function previewStateFromJob(state: PreviewJobSnapshot['state']): PreviewState {
  switch (state) {
    case 'capturing':
      return 'capturing';
    case 'queued':
      return 'queued';
    case 'waiting_clip':
      return 'waiting_clip';
    case 'error':
      return 'error';
    default:
      return 'pending';
  }
}

export function clipToPreviewTrack(clip: AudioInfo, api: PreviewTrackLookup): PreviewTrack {
  const id = String(clip.id);
  const status = String(clip.status || '');
  const cached = api.hasCachedPreview(id);
  const job = api.previewJobStatus(id);
  let preview: PreviewState;
  let progressPercent: number | null = null;
  let currentSec = 0;
  let durationSec = Number(clip.duration) || 0;
  let queuePosition = 0;
  let error: string | null = null;

  if (cached) {
    preview = 'ready';
  } else if (job) {
    preview = previewStateFromJob(job.state);
    progressPercent = job.progressPercent;
    currentSec = job.currentSec;
    durationSec = job.durationSec || durationSec;
    queuePosition = job.queuePosition;
    error = job.error;
  } else if (isPreviewableStatus(status)) {
    preview = 'pending';
  } else {
    preview = 'generating';
  }

  return {
    id,
    title: clip.title || id,
    status,
    createdAt: clip.created_at ? String(clip.created_at) : undefined,
    preview,
    progressPercent,
    currentSec,
    durationSec,
    queuePosition,
    error,
    unlocked: hasUnlockConsent(id)
  };
}

export function clipsToPreviewTracks(clips: AudioInfo[], api: PreviewTrackLookup): PreviewTrack[] {
  return clips.map((clip) => clipToPreviewTrack(clip, api));
}
