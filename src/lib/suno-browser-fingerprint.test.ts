import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildChromeFingerprint,
  buildChromeMacFingerprint,
  captchaWorkerLang,
  chromePlatformFromNode,
  fingerprintHttpHeaders,
  playwrightLocaleFromEnv,
  sunoCookieInjectList
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

test('Linux fingerprint does not claim macOS', () => {
  const fp = buildChromeFingerprint('131', 'Linux');
  assert.match(fp.userAgent, /X11; Linux x86_64/);
  assert.equal(fp.platform, 'Linux');
  assert.equal(fp.navigatorPlatform, 'Linux x86_64');
  assert.equal(fp.deviceScaleFactor, 1);
  assert.equal(fingerprintHttpHeaders(fp)['sec-ch-ua-platform'], '"Linux"');
  assert.equal(fp.userAgent.includes('Macintosh'), false);
});

test('chromePlatformFromNode maps process.platform', () => {
  assert.equal(chromePlatformFromNode('linux'), 'Linux');
  assert.equal(chromePlatformFromNode('win32'), 'Windows');
  assert.equal(chromePlatformFromNode('darwin'), 'macOS');
});

test('sunoCookieInjectList copies Clerk cookies onto auth.suno.com', () => {
  const injected = sunoCookieInjectList(
    { __client: 'clerk', ajs_anonymous_id: 'anon' },
    'jwt'
  );
  const domains = injected.map((item) => `${item.name}@${item.domain}`).sort();
  assert.deepEqual(domains, [
    '__client@.suno.com',
    '__client@auth.suno.com',
    '__session@.suno.com',
    'ajs_anonymous_id@.suno.com'
  ]);
  assert.equal(injected.find((item) => item.name === '__session')?.value, 'jwt');
});

test('playwrightLocaleFromEnv maps 2Captcha short codes', () => {
  assert.equal(playwrightLocaleFromEnv('en'), 'en-US');
  assert.equal(playwrightLocaleFromEnv('ru'), 'ru-RU');
  assert.equal(playwrightLocaleFromEnv('en-US'), 'en-US');
  assert.equal(captchaWorkerLang('en-US'), 'en');
  assert.equal(captchaWorkerLang('ru-RU'), 'ru');
});
