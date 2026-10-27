// Independent of the app bundle: a missing chunk must not leave an empty window.
(() => {
    const retry = document.getElementById('startup-retry');
    if (retry) retry.addEventListener('click', () => location.reload());
    const slowStartup = setTimeout(() => {
        const message = document.getElementById('startup-message');
        if (!message) return;
        message.textContent = 'Запуск занимает больше времени, чем обычно. Можно подождать или повторить запуск.';
        if (retry) retry.hidden = false;
    }, 15000);
    window.addEventListener('anixartix:ready', () => clearTimeout(slowStartup), { once: true });
})();
