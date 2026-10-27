// Only canonical catalog identifiers leave the renderer. Never return URLs or tokens.
export function resolveEpisodeSource(episode, episodes = []) {
    if (episode?.source && typeof episode.source === 'object') return episode.source;
    if (!['number', 'string'].includes(typeof episode?.source)) return null;
    return episodes.find((item) => item?.source && typeof item.source === 'object' && item.source['@id'] === episode?.source)?.source || null;
}

export function resolveEpisodeDubber(episode, episodes = []) {
    const source = resolveEpisodeSource(episode, episodes);
    if (source?.type && typeof source.type === 'object') return source.type;
    if (!['number', 'string'].includes(typeof source?.type)) return null;
    for (const item of episodes) {
        const candidate = resolveEpisodeSource(item, episodes)?.type;
        if (candidate && typeof candidate === 'object' && candidate['@id'] === source?.type) return candidate;
    }
    return null;
}

const positiveId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
export function playerMediaIdentity(release, episode, episodes = []) {
    const source = resolveEpisodeSource(episode, episodes);
    const releaseId = positiveId(release?.id);
    const sourceId = positiveId(source?.id);
    const dubberId = positiveId(resolveEpisodeDubber(episode, episodes)?.id);
    const episodePosition = Number(episode?.position);
    if (!releaseId || !sourceId || !dubberId || !Number.isSafeInteger(episodePosition) || episodePosition < 0) return null;
    return { releaseId, episodePosition, sourceId, dubberId };
}

export const mediaIdentityKey = (value) => value ? [value.releaseId, value.episodePosition, value.sourceId, value.dubberId].join(':') : '';

/** Serial, latest-target-wins coordination for asynchronous local catalog resolution. */
export function createMediaFollower({ load, onLoading = () => {}, onComplete = () => {}, onError = () => {} }) {
    let active = null;
    let pending = null;
    let lastAttempt = '';
    let disposed = false;
    function drain() {
        if (disposed || active || !pending) return;
        const media = pending;
        pending = null;
        lastAttempt = mediaIdentityKey(media);
        const token = {};
        active = token;
        onLoading(true);
        Promise.resolve().then(() => {
            if (active !== token || disposed) return;
            return load(media);
        }).then(() => {
            if (active === token && !disposed) onComplete(media);
        }).catch((error) => {
            if (active === token && !disposed) onError(error);
        }).finally(() => {
            if (active !== token || disposed) return;
            active = null;
            onLoading(false);
            drain();
        });
    }
    return {
        request(media, force = false) {
            if (disposed || !media) return;
            const key = mediaIdentityKey(media);
            if (!force && key === lastAttempt && !pending) return;
            pending = media;
            drain();
        },
        cancel() {
            active = null;
            pending = null;
            lastAttempt = '';
            onLoading(false);
        },
        destroy() {
            disposed = true;
            active = null;
            pending = null;
        },
    };
}
