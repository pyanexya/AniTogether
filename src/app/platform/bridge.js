/** Native compatibility boundary. No Electron and no production browser mocks. */
export function createBridge({ invoke, listen, report = console.error }) {
    const subscriptions = new Set();
    const mediaSources = new Map();
    let bridgeDisposed = false;
    const call = (command, args = {}) => invoke(command, args);
    const registerMedia = proxyUrl => {
        if (bridgeDisposed) {
            call('media_close', { proxyUrl }).catch(error => report('Не удалось освободить медиатранспорт', error));
            throw new Error('Медиасессия уже закрыта');
        }
        const parsed = new URL(proxyUrl);
        if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) throw new Error('Некорректный адрес медиатранспорта');
        mediaSources.set(proxyUrl, parsed.origin);
        return proxyUrl;
    };
    const openOffline = async id => registerMedia(await call('offline_open', { id }));
    const on = (name, callback) => {
        let disposed = false, unlisten;
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            subscriptions.delete(dispose);
            if (unlisten) unlisten();
        };
        subscriptions.add(dispose);
        Promise.resolve().then(() => listen(name, event => {
            if (!disposed) callback(event.payload);
        })).then(stop => {
            if (disposed) stop(); else unlisten = stop;
        }).catch(error => { dispose(); report(`Не удалось подключить событие ${name}`, error); });
        return dispose;
    };
    const ids = (command) => (animeId, episodeId) => call(command, { animeId, episodeId });
    const bridge = {
        titleBarAPI: {
            minimize: () => call('window_minimize'), maximize: () => call('window_maximize'),
            close: () => call('window_close'), startDragging: () => call('window_start_dragging'),
        },
        mediaTransport: {
            open: async (url, referer) => {
                const proxyUrl = await call('media_open', { url, referer });
                return registerMedia(proxyUrl);
            },
            close: async proxyUrl => {
                try { return await call('media_close', { proxyUrl }); }
                finally { mediaSources.delete(proxyUrl); }
            },
            isLocalUrl: value => {
                try { return [...mediaSources.values()].includes(new URL(value).origin); }
                catch { return false; }
            },
        },
        analytics: { trackEvent: () => {} }, // Telemetry intentionally not collected.
        winApi: { openLink: link => call('open_link', { link }) },
        systemPower: { sleep: () => call('power_sleep'), shutdown: () => call('power_shutdown'), quitApp: () => call('app_quit') },
        Sibnet: { Parse: link => call('sibnet_parse', { link }) },
        elecWindow: {
            getSize: () => call('window_get_size'), exitFullscreen: () => call('window_leave_fullscreen'),
            enterFullscreen: () => call('window_enter_fullscreen'), isFullScreen: () => call('window_is_fullscreen'),
            onFullscreenChange: cb => on('fullscreen:changed', cb),
        },
        netElec: { fetch: (url, requestInfo = {}) => call('net_fetch', { url, requestInfo }) },
        prc: { getVersions: () => call('runtime_versions'), isDebug: () => call('runtime_debug') },
        notify: { send: data => call('notify_send', { data: { ...data, body: data.body ?? data.message ?? '' } }), onNavigateRelease: cb => on('navigate:release', cb) },
        debugApi: { onLog: cb => on('debug:log', cb), sendLog: (type, message, data) => call('debug_send', { data: { type, message, data } }) },
        shikimoriAuth: {
            exchangeCode: (authCode, domain, clientId) => call('oauth_exchange', { authCode, domain, clientId }),
            refreshToken: (refreshToken, domain, clientId) => call('oauth_refresh', { refreshToken, domain, clientId }),
        },
        discordRPC: { setActivity: activity => call('discord_set', { activity }), clearActivity: () => call('discord_clear') },
        settings: { getAll: () => call('settings_get_all'), get: key => call('settings_get', { key }), set: (key, value) => call('settings_set', { key, value }) },
        proxy: { toggle: enabled => call('proxy_toggle', { enabled }) },
        updater: { check: () => call('updater_check'), install: () => call('updater_install'), onStatus: cb => on('updater:status', cb) },
        offlineApi: {
            getLibrary: () => call('offline_get_library'), openFolder: () => call('offline_open_folder'),
            deleteEpisode: ids('offline_delete_episode'), cancelDownload: ids('offline_cancel_download'),
            pauseDownload: ids('offline_pause_download'), resumeDownload: ids('offline_resume_download'), retryDownload: ids('offline_retry_download'),
            downloadEpisode: (animeMeta, episodeMeta, url) => call('offline_download_episode', { animeMeta, episodeMeta, url }),
            getActiveDownloads: () => call('offline_get_active_downloads'),
            // Opens only the selected file; callers release returned URL via mediaTransport.close.
            open: openOffline,
            mediaUrl: openOffline,
            close: proxyUrl => bridge.mediaTransport.close(proxyUrl),
            onProgress: cb => on('offline:progress', cb), onError: cb => on('offline:error', cb), onCompleted: cb => on('offline:completed', cb),
        },
        episodeDownloader: { download: (url, defaultFileName, referer) => call('download_episode', { url, defaultFileName, referer }), onProgress: cb => on('download:progress', cb) },
    };
    return { globals: bridge, dispose: () => {
        bridgeDisposed = true;
        [...subscriptions].forEach(dispose => dispose());
        const sources = [...mediaSources.keys()];
        mediaSources.clear();
        for (const proxyUrl of sources) bridge.mediaTransport.close(proxyUrl).catch(error => report('Не удалось освободить медиатранспорт', error));
    } };
}

export async function bootstrap({ target, native, loadApp, mountApp, report = console.error }) {
    if (!native) throw new Error('AnixArtix нужно запускать как приложение Tauri. Браузерный режим не подключён к Rust.');
    const bridge = createBridge({ ...native, report });
    try {
        const [baseSettings, versions] = await Promise.all([bridge.globals.settings.getAll(), bridge.globals.prc.getVersions()]);
        if (!baseSettings || typeof baseSettings !== 'object' || !versions || typeof versions !== 'object') throw new Error('Некорректный ответ нативного ядра');
        if (versions.capabilities?.discord === false) {
            const unsupported = async () => ({ supported: false, error: 'Discord RPC пока недоступен в Tauri' });
            bridge.globals.discordRPC = { setActivity: unsupported, clearActivity: unsupported };
        }
        Object.assign(target, bridge.globals, { baseSettings, versions, nativePlatform: { runtime: 'tauri', capabilities: versions.capabilities || {} } });
        const app = await loadApp();
        await mountApp(app);
        return bridge;
    } catch (error) { bridge.dispose(); throw error; }
}
