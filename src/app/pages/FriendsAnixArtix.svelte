<script>
    import { onMount } from 'svelte';
    import { accountState, accountAvatar, accountSymbol } from '../platform/account-state.js';
    import { friendsApi, friendsError, visiblePoll } from '../platform/friends.js';
    let data = { friends: [], incoming: [], outgoing: [] };
    let username = '', found = null, error = '', notice = '', busy = false, poll;
    let identity;
    $: if (identity !== $accountState?.profile?.id) {
        identity = $accountState?.profile?.id; data = { friends: [], incoming: [], outgoing: [] }; found = null; error = ''; poll?.reset();
    }
    onMount(() => {
        poll = visiblePoll({ read: friendsApi.list, receive: value => { data = value; error = ''; }, fail: e => error = friendsError(e), enabled: () => $accountState?.status === 'authenticated' });
        poll.refresh(); return () => poll.destroy();
    });
    async function run(action, success) {
        if (busy) return; busy = true; error = ''; notice = ''; const own = identity;
        try { await action(); if (own !== identity) return; notice = success; found = null; await poll?.refresh(); }
        catch (e) { if (own === identity) error = friendsError(e); }
        finally { busy = false; }
    }
    async function search() {
        if (busy || !username.trim()) return; busy = true; error = ''; found = null; const own = identity;
        try { const result = await friendsApi.lookup(username.trim().replace(/^@/, '')); if (own === identity) found = result.profile; }
        catch (e) { if (own === identity) error = friendsError(e); }
        finally { busy = false; }
    }
</script>
<section class="friends-page">
    <span class="eyebrow">ANIXARTIX</span><h1>Друзья</h1>
    <p class="muted">Ваш круг для совместного просмотра. Этот список не связан с друзьями Anixart.</p>
    {#if $accountState?.status !== 'authenticated'}
        <p>Войдите в свой аккаунт AnixArtix, чтобы добавлять друзей.</p>
    {:else}
        <form onsubmit={event => { event.preventDefault(); search(); }}>
            <label for="friend-nickname">Найти друга по нику AnixArtix</label>
            <div class="search"><input id="friend-nickname" bind:value={username} placeholder="@ник друга" maxlength="32" autocomplete="off" /><button disabled={busy || !username.trim()}>Найти</button></div>
        </form>
        {#if found}<article><div><strong>{found.displayName || found.username}</strong><small>@{found.username}</small></div>{#if found.id === identity}<span>Это вы</span>{:else if data.friends.some(p => p.id === found.id)}<span>Уже друзья</span>{:else}<button disabled={busy} onclick={() => run(() => friendsApi.request(found.id), 'Запрос отправлен')}>Добавить в друзья</button>{/if}</article>{/if}
        {#if error}<p class="error" role="alert">{error}</p><button disabled={busy} onclick={() => poll.refresh()}>Повторить</button>{/if}
        {#if notice}<p role="status">{notice}</p>{/if}
        {#if data.incoming.length}<h2>Входящие запросы</h2>{#each data.incoming as request (request.id)}<article><div><strong>{request.profile.displayName || request.profile.username}</strong><small>@{request.profile.username}</small></div><button disabled={busy} onclick={() => run(() => friendsApi.accept(request.id), 'Теперь вы друзья')}>Принять</button><button class="subtle" disabled={busy} onclick={() => run(() => friendsApi.reject(request.id), 'Запрос отклонён')}>Отклонить</button></article>{/each}{/if}
        <h2>Мои друзья <small>{data.friends.length}</small></h2>
        {#if !data.friends.length}<div class="empty"><h3>Смотреть интереснее вместе</h3><p>Попросите друга поделиться ником AnixArtix и найдите его выше. Затем откройте серию → «Смотреть вместе» → выберите друга.</p></div>{/if}
        {#each data.friends as friend (friend.id)}
            <article>
                {#if accountAvatar(friend)}<img src={accountAvatar(friend)} alt="" />{:else}<span class="avatar">{accountSymbol(friend)}</span>{/if}
                <div><strong>{friend.displayName || friend.username}</strong><small>@{friend.username}</small></div>
                <button class="subtle" disabled={busy} onclick={() => { if (confirm('Удалить этого друга?')) run(() => friendsApi.remove(friend.id), 'Друг удалён'); }}>Удалить</button>
            </article>
        {/each}
        {#if data.friends.length}<p class="muted">Чтобы пригласить друга, откройте серию и нажмите «Смотреть вместе» в плеере.</p>{/if}
        {#if data.outgoing.length}<h2>Отправленные запросы</h2>{#each data.outgoing as request (request.id)}<article><div><strong>{request.profile.displayName || request.profile.username}</strong><small>@{request.profile.username} · ждём ответа</small></div><button class="subtle" disabled={busy} onclick={() => run(() => friendsApi.remove(request.profile.id), 'Запрос отменён')}>Отменить</button></article>{/each}{/if}
    {/if}
</section>
<style>
.friends-page{max-width:760px;padding:36px;color:var(--text-primary,#eeeef6)}.eyebrow{font-size:11px;letter-spacing:2px;color:#b69bff}h1{font-size:30px;margin:8px 0}h2{font-size:18px;margin:28px 0 12px}.muted,small{color:#a4a2b4;line-height:1.6}form{margin:28px 0}label{display:block;font-size:13px;margin-bottom:10px}.search{display:flex;gap:10px}input{flex:1;min-width:0;background:#161620;color:#eee;border:1px solid #ffffff20;border-radius:10px;padding:13px;font:inherit}button{background:#a98bfa;color:#171322;border:0;border-radius:9px;padding:11px 15px;cursor:pointer;font:inherit;font-size:13px}button:disabled{opacity:.5;cursor:wait}.subtle{background:#ffffff0c;color:#aaa8bc}article{display:flex;align-items:center;gap:12px;padding:16px;border:1px solid #ffffff12;border-radius:13px;margin:9px 0;background:#ffffff04}article div{flex:1}small{display:block;font-size:12px}.empty{padding:28px;background:#a98bfa0a;border:1px dashed #a98bfa40;border-radius:16px}.empty p{color:#aaa8bc;line-height:1.7}.avatar,img{width:40px;height:40px;border-radius:12px;object-fit:cover}.avatar{display:grid;place-items:center;background:#a98bfa20;font-size:24px}.error{color:#f0b490}button:focus-visible,input:focus-visible{outline:2px solid #bea4ff;outline-offset:3px}
</style>
