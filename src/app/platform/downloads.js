export function downloadState(job) {
    const status = job.status || (job.percent === -3 ? 'paused' : job.percent === -2 ? 'queued' : 'downloading');
    const labels = { paused: 'На паузе', queued: 'В очереди', error: 'Ошибка загрузки', cancelled: 'Отменено', completed: 'Скачано' };
    return { status, label: labels[status] || `Загрузка: ${Math.round(Math.max(0, Math.min(100, Number(job.percent) || 0)))}%`,
        canPause: ['queued', 'downloading'].includes(status), canResume: status === 'paused', canRetry: status === 'error' };
}

/** Subscription ownership + latest-request protection, shared by actual offline page and tests. */
export function createOfflineController(api, update) {
    let disposed = false, revision = 0, timer;
    const unsubscribes = [];
    const busy = new Set();
    const state = { library: [], jobs: [], loading: true, error: '', busy: [] };
    const publish = () => { if (!disposed) update({ ...state, busy: [...busy] }); };
    async function refresh() {
        const current = ++revision;
        try {
            const [library, jobs] = await Promise.all([api.getLibrary(), api.getActiveDownloads()]);
            if (disposed || current !== revision) return;
            if (!Array.isArray(library) || !Array.isArray(jobs)) throw new Error('Некорректный ответ библиотеки');
            Object.assign(state, { library, jobs, loading: false, error: '' }); publish();
        } catch (error) {
            if (disposed || current !== revision) return;
            Object.assign(state, { loading: false, error: String(error?.message || error) }); publish();
        }
    }
    const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 100); };
    return {
        start() {
            unsubscribes.push(api.onProgress(schedule), api.onError(schedule), api.onCompleted(schedule));
            return refresh();
        },
        refresh,
        async action(name, job) {
            const commands = { pause: 'pauseDownload', resume: 'resumeDownload', retry: 'retryDownload', cancel: 'cancelDownload' };
            if (!commands[name]) throw new Error('Unknown download action');
            const id = job.downloadId;
            if (disposed || busy.has(id)) return;
            busy.add(id); state.error = ''; publish();
            try {
                const result = await api[commands[name]](job.animeMeta.id, job.episodeMeta.id);
                await refresh();
                if (result === false) state.error = 'Состояние загрузки уже изменилось. Список обновлён.';
            } catch (error) { state.error = String(error?.message || error); }
            finally { busy.delete(id); publish(); }
        },
        async openFolder() {
            try { await api.openFolder(); }
            catch (error) { state.error = String(error?.message || error); publish(); }
        },
        dispose() { disposed = true; revision++; clearTimeout(timer); unsubscribes.splice(0).forEach(stop => stop()); },
    };
}
