import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect, vi, afterEach } from 'vitest';
const source = readFileSync(new URL('../public/startup.js', import.meta.url), 'utf8');
function start() {
    const retry = { hidden: true, addEventListener: vi.fn() };
    const message = { textContent: 'Запускаем клиент…' };
    const listeners = {};
    const context = { document: { getElementById: id => id === 'startup-retry' ? retry : message }, window: { addEventListener: (name, callback) => listeners[name] = callback }, location: { reload: vi.fn() }, setTimeout, clearTimeout };
    vm.runInNewContext(source, context);
    return { retry, message, listeners, context };
}
afterEach(() => vi.useRealTimers());
describe('standalone startup feedback', () => {
    it('offers retry for a stalled/missing bundle without claiming permanent failure', () => {
        vi.useFakeTimers(); const { retry, message, context } = start();
        vi.advanceTimersByTime(15000);
        expect(retry.hidden).toBe(false);
        expect(message.textContent).toContain('Можно подождать');
        retry.addEventListener.mock.calls[0][1]();
        expect(context.location.reload).toHaveBeenCalledOnce();
    });
    it('cancels the slow-start message once the app mounts', () => {
        vi.useFakeTimers(); const { retry, message, listeners } = start();
        listeners['anixartix:ready'](); vi.advanceTimersByTime(15000);
        expect(retry.hidden).toBe(true);
        expect(message.textContent).toBe('Запускаем клиент…');
    });
});
