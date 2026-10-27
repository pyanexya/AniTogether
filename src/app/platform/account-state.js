import { writable } from 'svelte/store';
// Public profile only. Native credentials never enter a store or localStorage.
export const accountState = writable(null);
export function accountAvatar(profile) {
    const path = profile?.avatarUrl;
    return typeof path === 'string' && /^\/api\/avatars\/[a-zA-Z0-9_-]+\?v=[a-zA-Z0-9_-]+$/.test(path)
        ? `https://aniartix.pyanexy.cc${path}` : null;
}
export function accountSymbol(profile) {
    return ({ cat:'🐈', moon:'☾', star:'★', sakura:'🌸', fox:'🦊' })[profile?.avatar] || '◉';
}
