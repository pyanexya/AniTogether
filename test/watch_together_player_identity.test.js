import { describe, expect, it } from 'vitest';
import { playerMediaIdentity, resolveEpisodeSource } from '../src/app/components/watch-together/player-media.js';

const source = { '@id': 500, id: 12, name: 'Kodik', type: { id: 34, name: 'Dubber' } };
const episode = { id: 99, position: 3, source, url: 'https://private.example/video?token=SECRET' };
describe('watch-together catalog identity', () => {
    it('sends only canonical identity, excluding tokens, URLs, metadata, and hydration references', () => {
        expect(playerMediaIdentity({ id: 22, title: 'Private', token: 'SECRET' }, episode)).toEqual({ releaseId: 22, episodePosition: 3, sourceId: 12, dubberId: 34 });
    });
    it('resolves a shared source object via the API hydration reference', () => {
        const refEpisode = { position: 4, source: 500 };
        expect(resolveEpisodeSource(refEpisode, [episode, refEpisode])).toBe(source);
        expect(playerMediaIdentity({ id: 22 }, refEpisode, [episode, refEpisode])).toEqual({ releaseId: 22, episodePosition: 4, sourceId: 12, dubberId: 34 });
    });
    it.each([null, {}, { position: 1, source: 900 }, { position: 1, source: { id: 12 } }, { position: -1, source }, { position: NaN, source }])('rejects incomplete or invalid media identity %#', (value) => {
        expect(playerMediaIdentity({ id: 22 }, value, [episode])).toBeNull();
    });
    it('does not silently use hydration IDs when canonical source or dubber is missing', () => {
        expect(playerMediaIdentity({ id: 22 }, { position: 1, source: { '@id': 50, type: { '@id': 30 } } })).toBeNull();
    });
    it('accepts numeric API IDs while rejecting unsafe integers', () => {
        expect(playerMediaIdentity({ id: '22' }, episode)?.releaseId).toBe(22);
        expect(playerMediaIdentity({ id: Number.MAX_SAFE_INTEGER + 1 }, episode)).toBeNull();
    });
});

import { createMediaFollower } from '../src/app/components/watch-together/player-media.js';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const identity = (episodePosition) => ({ releaseId: 22, sourceId: 12, dubberId: 34, episodePosition });
describe('latest host media follow coordination', () => {
    it('loads the newest host target after an earlier lookup completes, without dropping the change', async () => {
        const calls = [], finish = [], completed = [];
        const follower = createMediaFollower({ load: (m) => { calls.push(m.episodePosition); return new Promise((resolve) => finish.push(resolve)); }, onComplete: (m) => completed.push(m.episodePosition) });
        follower.request(identity(1)); await tick();
        follower.request(identity(2)); follower.request(identity(3));
        expect(calls).toEqual([1]); finish[0](); await tick();
        expect(calls).toEqual([1, 3]); finish[1](); await tick();
        expect(completed).toEqual([1, 3]); follower.destroy();
    });
    it('ignores completion after leaving and does not clear loading for a new session', async () => {
        const finish = [], completed = [], states = [];
        const follower = createMediaFollower({ load: () => new Promise((resolve) => finish.push(resolve)), onLoading: (v) => states.push(v), onComplete: (m) => completed.push(m.episodePosition) });
        follower.request(identity(1)); await tick(); follower.cancel();
        follower.request(identity(2)); await tick();
        finish[0](); await tick(); expect(completed).toEqual([]); expect(states.at(-1)).toBe(true);
        finish[1](); await tick(); expect(completed).toEqual([2]); expect(states.at(-1)).toBe(false);
        follower.destroy();
    });
    it('does not repeatedly reload failed media without an explicit retry', async () => {
        let calls = 0;
        const follower = createMediaFollower({ load: async () => { ++calls; throw new Error('Unavailable'); } });
        follower.request(identity(1)); await tick(); follower.request(identity(1)); await tick(); expect(calls).toBe(1);
        follower.request(identity(1), true); await tick(); expect(calls).toBe(2); follower.destroy();
    });
    it('does not call load after cancellation before its microtask starts', async () => {
        let calls = 0;
        const follower = createMediaFollower({ load: async () => { ++calls; } });
        follower.request(identity(1)); follower.destroy(); await tick(); expect(calls).toBe(0);
    });
});

it('resolves a nested dubber hydration reference only through an explicit catalog object', () => {
    const referenced = { position: 1, source: { '@id': 700, id: 12, type: 800 } };
    const donor = { position: 2, source: { '@id': 701, id: 13, type: { '@id': 800, id: 34, name: 'Dubber' } } };
    expect(playerMediaIdentity({ id: 22 }, referenced, [referenced, donor])).toEqual({ releaseId: 22, episodePosition: 1, sourceId: 12, dubberId: 34 });
    expect(playerMediaIdentity({ id: 22 }, referenced, [referenced])).toBeNull();
});
