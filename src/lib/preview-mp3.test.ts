import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  clearPreviewTranscodeCooldown,
  ensurePreviewMp3,
  ffmpegBinary,
  isMp3Buffer,
  PREVIEW_MP3_MIME,
  previewTranscodeCooldownRemainingMs,
  transcodeToMp3,
} from "./preview-mp3";

function ffmpegAvailable(): boolean {
  try {
    const r = spawnSync(ffmpegBinary(), ["-version"], { stdio: "ignore" });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/** 0.5s 8kHz mono 16-bit PCM sine wrapped in a WAV container. */
function tinyWav(): Buffer {
  const sampleRate = 8000;
  const samples = 4000;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 16000);
    data.writeInt16LE(v, i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

test("isMp3Buffer sniffs ID3 and frame sync, rejects wav", () => {
  assert.equal(isMp3Buffer(Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00])), true);
  assert.equal(isMp3Buffer(Buffer.from([0xff, 0xfb, 0x90, 0x00])), true);
  assert.equal(isMp3Buffer(tinyWav()), false);
  assert.equal(isMp3Buffer(Buffer.alloc(0)), false);
});

test("ensurePreviewMp3 passes mp3 through without spawning ffmpeg", async () => {
  const mp3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00]), Buffer.alloc(100)]);
  const out = await ensurePreviewMp3(mp3, "audio/webm");
  assert.equal(out.buffer, mp3);
  assert.equal(out.contentType, PREVIEW_MP3_MIME);
  assert.equal(out.transcoded, false);
});

test("transcodeToMp3 converts wav to playable mp3", { skip: !ffmpegAvailable() }, async () => {
  const mp3 = await transcodeToMp3(tinyWav());
  assert.equal(isMp3Buffer(mp3), true);
  assert.ok(mp3.length > 1000, `mp3 suspiciously small: ${mp3.length} bytes`);
});

test("transcodeToMp3 rejects empty input", async () => {
  await assert.rejects(transcodeToMp3(Buffer.alloc(0)), /empty/);
});

test("ensurePreviewMp3 falls back to original when ffmpeg is missing", async () => {
  const prev = process.env.PREVIEW_FFMPEG_PATH;
  process.env.PREVIEW_FFMPEG_PATH = "ffmpeg-binary-that-does-not-exist-xyz";
  clearPreviewTranscodeCooldown();
  try {
    const wav = tinyWav();
    const out = await ensurePreviewMp3(wav, "audio/wav");
    assert.equal(out.buffer, wav);
    assert.equal(out.contentType, "audio/wav");
    assert.equal(out.transcoded, false);
  } finally {
    if (prev === undefined) delete process.env.PREVIEW_FFMPEG_PATH;
    else process.env.PREVIEW_FFMPEG_PATH = prev;
    clearPreviewTranscodeCooldown();
  }
});

test("ffmpeg-unavailable failures arm a spawn-skip cooldown", async () => {
  const prev = process.env.PREVIEW_FFMPEG_PATH;
  process.env.PREVIEW_FFMPEG_PATH = "ffmpeg-binary-that-does-not-exist-xyz";
  clearPreviewTranscodeCooldown();
  try {
    assert.equal(previewTranscodeCooldownRemainingMs(), 0);
    await ensurePreviewMp3(tinyWav(), "audio/wav");
    assert.ok(previewTranscodeCooldownRemainingMs() > 0, "cooldown should be armed after unavailable failure");
    // Second call serves the original without spawning again.
    const wav = tinyWav();
    const out = await ensurePreviewMp3(wav, "audio/wav");
    assert.equal(out.buffer, wav);
    assert.equal(out.transcoded, false);
  } finally {
    if (prev === undefined) delete process.env.PREVIEW_FFMPEG_PATH;
    else process.env.PREVIEW_FFMPEG_PATH = prev;
    clearPreviewTranscodeCooldown();
  }
});
