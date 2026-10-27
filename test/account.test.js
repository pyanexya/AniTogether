import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAccountApi, createAccountFlow } from '../src/app/platform/account.js';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const pairing = { attemptId:'opaque-attempt', pairingCode:'ABCD1234', expiresIn:300, interval:5 };
function setup() {
    vi.useFakeTimers();
    const api = { start:vi.fn().mockResolvedValue(pairing), poll:vi.fn().mockResolvedValue({status:'pending'}), cancel:vi.fn().mockResolvedValue(), status:vi.fn().mockResolvedValue({status:'authenticated',profile:{username:'verified'}}) };
    const update=vi.fn(); return { api, update, flow:createAccountFlow(api,update) };
}
afterEach(()=>vi.useRealTimers());
describe('independent native account boundary',()=>{
    it('exposes fixed commands only, no token or arbitrary URL API',async()=>{
        const invoke=vi.fn().mockResolvedValue({});const api=createAccountApi(invoke);
        await api.start(true); await api.poll('attempt');await api.status();await api.cancel();await api.logout();await api.portal('https://evil.test');
        expect(invoke.mock.calls).toEqual([['account_start',{remember:true}],['account_poll',{attemptId:'attempt'}],['account_status'],['account_cancel'],['account_logout'],['account_portal']]);
        expect(Object.keys(api)).toEqual(['status','start','poll','cancel','logout','portal']);
    });
    it('polls pending at five-second intervals and never overlaps',async()=>{
        const {api,flow}=setup();await flow.start(false);
        await vi.advanceTimersByTimeAsync(4999);expect(api.poll).not.toHaveBeenCalled();
        const held=deferred();api.poll.mockReturnValueOnce(held.promise);
        await vi.advanceTimersByTimeAsync(20000);expect(api.poll).toHaveBeenCalledTimes(1);
        held.resolve({status:'pending'});await Promise.resolve();await vi.advanceTimersByTimeAsync(5000);expect(api.poll).toHaveBeenCalledTimes(2);flow.dispose();
    });
    it('cancel prevents late start completion from scheduling a poll',async()=>{
        const {api,flow,update}=setup();const held=deferred();api.start.mockReturnValue(held.promise);
        const start=flow.start(false);await flow.cancel();held.resolve(pairing);await start;
        await vi.advanceTimersByTimeAsync(10000);expect(api.poll).not.toHaveBeenCalled();expect(update.mock.calls.at(-1)[0]).toEqual({busy:false,pairing:null});
    });
    it('out-of-order attempts do not replace current pairing',async()=>{
        const {api,flow,update}=setup();const held=deferred();api.start.mockReturnValueOnce(held.promise);
        const first=flow.start(false);await flow.start(true);held.resolve({...pairing,attemptId:'old'});await first;
        expect(update.mock.calls.at(-1)[0].pairing.attemptId).toBe(pairing.attemptId);flow.dispose();
    });
    it('late exchange after cancel cannot update profile',async()=>{
        const {api,flow,update}=setup();const held=deferred();api.poll.mockReturnValue(held.promise);
        await flow.start(false);await vi.advanceTimersByTimeAsync(5000);await flow.cancel();held.resolve({status:'authenticated'});await Promise.resolve();
        expect(api.status).not.toHaveBeenCalled();expect(update.mock.calls.some(([v])=>v.account)).toBe(false);
    });
    it('successful exchange asks native for verified profile rather than inventing one',async()=>{
        const {api,flow,update}=setup();api.poll.mockResolvedValue({status:'authenticated'});await flow.start(true);await vi.advanceTimersByTimeAsync(5000);
        expect(update.mock.calls.at(-1)[0]).toEqual({busy:false,pairing:null,account:{status:'authenticated',profile:{username:'verified'}}});flow.dispose();
    });
    it('bounds wait to five minutes',async()=>{
        const {api,flow,update}=setup();await flow.start(false);await vi.advanceTimersByTimeAsync(300000);
        expect(api.cancel).toHaveBeenCalledOnce();expect(update.mock.calls.at(-1)[0].error).toContain('истекло');
        const n=api.poll.mock.calls.length;await vi.advanceTimersByTimeAsync(60000);expect(api.poll).toHaveBeenCalledTimes(n);
    });
    it('unmount cancels and ignores late profile',async()=>{
        const {api,flow,update}=setup();const held=deferred();api.poll.mockResolvedValue({status:'authenticated'});api.status.mockReturnValue(held.promise);
        await flow.start(false);await vi.advanceTimersByTimeAsync(5000);flow.dispose();held.resolve({status:'authenticated',profile:{username:'late'}});await Promise.resolve();
        expect(update.mock.calls.some(([v])=>v.account)).toBe(false);expect(api.cancel).toHaveBeenCalled();
    });
    it('offline failures are visible and stop polling',async()=>{
        const {api,flow,update}=setup();api.poll.mockRejectedValue('Нет связи');await flow.start(false);await vi.advanceTimersByTimeAsync(5000);
        expect(update.mock.calls.at(-1)[0]).toEqual({busy:false,pairing:null,error:'Нет связи'});expect(api.cancel).toHaveBeenCalled();
    });
});

describe('account entry lifecycle', () => {
    it('publishes native restored status and logout without persisting a token', async () => {
        const { accountState } = await import('../src/app/platform/account-state.js');
        const updates = []; const unsubscribe = accountState.subscribe(value => updates.push(value));
        const profile = { status: 'authenticated', profile: { id: 'one', displayName: 'One' } };
        const api = createAccountApi(vi.fn().mockResolvedValueOnce(profile).mockResolvedValueOnce({ status: 'signedOut', revoked: true }));
        await api.status(); await api.logout(); unsubscribe();
        expect(updates.slice(-2)).toEqual([profile, { status: 'signedOut', revoked: true }]);
    });
    it('only resolves public avatars on the fixed issuer', async () => {
        const { accountAvatar, accountSymbol } = await import('../src/app/platform/account-state.js');
        expect(accountAvatar({ avatarUrl: '/api/avatars/alice?v=123' })).toBe('https://aniartix.pyanexy.cc/api/avatars/alice?v=123');
        for (const avatarUrl of ['https://evil.test/x', '//evil.test/x', '/api/avatars/../me?v=1', '/api/avatars/a?v=1&token=secret']) expect(accountAvatar({avatarUrl})).toBeNull();
        expect(accountSymbol({avatar: 'fox'})).toBe('🦊');
        expect(accountSymbol({avatar: 'https://evil.test'})).toBe('◉');
    });
    it('expiry stays visible even if native cancel fails', async () => {
        const { api, flow, update } = setup(); api.cancel.mockRejectedValue('Unavailable');
        await flow.start(false); await vi.advanceTimersByTimeAsync(300000);
        expect(update.mock.calls.at(-1)[0]).toMatchObject({busy:false,pairing:null,error:expect.stringContaining('истекло')});
    });
    it('a late failed poll cannot overwrite a newer attempt after cancellation', async () => {
        const { api, flow, update } = setup(); const held = deferred();
        api.poll.mockRejectedValueOnce('old failure'); api.cancel.mockReturnValueOnce(held.promise);
        await flow.start(false); await vi.advanceTimersByTimeAsync(5000);
        await flow.start(true); held.resolve(); await Promise.resolve(); await Promise.resolve();
        expect(update.mock.calls.at(-1)[0]).toEqual({busy:true,pairing}); flow.dispose();
    });
});
