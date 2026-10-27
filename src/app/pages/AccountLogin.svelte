<script>
    import { onMount, onDestroy } from 'svelte';
    import { invoke } from '@tauri-apps/api/core';
    import { createAccountApi, createAccountFlow } from '../platform/account.js';
    import { accountState } from '../platform/account-state.js';
    export let onContinue = () => {};
    const api = createAccountApi(invoke);
    let busy = false, pairing = null, error = '', loading = true, remember = false, alive = true;
    let refreshGeneration = 0;
    const flow = createAccountFlow(api, patch => {
        if (!alive) return;
        if ('busy' in patch) busy = patch.busy;
        if ('pairing' in patch) pairing = patch.pairing;
        if ('error' in patch) error = patch.error;
    });
    async function refresh() {
        const generation = ++refreshGeneration;
        loading = true; error = '';
        let timeout;
        try {
            await Promise.race([api.status(), new Promise((_, reject) => timeout = setTimeout(() => reject(new Error('Проверка заняла слишком много времени. Повторите попытку.')), 15000))]);
        } catch (e) { if (alive && generation === refreshGeneration) error = String(e); }
        finally { clearTimeout(timeout); if (alive && generation === refreshGeneration) loading = false; }
    }
    async function cancel() { try { await flow.cancel(); } catch (e) { error = String(e); } }
    onMount(() => { if ($accountState?.status === 'signedOut') loading = false; else refresh(); });
    onDestroy(() => { alive = false; refreshGeneration++; flow.dispose(); });
</script>
<section class="entry" aria-label="Вход в AnixArtix">
    <div class="intro">
        <div class="brand"><img src="./assets/icons/anixartix.png" width="48" height="48" alt=""/>AnixArtix</div>
        <span class="eyebrow">ВАШ АККАУНТ. ВАШ КРУГ.</span>
        <h1>Хорошие истории<br/>сближают.</h1>
        <p>Войдите в свой аккаунт AnixArtix.<br/>Через Google или Discord — в привычном браузере.</p>
        <div class="benefits"><span>01</span><div><strong>Один профиль — это вы</strong><small>Ваше имя, аватар и привязки AnixArtix.</small></div><span>02</span><div><strong>Без пароля в приложении</strong><small>Безопасный вход с подтверждением устройства.</small></div></div>
        <small class="separate">Anixart подключается отдельно для каталога и просмотра. Аккаунт AnixArtix не заменяет доступ к этому сервису.</small>
    </div>
    <div class="card" aria-busy={busy || loading}>
        <span class="eyebrow">НАЧНИТЕ ЗДЕСЬ</span>
        <h2>Войти в AnixArtix</h2>
        <p>Google или Discord выбирается на странице входа. Мы откроем её в системном браузере.</p>
        {#if loading}
            <p role="status">Проверяем сохранённую сессию…</p>
        {:else if busy}
            <div class="pair" role="status">
                {#if pairing}<strong>Подтвердите это устройство</strong><p>Сравните код с кодом в браузере:</p><code>{pairing.pairingCode}</code><p>Совпадает? Подтвердите вход на сайте.<br/>Не подтверждайте чужие запросы.</p><small>Ожидаем подтверждение до 5 минут.</small>
                {:else}<p>Открываем браузер…</p>{/if}
            </div>
            <button class="secondary" onclick={cancel}>← Отменить и вернуться</button>
        {:else}
            {#if $accountState?.status === 'expired'}<p class="notice">Сессия истекла. Войдите снова.</p>{/if}
            <button class="primary" onclick={() => flow.start(remember)}><span class="providers" aria-hidden="true">G · ◈</span> Войти через Google / Discord <span aria-hidden="true">↗</span></button>
            <label><input type="checkbox" bind:checked={remember}/> Запомнить вход на этом устройстве</label>
            <small>Сессия хранится в защищённом хранилище Windows. Доступ к почте не запрашивается.</small>
        {/if}
        {#if error}<div class="notice" role="alert">{error}</div>{#if !busy}<button class="secondary" onclick={refresh}>Повторить проверку</button>{/if}{/if}
        {#if $accountState?.revoked === false}<p class="notice">Вы вышли на этом устройстве. Сервер не подтвердил отзыв сессии; она может оставаться действительной до истечения срока.</p>{/if}
        {#if $accountState?.warning}<p class="notice">{$accountState.warning}</p>{/if}
        <div class="footer"><button disabled={busy} onclick={onContinue}>Пока без аккаунта →</button><small>Подключить Anixart можно отдельно в приложении.</small></div>
    </div>
</section>
<style>
.entry{width:100%;min-height:100%;box-sizing:border-box;display:grid;grid-template-columns:minmax(260px,430px) minmax(320px,420px);align-content:center;justify-content:center;gap:clamp(30px,7vw,100px);padding:48px;overflow:auto;background:radial-gradient(ellipse at 80% 15%,var(--accent-soft),transparent 55%)}
.brand{display:flex;gap:12px;align-items:center;font-size:24px;font-weight:750;margin-bottom:48px}.eyebrow{color:var(--accent-color);font-size:10px;font-weight:700;letter-spacing:2px}h1{font-size:clamp(32px,4vw,50px);line-height:1.13;letter-spacing:-1.5px;margin:18px 0 24px}p{font-size:13px;line-height:1.8;color:var(--secondary-text-color)}.benefits{display:grid;grid-template-columns:34px 1fr;gap:22px 14px;margin:30px 0}.benefits>span{background:var(--accent-soft);color:var(--accent-color);border:1px solid var(--accent-border);border-radius:10px;display:grid;place-items:center;font-size:10px}.benefits strong{font-size:12px}.benefits small{display:block;margin-top:5px}small{color:var(--third-text-color);font-size:11px;line-height:1.7}.separate{display:block;border-top:1px solid var(--border-color);padding-top:20px;max-width:360px}.card{align-self:center;background:var(--alt-background-color);border:1px solid var(--border-color);border-radius:24px;padding:32px;box-shadow:0 20px 70px #00000018}h2{font-size:25px;letter-spacing:-.7px;margin:16px 0 10px}.card>p{margin-bottom:24px}button{border-radius:10px;padding:13px 16px;font-size:12px;font-weight:600;cursor:pointer}.primary{display:flex;gap:10px;align-items:center;justify-content:center;width:100%;background:var(--accent-color);color:var(--accent-contrast);min-height:50px;margin:25px 0 20px}.providers{font-size:18px;white-space:nowrap}.secondary{background:var(--hover-color);width:100%;margin-top:12px}label{display:flex;align-items:center;gap:8px;font-size:11px;margin-bottom:10px}input{accent-color:var(--accent-color)}.footer{margin-top:27px;padding-top:18px;border-top:1px solid var(--border-color);text-align:center}.footer button{color:var(--secondary-text-color)}.footer small{display:block}.pair{border-radius:12px;padding:18px;background:var(--background-color);text-align:center}.pair strong{font-size:13px}.pair p{font-size:12px}.pair code{display:block;font-size:30px;letter-spacing:5px;color:var(--accent-color);padding:10px 0}.notice{border-left:3px solid var(--accent-color);background:var(--accent-soft);padding:12px;font-size:12px;line-height:1.6;overflow-wrap:anywhere;margin:14px 0}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible{outline:2px solid var(--accent-color);outline-offset:3px}@media(max-width:800px){.entry{grid-template-columns:minmax(0,420px);padding:28px 20px;gap:28px}.brand{margin:0}.intro h1,.intro>p,.intro>.eyebrow,.benefits,.separate{display:none}.card{padding:26px}}
</style>
