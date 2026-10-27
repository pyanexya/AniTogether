<script>
    import { Pages } from "../../pages.js";
    import { localStorageWritable } from "@babichjacob/svelte-localstorage";
    import Icon from "../elements/Icon.svelte";
    import { onDestroy } from "svelte";
    import Home from "../../pages/Home.svelte";
    import Release from "../../pages/Release.svelte";
    import Profile from "../../pages/Profile.svelte";
    import Login from "../../pages/Login.svelte";
    import Player from "../../pages/Player.svelte";
    import Bookmarks from "../../pages/Bookmarks.svelte";
    import { pageHistory } from "../stores/pageHistory.js";
    import Discover from "../../pages/Discover.svelte";
    import Search from "../../pages/Search.svelte";
    import HomeIcon from "../../icons/home.svg";
    import BookmarkIcon from "../../icons/bookmark.svg";
    import FriendsIcon from "../../icons/friends.svg";
    import DiscoverIcon from "../../icons/discover.svg";
    import SearchIcon from "../../icons/search.svg";
    import NotificationIcon from "../../icons/notification.svg";
    import SettingsIcon from "../../icons/settings.svg";
    import Settings from "../../pages/Settings.svelte";
    import Friends from "../../pages/Friends.svelte";
    import FriendsAnixArtix from "../../pages/FriendsAnixArtix.svelte";
    import NotAvailable from "../../pages/NotAvailable.svelte";
    import CollectionIcon from "../../icons/collection.svg";
    import CollectionList from "../../pages/CollectionList.svelte";
    import Collection from "../../pages/Collection.svelte";
    import Notifications from "../../pages/Notifications.svelte";
    import { notificationCount } from "../stores/notificationCount";
    import Offline from "../../pages/Offline.svelte";
    import OfflineRelease from "../../pages/OfflineRelease.svelte";
    import DownloadIcon from "../../icons/download.svg";

    import { accountState, accountAvatar, accountSymbol } from "../../platform/account-state.js";
    export let onAccountLogin = () => {};

    export const views = [
        Home,
        Bookmarks,
        Friends,
        CollectionList,
        Discover,
        Search,
        NotAvailable,
        Settings,
        Release,
        Profile,
        Login,
        Player,
        Collection,
        Offline,
        OfflineRelease
    ];

    export let viewportComponent = null;
    export let argsComponent = null;

    export let viewInfoOld = {
        viewportComponent: null,
        args: null,
    };

    let utoken;

    $: nCount = $notificationCount;

    const user_token = localStorageWritable("user_token", null);
    const unsubscribeToken = user_token.subscribe((value) => {
        try { utoken = value ? JSON.parse(value) : null; }
        catch { utoken = null; }
    });
    onDestroy(unsubscribeToken);
    let showNotifications = false;
    const navigation = [
        { page: Pages.HOME, label: "Главная", icon: HomeIcon, args: { typeReleases: 0 } },
        { page: Pages.DISCOVER, label: "Открытия", icon: DiscoverIcon },
        { page: Pages.SEARCH, label: "Поиск", icon: SearchIcon, args: { query: null } },
        { page: Pages.BOOKMARKS, label: "Мой список", icon: BookmarkIcon, args: { typeBookmark: 0, sort: 1 } },
        { page: Pages.COLLECTION_LIST, label: "Коллекции", icon: CollectionIcon },
        { page: Pages.FRIENDS, label: "Друзья Anixart", icon: FriendsIcon },
        { page: Pages.OFFLINE, label: "Загрузки", icon: DownloadIcon },
    ];

    window.updateViewportComponent = (page, args, history = false) => {
        window.dispatchEvent(new Event('anixartix:navigate'));
        setViewportScrollEvent(null);
        viewInfoOld.viewportComponent = viewportComponent;
        viewInfoOld.args = argsComponent;
        if (
            viewInfoOld.viewportComponent == views[page] &&
            (JSON.stringify(viewInfoOld.args) === JSON.stringify(args) ||
                viewInfoOld.args == args)
        )
            return;

        argsComponent = args ?? null;
        viewportComponent = typeof(page) == "number" ? views[page] : page;

        if (viewportComponent != Player && viewportComponent != Release) {
            discordRPC.setActivity({
                type: 3,
                state: "Ожидание...",
                largeImageKey: "anidesk-transparent",
                largeImageText: "AnixArtix · аниме вместе",
                instance: true,
                buttons: [
                    { label: "Ссылка на клиент", url: "https://github.com/pyanexya/AniTogether" },
                ],
            });
        }

	if (!history && viewInfoOld.viewportComponent !== Player) {
		pageHistory.update(h => {
			if (h[0]?.page !== viewInfoOld.viewportComponent || JSON.stringify(h[0].args) !== JSON.stringify(viewInfoOld.args)) {
				h.unshift({ page: viewInfoOld.viewportComponent, args: viewInfoOld.args });
			}
			return h;
		});
	}
    };

</script>

<aside class="left-menu unselectable" class:hide={viewportComponent == views[Pages.PLAYER]} aria-label="Навигация">
    <button class="brand" onclick={() => updateViewportComponent(Pages.HOME, { typeReleases: 0 })} title="AnixArtix — главная">
        <img src="./assets/icons/anixartix.png" alt="" width="34" height="34" />
        <span class="brand-text">AnixArtix<span>АНИМЕ БЛИЖЕ</span></span>
    </button>
    <div class="section-label">ОБЗОР</div>
    <nav>
        <button class="nav-item" class:selected={viewportComponent === FriendsAnixArtix} title="Друзья AnixArtix" onclick={() => updateViewportComponent(FriendsAnixArtix)}>
            <Icon src={FriendsIcon} varColor="--main-text-color" size={{ width: 20, height: 20 }} /><span>Друзья AnixArtix</span>
        </button>
        {#each navigation as item, index}
            {#if index === 3}<div class="section-label library-label">БИБЛИОТЕКА</div>{/if}
            <button class="nav-item" class:selected={viewportComponent === views[item.page] || (item.page === Pages.OFFLINE && viewportComponent === OfflineRelease)}
                aria-current={viewportComponent === views[item.page] ? "page" : undefined}
                title={item.label} onclick={() => updateViewportComponent(item.page, item.args ?? null)}>
                <Icon src={item.icon} varColor="--main-text-color" size={{ width: 20, height: 20 }} />
                <span>{item.label}</span>
            </button>
        {/each}
    </nav>
    <div class="bottom-menu-content">
        <button class="nav-item" title="Уведомления" onclick={() => utoken?.token ? showNotifications = true : updateViewportComponent(Pages.LOGIN)}>
            <Icon src={NotificationIcon} varColor="--main-text-color" size={{ width: 20, height: 20 }} />
            <span>Уведомления</span>
            {#if nCount > 0}<b class="count" aria-label={`${nCount} новых уведомлений`}>{nCount > 99 ? "99+" : nCount}</b>{/if}
        </button>
        <button class="nav-item" class:selected={viewportComponent === Settings} title="Настройки" onclick={() => updateViewportComponent(Pages.SETTINGS)}>
            <Icon src={SettingsIcon} varColor="--main-text-color" size={{ width: 20, height: 20 }} />
            <span>Настройки</span>
        </button>
        <button class="connection" title={utoken?.token ? "Профиль Anixart" : "Подключить Anixart для каталога"} onclick={() => updateViewportComponent(utoken?.token ? Pages.PROFILE : Pages.LOGIN, utoken?.id)}>
            <span class:linked={Boolean(utoken?.token)} aria-hidden="true">●</span><span>Anixart: {utoken?.token ? "подключён" : "подключить"}</span>
        </button>
        <button class="account" title={$accountState?.status === 'authenticated' ? "Аккаунт AnixArtix" : "Войти в AnixArtix"} onclick={() => $accountState?.status === 'authenticated' ? updateViewportComponent(Pages.SETTINGS, {section: 'account'}) : onAccountLogin()}>
            {#if accountAvatar($accountState?.profile)}
                <img src={accountAvatar($accountState.profile)} alt="" width="34" height="34" referrerpolicy="no-referrer" onerror={event => { event.currentTarget.src = './assets/icons/defaultAvatar.svg'; }}/>
            {:else}<span class="account-symbol" aria-hidden="true">{accountSymbol($accountState?.profile)}</span>{/if}
            <span><strong>{$accountState?.profile?.displayName || $accountState?.profile?.username || "Войти в AnixArtix"}</strong><small>{$accountState?.status === 'authenticated' ? "Ваш аккаунт AnixArtix" : "Google / Discord"}</small></span>
        </button>
    </div>
</aside>
{#if showNotifications}
    <Notifications showed={showNotifications} on:closeModal={() => showNotifications = false} />
{/if}

<style>
    .connection { display:flex; gap:7px; align-items:center; width:100%; padding:10px 14px 0; text-align:left; color:var(--third-text-color); font-size:10px; }
    .connection .linked { color:#73bb95; }
    .account-symbol { display:grid; place-items:center; width:34px; height:34px; border-radius:11px; background:var(--accent-soft); color:var(--accent-color); font-size:22px; flex-shrink:0; }
    @media(max-width:900px) { .connection { justify-content:center; padding:10px 0 0; } .connection span:last-child { display:none; } .account .account-symbol { display:grid; } }

    .left-menu { display:flex; flex-direction:column; flex:0 0 208px; width:208px; height:100%; box-sizing:border-box; background:var(--alt-background-color); border-right:1px solid var(--border-color); padding:20px 12px 12px; z-index:10; overflow-y:auto; }
    .brand { display:flex; align-items:center; gap:10px; text-align:left; padding:0 8px 25px; min-height:59px; flex-shrink:0; }
    .brand-text { font-size:17px; letter-spacing:-.6px; font-weight:750; }
    .brand-text span { display:block; font-size:8px; letter-spacing:2.3px; font-weight:600; color:var(--third-text-color); margin-top:3px; }
    .section-label { padding:0 14px 9px; color:var(--third-text-color); font-size:9px; font-weight:700; letter-spacing:1.7px; }
    .library-label { margin-top:23px; }
    nav { display:flex; flex-direction:column; gap:4px; }
    .nav-item { display:flex; align-items:center; gap:13px; min-height:42px; width:100%; padding:0 14px; border-radius:10px; text-align:left; font-size:12px; font-weight:550; color:var(--secondary-text-color); transition:background .15s,color .15s; }
    .nav-item:hover { background:var(--hover-color); color:var(--main-text-color); }
    .nav-item.selected { background:var(--accent-soft); color:var(--accent-color); }
    .nav-item.selected::before { content:""; position:absolute; left:-12px; height:18px; width:3px; background:var(--accent-color); border-radius:0 3px 3px 0; }
    .bottom-menu-content { margin-top:auto; padding-top:30px; }
    .count { margin-left:auto; background:var(--accent-color); color:var(--accent-contrast); border-radius:6px; padding:2px 5px; font-size:9px; }
    .account { display:flex; align-items:center; gap:10px; width:100%; border-top:1px solid var(--border-color); padding:17px 6px 0; margin-top:14px; text-align:left; }
    .account img { border-radius:11px; flex-shrink:0; object-fit:cover; }
    .account span { min-width:0; }
    .account strong { display:block; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:125px; }
    .account small { display:block; font-size:9px; color:var(--third-text-color); margin-top:3px; }
    @media (max-width:900px) { .left-menu { width:72px; flex-basis:72px; padding:18px 8px 10px; } .brand { padding:0 10px 24px; } .brand-text,.section-label,.nav-item span,.account span { display:none; } .library-label { display:block; height:10px; padding:0; margin:0; } .nav-item { justify-content:center; padding:0; } .nav-item.selected::before { left:-8px; } .account { justify-content:center; padding:14px 0 0; } .count { position:absolute; right:0; top:0; } }
</style>
