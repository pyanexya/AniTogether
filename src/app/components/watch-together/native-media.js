// Native registrations are scoped to a player, never broadcast to room peers.
export function createNativeMediaSession(transport, offlineTransport = null) {
    let generation = 0, current = null, destroyed = false;
    const close = async (url) => { if (url) { try { await transport.close(url); } catch {} } };
    return {
        async open(url, referer, valid = () => true) {
            const request = ++generation;
            if (destroyed || !transport?.open || !transport?.close) throw new Error('NATIVE_MEDIA_UNAVAILABLE');
            const offline = typeof url === 'string' && url.startsWith('offline-file:');
            if (offline && !offlineTransport?.open) throw new Error('OFFLINE_MEDIA_UNAVAILABLE');
            const local = offline
                ? await offlineTransport.open(decodeURIComponent(url.slice('offline-file:'.length)))
                : await transport.open(url, referer);
            if (destroyed || request !== generation || !valid()) { await close(local); return null; }
            let parsed;
            try { parsed = new URL(local); } catch { await close(local); throw new Error('INVALID_NATIVE_MEDIA'); }
            if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password) { await close(local); throw new Error('INVALID_NATIVE_MEDIA'); }
            const old = current; current = local; await close(old);
            if (destroyed || request !== generation || !valid()) {
                if (current === local) { current = null; await close(local); }
                return null;
            }
            return local;
        },
        cancel() { ++generation; const old = current; current = null; return close(old); },
        destroy() { destroyed = true; ++generation; const old = current; current = null; return close(old); },
    };
}
export const originalIsHls = (url) => typeof url === 'string' && /\.m3u8(?:[?#]|$)|:hls:/i.test(url);
export function providerReferer(source) {
    if (source?.name === 'Kodik') return 'https://kodik.info/';
    if (source?.name === 'Sibnet') return 'https://video.sibnet.ru/';
    return null;
}

export const classifiedIsHls = (original, local) => originalIsHls(original) || originalIsHls(local);
