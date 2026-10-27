<script>
    import { onMount } from 'svelte';
    import { invoke } from '@tauri-apps/api/core';
    import { createAccountApi, createAccountFlow } from '../platform/account.js';
    const api = createAccountApi(invoke);
    let account = null, pairing = null, busy = false, error = '', remember = false, loading = true, loggingOut = false;
    let alive = true;
    const flow = createAccountFlow(api, patch => {
        if (!alive) return;
        if ('account' in patch) account = patch.account;
        if ('pairing' in patch) pairing = patch.pairing;
        if ('busy' in patch) busy = patch.busy;
        if ('error' in patch) error = patch.error;
    });
    async function refresh() {
        loading = true; error = '';
        try { const value = await api.status(); if (alive) account = value; }
        catch (e) { if (alive) error = String(e); }
        finally { if (alive) loading = false; }
    }
    async function logout() {
        loggingOut = true; error = '';
        try {
            await flow.cancel(); const result = await api.logout(); account = result;
            if (!result.revoked) error = 'Вы вышли на этом устройстве. Сервер не подтвердил отзыв сессии — серверная сессия может оставаться действительной до истечения срока.';
        } catch(e) { error = String(e); } finally { loggingOut = false; }
    }
    async function portal() { try { await api.portal(); } catch(e) { error = String(e); } }
    onMount(() => { refresh(); return () => { alive = false; flow.dispose(); }; });
</script>
<section class="account-page">
    <span class="eyebrow">АККАУНТ ANIXARTIX</span>
    <h2>Аккаунт AnixArtix</h2>
    <p>Профиль, вход через Google или Discord и привязка Shikimori. Это не аккаунт каталога Anixart: его авторизация не изменяется. Комнаты по приглашению по-прежнему доступны без входа.</p>
    {#if loading}<p role="status">Проверяем сессию…</p>{/if}
    {#if account?.status === 'authenticated'}
        <div class="card">
            <h3>{account.profile?.displayName || account.profile?.username}</h3>
            <p>@{account.profile?.username}</p>
            {#if account.profile?.bio}<p>{account.profile.bio}</p>{/if}
            <p>Shikimori: {account.shikimori?.nickname || 'не привязан'}</p>
            <button onclick={portal}>Профиль и привязки в браузере ↗</button>
            <button disabled={busy} onclick={refresh}>Обновить профиль</button>
            <button disabled={busy || loggingOut} onclick={logout}>Выйти из AnixArtix</button>
            <small>В браузере может понадобиться отдельный вход. Токен приложения туда не передаётся.</small>
        </div>
    {:else if !loading}
        <div class="card">
            {#if account?.status === 'expired'}<p>Сессия истекла. Войдите заново.</p>{/if}
            <label><input type="checkbox" bind:checked={remember} disabled={busy}/> Запомнить вход в защищённом хранилище Windows</label>
            <button disabled={busy} onclick={() => flow.start(remember)}>Войти через браузер</button>
            <small>Google / Discord выбирается на сайте. Если сервис ещё не настроен, вход будет недоступен. Доступ к почте не запрашивается.</small>
        </div>
    {/if}
    {#if busy}
        <div class="card" role="status">
            {#if pairing}
                <p>Сравните код с открытой страницей и только затем подтвердите вход:</p>
                <strong class="pairing">{pairing.pairingCode}</strong>
                <p>Не подтверждайте запросы, которые вы не начинали. Ожидаем подтверждения, не дольше 5 минут.</p>
            {:else}<p>Начинаем вход…</p>{/if}
            <button onclick={() => flow.cancel().catch(e => error = String(e))}>Отменить</button>
        </div>
    {/if}
    {#if account?.warning}<p class="notice">{account.warning}</p>{/if}
    {#if error}<p class="notice" role="alert">{error}</p><button disabled={busy} onclick={refresh}>Повторить проверку</button>{/if}
</section>
<style>
    .account-page { padding: 32px clamp(16px, 3vw, 36px); max-width: 720px; min-width: 0; box-sizing: border-box; overflow-wrap: anywhere; color: var(--main-text-color); }
    .eyebrow { font-size: 11px; letter-spacing: .14em; color: var(--secondary-text-color); }
    h2 { margin: 12px 0; } h3 { margin: 0; }
    p, small { line-height: 1.6; color: var(--secondary-text-color); }
    .card { padding: 22px; margin: 22px 0; background: var(--alt-background-color); border-radius: 16px; display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
    button { padding: 10px 16px; border-radius: 10px; background: var(--select-button-color); color: var(--main-text-color); }
    button:disabled { opacity: .5; } label { line-height: 1.6; } input { margin-right: 8px; }
    .pairing { font-size: 32px; letter-spacing: .14em; font-family: monospace; }
    .notice { padding: 14px; border-left: 3px solid #e66b76; background: var(--alt-background-color); }
</style>
