import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captchaEngageKind,
  captchaNeedsPaidSolver,
  captchaSolverClickTarget,
  captchaTriggerPrompt,
  DEFAULT_CAPTCHA_PASS_GRACE_MS,
  isVerifiedSessionFresh,
  shouldClickHomepageCreateFallback,
  shouldReloadCreatePage,
  studioWebApiHeaders,
  tokenlessGenerateAction
} from './suno-captcha-policy';

test('shouldReloadCreatePage keeps a passed checkbox session on /create', () => {
  assert.equal(
    shouldReloadCreatePage({ onCreate: true, challengeOpen: false, textareaVisible: true }),
    false
  );
});

test('shouldReloadCreatePage reloads when the editor is gone or challenge is stuck', () => {
  assert.equal(
    shouldReloadCreatePage({ onCreate: false, challengeOpen: false, textareaVisible: true }),
    true
  );
  assert.equal(
    shouldReloadCreatePage({ onCreate: true, challengeOpen: false, textareaVisible: false }),
    true
  );
  assert.equal(
    shouldReloadCreatePage({ onCreate: true, challengeOpen: true, textareaVisible: true }),
    true
  );
});

test('shouldReloadCreatePage keeps an accepted generate even if overlay still covers the editor', () => {
  assert.equal(
    shouldReloadCreatePage({
      onCreate: true,
      challengeOpen: true,
      textareaVisible: false,
      generateAccepted: true
    }),
    false
  );
  assert.equal(
    shouldReloadCreatePage({
      onCreate: false,
      challengeOpen: false,
      textareaVisible: true,
      generateAccepted: true
    }),
    true
  );
});

test('shouldClickHomepageCreateFallback never fires on /create', () => {
  assert.equal(
    shouldClickHomepageCreateFallback({ onCreate: true, widgetOrToken: false }),
    false
  );
  assert.equal(
    shouldClickHomepageCreateFallback({ onCreate: false, widgetOrToken: true }),
    false
  );
  assert.equal(
    shouldClickHomepageCreateFallback({ onCreate: false, widgetOrToken: false }),
    true
  );
});

test('captchaSolverClickTarget never hands homepage Create to the solver on /create', () => {
  assert.equal(
    captchaSolverClickTarget({ onCreate: true, createSongAvailable: false }),
    'create-song'
  );
  assert.equal(
    captchaSolverClickTarget({ onCreate: true, createSongAvailable: true }),
    'create-song'
  );
  assert.equal(
    captchaSolverClickTarget({ onCreate: false, createSongAvailable: false }),
    'homepage-create'
  );
});

test('captchaTriggerPrompt uses the real prompt instead of lorem ipsum', () => {
  assert.equal(captchaTriggerPrompt('  Two cats fighting  '), 'Two cats fighting');
  assert.equal(captchaTriggerPrompt(''), 'a short original melody');
  assert.equal(captchaTriggerPrompt(undefined), 'a short original melody');
  assert.equal(captchaTriggerPrompt('x'.repeat(600)).length, 500);
});

test('studioWebApiHeaders match the official web client custom headers', () => {
  const headers = studioWebApiHeaders('jwt-token', 'device-1');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['x-suno-client'], 'suno-web');
  assert.equal(headers['Affiliate-Id'], 'undefined');
  assert.equal(headers['Device-Id'], '"device-1"');
  assert.equal(headers.Authorization, 'Bearer jwt-token');
  assert.equal(studioWebApiHeaders(undefined, 'device-1').Authorization, undefined);
});

test('tokenless generate continues until the captcha-backed POST is sent', () => {
  assert.equal(tokenlessGenerateAction(false), 'continue');
  assert.equal(tokenlessGenerateAction(true), 'abort');
});

test('captchaEngageKind ignores checkbox-only hCaptcha', () => {
  assert.equal(
    captchaEngageKind({ tokenCaptured: false, overlayOpen: false, turnstileVisible: false }),
    'none'
  );
  assert.equal(
    captchaEngageKind({ tokenCaptured: true, overlayOpen: false, turnstileVisible: false }),
    'token'
  );
  assert.equal(
    captchaEngageKind({ tokenCaptured: false, overlayOpen: true, turnstileVisible: false }),
    'overlay'
  );
  assert.equal(captchaNeedsPaidSolver('none'), false);
  assert.equal(captchaNeedsPaidSolver('token'), false);
  assert.equal(captchaNeedsPaidSolver('overlay'), true);
  assert.equal(captchaNeedsPaidSolver('turnstile'), true);
});

test('isVerifiedSessionFresh is a grace window, not a one-time token replay', () => {
  const now = 1_000_000;
  assert.equal(isVerifiedSessionFresh(0, now), false);
  assert.equal(isVerifiedSessionFresh(now - 10_000, now), true);
  assert.equal(isVerifiedSessionFresh(now - DEFAULT_CAPTCHA_PASS_GRACE_MS - 1, now), false);
});
