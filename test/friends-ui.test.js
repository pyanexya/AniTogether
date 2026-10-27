import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { friendsApi, visiblePoll, DEFAULT_WATCH_SERVER } from '../src/app/platform/friends.js';
import { prepareAcceptedInvite } from '../src/app/components/watch-together/accepted-invite.js';
const media = { releaseId: 5, episodePosition: 1, sourceId: 8, dubberId: 3 };
const invitation = { serverUrl: DEFAULT_WATCH_SERVER, roomId: '1234567890ab', inviteToken: 'a'.repeat(48) };
function fixture() {
    const destroy = vi.fn();
    class Client {
        subscribe(fn) { this.callback = fn; return vi.fn(); }
        join() { this.callback({ role: 'guest', status: 'connected', snapshot: { media } }); }
        destroy() { destroy(); }
    }
    const episode = { position: 1, source: { id: 8, type: { id: 3 } } };
    const catalog = { release: { info: vi.fn(async () => ({ release: { id: 5 } })), getEpisodes: vi.fn(async () => ({ episodes: [episode] })) } };
    return { Client, catalog, destroy, episode };
}
describe('native friends UI', () => {
    it('uses fixed typed commands without arbitrary URLs or account bearer', async () => {
        await friendsApi.invite('friend', 'room', 'host-proof');
        expect(invoke).toHaveBeenLastCalledWith('watch_invite_send', { recipientId: 'friend', roomId: 'room', hostToken: 'host-proof' });
        await friendsApi.acceptInvite('invitation');
        expect(invoke).toHaveBeenLastCalledWith('watch_invite_accept', { inviteId: 'invitation' });
    });
    it('resolves accepted room media through the local catalog and disposes temporary connection', async () => {
        const f = fixture();
        const result = await prepareAcceptedInvite(invitation, 'My profile', f);
        expect(f.catalog.release.getEpisodes).toHaveBeenCalledWith(5, 3, 8);
        expect(result.currentEpisode).toBe(f.episode);
        expect(result.acceptedWatchInvite).toBe(invitation);
        expect(f.destroy).toHaveBeenCalledOnce();
    });
    it('rejects non-default relay before connecting', async () => {
        const f = fixture();
        await expect(prepareAcceptedInvite({ ...invitation, serverUrl: 'wss://evil.example/watch' }, 'name', f)).rejects.toThrow('Invalid invitation server');
        expect(f.catalog.release.info).not.toHaveBeenCalled();
    });
    it('rejects catalog mismatch and still disposes the room connection', async () => {
        const f = fixture(); f.episode.source.id = 99;
        await expect(prepareAcceptedInvite(invitation, 'name', f)).rejects.toThrow('Media unavailable');
        expect(f.destroy).toHaveBeenCalledOnce();
    });
    it('cancellation before join does not access the catalog', async () => {
        const f = fixture(), controller = new AbortController(); controller.abort();
        await expect(prepareAcceptedInvite(invitation, 'name', { ...f, signal: controller.signal })).rejects.toThrow('Cancelled');
        expect(f.catalog.release.info).not.toHaveBeenCalled(); expect(f.destroy).toHaveBeenCalledOnce();
    });
    it('cancellation during catalog loading cannot navigate later', async () => {
        const f = fixture(), controller = new AbortController();
        f.catalog.release.info.mockImplementation(async () => { controller.abort(); return { release: { id: 5 } }; });
        await expect(prepareAcceptedInvite(invitation, 'name', { ...f, signal: controller.signal })).rejects.toThrow('Cancelled');
        expect(f.destroy).toHaveBeenCalledOnce();
    });
    it('visibility polling ignores late results after reset/logout', async () => {
        let finish; const receive = vi.fn(), documentRef = { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() };
        let enabled = true;
        const poll = visiblePoll({ read: () => new Promise(resolve => finish = resolve), receive, fail: vi.fn(), enabled: () => enabled, documentRef });
        const pending = poll.refresh(); enabled = false; poll.reset(); finish({ friends: ['old-account'] }); await pending;
        expect(receive).not.toHaveBeenCalled(); poll.destroy();
    });
    it('inbox does not auto-accept and Player removes capability from navigation arguments', () => {
        const inbox = readFileSync(new URL('../src/app/components/FriendsInviteInbox.svelte', import.meta.url), 'utf8');
        const player = readFileSync(new URL('../src/app/pages/Player.svelte', import.meta.url), 'utf8');
        expect(inbox).toContain('onclick={() => respond(invite, true)}');
        expect(inbox).toContain('read: friendsApi.invites');
        expect(inbox).toContain("window.addEventListener('anixartix:navigate', cancel)");
        expect(player).toContain('delete args.acceptedWatchInvite');
        const panel = readFileSync(new URL('../src/app/components/watch-together/WatchTogetherPanel.svelte', import.meta.url), 'utf8');
        expect(panel).toContain('const serverUrl = DEFAULT_WATCH_SERVER');
        expect(panel).not.toContain('bind:value={serverUrl}');
        expect(panel).toContain('friendsApi.invite(recipientId, view.roomId, client.memberToken)');
    });
});
