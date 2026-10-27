import './app.css';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { bootstrap } from './platform/bridge.js';
import { installNativeFetch } from './platform/fetch.js';

bootstrap({
    target: window,
    report: (message, error) => {
        console.error(message, error);
        let status = document.getElementById('native-event-error');
        if (!status) {
            status = document.createElement('div'); status.id = 'native-event-error';
            status.setAttribute('role', 'alert');
            status.style.cssText = 'position:fixed;bottom:16px;left:16px;right:16px;z-index:99999;background:#662d3c;color:#fff;padding:16px;border-radius:12px;font:14px system-ui';
            document.body.append(status);
        }
        status.textContent = `${message}. Состояние приложения может не обновляться. Перезапустите клиент.`;
    },
    native: isTauri() ? { invoke, listen } : null,
    loadApp: () => {
        installNativeFetch(window);
        return import('./App.svelte');
    },
    mountApp: async ({ default: App }) => {
        const { mount } = await import('svelte');
        mount(App, { target: document.body });
        document.getElementById('startup-status')?.remove();
        window.dispatchEvent(new Event('anixartix:ready'));
    },
}).then(bridge => window.addEventListener('beforeunload', bridge.dispose, { once: true }))
.catch(error => {
    window.dispatchEvent(new Event('anixartix:ready'));
    console.error('Native startup failed', error);
    const panel = document.createElement('main');
    panel.style.cssText = 'max-width:640px;margin:12vh auto;padding:32px;font:16px system-ui;color:#eee;background:#24252b;border-radius:20px';
    const title = document.createElement('h1'); title.textContent = 'AnixArtix не удалось запустить';
    const detail = document.createElement('p'); detail.textContent = String(error?.message || error);
    const retry = document.createElement('button'); retry.textContent = 'Повторить запуск'; retry.onclick = () => location.reload();
    panel.append(title, detail, retry); document.body.replaceChildren(panel);
});
