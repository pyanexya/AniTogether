import { describe, it, expect, vi } from 'vitest';
import { bootstrap, createBridge } from '../src/app/platform/bridge.js';
import { installNativeFetch } from '../src/app/platform/fetch.js';

const nativeMock = () => ({ invoke: vi.fn().mockResolvedValue({}), listen: vi.fn().mockResolvedValue(vi.fn()), convertFileSrc: vi.fn((path, scheme) => `${scheme}://${path}`) });
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('actual Tauri compatibility bridge', () => {
    it('maps payloads without leaking ignored OAuth secret', async () => {
        const native = nativeMock(); const { globals: g } = createBridge(native);
        await g.netElec.fetch('https://example.com', { method: 'POST', body: 'x' });
        expect(native.invoke).toHaveBeenLastCalledWith('net_fetch', { url: 'https://example.com', requestInfo: { method: 'POST', body: 'x' } });
        await g.shikimoriAuth.exchangeCode('code', 'shikimori.one', 'client', 'NEVER-SEND');
        expect(native.invoke).toHaveBeenLastCalledWith('oauth_exchange', { authCode: 'code', domain: 'shikimori.one', clientId: 'client' });
        await g.offlineApi.downloadEpisode({ id: 4 }, { id: 3 }, 'https://media.test/video');
        expect(native.invoke).toHaveBeenLastCalledWith('offline_download_episode', { animeMeta: { id: 4 }, episodeMeta: { id: 3 }, url: 'https://media.test/video' });
        await g.offlineApi.pauseDownload(4, 3);
        expect(native.invoke).toHaveBeenLastCalledWith('offline_pause_download', { animeId: 4, episodeId: 3 });
        native.invoke.mockResolvedValue('http://127.0.0.1:32123/offline-token');
        const offlineUrl = await g.offlineApi.mediaUrl('safe.mp4');
        expect(native.invoke).toHaveBeenLastCalledWith('offline_open', { id: 'safe.mp4' });
        expect(g.mediaTransport.isLocalUrl(offlineUrl)).toBe(true);
        await g.offlineApi.close(offlineUrl);
        expect(native.invoke).toHaveBeenLastCalledWith('media_close', { proxyUrl: offlineUrl });
        expect(g.mediaTransport.isLocalUrl(offlineUrl)).toBe(false);
    });
    it('tracks native media origins only during source lifetime', async () => {
        const native = nativeMock(); native.invoke.mockResolvedValue('http://127.0.0.1:32123/secret/source');
        const { globals: g } = createBridge(native);
        const proxyUrl = await g.mediaTransport.open('https://media.test/a.m3u8', 'https://provider.test/');
        expect(native.invoke).toHaveBeenLastCalledWith('media_open', { url: 'https://media.test/a.m3u8', referer: 'https://provider.test/' });
        expect(g.mediaTransport.isLocalUrl('http://127.0.0.1:32123/secret/segment')).toBe(true);
        expect(g.mediaTransport.isLocalUrl('http://127.0.0.1:32124/secret')).toBe(false);
        await g.mediaTransport.close(proxyUrl);
        expect(native.invoke).toHaveBeenLastCalledWith('media_close', { proxyUrl });
        expect(g.mediaTransport.isLocalUrl(proxyUrl)).toBe(false);
    });
    it('releases offline handles that arrive after bridge disposal', async () => {
        const native = nativeMock(); let resolve;
        native.invoke.mockImplementation(command => command === 'offline_open' ? new Promise(r => { resolve = r; }) : Promise.resolve());
        const bridge = createBridge(native);
        const pending = bridge.globals.offlineApi.open('safe.mp4');
        bridge.dispose(); resolve('http://127.0.0.1:32123/late-file');
        await expect(pending).rejects.toThrow('закрыта');
        expect(native.invoke).toHaveBeenLastCalledWith('media_close', { proxyUrl: 'http://127.0.0.1:32123/late-file' });
    });
    it('unwraps events and synchronously returns an idempotent disposer', async () => {
        const native = nativeMock(), callback = vi.fn(), stop = vi.fn();
        native.listen.mockResolvedValue(stop);
        const bridge = createBridge(native), dispose = bridge.globals.offlineApi.onProgress(callback);
        await flush();
        expect(native.listen.mock.calls[0][0]).toBe('offline:progress');
        native.listen.mock.calls[0][1]({ payload: { percent: 25 } });
        expect(callback).toHaveBeenCalledWith({ percent: 25 });
        dispose(); dispose(); bridge.dispose();
        native.listen.mock.calls[0][1]({ payload: { percent: 50 } });
        expect(stop).toHaveBeenCalledTimes(1); expect(callback).toHaveBeenCalledTimes(1);
    });
    it('cleans late subscription resolution after unmount', async () => {
        const native = nativeMock(); let resolve; const stop = vi.fn();
        native.listen.mockReturnValue(new Promise(r => { resolve = r; }));
        const bridge = createBridge(native); bridge.globals.debugApi.onLog(vi.fn())();
        await flush(); resolve(stop); await flush(); expect(stop).toHaveBeenCalledTimes(1);
    });
    it('reports subscription failures without unhandled rejection', async () => {
        const native = nativeMock(), report = vi.fn(); native.listen.mockRejectedValue(new Error('denied'));
        createBridge({ ...native, report }).globals.updater.onStatus(vi.fn());
        await flush(); expect(report).toHaveBeenCalledOnce();
    });
    it('never imports app until settings and versions resolve and globals exist', async () => {
        const native = nativeMock(), target = {}; let ready;
        native.invoke.mockImplementation(command => command === 'settings_get_all' ? new Promise(r => { ready = r; }) : Promise.resolve({ runtime: 'tauri' }));
        const loadApp = vi.fn(() => { expect(target.baseSettings.theme).toBe('dark'); expect(target.offlineApi).toBeTruthy(); return 'APP'; });
        const mountApp = vi.fn(); const pending = bootstrap({ target, native, loadApp, mountApp });
        await flush(); expect(loadApp).not.toHaveBeenCalled(); ready({ theme: 'dark' }); await pending;
        expect(mountApp).toHaveBeenCalledWith('APP');
    });
    it('fails closed outside native runtime or on bootstrap IPC failure', async () => {
        const loadApp = vi.fn(), mountApp = vi.fn();
        await expect(bootstrap({ target: {}, native: null, loadApp, mountApp })).rejects.toThrow('Tauri');
        const native = nativeMock(); native.invoke.mockRejectedValue(new Error('IPC unavailable'));
        await expect(bootstrap({ target: {}, native, loadApp, mountApp })).rejects.toThrow('IPC unavailable');
        expect(loadApp).not.toHaveBeenCalled(); expect(mountApp).not.toHaveBeenCalled();
    });
    it('exposes unsupported RPC honestly without calling unavailable native RPC', async () => {
        const native = nativeMock(), target = {};
        native.invoke.mockImplementation(command => Promise.resolve(command === 'runtime_versions' ? { capabilities: { discord: false } } : {}));
        await bootstrap({ target, native, loadApp: async () => ({}), mountApp: () => {} });
        expect(await target.discordRPC.setActivity({})).toMatchObject({ supported: false });
        expect(native.invoke).not.toHaveBeenCalledWith('discord_set', expect.anything());
    });
});

describe('native HTTP fetch adapter', () => {
    const fixture = () => {
        const target = { fetch: vi.fn(), netElec: { fetch: vi.fn().mockResolvedValue({ status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, text: '{"ok":true}' }) } };
        installNativeFetch(target); return target;
    };
    it('retains HTTP response semantics and request headers/body', async () => {
        const target = fixture(); const response = await target.fetch('https://api.test/auth', { method: 'POST', headers: new Headers({ 'x-test': '1' }), body: new URLSearchParams({ login: 'a' }) });
        expect(await response.json()).toEqual({ ok: true }); expect(response.ok).toBe(true);
        expect(target.netElec.fetch).toHaveBeenCalledWith('https://api.test/auth', { method: 'POST', headers: { 'x-test': '1', 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'login=a' });
    });
    it('passes binary request bytes losslessly', async () => {
        const target = fixture(); await target.fetch('https://api.test/image', { method: 'POST', body: new Uint8Array([0, 255, 128]) });
        expect(target.netElec.fetch.mock.calls[0][1].bodyBytes).toEqual([0, 255, 128]);
    });
    it('cancels renderer wait while ignoring late native responses', async () => {
        const target = fixture(), controller = new AbortController(); target.netElec.fetch.mockReturnValue(new Promise(() => {}));
        const pending = target.fetch('https://api.test', { signal: controller.signal }); controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });
    it('does not route local offline media through text IPC', async () => {
        const original = vi.fn().mockResolvedValue('MEDIA'), target = { fetch: original, netElec: { fetch: vi.fn() } };
        installNativeFetch(target); expect(await target.fetch('http://offline.localhost/a.mp4')).toBe('MEDIA');
        expect(target.netElec.fetch).not.toHaveBeenCalled();
    });
});
