import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const commands = ['friends_list', 'friends_lookup', 'friends_request', 'friends_accept', 'friends_reject', 'friends_remove', 'watch_invites_list', 'watch_invite_send', 'watch_invite_accept', 'watch_invite_decline'];
describe('native social command registration', () => {
    it.each(commands)('%s is implemented, registered, and permissioned only for main', command => {
        expect(read('src-tauri/src/account_host.rs')).toContain(`pub async fn ${command}(`);
        expect(read('src-tauri/src/lib.rs')).toContain(`account_host::${command},`);
        expect(read('src-tauri/build.rs')).toContain(`"${command}"`);
        const capability = JSON.parse(read('src-tauri/capabilities/main.json'));
        expect(capability.permissions).toContain(`allow-${command.replaceAll('_', '-')}`);
        expect(capability.windows).toEqual(['main']);
        expect(capability.remote).toBeUndefined();
    });
});
