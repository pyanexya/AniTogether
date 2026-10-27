import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { bootstrap } from '../src/app/platform/bridge.js';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const native = () => ({invoke:vi.fn().mockResolvedValue({}),listen:vi.fn().mockResolvedValue(()=>{})});
afterEach(()=>vi.useRealTimers());
describe('bounded native bootstrap readiness',()=>{
    it('does not report mounted before the mount has completed',async()=>{
        const held=deferred(), started=deferred(), stages=[];
        const pending=bootstrap({target:{},native:native(),loadApp:async()=>({}),mountApp:()=>{started.resolve();return held.promise},onStage:s=>stages.push(s)});
        await started.promise;
        expect(stages).toContain('mount-started');expect(stages).not.toContain('app-mounted');
        held.resolve();const bridge=await pending;expect(stages.at(-1)).toBe('app-mounted');bridge.dispose();
    });
    it('times out stalled native IPC and never imports or mounts on late reply',async()=>{
        vi.useFakeTimers();const held=deferred(),n=native(),loadApp=vi.fn(),mountApp=vi.fn(),stages=[];
        n.invoke.mockReturnValue(held.promise);
        const pending=bootstrap({target:{},native:n,loadApp,mountApp,onStage:s=>stages.push(s),stageTimeout:100});
        const rejected=expect(pending).rejects.toThrow('настройки ядра');
        await vi.advanceTimersByTimeAsync(100);await rejected;held.resolve({});await Promise.resolve();
        expect(loadApp).not.toHaveBeenCalled();expect(mountApp).not.toHaveBeenCalled();expect(stages.at(-1)).toBe('failed');
    });
    it('late module completion cannot ghost mount after failure',async()=>{
        vi.useFakeTimers();const held=deferred(),mountApp=vi.fn();
        const pending=bootstrap({target:{},native:native(),loadApp:()=>held.promise,mountApp,stageTimeout:100});
        const rejected=expect(pending).rejects.toThrow('загрузка интерфейса');
        await vi.advanceTimersByTimeAsync(100);await rejected;held.resolve({});await Promise.resolve();
        expect(mountApp).not.toHaveBeenCalled();
    });
    it('aborts stalled mount and consumes late rejection without ready',async()=>{
        vi.useFakeTimers();const held=deferred(),stages=[];let signal;
        const pending=bootstrap({target:{},native:native(),loadApp:async()=>({}),mountApp:(_,s)=>{signal=s;return held.promise},onStage:s=>stages.push(s),stageTimeout:100});
        const rejected=expect(pending).rejects.toThrow('отображение интерфейса');
        await vi.advanceTimersByTimeAsync(100);await rejected;
        expect(signal.aborted).toBe(true);held.reject(new Error('late rejection'));await Promise.resolve();
        expect(stages).not.toContain('app-mounted');expect(stages.at(-1)).toBe('failed');
    });
    it('failure is not ready, and successful DOM proof follows tick and frames',()=>{
        const app=readFileSync(new URL('../src/app/app.js',import.meta.url),'utf8');
        expect(app.slice(app.indexOf('.catch(error => {'))).not.toContain("new Event('anixartix:ready')");
        expect(app).toContain("new Event('anixartix:failed')");expect(app).toContain('await tick()');
        expect(app).toContain("document.querySelector('[data-anixartix-app]')");
        expect(app).toContain('requestAnimationFrame(() => requestAnimationFrame(resolve))');
    });
});
