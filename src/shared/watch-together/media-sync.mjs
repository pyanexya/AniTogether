import { sameMedia, projectedPosition, normalizeMedia } from './protocol.mjs';

/** Bind only to an already locally resolved video. Never load a remote URL. */
export function attachMediaSync({ client, video, getMedia, onMismatch = () => {}, onAutoplayBlocked = () => {}, onError = () => {} }) {
  let destroyed = false, applying = false, buffering = false, autoplayBlocked = false, wasConnected = false;
  let suspended = false, previousRole = null, wasGuest = false;
  const originalPlaybackRate = video.playbackRate;
  let applyTimer, publishTimer, lastMismatch = '', lastSnapshot = null;
  const report = code => { try { onError(code); } catch {} };
  function media() { try { return normalizeMedia(getMedia()); } catch { return null; } }
  function publish() {
    if (destroyed || suspended || applying || client.view.role !== 'host' || client.view.status !== 'connected' || !media() || !Number.isFinite(video.currentTime)) return;
    try { client.publish({ media: media(), position: Math.max(0, video.currentTime), paused: video.paused || video.ended, buffering, rate: video.playbackRate }); } catch { report('INVALID_LOCAL_PLAYBACK'); }
  }
  function schedulePublish() { clearTimeout(publishTimer); publishTimer = setTimeout(publish, 100); }
  async function apply() {
    if (destroyed || suspended || applying || client.view.role !== 'guest' || client.view.status !== 'connected') return;
    const snapshot = client.view.snapshot;
    if (!snapshot || !media()) return;
    if (!sameMedia(media(), snapshot.media)) {
      video.pause();
      const key = JSON.stringify(snapshot.media);
      if (lastMismatch !== key) { lastMismatch = key; try { onMismatch(snapshot.media); } catch { report('MEDIA_MISMATCH'); } }
      return;
    }
    lastMismatch = '';
    if (video.readyState < 1 || video.seeking) return;
    applying = true;
    try {
      const target = Math.min(projectedPosition(snapshot, client.serverNow()), Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.05) : Infinity);
      const drift = target - video.currentTime;
      if (Math.abs(drift) > 1.25 || ((snapshot.paused || snapshot.buffering) && Math.abs(drift) > 0.2)) video.currentTime = target;
      const adjustment = !snapshot.paused && !snapshot.buffering && Math.abs(drift) > 0.2 ? Math.sign(drift) * 0.04 : 0;
      video.playbackRate = Math.max(0.25, Math.min(3, snapshot.rate + adjustment));
      if (snapshot.paused || snapshot.buffering || !snapshot.hostOnline) { video.pause(); autoplayBlocked = false; }
      else if (video.paused && !autoplayBlocked) {
        try { await video.play(); } catch (error) {
          if (destroyed) return;
          if (error?.name === 'NotAllowedError') { autoplayBlocked = true; onAutoplayBlocked(); }
          else report('PLAYBACK_FAILED');
        }
      }
    } catch { report('SYNC_FAILED'); }
    finally { clearTimeout(applyTimer); if (!destroyed) applyTimer = setTimeout(() => { applying = false; }, 150); else applying = false; }
  }
  const playbackEvent = () => {
    if (applying || destroyed) return;
    if (client.view.role === 'host') schedulePublish();
    else { autoplayBlocked = false; apply(); }
  };
  const waiting = () => { buffering = true; if (client.view.role === 'host') schedulePublish(); };
  const ready = () => { buffering = false; if (client.view.role === 'host') schedulePublish(); else apply(); };
  const events = [['play', playbackEvent], ['pause', playbackEvent], ['seeked', playbackEvent], ['ratechange', playbackEvent], ['ended', playbackEvent], ['waiting', waiting], ['stalled', waiting], ['playing', ready], ['canplay', ready], ['loadedmetadata', ready]];
  for (const [name, fn] of events) video.addEventListener(name, fn);
  const unsubscribe = client.subscribe(view => {
    if (view.status !== 'connected') {
      if (wasConnected && previousRole === 'guest') video.pause();
      wasConnected = false;
      if (['idle', 'closed', 'error'].includes(view.status) && previousRole === 'guest') video.playbackRate = originalPlaybackRate;
      return;
    }
    if (!wasConnected && view.role === 'host') schedulePublish();
    wasConnected = true; previousRole = view.role; if (view.role === 'guest') wasGuest = true;
    if (view.snapshot !== lastSnapshot) { lastSnapshot = view.snapshot; if (view.role === 'guest') apply(); }
  });
  const timer = setInterval(() => { if (client.view.role === 'host') publish(); else apply(); }, 2000);
  return {
    suspend() {
      if (client.view.role === 'host' && client.view.snapshot && client.view.status === 'connected') {
        const state = client.view.snapshot;
        client.publish({ media: state.media, position: Number.isFinite(video.currentTime) ? video.currentTime : state.position, paused: true, buffering: true, rate: state.rate });
      }
      suspended = true; clearTimeout(publishTimer);
    },
    refresh() { suspended = false; autoplayBlocked = false; lastMismatch = ''; if (client.view.role === 'host') publish(); else { client.requestSnapshot(); apply(); } },
    destroy() { destroyed = true; unsubscribe(); clearInterval(timer); clearTimeout(applyTimer); clearTimeout(publishTimer); for (const [name, fn] of events) video.removeEventListener(name, fn); if (wasGuest) video.playbackRate = originalPlaybackRate; }
  };
}
