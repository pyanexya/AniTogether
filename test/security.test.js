import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { isTrustedAppUrl, isHttpUrl, shikimoriTokenUrl, redactedUrl, isTrustedMainFrame } = require('../src/security.js');

describe('renderer trust boundary', () => {
  it('accepts only the app origin, with development origin explicitly enabled', () => {
    expect(isTrustedAppUrl('app://-/index.html')).toBe(true);
    expect(isTrustedAppUrl('http://localhost:8080/', true)).toBe(true);
    for (const url of ['https://example.com', 'app://evil/', 'file:///tmp/a.html', 'javascript:alert(1)', 'app://user@-/']) {
      expect(isTrustedAppUrl(url, true)).toBe(false);
    }
    expect(isTrustedAppUrl('http://localhost:8080/', false)).toBe(false);
    expect(isTrustedAppUrl('http://localhost:8081/', true)).toBe(false);
  });

  it('rejects subframes, foreign webContents and destroyed windows', () => {
    const frame = { url: 'app://-/index.html' };
    const contents = { mainFrame: frame };
    const window = { isDestroyed: () => false, webContents: contents };
    const event = { sender: contents, senderFrame: frame };
    expect(isTrustedMainFrame(event, window)).toBe(true);
    expect(isTrustedMainFrame({ ...event, sender: {} }, window)).toBe(false);
    expect(isTrustedMainFrame({ ...event, senderFrame: { url: frame.url } }, window)).toBe(false);
    expect(isTrustedMainFrame(event, { ...window, isDestroyed: () => true })).toBe(false);
    expect(isTrustedMainFrame(event, null)).toBe(false);
    frame.url = 'https://example.com/';
    expect(isTrustedMainFrame(event, window)).toBe(false);
  });
});

describe('URL and OAuth validation', () => {
  it('allows HTTP providers but not executable URLs or embedded credentials', () => {
    expect(isHttpUrl('https://video.sibnet.ru/video123.html')).toBe(true);
    expect(isHttpUrl('http://example.com/video.mp4')).toBe(true);
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@example.com', null, 'x'.repeat(17000)]) {
      expect(isHttpUrl(url)).toBe(false);
    }
  });

  it('constrains credential transmission to the three existing Shikimori mirrors', () => {
    for (const domain of ['shikimori.io', 'shikimori.me', 'shikimori.one']) {
      expect(shikimoriTokenUrl(domain)).toBe(`https://${domain}/oauth/token`);
    }
    for (const domain of ['shikimori.io.evil.test', 'shikimori.io@evil.test', 'evil.test', 'https://shikimori.io']) {
      expect(() => shikimoriTokenUrl(domain)).toThrow();
    }
  });

  it('does not include query credentials, URL credentials or fragments in URL logs', () => {
    expect(redactedUrl('https://user:password@example.com/video?token=secret#code')).toBe('https://example.com/video?[redacted]');
    expect(redactedUrl('https://example.com/video#token')).toBe('https://example.com/video');
  });
});

describe('fork build safety invariants', () => {
  it('does not embed an OAuth client secret or use the upstream updater', () => {
    const rollup = fs.readFileSync(new URL('../rollup.config.js', import.meta.url), 'utf8');
    const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    expect(rollup).not.toContain('envVars.SHIKIMORI_CLIENT_SECRET');
    expect(main).not.toContain('autoUpdater.');
    expect(main).not.toContain('api.github.com/repos/MjKey/AniXFlow/releases/latest');
  });
});
