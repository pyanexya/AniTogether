// Shared trust-boundary checks. Keep these free of Electron side effects for tests.
const SHIKIMORI_DOMAINS = new Set(['shikimori.io', 'shikimori.me', 'shikimori.one']);

function isTrustedAppUrl(value, allowDev = false) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return (url.protocol === 'app:' && url.hostname === '-') ||
      (allowDev && url.origin === 'http://localhost:8080');
  } catch (_) {
    return false;
  }
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 16384) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch (_) {
    return false;
  }
}

function shikimoriTokenUrl(domain = 'shikimori.io') {
  if (!SHIKIMORI_DOMAINS.has(domain)) throw new Error('Unsupported Shikimori domain');
  return `https://${domain}/oauth/token`;
}

function redactedUrl(value) {
  try {
    const url = new URL(value);
    // Signed media links and OAuth parameters must not enter debug logs.
    return `${url.protocol}//${url.host}${url.pathname}${url.search ? '?[redacted]' : ''}`;
  } catch (_) {
    return '[invalid URL]';
  }
}

function isTrustedMainFrame(event, mainWindow, allowDev = false) {
  if (!mainWindow || mainWindow.isDestroyed() || !event?.senderFrame) return false;
  const contents = mainWindow.webContents;
  return event.sender === contents && event.senderFrame === contents.mainFrame &&
    isTrustedAppUrl(event.senderFrame.url, allowDev);
}

module.exports = { isTrustedAppUrl, isHttpUrl, shikimoriTokenUrl, redactedUrl, isTrustedMainFrame };
