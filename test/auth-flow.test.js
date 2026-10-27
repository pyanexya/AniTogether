import { describe, it, expect } from 'vitest';
import { DefaultResult, RegisterResult, RegisterVerifyResult } from 'anixartjs';
import { createAuthRequestGate, readAuthSession, registrationOutcome, verificationOutcome } from '../src/app/utils/authFlow.js';

describe('authentication request ownership', () => {
  it('blocks repeated submit until the pending request finishes', () => {
    const gate = createAuthRequestGate(); const first = gate.begin();
    expect(first).not.toBeNull(); expect(gate.busy).toBe(true); expect(gate.begin()).toBeNull();
    expect(gate.finish(first)).toBe(true); expect(gate.busy).toBe(false); expect(gate.begin()).not.toBeNull();
  });
  it.each(['tab change', 'verification back'])('rejects stale responses after %s', () => {
    const gate = createAuthRequestGate(); const abandoned = gate.begin(); gate.invalidate(); const current = gate.begin();
    expect(gate.isCurrent(abandoned)).toBe(false); expect(gate.finish(abandoned)).toBe(false);
    expect(gate.busy).toBe(true); expect(gate.isCurrent(current)).toBe(true);
  });
  it('cannot write or begin again after screen unmount', () => {
    const gate = createAuthRequestGate(); const pending = gate.begin(); gate.dispose();
    expect(gate.isCurrent(pending)).toBe(false); expect(gate.finish(pending)).toBe(false); expect(gate.begin()).toBeNull();
  });
});

describe('authentication response validation', () => {
  it('extracts only profile identity and opaque session token', () => {
    expect(readAuthSession({ profile: { id: 12, privateData: 'not retained' }, profileToken: { token: 'test-token' } })).toEqual({ id: 12, token: 'test-token' });
  });
  it.each([null, {}, {profile:{id:0},profileToken:{token:'x'}}, {profile:{id:12},profileToken:{token:''}}, {profile:{id:12},profileToken:{token:'   '}}, {profile:{id:12},profileToken:{token:45}}, {profile:{id:'invalid'},profileToken:{token:'x'}}])('rejects malformed success payload %j', response => expect(readAuthSession(response)).toBeNull());
});

describe('registration and verification recovery', () => {
  it('enters verification only with a hash', () => {
    expect(registrationOutcome({ code: DefaultResult.Ok, hash: 'test-hash' }, DefaultResult.Ok, RegisterResult)).toEqual({step:2,hash:'test-hash',error:''});
    expect(registrationOutcome({ code: DefaultResult.Ok }, DefaultResult.Ok, RegisterResult)).toMatchObject({step:1,hash:''});
  });
  it('does not strand an already-sent-code response without its hash', () => {
    const result = registrationOutcome({code:RegisterResult.CodeAlreadySend}, DefaultResult.Ok, RegisterResult);
    expect(result.step).toBe(1); expect(result.error).not.toBe('');
  });
  it('preserves a known current registration hash when the server says already sent', () => {
    expect(registrationOutcome({code:RegisterResult.CodeAlreadySend}, DefaultResult.Ok, RegisterResult,'known')).toMatchObject({step:2,hash:'known',error:''});
  });
  it.each([RegisterResult.InvalidLogin, RegisterResult.InvalidEmail, RegisterResult.InvalidPassword, RegisterResult.LoginAlreadyTaken, RegisterResult.EmailAlreadyTaken, RegisterResult.TooManyRegistrations])('provides a recoverable error for registration code %s', code => {
    const result = registrationOutcome({code}, DefaultResult.Ok, RegisterResult); expect(result.step).toBe(1); expect(result.error).not.toBe('');
  });
  it('resets expired verification requests and preserves form on wrong codes', () => {
    expect(verificationOutcome({code:RegisterVerifyResult.InvalidHash},DefaultResult.Ok,RegisterVerifyResult)).toMatchObject({success:false,reset:true});
    expect(verificationOutcome({code:-999},DefaultResult.Ok,RegisterVerifyResult)).toMatchObject({success:false,reset:false});
  });
  it('marks valid verification ready for guarded session processing', () => expect(verificationOutcome({code:DefaultResult.Ok},DefaultResult.Ok,RegisterVerifyResult)).toEqual({success:true,reset:false,error:''}));
});
