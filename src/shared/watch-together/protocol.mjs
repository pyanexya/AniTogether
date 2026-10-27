/* AnixArtix watch-together protocol. GPL-2.0, see LICENSE. */
export const VERSION = 1;
export const MAX_MESSAGE_BYTES = 4096;
export const MAX_POSITION = 7 * 24 * 60 * 60;
export const isToken = value => typeof value === 'string' && /^[a-f0-9]{48}$/.test(value);
export const isRoomId = value => typeof value === 'string' && /^[a-f0-9]{12}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
export function normalizeMedia(value) {
  if (!value || typeof value !== 'object' || !integer(value.releaseId) || value.releaseId === 0 || !integer(value.episodePosition)) throw new Error('Invalid media identity');
  if (!integer(value.sourceId) || value.sourceId === 0 || !integer(value.dubberId) || value.dubberId === 0) throw new Error('Invalid source or dubber identity');
  return { releaseId: value.releaseId, episodePosition: value.episodePosition, sourceId: value.sourceId, dubberId: value.dubberId };
}
export function sameMedia(a, b) {
  return !!a && !!b && a.releaseId === b.releaseId && a.episodePosition === b.episodePosition && a.sourceId === b.sourceId && a.dubberId === b.dubberId;
}
export function normalizePlayback(value) {
  if (!value || typeof value !== 'object' || !Number.isFinite(value.position) || value.position < 0 || value.position > MAX_POSITION || typeof value.paused !== 'boolean' || typeof value.buffering !== 'boolean' || !Number.isFinite(value.rate) || value.rate < 0.25 || value.rate > 3) throw new Error('Invalid playback state');
  return { media: normalizeMedia(value.media), position: value.position, paused: value.paused, buffering: value.buffering, rate: value.rate };
}
export function normalizeName(value) {
  if (typeof value !== 'string') return 'Зритель';
  return value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 32) || 'Зритель';
}
export function validateServerUrl(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search || (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && local))) throw new Error('Нужен wss:// сервер (ws:// разрешён только для localhost)');
  return url.href;
}
export function projectedPosition(snapshot, serverNow) {
  const elapsed = !snapshot.paused && !snapshot.buffering ? Math.max(0, Math.min(30_000, serverNow - snapshot.updatedAt)) / 1000 * snapshot.rate : 0;
  return Math.min(MAX_POSITION, snapshot.position + elapsed);
}
export function validSnapshot(value) {
  try {
    normalizePlayback(value);
    return integer(value.sequence) && typeof value.epoch === 'string' && /^[a-f0-9]{24}$/.test(value.epoch) && Number.isFinite(value.updatedAt) && typeof value.hostOnline === 'boolean';
  } catch { return false; }
}
