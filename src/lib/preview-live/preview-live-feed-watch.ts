import pino from 'pino';
import type { PreviewTrack } from '@/lib/preview-live/preview-live-protocol';
import { clipsToPreviewTracks, type PreviewLiveApi } from '@/lib/preview-live/preview-live-track-state';

const logger = pino();

const FAST_MS = 2_000;
const SLOW_MS = 20_000;

export type PreviewLiveFeedWatch = {
  stop: () => void;
  nudge: () => void;
};

export function startPreviewLiveFeedWatch(opts: {
  api: PreviewLiveApi;
  onPage1: (tracks: PreviewTrack[]) => void;
}): PreviewLiveFeedWatch {
  let stopped = false;
  let wake: (() => void) | null = null;
  let pendingNudge = false;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (stopped) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  const nudge = () => {
    if (wake) wake();
    else pendingNudge = true;
  };

  const stop = () => {
    stopped = true;
    wake?.();
  };

  const loop = async () => {
    logger.info('preview-live feed watch start');
    let lastBusy = false;
    try {
      while (!stopped) {
        let errored = false;
        try {
          await opts.api.ensurePreviewCacheIndex();
          const clips = await opts.api.get(undefined, '1', { fresh: true });
          const tracks = clipsToPreviewTracks(clips, opts.api);
          if (stopped) break;
          opts.onPage1(tracks);
          lastBusy = tracks.some((t) => t.status === 'generating' || t.status === 'streaming');
        } catch (err: any) {
          errored = true;
          logger.warn({ err: err?.message || String(err) }, 'preview-live feed watch fetch failed');
        }
        if (stopped) break;
        if (pendingNudge && !errored) {
          pendingNudge = false;
          continue;
        }
        pendingNudge = false;
        await sleep(errored || lastBusy ? FAST_MS : SLOW_MS);
      }
    } finally {
      logger.info('preview-live feed watch stop');
    }
  };

  void loop();
  return { stop, nudge };
}
