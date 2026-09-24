import { spawn } from 'node:child_process';
import pino from 'pino';

const logger = pino();

export const PREVIEW_MP3_MIME = 'audio/mpeg';
export const PREVIEW_MP3_BITRATE_KBPS = 128;

/** How long to skip ffmpeg spawn after the binary proved unavailable. */
export const FFMPEG_UNAVAILABLE_COOLDOWN_MS = 5 * 60 * 1000;

/** ffmpeg binary itself missing/unspawnable (vs. a per-file transcode error). */
export class FfmpegUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FfmpegUnavailableError';
  }
}

let lastFfmpegUnavailableAt = 0;

/** ms remaining in the spawn-skip cooldown, 0 when transcodes may proceed. */
export function previewTranscodeCooldownRemainingMs(): number {
  return Math.max(0, lastFfmpegUnavailableAt + FFMPEG_UNAVAILABLE_COOLDOWN_MS - Date.now());
}

/** Test hook: clear the unavailable cooldown. */
export function clearPreviewTranscodeCooldown(): void {
  lastFfmpegUnavailableAt = 0;
}

/** Binary path: explicit env override first, otherwise rely on PATH. */
export function ffmpegBinary(): string {
  return process.env.PREVIEW_FFMPEG_PATH || 'ffmpeg';
}

function hasId3Header(buf: Buffer): boolean {
  return buf.length >= 3 && buf.subarray(0, 3).toString() === 'ID3';
}

function hasMp3FrameSync(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
}

/** True when the bytes are already MP3 (header sniff, no decode). */
export function isMp3Buffer(buf: Buffer): boolean {
  return hasId3Header(buf) || hasMp3FrameSync(buf);
}

/**
 * Transcode arbitrary preview audio bytes to MP3 (libmp3lame, 128k CBR).
 * Resolves with the MP3 buffer; rejects when ffmpeg is missing, times out,
 * exits non-zero, or yields bytes that do not look like MP3.
 */
export function transcodeToMp3(
  input: Buffer,
  opts?: { bitrateKbps?: number; timeoutMs?: number }
): Promise<Buffer> {
  const bitrateKbps = opts?.bitrateKbps ?? PREVIEW_MP3_BITRATE_KBPS;
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  if (input.length === 0) return Promise.reject(new Error('Refusing to transcode empty audio buffer'));

  return new Promise<Buffer>((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-vn',
      '-c:a',
      'libmp3lame',
      '-b:a',
      `${bitrateKbps}k`,
      '-f',
      'mp3',
      'pipe:1',
    ];
    let child;
    try {
      child = spawn(ffmpegBinary(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err: any) {
      reject(new Error(`Failed to spawn ffmpeg: ${err?.message || String(err)}`));
      return;
    }

    const out: Buffer[] = [];
    const errLog: Buffer[] = [];
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // Already exited; nothing to clean up.
      }
      reject(err);
    };

    const timer = setTimeout(() => {
      fail(new Error(`ffmpeg transcode timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Don't keep the server alive just for a stalled transcode watchdog.
    timer.unref?.();

    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errLog.push(chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      fail(new FfmpegUnavailableError(`ffmpeg not available (${ffmpegBinary()}): ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const detail = Buffer.concat(errLog).toString('utf8').slice(0, 500);
        reject(new Error(`ffmpeg exited with code ${code}${detail ? `: ${detail}` : ''}`));
        return;
      }
      const mp3 = Buffer.concat(out);
      if (!isMp3Buffer(mp3)) {
        reject(new Error(`ffmpeg output (${mp3.length} bytes) does not look like MP3`));
        return;
      }
      resolve(mp3);
    });

    // stdin 'error' (e.g. EPIPE when ffmpeg exited early) is async and would
    // otherwise escape the try/catch below as an unhandled emission.
    child.stdin.on('error', (err: Error) => {
      clearTimeout(timer);
      fail(new Error(`Failed to pipe audio into ffmpeg: ${err.message}`));
    });
    try {
      // end(input) writes once and closes; preview payloads are a few MB, so
      // chunked drain handling would add no value here.
      child.stdin.end(input);
    } catch (err: any) {
      clearTimeout(timer);
      fail(new Error(`Failed to pipe audio into ffmpeg: ${err?.message || String(err)}`));
    }
  });
}

export interface PreviewMp3 {
  buffer: Buffer;
  contentType: string;
  /** False when the input was already MP3 or ffmpeg failed and we fell back. */
  transcoded: boolean;
}

/**
 * Ensure MP3 bytes for an already-captured preview.
 * MP3 input passes through untouched; anything else is transcoded.
 * Never throws: on transcode failure the original buffer is returned so the
 * caller can still serve a playable (non-MP3) preview.
 */
export async function ensurePreviewMp3(
  input: Buffer,
  contentType: string
): Promise<PreviewMp3> {
  if (contentType === PREVIEW_MP3_MIME || isMp3Buffer(input)) {
    return { buffer: input, contentType: PREVIEW_MP3_MIME, transcoded: false };
  }
  if (previewTranscodeCooldownRemainingMs() > 0) {
    logger.debug({ from: contentType }, 'ffmpeg cooldown active, serving original preview');
    return { buffer: input, contentType, transcoded: false };
  }
  try {
    const mp3 = await transcodeToMp3(input);
    logger.info(
      { inBytes: input.length, outBytes: mp3.length, from: contentType },
      'preview transcoded to mp3'
    );
    return { buffer: mp3, contentType: PREVIEW_MP3_MIME, transcoded: true };
  } catch (err: any) {
    if (err instanceof FfmpegUnavailableError) lastFfmpegUnavailableAt = Date.now();
    logger.warn({ err: err?.message || String(err), from: contentType }, 'preview mp3 transcode failed, serving original');
    return { buffer: input, contentType, transcoded: false };
  }
}
