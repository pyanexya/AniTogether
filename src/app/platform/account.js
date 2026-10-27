// Deliberately no token, verifier, URL argument, or arbitrary HTTP facility.
export function createAccountApi(invoke) {
    return Object.freeze({
        status: () => invoke('account_status'),
        start: remember => invoke('account_start', { remember: Boolean(remember) }),
        poll: attemptId => invoke('account_poll', { attemptId }),
        cancel: () => invoke('account_cancel'),
        logout: () => invoke('account_logout'),
        portal: () => invoke('account_portal'),
    });
}
// A generation protects the view when cancel/unmount races an in-flight native call.
export function createAccountFlow(api, update, schedule = setTimeout, unschedule = clearTimeout) {
    let generation = 0, timer;
    function stop() { generation++; unschedule(timer); }
    async function start(remember) {
        stop(); const own = generation;
        update({ busy: true, error: '', pairing: null });
        try {
            const pairing = await api.start(remember);
            if (own !== generation) return;
            update({ busy: true, pairing });
            const deadline = Date.now() + Math.min(pairing.expiresIn, 300) * 1000;
            const poll = async () => {
                if (own !== generation) return;
                if (Date.now() >= deadline) { await cancel(); update({ error: 'Время входа истекло. Попробуйте ещё раз.' }); return; }
                try {
                    const result = await api.poll(pairing.attemptId);
                    if (own !== generation) return;
                    if (result.status === 'pending') { timer = schedule(poll, 5000); return; }
                    const account = await api.status();
                    if (own === generation) update({ busy: false, pairing: null, account });
                } catch (error) { if (own === generation) { await api.cancel().catch(() => {}); update({ busy: false, pairing: null, error: String(error) }); } }
            };
            timer = schedule(poll, 5000);
        } catch (error) { if (own === generation) update({ busy: false, pairing: null, error: String(error) }); }
    }
    async function cancel() { stop(); update({ busy: false, pairing: null }); await api.cancel(); }
    return { start, cancel, dispose() { stop(); api.cancel().catch(() => {}); } };
}
