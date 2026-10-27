import { invoke } from '@tauri-apps/api/core';
// Only typed native commands: no bearer, URL, HTTP method, or arbitrary JSON relay.
export const friendsApi = Object.freeze({
    list: () => invoke('friends_list'),
    lookup: username => invoke('friends_lookup', { username }),
    request: userId => invoke('friends_request', { userId }),
    accept: requestId => invoke('friends_accept', { requestId }),
    reject: requestId => invoke('friends_reject', { requestId }),
    remove: userId => invoke('friends_remove', { userId }),
    invites: () => invoke('watch_invites_list'),
    invite: (recipientId, roomId, hostToken) => invoke('watch_invite_send', { recipientId, roomId, hostToken }),
    acceptInvite: inviteId => invoke('watch_invite_accept', { inviteId }),
    declineInvite: inviteId => invoke('watch_invite_decline', { inviteId }),
});
export const DEFAULT_WATCH_SERVER = 'wss://aniartix.pyanexy.cc/watch';
export function friendsError(error) {
    const value = String(error);
    if (/429|rate|част/i.test(value)) return 'Слишком много запросов. Подождите минуту и повторите.';
    if (/401|auth|вход|сесси/i.test(value)) return 'Войдите в аккаунт AnixArtix ещё раз.';
    if (/404|not_found/i.test(value)) return 'Пользователь или приглашение не найдены.';
    if (/409|conflict|already/i.test(value)) return 'Запрос уже обработан. Обновите список.';
    return 'Не удалось выполнить запрос. Проверьте соединение и повторите.';
}
// One in-flight request, only while visible/authenticated; invalidate late results on logout.
export function visiblePoll({ read, receive, fail, enabled, interval = 30000, documentRef = document }) {
    let stopped = false, pending = false, generation = 0, timer;
    const cancel = () => { ++generation; clearTimeout(timer); };
    async function refresh() {
        if (stopped || pending || !enabled() || documentRef.visibilityState !== 'visible') return;
        clearTimeout(timer); pending = true; const own = generation;
        try { const result = await read(); if (!stopped && own === generation && enabled()) receive(result); }
        catch (error) { if (!stopped && own === generation && enabled()) fail(error); }
        finally { pending = false; if (!stopped && enabled() && documentRef.visibilityState === 'visible') timer = setTimeout(refresh, interval); }
    }
    const visibility = () => { cancel(); if (documentRef.visibilityState === 'visible') refresh(); };
    documentRef.addEventListener('visibilitychange', visibility);
    return { refresh, reset() { cancel(); refresh(); }, destroy() { stopped = true; cancel(); documentRef.removeEventListener('visibilitychange', visibility); } };
}
