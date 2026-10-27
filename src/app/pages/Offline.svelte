<script>
    import AnimeColumnCard from "../components/elements/AnimeColumnCard.svelte";
    import MetaInfo from "../components/gui/MetaInfo.svelte";
    import Preloader from "../components/gui/Preloader.svelte";
    import OfflineRelease from "./OfflineRelease.svelte";
    import { onMount } from "svelte";
    import { createOfflineController, downloadState } from "../platform/downloads.js";

    let state = { library: [], jobs: [], loading: true, error: '', busy: [] };
    const controller = createOfflineController(window.offlineApi, value => { state = value; });
    onMount(() => { controller.start(); return () => controller.dispose(); });
</script>

<MetaInfo subTitle="Загрузки" />
<div class="releases-type flex-row"><span class="releases-type-title selected">Загрузки и офлайн-библиотека</span></div>
<div class="releases-container flex-column">
    <div class="flex-row releases-title">
        <span>Скачанные серии доступны без интернета</span>
        <button class="open-folder-btn" onclick={() => controller.openFolder()}>Открыть папку</button>
    </div>
    {#if state.error}<div class="download-error" role="alert">{state.error}<button onclick={() => controller.refresh()}>Обновить</button></div>{/if}
    {#if state.loading}<Preloader />{/if}
    {#if state.jobs.length}
        <section class="download-jobs" aria-label="Очередь загрузок">
            {#each state.jobs as job (job.downloadId)}
                {@const progress = downloadState(job)}
                {@const busy = state.busy.includes(job.downloadId)}
                <article class="download-job">
                    <div class="job-info">
                        <strong>{job.animeMeta.title_ru || job.animeMeta.title || 'Аниме'} · {job.episodeMeta.title || `Серия ${job.episodeMeta.id}`}</strong>
                        <span class:error={progress.status === 'error'}>{progress.label}</span>
                        {#if job.error}<span class="error">{job.error}</span>{/if}
                        {#if progress.status === 'downloading'}<progress max="100" value={Math.max(0, Math.min(100, job.percent || 0))} aria-label="Прогресс загрузки" />{/if}
                    </div>
                    <div class="job-actions">
                        {#if progress.canPause}<button disabled={busy} onclick={() => controller.action('pause', job)}>Пауза</button>{/if}
                        {#if progress.canResume}<button disabled={busy} onclick={() => controller.action('resume', job)}>Продолжить</button>{/if}
                        {#if progress.canRetry}<button disabled={busy} onclick={() => controller.action('retry', job)}>Повторить</button>{/if}
                        <button disabled={busy} onclick={() => controller.action('cancel', job)}>Отменить</button>
                    </div>
                </article>
            {/each}
        </section>
    {/if}
    {#if !state.loading && state.library.length === 0 && state.jobs.length === 0}<div class="empty-state">У вас пока нет скачанных серий.</div>{/if}
    <div class="cards-grid">
        {#each state.library as release (release.id)}
            <AnimeColumnCard
                onClickOverride={() => updateViewportComponent(OfflineRelease, { anime: release })}
                anime={{ ...release, title_ru: release.title_ru || release.title || release.name || 'Без названия', episodes_released: release.episodes?.length || 0, episodes_total: release.episodes?.length || 0, grade: release.grade ?? null, status: release.status ?? null, profile_list_status: release.profile_list_status ?? 0 }} />
        {/each}
    </div>
</div>

<style>
    .download-jobs { margin:20px; display:grid; gap:12px; }
    .download-job { display:flex; flex-wrap:wrap; align-items:center; gap:16px; padding:16px; border:1px solid var(--border-color); background:var(--alt-background-color); border-radius:14px; }
    .job-info { flex:1; min-width:180px; display:grid; gap:8px; overflow-wrap:anywhere; }
    .job-info span { font-size:13px; color:var(--secondary-text-color); }
    .job-info .error, .download-error { color:var(--warning-color, #ff7b82); }
    .job-actions { display:flex; flex-wrap:wrap; gap:8px; }
    .job-actions button, .download-error button { padding:8px 12px; background:var(--hover-color); color:var(--main-text-color); border-radius:8px; }
    button:disabled { opacity:.45; cursor:wait; }
    progress { width:100%; accent-color:var(--select-button-color); height:6px; }
    .download-error { margin:20px; display:flex; align-items:center; gap:16px; overflow-wrap:anywhere; }

    .empty-state {
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100%;
        color: var(--third-text-color);
        font-size: 16px;
    }

    .open-folder-btn {
        background-color: var(--select-button-color);
        color: var(--main-text-color);
        border: none;
        padding: 5px 15px;
        border-radius: 8px;
        cursor: pointer;
        transition: background-color 0.2s;
    }

    .open-folder-btn:hover {
        background-color: var(--select-button-left-color);
    }

    .cards-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 20px;
        padding: 20px;
    }

    .releases-container {
        width: 100%;
        height: 100%;
        overflow-y: auto;
    }

    .releases-title {
        margin-top: var(--margin-title, 16px);
        margin-left: 23px;
        margin-right: 23px;
        justify-content: space-between;
        align-items: center;
    }

    .releases-type {
        width: 100%;
        height: 50px;
        justify-content: center;
        align-items: center;
        position: sticky;
        top: 0;
        background-color: var(--background-color);
        z-index: 1;
    }

    .releases-type-title {
        margin-right: auto;
        height: 100%;
        padding-left: 20px;
        padding-right: 20px;
        font-size: 16px !important;
        display: flex;
        justify-content: center;
        align-items: center;
        color: var(--third-text-color);
        transition: all 0.3s ease;
        font-weight: 400;
        position: relative;
    }

    .releases-type-title:hover {
        cursor: pointer;
        background-color: var(--alt-background-color);
    }

    .selected {
        font-weight: bold;
        color: var(--main-text-color);
    }

    .selected:hover {
        background-color: var(--background-color);
        cursor: default;
    }

    .selected::after {
        content: "";
        position: absolute;
        bottom: 0;
        left: 0;
        width: 100%;
        height: 2px;
        background-color: var(--main-text-color);
        animation: line-grow 0.5s cubic-bezier(0.55, 0, 0.1, 1) forwards;
    }

    @keyframes line-grow {
        0% {
            width: 0;
            left: 50%;
        }
        100% {
            width: 100%;
            left: 0;
        }
    }
</style>
