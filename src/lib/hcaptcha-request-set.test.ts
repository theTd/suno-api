import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  hcaptchaOverlayFromBoxes,
  isClosedCdpError,
  isHcaptchaChallengeBox,
  StartedRequestSet
} from './utils';

test('StartedRequestSet ignores finishes for requests it never saw start', () => {
  const set = new StartedRequestSet();
  const early = { id: 'early' };
  const live = { id: 'live' };
  assert.equal(set.end(early), true);
  assert.equal(set.seen, 0);
  assert.equal(set.idle, true);

  set.start(live);
  assert.equal(set.seen, 1);
  assert.equal(set.idle, false);
  assert.equal(set.end(early), false);
  assert.equal(set.idle, false);
  assert.equal(set.end(live), true);
  assert.equal(set.idle, true);
});

test('StartedRequestSet does not double-count the same request', () => {
  const set = new StartedRequestSet();
  const req = { id: 1 };
  set.start(req);
  set.start(req);
  assert.equal(set.seen, 1);
  assert.equal(set.end(req), true);
  assert.equal(set.end(req), true);
  assert.equal(set.idle, true);
});

test('isClosedCdpError matches rebrowser isolated-world teardown', () => {
  assert.equal(
    isClosedCdpError({
      message: 'Protocol error (Page.createIsolatedWorld): Internal server error, session closed.'
    }),
    true
  );
  assert.equal(isClosedCdpError({ message: 'Target closed' }), true);
  assert.equal(isClosedCdpError({ message: 'frame was detached' }), true);
  assert.equal(isClosedCdpError({ message: 'hCaptcha challenge did not open within 15s' }), false);
});

test('isHcaptchaChallengeBox distinguishes overlay from checkbox', () => {
  assert.equal(isHcaptchaChallengeBox(null), false);
  assert.equal(isHcaptchaChallengeBox({ width: 303, height: 78 }), false);
  assert.equal(isHcaptchaChallengeBox({ width: 400, height: 600 }), true);
  assert.equal(isHcaptchaChallengeBox({ width: 200, height: 150 }), true);
});

test('hcaptchaOverlayFromBoxes treats a failed snapshot as unknown, not gone', () => {
  assert.equal(hcaptchaOverlayFromBoxes(null), 'unknown');
  assert.equal(hcaptchaOverlayFromBoxes(undefined), 'unknown');
  assert.equal(hcaptchaOverlayFromBoxes([]), 'gone');
  assert.equal(hcaptchaOverlayFromBoxes([{ width: 303, height: 78 }]), 'gone');
  assert.equal(hcaptchaOverlayFromBoxes([{ width: 400, height: 600 }]), 'open');
  assert.equal(
    hcaptchaOverlayFromBoxes([{ width: 303, height: 78 }, { width: 400, height: 600 }]),
    'open'
  );
});
