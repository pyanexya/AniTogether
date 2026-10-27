<script>
    import { Pages } from "../pages.js";
    import MetaInfo from "../components/gui/MetaInfo.svelte";
    import { onDestroy } from "svelte";
    export let args = { typeReleases: 0 };
    const tabs = ["Последние", "Онгоинги", "Анонсы", "Завершённые", "Фильмы"];
    let selected = args?.typeReleases ?? 0;
    let releases = [];
    let page = 0;
    let loading = false;
    let error = "";
    let hasMore = true;
    let generation = 0;
    let disposed = false;
    let query = "";
    const filters = type => ({ sort: 0, status_id: [null, 2, 3, 1, null][type] ?? null, category_id: type === 4 ? 2 : null });
    async function load(reset = false) {
        if (loading && !reset) return;
        if (reset) { generation++; releases = []; page = 0; hasMore = true; }
        const requestGeneration = generation;
        const requestPage = reset ? 0 : page + 1;
        loading = true;
        error = "";
        try {
            const response = await anixApi.release.filter(requestPage, filters(selected), true);
            if (disposed || requestGeneration !== generation) return;
            if (!Array.isArray(response?.content)) throw new Error("Invalid catalogue response");
            const unique = new Map(releases.map(item => [item.id, item]));
            for (const item of response.content) {
                if (item?.id != null && !unique.has(item.id)) unique.set(item.id, item);
            }
            releases = [...unique.values()];
            hasMore = response.content.length > 0;
            page = requestPage;
        } catch {
            if (!disposed && requestGeneration === generation) error = "Не удалось загрузить каталог. Проверьте подключение и попробуйте ещё раз.";
        } finally {
            if (!disposed && requestGeneration === generation) loading = false;
        }
    }
    function selectTab(type) {
        if (selected === type) return;
        selected = type;
        args = { ...(args ?? {}), typeReleases: type };
        document.getElementById("viewport")?.scrollTo({ top: 0 });
        load(true);
    }
    function search() { window.updateViewportComponent(Pages.SEARCH, { query: query.trim() || null }); }
    load(true);
    setViewportScrollEvent(event => {
        const target = event.target || event.currentTarget;
        if (target && target.scrollTop + target.clientHeight >= target.scrollHeight - 500 && hasMore && !loading && !error) load();
    });
    onDestroy(() => { disposed = true; generation++; setViewportScrollEvent(null); });
</script>
<MetaInfo subTitle="Главная" />
<section class="home">
    <header class="home-header">
        <div><div class="eyebrow">ВАША СЛЕДУЮЩАЯ ИСТОРИЯ</div><h1>Что посмотрим?</h1><p>Новые серии, любимые миры и аниме под настроение.</p></div>
        <form class="quick-search" onsubmit={event => { event.preventDefault(); search(); }} role="search">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
            <input bind:value={query} placeholder="Найти аниме…" aria-label="Название аниме" />
            <button type="submit" aria-label="Найти аниме" title="Найти">↵</button>
        </form>
    </header>
    <div class="catalogue-heading"><h2>Каталог</h2><span>На основе Anixart</span></div>
    <div class="tabs" role="group" aria-label="Категория аниме">
        {#each tabs as label, index}<button class:active={selected === index} aria-pressed={selected === index} onclick={() => selectTab(index)}>{label}</button>{/each}
    </div>
    {#if error}
        <div class="notice" role="alert"><div><strong>Каталог временно недоступен</strong><p>{error}</p></div><button onclick={() => load(releases.length === 0)}>Повторить</button></div>
    {/if}
    <div class="anime-grid" aria-busy={loading}>
        {#each releases as anime (anime.id)}
            <button class="anime-card" onclick={() => window.updateViewportComponent(Pages.RELEASE, { id: anime.id })} aria-label={`Открыть ${anime.title_ru || anime.title || "аниме"}`}>
                <div class="poster">
                    <img src={anime.image || "./assets/icons/anixartix.png"} alt="" loading="lazy" onerror={event => {
                        const image = event.currentTarget;
                        if (image.dataset.fallback) return;
                        image.dataset.fallback = "true";
                        image.src = "./assets/icons/anixartix.png";
                        image.classList.add("poster-fallback");
                    }} />
                    {#if typeof anime.grade === "number" && anime.grade > 0}<span class="rating"><span aria-hidden="true">★</span> {anime.grade.toFixed(1)}</span>{/if}
                    <span class="open-card" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>
                </div>
                <h3>{anime.title_ru || anime.title || "Без названия"}</h3>
                <div class="card-meta"><span>{anime.year || anime.status?.name || "Аниме"}</span><span>{utils.returnEpisodeString(anime)} эп.</span></div>
            </button>
        {/each}
        {#if loading && releases.length === 0}
            {#each Array(12) as _}<div class="skeleton-card" aria-hidden="true"><div></div><span></span><small></small></div>{/each}
        {/if}
    </div>
    {#if !loading && !error && releases.length === 0}
        <div class="empty"><img src="./assets/icons/anixartix.png" width="48" height="48" alt=""/><h2>Пока ничего нет</h2><p>В этой категории ещё нет релизов. Попробуйте другую категорию или поиск.</p><button onclick={search}>Открыть поиск</button></div>
    {:else if releases.length > 0 && hasMore}
        <div class="load-more"><button disabled={loading} onclick={() => load()}>{loading ? "Загружаем ещё…" : "Показать ещё"}</button></div>
    {/if}
</section>
<style>
    .home { padding:34px 36px 24px; max-width:1500px; margin:0 auto; }
    .home-header { display:flex; align-items:center; justify-content:space-between; gap:24px; margin-bottom:40px; }
    .eyebrow { font-size:9px; font-weight:650; color:var(--accent-color); letter-spacing:2px; margin-bottom:9px; }
    h1 { font-size:30px; line-height:1.2; font-weight:700; letter-spacing:-1px; margin:0 0 10px; }
    .home-header p { font-size:12px; color:var(--secondary-text-color); margin:0; }
    .quick-search { display:flex; align-items:center; gap:11px; width:285px; flex-shrink:0; padding:10px 12px; background:var(--alt-background-color); border:1px solid var(--border-color); border-radius:11px; color:var(--third-text-color); }
    .quick-search:focus-within { border-color:var(--accent-color); }
    input { background:none; border:0; color:var(--main-text-color); min-width:0; width:100%; font:inherit; font-size:12px; outline:0; }
    input::placeholder { color:var(--third-text-color); }
    .quick-search button { padding:0 5px; color:var(--third-text-color); }
    .catalogue-heading { display:flex; align-items:baseline; gap:12px; margin-bottom:17px; }
    .catalogue-heading h2 { margin:0; font-size:18px; font-weight:650; letter-spacing:-.4px; }
    .catalogue-heading span { font-size:10px; color:var(--third-text-color); }
    .tabs { display:flex; gap:5px; margin-bottom:25px; overflow-x:auto; padding-bottom:3px; }
    .tabs button { white-space:nowrap; padding:8px 15px; font-size:11px; font-weight:550; color:var(--secondary-text-color); border:1px solid transparent; border-radius:8px; }
    .tabs button:hover { background:var(--hover-color); }
    .tabs button.active { color:var(--accent-color); background:var(--accent-soft); border-color:var(--accent-border); }
    .anime-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:27px 20px; }
    .anime-card { text-align:left; padding:0; display:block; min-width:0; border-radius:11px; }
    .poster { aspect-ratio:2/3; position:relative; overflow:hidden; background:var(--alt-background-color); border-radius:12px; border:1px solid var(--border-color); }
    .poster img { width:100%; height:100%; object-fit:cover; display:block; transition:transform .25s ease; }
    .poster img:global(.poster-fallback) { object-fit:contain; padding:35%; box-sizing:border-box; }
    .anime-card:hover .poster img { transform:scale(1.035); }
    .rating { position:absolute; top:9px; left:9px; background:#11141de8; color:#fff; border:1px solid #ffffff18; border-radius:6px; padding:3px 6px; font-size:10px; font-weight:650; backdrop-filter:blur(10px); }
    .rating span { color:#e8c97e; }
    .open-card { display:grid; place-items:center; position:absolute; bottom:10px; right:10px; width:32px; height:32px; border-radius:50%; background:var(--accent-color); color:var(--accent-contrast); opacity:0; transform:translateY(5px); transition:opacity .15s,transform .15s; }
    .anime-card:hover .open-card,.anime-card:focus-visible .open-card { opacity:1; transform:none; }
    h3 { font-size:12px; font-weight:600; line-height:1.5; margin:10px 0 6px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; min-height:36px; }
    .card-meta { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:10px; color:var(--third-text-color); }
    .card-meta span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .skeleton-card div { aspect-ratio:2/3; border-radius:12px; background:var(--skeleton-background-color); animation:skeletonAnimation 1.8s infinite; }
    .skeleton-card span,.skeleton-card small { display:block; background:var(--skeleton-background-color); height:12px; border-radius:3px; margin-top:12px; width:85%; }
    .skeleton-card small { width:55%; height:9px; margin-top:8px; }
    .notice { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:20px; border:1px solid var(--border-color); border-radius:12px; background:var(--alt-background-color); margin-bottom:24px; }
    .notice strong { font-size:13px; } .notice p { color:var(--secondary-text-color); font-size:12px; margin:5px 0 0; }
    .notice button,.load-more button,.empty button { border:1px solid var(--border-color); background:var(--alt-background-color); border-radius:8px; padding:10px 18px; font-size:12px; white-space:nowrap; }
    .notice button:hover,.load-more button:hover,.empty button:hover { background:var(--hover-color); }
    .load-more { text-align:center; margin-top:30px; } .load-more button:disabled { opacity:.5; cursor:wait; }
    .empty { text-align:center; max-width:390px; padding:65px 10px; margin:0 auto; }
    .empty h2 { font-size:19px; margin:18px 0 8px; } .empty p { font-size:13px; color:var(--secondary-text-color); margin:0 0 22px; }
    @media (max-width:1100px) { .home { padding:28px 24px; } .home-header { align-items:flex-start; flex-direction:column; gap:20px; margin-bottom:30px; } .quick-search { width:min(100%,360px); box-sizing:border-box; } }
    @media (max-width:600px) { .home { padding:24px 16px; } h1 { font-size:25px; } .anime-grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:22px 12px; } .tabs button { padding:8px 11px; } .notice { align-items:flex-start; flex-direction:column; } }
</style>
