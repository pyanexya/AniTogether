import { WatchTogetherClient } from '../../../shared/watch-together/client.mjs';
import { playerMediaIdentity } from './player-media.js';
import { DEFAULT_WATCH_SERVER } from '../../platform/friends.js';

// Called only after the recipient explicitly accepts. No capability is persisted.
export async function prepareAcceptedInvite(invitation, name, { catalog, signal, Client = WatchTogetherClient, timeout = 15000 }) {
    if (invitation?.serverUrl !== DEFAULT_WATCH_SERVER) throw new Error('Invalid invitation server');
    const client = new Client();
    let unsubscribe, timer, abort;
    try {
        const media = await new Promise((resolve, reject) => {
            abort = () => reject(new Error('Cancelled'));
            if (signal?.aborted) return abort();
            signal?.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => reject(new Error('Room unavailable')), timeout);
            unsubscribe = client.subscribe(view => {
                if (view.status === 'closed' || view.status === 'error' || view.error) reject(new Error('Room unavailable'));
                else if (view.role === 'guest' && view.snapshot?.media) resolve(view.snapshot.media);
            });
            client.join({ ...invitation, name });
        });
        const [releaseResult, episodesResult] = await Promise.all([
            catalog.release.info(media.releaseId, true),
            catalog.release.getEpisodes(media.releaseId, media.dubberId, media.sourceId),
        ]);
        if (signal?.aborted) throw new Error('Cancelled');
        const episodes = episodesResult?.episodes || [];
        const episode = episodes.find(item => Number(item.position) === media.episodePosition);
        const actual = playerMediaIdentity(releaseResult?.release, episode, episodes);
        if (!actual || Object.keys(actual).some(field => actual[field] !== media[field])) throw new Error('Media unavailable');
        return { release: releaseResult.release, episodes, currentEpisode: episode, src: null, acceptedWatchInvite: invitation };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        unsubscribe?.();
        client.destroy();
    }
}
