<script>
    import { pageHistory } from "../stores/pageHistory.js";
    import { onMount } from "svelte";
    let isDebug = false;
    onMount(async () => { isDebug = await window.prc?.isDebug?.() ?? false; });
    function backToHistory() {
        if (!$pageHistory.length) return;
        let previous;
        pageHistory.update(history => { const next = [...history]; previous = next.shift(); return next; });
        if (previous?.page) window.updateViewportComponent(previous.page, previous.args, true);
    }
</script>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="title-bar unselectable" onmousedown={(event) => {
    if (event.button === 0 && !event.target.closest('button')) window.titleBarAPI.startDragging().catch(console.error);
}} ondblclick={(event) => {
    if (!event.target.closest('button')) window.titleBarAPI.maximize().catch(console.error);
}}>
    <button class="back" title="Назад" aria-label="Назад" disabled={!$pageHistory.length} onclick={backToHistory}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m14 6-6 6 6 6M8 12h12" /></svg>
    </button>
    <span class="window-name">AnixArtix <span>DESKTOP</span>{#if isDebug}<b>DEBUG</b>{/if}</span>
    <div class="window-actions">
        <button title="Свернуть" aria-label="Свернуть" onclick={() => window.titleBarAPI?.minimize()}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" stroke="currentColor" /></svg></button>
        <button title="Развернуть" aria-label="Развернуть" onclick={() => window.titleBarAPI?.maximize()}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="1" /></svg></button>
        <button class="close" title="Закрыть" aria-label="Закрыть" onclick={() => window.titleBarAPI?.close()}><svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" aria-hidden="true"><path d="m2 2 8 8M10 2l-8 8" /></svg></button>
    </div>
</div>
<style>
    .title-bar { position:absolute; top:0; left:0; right:0; display:flex; align-items:center; height:38px; z-index:9999; background:var(--alt-background-color); color:var(--secondary-text-color); border-bottom:1px solid var(--border-color); box-sizing:border-box; -webkit-app-region:drag; }
    button { -webkit-app-region:no-drag; display:grid; place-items:center; height:37px; width:46px; color:var(--secondary-text-color); border-radius:0; }
    button:hover { background:var(--hover-color); color:var(--main-text-color); }
    button:disabled { opacity:.25; cursor:default; }
    .back { width:48px; }
    .window-name { font-size:10px; font-weight:650; letter-spacing:.2px; }
    .window-name span { font-size:8px; margin-left:9px; color:var(--third-text-color); letter-spacing:1.5px; }
    .window-name b { font-size:8px; margin-left:10px; color:var(--warning-color); }
    .window-actions { display:flex; margin-left:auto; }
    .close:hover { background:#c5364c; color:white; }
</style>
