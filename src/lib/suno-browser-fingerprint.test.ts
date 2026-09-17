import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildChromeMacFingerprint,
  captchaWorkerLang,
  fingerprintHttpHeaders,
  playwrightLocaleFromEnv
} from './suno-browser-fingerprint';

test('fingerprint never advertises HeadlessChrome', () => {
  const fp = buildChromeMacFingerprint('131');
  assert.equal(fp.userAgent.includes('HeadlessChrome'), false);
  assert.equal(fp.secChUa.includes('HeadlessChrome'), false);
  assert.equal(fp.brands.some((item) => /headless/i.test(item.brand)), false);
  assert.match(fp.userAgent, /Chrome\/131\.0\.0\.0/);
  assert.match(fp.secChUa, /"Google Chrome";v="131"/);
  assert.match(fp.secChUa, /"Chromium";v="131"/);
});

test('axios headers match the browser UA and client hints', () => {
  const fp = buildChromeMacFingerprint(132);
  const headers = fingerprintHttpHeaders(fp);
  assert.equal(headers['User-Agent'], fp.userAgent);
  assert.equal(headers['sec-ch-ua'], fp.secChUa);
  assert.equal(headers['sec-ch-ua-mobile'], '?0');
  assert.equal(headers['sec-ch-ua-platform'], '"macOS"');
  assert.ok(headers['Accept-Language'].length > 0);
});

test('playwrightLocaleFromEnv maps 2Captcha short codes', () => {
  assert.equal(playwrightLocaleFromEnv('en'), 'en-US');
  assert.equal(playwrightLocaleFromEnv('ru'), 'ru-RU');
  assert.equal(playwrightLocaleFromEnv('en-US'), 'en-US');
  assert.equal(captchaWorkerLang('en-US'), 'en');
  assert.equal(captchaWorkerLang('ru-RU'), 'ru');
});
