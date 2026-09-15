import assert from "node:assert/strict";
import { test } from "node:test";
import { isClipId } from "./clip-id";
import { masterFileAccessDenied } from "./master-file-access";
import { clipReadyToUnlock, mergeUnlocked } from "./preview-unlock-flags";
import {
  isPreviewPageUnlockRequest,
  issuePreviewUnlockToken,
  verifyPreviewUnlockToken,
} from "./preview-unlock-session";
import { grantUnlockConsent, hasUnlockConsent } from "./unlock-consent";

const CLIP = "af092dc0-e87a-4241-b440-6c252527121e";
const CLIP_B = "eeaf652f-e0cd-49d0-b2c5-c127dba1161c";

test("isClipId accepts suno uuids only", () => {
  assert.equal(isClipId(CLIP), true);
  assert.equal(isClipId("nope"), false);
  assert.equal(isClipId(""), false);
});

test("mergeUnlocked uses the server snapshot and does not stick true", () => {
  assert.equal(mergeUnlocked(true), true);
  assert.equal(mergeUnlocked(false), false);
  assert.equal(mergeUnlocked(undefined), false);
});

test("clipReadyToUnlock requires complete, not streaming", () => {
  assert.equal(clipReadyToUnlock("complete"), true);
  assert.equal(clipReadyToUnlock("streaming"), false);
  assert.equal(clipReadyToUnlock("queued"), false);
  assert.equal(clipReadyToUnlock(undefined), false);
});

test("preview unlock request needs issued cookie and matching origin host", () => {
  const token = issuePreviewUnlockToken();
  assert.equal(verifyPreviewUnlockToken(token), true);
  assert.equal(verifyPreviewUnlockToken("deadbeef"), false);
  assert.equal(
    isPreviewPageUnlockRequest({
      cookie: token,
      origin: "http://localhost:8556",
      host: "localhost:8556",
    }),
    true
  );
  assert.equal(
    isPreviewPageUnlockRequest({
      cookie: token,
      origin: "http://evil.example",
      host: "localhost:8556",
    }),
    false
  );
  assert.equal(
    isPreviewPageUnlockRequest({
      origin: "http://localhost:8556",
      host: "localhost:8556",
    }),
    false
  );
});

test("master file access is 403 without consent and allowed after grant", () => {
  assert.deepEqual(masterFileAccessDenied("bad"), {
    status: 400,
    error: "Invalid clip id",
  });
  assert.equal(hasUnlockConsent(CLIP), false);
  assert.deepEqual(masterFileAccessDenied(CLIP), {
    status: 403,
    error: "Clip has not been unlocked on /mcp/preview",
  });
  grantUnlockConsent(CLIP);
  assert.equal(hasUnlockConsent(CLIP), true);
  assert.equal(masterFileAccessDenied(CLIP), null);
  assert.equal(hasUnlockConsent(CLIP_B), false);
  assert.equal(masterFileAccessDenied(CLIP_B)?.status, 403);
});
