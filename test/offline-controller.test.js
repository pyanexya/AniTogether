import { describe, it, expect, vi } from 'vitest';
import { createOfflineController, downloadState } from '../src/app/platform/downloads.js';
const job = { downloadId: '4_3', animeMeta: { id: 4 }, episodeMeta: { id: 3 }, percent: -3, status: 'paused' };
const fixture = () => {
    const stop = vi.fn();
    const api = { getLibrary: vi.fn().mockResolvedValue([]), getActiveDownloads: vi.fn().mockResolvedValue([job]), onProgress: vi.fn(() => stop), onError: vi.fn(() => stop), onCompleted: vi.fn(() => stop), pauseDownload: vi.fn().mockResolvedValue(true), resumeDownload: vi.fn().mockResolvedValue(true), retryDownload: vi.fn().mockResolvedValue(true), cancelDownload: vi.fn().mockResolvedValue(true), openFolder: vi.fn().mockResolvedValue(true) };
    const update = vi.fn(); return { api, stop, update, controller: createOfflineController(api, update) };
};
describe('offline page real controller', () => {
    it('never renders negative sentinel percentages', () => {
        expect(downloadState(job)).toMatchObject({ label: 'На паузе', canResume: true, canPause: false });
        expect(downloadState({ percent: -2 })).toMatchObject({ label: 'В очереди', canPause: true });
        expect(downloadState({ status: 'error', percent: 12 })).toMatchObject({ label: 'Ошибка загрузки', canRetry: true });
        expect(downloadState({ status: 'downloading', percent: -50 }).label).toBe('Загрузка: 0%');
    });
    it('loads real snapshots and delegates controls with canonical IDs', async () => {
        const { controller, api, update } = fixture(); await controller.start();
        expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ jobs: [job], loading: false }));
        for (const [action, method] of [['pause', 'pauseDownload'], ['resume', 'resumeDownload'], ['retry', 'retryDownload'], ['cancel', 'cancelDownload']]) {
            await controller.action(action, job); expect(api[method]).toHaveBeenCalledWith(4, 3);
        }
        controller.dispose();
    });
    it('shows native failures rather than changing to pretend success', async () => {
        const { controller, api, update } = fixture(); api.resumeDownload.mockRejectedValue(new Error('FFmpeg отсутствует'));
        await controller.start(); await controller.action('resume', job);
        expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ error: 'FFmpeg отсутствует', busy: [] })); controller.dispose();
    });
    it('removes all listeners and ignores responses after unmount', async () => {
        const { controller, api, update, stop } = fixture(); let resolve;
        api.getLibrary.mockReturnValue(new Promise(r => { resolve = r; }));
        const pending = controller.start(); controller.dispose(); resolve([]); await pending;
        expect(stop).toHaveBeenCalledTimes(3); expect(update).not.toHaveBeenCalled();
    });
    it('guards repeated actions on the same job', async () => {
        const { controller, api } = fixture(); let resolve;
        api.pauseDownload.mockReturnValue(new Promise(r => { resolve = r; }));
        const first = controller.action('pause', job); await controller.action('pause', job);
        expect(api.pauseDownload).toHaveBeenCalledTimes(1); resolve(true); await first; controller.dispose();
    });
});
