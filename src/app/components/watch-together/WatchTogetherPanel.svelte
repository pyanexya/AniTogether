<script>
    import { onDestroy } from 'svelte';
    import { WatchTogetherClient } from '../../../shared/watch-together/client.mjs';
    import { createMediaFollower, mediaIdentityKey } from './player-media.js';
    import { attachMediaSync } from '../../../shared/watch-together/media-sync.mjs';

    export let video = null;
    export let media = null;
    export let mediaLabel = '';
    export let loadMedia = async () => {};
    export let onState = () => {};
    export let unavailable = false;
    export let sourceLoading = false;

    let expanded = false;
    let tab = 'create';
    let serverUrl = '';
    let name = '';
    let invitationText = '';
    let copiedInvitation = '';
    let notice = '';
    let localError = '';
    let mismatch = null;
    let autoFollow = true;
    let autoplayBlocked = false;
    let resolving = false;
    let sync = null;
    let attachedVideo = null;
    let wasLoading = false;
    let lastMediaKey = '';
    const client = new WatchTogetherClient();
    let view = { status: 'idle', role: null, members: [], snapshot: null };
    const key = mediaIdentityKey;
    const follower = createMediaFollower({
        load: (target) => loadMedia(target),
        onLoading: (value) => { resolving = value; if (value) localError = ''; },
        onComplete: () => { sync?.refresh(); client.requestSnapshot(); },
        onError: () => {
            localError = 'Серия или озвучка ведущего недоступна в вашем аккаунте. Повторите загрузку либо выйдите из комнаты.';
            expanded = true;
        },
    });
    const unsubscribe = client.subscribe((next) => {
        view = next;
        onState(next);
        if (next.status === 'connected') invitationText = '';
        if (next.status === 'closed' || next.status === 'idle') {
            follower.cancel();
            mismatch = null;
            copiedInvitation = '';
        }
    });
    $: active = Boolean(view.role && !['idle', 'closed'].includes(view.status));
    $: busy = ['connecting', 'reconnecting'].includes(view.status);
    $: compatible = Boolean(media && !unavailable);
    $: statusLabel = ({ idle: 'Смотреть вместе', connecting: 'Подключение…', connected: 'В комнате', reconnecting: 'Восстанавливаем связь…', error: 'Ошибка соединения', closed: 'Комната закрыта' })[view.status] || 'Смотреть вместе';
    $: if (video && video !== attachedVideo) attach(video);
    $: if (sourceLoading !== wasLoading) {
        wasLoading = sourceLoading;
        if (sourceLoading) sync?.suspend();
        else sync?.refresh();
    }
    $: if (key(media) !== lastMediaKey) {
        lastMediaKey = key(media);
        if (mismatch && key(mismatch) === lastMediaKey) mismatch = null;
        if (media && !sourceLoading) sync?.refresh();
    }

    function attach(element) {
        sync?.destroy();
        attachedVideo = element;
        sync = attachMediaSync({
            client,
            video: element,
            getMedia: () => media,
            onMismatch: handleMismatch,
            onAutoplayBlocked: () => { autoplayBlocked = true; expanded = true; },
            onError: () => { localError = 'Не удалось синхронизировать видео. Попробуйте обновить источник.'; },
        });
    }

    function handleMismatch(remote) {
        mismatch = remote;
        if (autoFollow) follower.request(remote);
    }

    function follow(remote = mismatch) {
        follower.request(remote, true);
    }

    async function connect() {
        localError = '';
        notice = '';
        if (!name.trim()) { localError = 'Введите имя для комнаты.'; return; }
        if (tab === 'create' && !compatible) { localError = 'Сначала загрузите онлайн-серию с выбранной озвучкой.'; return; }
        try {
            if (tab === 'create') await client.create({ serverUrl: serverUrl.trim(), name: name.trim(), media });
            else await client.joinInvitation(invitationText.trim(), name.trim());
            sync?.refresh();
        } catch (_) {
            localError = 'Не удалось подключиться. Проверьте адрес сервера или приглашение.';
        }
    }

    async function copyInvitation() {
        try {
            const value = client.invitation();
            if (!value) throw new Error('no invitation');
            await navigator.clipboard.writeText(value);
            notice = 'Приглашение скопировано. Отправьте его только друзьям.';
            copiedInvitation = '';
        } catch (_) {
            copiedInvitation = client.invitation() || '';
            notice = 'Выделите и скопируйте приглашение вручную.';
        }
    }

    function leave() {
        follower.cancel();
        resolving = false;
        mismatch = null;
        localError = '';
        notice = '';
        copiedInvitation = '';
        invitationText = '';
        autoplayBlocked = false;
        client.leave();
    }

    async function unlockPlayback() {
        try {
            await video?.play();
            autoplayBlocked = false;
            sync?.refresh();
            client.requestSnapshot();
        } catch (_) { localError = 'Браузер не разрешил воспроизведение. Обновите источник и повторите.'; }
    }

    function resync() {
        localError = '';
        sync?.refresh();
        client.requestSnapshot();
        notice = 'Запрошено актуальное состояние комнаты.';
    }

    onDestroy(() => {
        follower.destroy();
        sync?.destroy();
        unsubscribe();
        client.destroy();
        onState({ status: 'idle', role: null, snapshot: null });
    });
</script>

<div class="together-widget" class:expanded>
    <button class="room-toggle" class:connected={view.status === 'connected'} onclick={() => expanded = !expanded} aria-expanded={expanded} aria-controls="together-panel">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-1a3 3 0 1 0 0-6M2 21v-2a6 6 0 0 1 12 0v2m2-6a5 5 0 0 1 6 5v1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
        <span>{statusLabel}</span>
        {#if active}<span class="member-count">{view.members?.filter((member) => member.online).length || 1}</span>{/if}
    </button>
    {#if expanded}
        <section id="together-panel" class="room-panel modal-content" aria-label="Совместный просмотр" onwheel={(event) => event.stopPropagation()}>
            <header><div><span class="eyebrow">WATCH TOGETHER</span><h2>В одной комнате</h2></div><button class="icon-button" onclick={() => expanded = false} aria-label="Закрыть панель">×</button></header>
            <p class="intro">Каждый смотрит видео у себя. Серия, пауза и перемотка следуют за ведущим, без трансляции экрана.</p>
            {#if !active}
                <div class="tabs" role="group" aria-label="Действие"><button class:selected={tab === 'create'} onclick={() => tab = 'create'} disabled={busy}>Создать</button><button class:selected={tab === 'join'} onclick={() => tab = 'join'} disabled={busy}>Присоединиться</button></div>
                <form onsubmit={(event) => { event.preventDefault(); connect(); }}>
                    <label>Ваше имя<input bind:value={name} maxlength="32" autocomplete="off" placeholder="Как вас зовут?" disabled={busy} required /></label>
                    {#if tab === 'create'}
                        <label>Сервер синхронизации<input bind:value={serverUrl} type="url" placeholder="wss://your-server.example/watch" autocomplete="off" spellcheck="false" disabled={busy} required /></label>
                        <p class="hint">Сервер получает имя, IP-адрес и состояние просмотра, но не аккаунт или видео. Нужен запущенный сервер из папки server проекта. На разных компьютерах localhost не подойдёт: используйте общий адрес wss://.</p>
                        <div class="media-preview"><span>Сейчас в плеере</span><strong>{mediaLabel || 'Загрузите серию'}</strong></div>
                        {#if unavailable}<p class="warning">Совместный просмотр локальных файлов пока недоступен.</p>
                        {:else if !sourceLoading && !media}<p class="warning">Каталог не вернул полные идентификаторы источника и озвучки. Выберите другой источник, чтобы не синхронизировать разные версии серии.</p>{/if}
                    {:else}
                        <label>Приглашение друга<textarea bind:value={invitationText} rows="3" maxlength="4096" placeholder="Вставьте полное приглашение" autocomplete="off" spellcheck="false" disabled={busy} required></textarea></label>
                        <p class="hint">При подключении сервер получит ваше имя, IP-адрес и состояние просмотра. Аккаунт и адрес видео не передаются. Принимайте приглашения только от друзей.</p>
                    {/if}
                    <button class="primary" type="submit" disabled={busy || (tab === 'create' && !compatible)}>{busy ? 'Подключаемся…' : tab === 'create' ? 'Создать комнату' : 'Войти в комнату'}</button>
                </form>
                {#if busy}<button class="secondary" onclick={leave}>Отменить подключение</button>{/if}
            {:else}
                <div class="session-meta"><span class="role">{view.role === 'host' ? 'Вы ведущий' : 'Вы зритель'}</span><span>{view.status === 'reconnecting' ? 'Связь потеряна' : `Комната ${view.roomId || ''}`}</span></div>
                {#if view.role === 'guest'}<p class="hint">Воспроизведением управляет ведущий. Громкость, качество и полноэкранный режим остаются вашими.</p>{/if}
                <div class="members" aria-label="Участники">{#each view.members || [] as member (member.id)}<div><span class:offline={!member.online} class="presence"></span><span>{member.name}</span><small>{member.role === 'host' ? 'ведущий' : !member.online ? 'нет связи' : 'зритель'}</small></div>{/each}</div>
                {#if view.role === 'guest'}<label class="check"><input type="checkbox" bind:checked={autoFollow} onchange={(event) => { if (event.currentTarget.checked && mismatch) follow(); }} /> Автоматически открывать серию ведущего</label>{/if}
                {#if resolving}<p class="hint" role="status">Загружаем серию и озвучку ведущего…</p>{/if}
                {#if mismatch && !resolving}<div class="warning">Серия или озвучка отличается: релиз {mismatch.releaseId}, серия {mismatch.episodePosition}.<button onclick={() => follow()}>Открыть серию ведущего</button></div>{/if}
                {#if view.snapshot?.buffering}<p class="hint">Ведущий загружает видео. Синхронизация продолжится после буферизации.</p>{/if}
                {#if view.snapshot?.hostOnline === false}<p class="warning">Ведущий потерял соединение. Воспроизведение приостановлено.</p>{/if}
                {#if autoplayBlocked}<button class="primary" onclick={unlockPlayback}>Разрешить воспроизведение</button>{/if}
                <div class="actions">{#if view.role === 'host'}<button class="primary" onclick={copyInvitation}>Пригласить друга</button>{:else}<button class="secondary" onclick={resync} disabled={busy}>Синхронизировать</button>{/if}<button class="secondary" onclick={leave}>{view.role === 'host' ? 'Закрыть комнату' : 'Выйти'}</button></div>
                {#if copiedInvitation}<label>Личное приглашение<textarea readonly value={copiedInvitation} rows="3" onclick={(event) => event.currentTarget.select()}></textarea></label>{/if}
                <p class="hint">При выходе из плеера соединение закрывается. Приглашение даёт доступ к комнате: не публикуйте его.</p>
            {/if}
            {#if localError || view.error}<p class="warning" role="alert">{localError || 'Соединение с комнатой прервано. Проверьте сервер и повторите подключение.'}</p>{/if}
            {#if notice}<p class="hint" role="status">{notice}</p>{/if}
        </section>
    {/if}
</div>

<style>
    .together-widget{position:absolute;right:24px;top:20px;z-index:25;color:#eeeef6;font-family:inherit;max-width:calc(100% - 48px)}
    button,input,textarea{font:inherit}button{cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid #b6a0ff;outline-offset:3px}
    .room-toggle{display:flex;gap:9px;align-items:center;border:1px solid #ffffff24;border-radius:12px;padding:10px 14px;background:#171821e8;color:#eeeef6;font-size:13px;backdrop-filter:blur(16px)}.room-toggle.connected{border-color:#a58aff70}.member-count{border-radius:6px;background:#a58aff25;padding:1px 6px;color:#c4b1ff}
    .room-panel{width:360px;max-width:100%;box-sizing:border-box;margin-top:10px;background:#171821f5;border:1px solid #ffffff17;border-radius:18px;padding:22px;box-shadow:0 20px 70px #0008;max-height:calc(100vh - 150px);overflow:auto;backdrop-filter:blur(24px)}header{display:flex;justify-content:space-between;align-items:center;gap:12px}.eyebrow{font-size:10px;letter-spacing:1.8px;color:#b59cff;font-weight:700}h2{font-size:21px;margin:5px 0 0;font-weight:650;letter-spacing:-.5px}.icon-button{border:0;background:transparent;color:#9c9baa;font-size:26px;padding:0 4px}.intro{font-size:12px;line-height:1.65;color:#aaa9b9;margin:15px 0 18px}
    .tabs{display:flex;background:#0e0f16;border-radius:10px;padding:4px;margin-bottom:16px}.tabs button{flex:1;border:0;background:transparent;color:#9998aa;border-radius:7px;font-size:12px;padding:9px}.tabs button.selected{background:#2e293e;color:#ded3ff}form{display:flex;flex-direction:column;gap:13px}label{display:flex;flex-direction:column;gap:7px;font-size:12px;color:#c7c6d2}input,textarea{width:100%;box-sizing:border-box;color:#eeedf6;background:#0f1018;border:1px solid #ffffff18;border-radius:9px;padding:10px;font-size:12px;resize:vertical}textarea{word-break:break-all}.hint{font-size:11px;line-height:1.65;color:#9695a8;margin:8px 0}.media-preview{border-left:2px solid #a58aff;padding:4px 0 4px 12px;display:flex;flex-direction:column;gap:4px}.media-preview span{font-size:10px;color:#9695a8}.media-preview strong{font-size:12px;font-weight:500;line-height:1.5}
    .primary,.secondary{padding:11px 13px;border-radius:10px;font-size:12px;font-weight:600;border:1px solid transparent}.primary{background:#a88bfa;color:#15121e}.secondary{background:#252530;color:#d3d0df;border-color:#ffffff12}.actions{display:flex;gap:8px;margin-top:16px}.actions button{flex:1}.session-meta{display:flex;gap:8px;align-items:center;justify-content:space-between;font-size:11px;color:#9998aa}.role{padding:5px 8px;border-radius:6px;background:#a58aff1a;color:#c3acff}.members{margin:15px 0;display:flex;flex-direction:column;gap:9px}.members>div{display:flex;align-items:center;gap:9px;font-size:12px}.members small{margin-left:auto;color:#888798;font-size:10px}.presence{width:6px;height:6px;background:#91c9b4;border-radius:50%}.presence.offline{background:#666}.check{flex-direction:row;align-items:center;font-size:11px}.check input{width:14px;accent-color:#a58aff}.warning{padding:10px;border-radius:9px;background:#c99e5518;border:1px solid #c99e5525;color:#e7c99d;font-size:11px;line-height:1.6}.warning button{display:block;margin-top:8px;padding:7px 10px;border-radius:6px;border:1px solid #c99e5530;color:#edd6b0;background:#c99e5514}
    @media(max-width:600px){.together-widget{right:12px;top:12px;max-width:calc(100% - 24px)}.room-panel{width:330px;padding:17px}.room-toggle{font-size:11px}}
</style>
