<script>
    import { onMount } from 'svelte';
    import { accountState } from '../platform/account-state.js';
    import { friendsApi, friendsError, visiblePoll } from '../platform/friends.js';
    import { prepareAcceptedInvite } from './watch-together/accepted-invite.js';
    import { Pages } from '../pages.js';
    let invites = [], error = '', busy = false, poll, identity, controller, alive = true;
    $: if (identity !== $accountState?.profile?.id) {
        identity = $accountState?.profile?.id; invites = []; error = ''; controller?.abort(); poll?.reset();
    }
    onMount(() => {
        poll = visiblePoll({ read: friendsApi.invites, receive: value => { invites = value.invites; }, fail: e => error = friendsError(e), enabled: () => $accountState?.status === 'authenticated' });
        poll.refresh();
        const cancel = () => controller?.abort();
        window.addEventListener('anixartix:navigate', cancel);
        return () => { alive = false; controller?.abort(); poll.destroy(); window.removeEventListener('anixartix:navigate', cancel); };
    });
    async function respond(invite, accept) {
        if (busy) return;
        if (accept && !window.anixApi?.client?.token) { error = 'Сначала подключите Anixart для доступа к серии.'; return; }
        busy = true; error = ''; const own = identity;
        controller = new AbortController();
        try {
            if (accept) {
                const accepted = await friendsApi.acceptInvite(invite.id);
                if (!alive || own !== identity) return;
                invites = invites.filter(item => item.id !== invite.id);
                const profile = $accountState.profile;
                const args = await prepareAcceptedInvite(accepted, profile.displayName || profile.username, { catalog: window.anixApi, signal: controller.signal });
                if (alive && own === identity) window.updateViewportComponent(Pages.PLAYER, args);
            } else {
                await friendsApi.declineInvite(invite.id);
                if (alive && own === identity) invites = invites.filter(item => item.id !== invite.id);
            }
        } catch (e) { if (alive && own === identity && !controller.signal.aborted) error = accept ? 'Не удалось открыть комнату или серию. Попросите друга прислать новое приглашение.' : friendsError(e); }
        finally { busy = false; }
    }
</script>
{#if invites.length || error || busy}
    <aside class="invite-inbox" aria-label="Приглашения друзей" aria-live="polite">
        {#each invites as invite (invite.id)}
            <div><strong>{invite.sender.displayName || invite.sender.username}</strong><p>приглашает смотреть вместе</p><button disabled={busy} onclick={() => respond(invite, true)}>Принять и смотреть</button><button disabled={busy} onclick={() => respond(invite, false)}>Отклонить</button></div>
        {/each}
        {#if busy}<p>Открываем приглашение…</p>{/if}
        {#if error}<p role="alert">{error}</p><button disabled={busy} onclick={() => { error = ''; poll.refresh(); }}>Обновить</button>{/if}
    </aside>
{/if}
<style>
.invite-inbox{position:fixed;right:24px;bottom:24px;z-index:1000;width:320px;max-height:60vh;overflow:auto;padding:18px;border:1px solid #a98bfa60;border-radius:16px;background:#1d1b2bf5;color:#eeedf5;box-shadow:0 12px 45px #0008}.invite-inbox div+div{border-top:1px solid #ffffff20;margin-top:14px;padding-top:14px}p{font-size:12px;color:#beb8ce}button{padding:9px;margin:3px;border-radius:8px;background:#a98bfa;color:#171322;border:0;cursor:pointer}button:disabled{opacity:.5}button:focus-visible{outline:2px solid white;outline-offset:2px}
</style>
