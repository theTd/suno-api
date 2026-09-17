import { Page } from 'rebrowser-playwright-core';

/** Playwright 1.49 ships Chromium 131; used until browser.version() is known. */
export const DEFAULT_CHROME_MAJOR = '131';

export interface ChromeMacFingerprint {
  chromeMajor: string;
  fullVersion: string;
  userAgent: string;
  secChUa: string;
  acceptLanguage: string;
  languages: string[];
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  platform: 'macOS';
  platformVersion: string;
  viewport: { width: number; height: number };
  screen: { width: number; height: number };
  deviceScaleFactor: number;
  timezoneId: string;
  playwrightLocale: string;
}

export function envInt(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** Playwright `locale` (BCP 47). `BROWSER_LOCALE=en|ru` still works for 2Captcha. */
export function playwrightLocaleFromEnv(raw?: string): string {
  const value = (raw ?? process.env.BROWSER_LOCALE ?? 'en-US').trim();
  const lower = value.toLowerCase();
  if (lower === 'en' || lower === 'en-us')
    return 'en-US';
  if (lower === 'ru' || lower === 'ru-ru')
    return 'ru-RU';
  const bcp = value.match(/^([a-z]{2})[-_]([a-z]{2})$/i);
  if (bcp)
    return `${bcp[1].toLowerCase()}-${bcp[2].toUpperCase()}`;
  if (/^[a-z]{2}$/i.test(value))
    return `${value.toLowerCase()}-${value.toUpperCase()}`;
  return 'en-US';
}

/** 2Captcha `lang` wants a short code (`en` / `ru`), not `en-US`. */
export function captchaWorkerLang(raw?: string): string {
  const locale = (raw ?? process.env.BROWSER_LOCALE ?? 'en').toLowerCase();
  if (locale.startsWith('ru'))
    return 'ru';
  return 'en';
}

/**
 * Desktop Chrome-on-macOS identity. Brands never include HeadlessChrome.
 * Axios and the Chromium session must send the same UA + client hints.
 */
export function buildChromeMacFingerprint(chromeMajor?: string | number): ChromeMacFingerprint {
  const major = String(chromeMajor || process.env.BROWSER_CHROME_MAJOR || DEFAULT_CHROME_MAJOR)
    .split('.')[0]
    .replace(/\D/g, '') || DEFAULT_CHROME_MAJOR;
  const fullVersion = `${major}.0.0.0`;
  const brands = [
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
    { brand: 'Not_A Brand', version: '24' }
  ];
  const fullVersionList = brands.map((item) => ({
    brand: item.brand,
    version: item.brand === 'Not_A Brand' ? '10.0.0.0' : fullVersion
  }));
  const secChUa = brands.map((item) => `"${item.brand}";v="${item.version}"`).join(', ');
  const locale = playwrightLocaleFromEnv();
  const russian = locale.toLowerCase().startsWith('ru');
  return {
    chromeMajor: major,
    fullVersion,
    userAgent:
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${fullVersion} Safari/537.36`,
    secChUa,
    acceptLanguage: russian
      ? 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
      : 'en-US,en;q=0.9',
    languages: russian ? ['ru-RU', 'ru', 'en-US', 'en'] : ['en-US', 'en'],
    brands,
    fullVersionList,
    platform: 'macOS',
    platformVersion: '14.6.0',
    viewport: { width: 1512, height: 982 },
    screen: { width: 3024, height: 1964 },
    deviceScaleFactor: 2,
    timezoneId: process.env.BROWSER_TIMEZONE || 'America/Los_Angeles',
    playwrightLocale: locale
  };
}

export function fingerprintHttpHeaders(fp: ChromeMacFingerprint): Record<string, string> {
  return {
    'User-Agent': fp.userAgent,
    'sec-ch-ua': fp.secChUa,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'Accept-Language': fp.acceptLanguage
  };
}

export function contextOptionsFromFingerprint(fp: ChromeMacFingerprint) {
  return {
    userAgent: fp.userAgent,
    locale: fp.playwrightLocale,
    timezoneId: fp.timezoneId,
    viewport: fp.viewport,
    screen: fp.screen,
    deviceScaleFactor: fp.deviceScaleFactor,
    isMobile: false,
    hasTouch: false,
    colorScheme: 'light' as const,
    extraHTTPHeaders: {
      'sec-ch-ua': fp.secChUa,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'Accept-Language': fp.acceptLanguage
    }
  };
}

export function stealthInitPayload(fp: ChromeMacFingerprint) {
  return {
    languages: fp.languages,
    language: fp.languages[0],
    userAgent: fp.userAgent,
    platform: 'MacIntel',
    brands: fp.brands,
    fullVersionList: fp.fullVersionList,
    uaFullVersion: fp.fullVersion,
    platformVersion: fp.platformVersion
  };
}

type StealthInitParams = ReturnType<typeof stealthInitPayload>;

/** Runs in the page before any site JS. Must stay self-contained. */
export function applyStealthInit(params: StealthInitParams): void {
  const w = window as any;
  try {
    Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => undefined });
  } catch {}
  try {
    Object.defineProperty(navigator, 'language', { configurable: true, get: () => params.language });
    Object.defineProperty(navigator, 'languages', {
      configurable: true,
      get: () => Object.freeze([...params.languages])
    });
  } catch {}
  try {
    Object.defineProperty(navigator, 'platform', { configurable: true, get: () => params.platform });
  } catch {}
  const uaData = {
    brands: params.brands,
    mobile: false,
    platform: 'macOS',
    getHighEntropyValues: async () => ({
      brands: params.brands,
      fullVersionList: params.fullVersionList,
      mobile: false,
      model: '',
      platform: 'macOS',
      platformVersion: params.platformVersion,
      architecture: 'x86',
      bitness: '64',
      uaFullVersion: params.uaFullVersion
    }),
    toJSON() {
      return { brands: params.brands, mobile: false, platform: 'macOS' };
    }
  };
  try {
    Object.defineProperty(navigator, 'userAgentData', { configurable: true, get: () => uaData });
  } catch {}
  if (!w.chrome) {
    w.chrome = { runtime: {}, loadTimes() {}, csi() {}, app: {} };
  }
}

/**
 * Overwrite Chromium client-hints metadata so sec-ch-ua cannot say HeadlessChrome
 * even if the process was launched headless.
 */
export async function applyChromiumUserAgentOverride(
  page: Page,
  fp: ChromeMacFingerprint
): Promise<void> {
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setUserAgentOverride', {
      userAgent: fp.userAgent,
      acceptLanguage: fp.acceptLanguage,
      platform: 'MacIntel',
      userAgentMetadata: {
        brands: fp.brands,
        fullVersionList: fp.fullVersionList,
        fullVersion: fp.fullVersion,
        platform: 'macOS',
        platformVersion: fp.platformVersion,
        architecture: 'x86',
        model: '',
        mobile: false,
        bitness: '64',
        wow64: false
      }
    });
  } catch {
    // Firefox and other non-CDP browsers skip this.
  }
}
