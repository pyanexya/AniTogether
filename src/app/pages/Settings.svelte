<script>
    import Separator from "../components/elements/Separator.svelte";
    import SettingsAbout from "../settings-pages/SettingsAbout.svelte";
    import SettingsPlayer from "../settings-pages/SettingsPlayer.svelte";
    import SettingsProfile from "../settings-pages/SettingsProfile.svelte";
    import SettingsPlaying from "../settings-pages/SettingsPlaying.svelte";
    import SettingsUpscale from "../settings-pages/SettingsUpscale.svelte";
    import { localStorageWritable } from "@babichjacob/svelte-localstorage";
    import githubLogo from "../icons/github.svg";
    import Icon from "../components/elements/Icon.svelte";
    import SettingsAccount from "../settings-pages/SettingsAccount.svelte";
    import SettingsApp from "../settings-pages/SettingsApp.svelte";

    import { runtimeVersionLabels } from "../platform/runtime-info.js";

    const runtimeLabels = runtimeVersionLabels(window.versions);
    const user_token = localStorageWritable("user_token", null);

    const views = [SettingsProfile, SettingsApp, SettingsPlayer, SettingsPlaying, SettingsUpscale, SettingsAbout];

    export let args = null;

    let viewInfo = {
        page: SettingsAccount,
        args: null
    }

    $: if (args?.section === 'account') viewInfo = { page: SettingsAccount, args: null };

    function setPage(page, args) {
        viewInfo.page = page;
        viewInfo.args = args;
    }
</script>


<div class="settings flex-row">
    <div class="settings-left-menu flex-column">
        <span class="settings-title">Основное</span>
        <button class="settings-category flex-row" class:selected-category={viewInfo.page == SettingsAccount} onclick={() => setPage(SettingsAccount, null)}>Аккаунт AnixArtix</button>
        <button class="settings-category flex-row" class:selected-category={viewInfo.page == views[0]} onclick={() => setPage(views[0], null)}>Профиль каталога Anixart</button>
        <button class="settings-category flex-row" class:selected-category={viewInfo.page == views[1]} onclick={() => setPage(views[1], null)}>Настройки приложения</button>
        <Separator marginRight={22}/>
        <span class="settings-title">Воспроизведение</span>
        <button class="settings-category flex-row" class:selected-category={viewInfo.page == views[2]} onclick={() => setPage(views[2], null)}>Настройки плеера</button>
        <button class="settings-category flex-row" class:selected-category={viewInfo.page == views[3]} onclick={() => setPage(views[3], null)}>Настройки воспроизведения</button>
        <button class="settings-category flex-row" class:selected-category={viewInfo.page == views[4]} onclick={() => setPage(views[4], null)}>Улучшение качества</button>
        <Separator marginRight={22}/>
        <button class="settings-category flex-row" class:selected-category={viewInfo.page == views[5]} onclick={() => setPage(views[5], null)}>О программе</button>
        <Separator marginRight={22}/>
        <button class="settings-category flex-row" disabled={!anixApi.client.token} class:disabled={!anixApi.client.token} onclick={() => {
            user_token.set(null);
            location.reload();
        }}>Выйти из Anixart</button>
        <Separator marginRight={22}/>
        <div class="build-info flex-column">
            {#each runtimeLabels as label}
                <span class="third-text">{label}</span>
            {/each}
        </div>
        <div class="links-info flex-row">
            <button onclick={() => winApi.openLink(`https://github.com/pyanexya/AniTogether`)}>
            <Icon src={githubLogo} varColor="--third-text-color" size={{width: 30, height: 30}}/>
            </button>
        </div>
    </div>
    <div class="settings-page">
        {#key viewInfo}
        <svelte:component this={viewInfo.page} args={viewInfo.args}></svelte:component>
        {/key}
    </div>
</div>

<style>
    .third-text {
        color: var(--third-text-color);
        font-size: 11px;
        font-weight: 400;
        max-width: 100%;
    }

    .links-info {
        margin-top: 10px;
        margin-right: 22px;
        width: 100%;
    }

    .build-info {
        margin-top: 10px;
    }

    .settings {
        width: 100%;
        min-width: 0;
        min-height: 0;
        height: 100%;
        overflow: hidden;
    }

    .settings-page {
        flex: 1 1 0;
        min-width: 0;
        min-height: 0;
        overflow: auto;
        overflow-wrap: anywhere;
        padding-bottom: 20px;
    }

    .selected-category {
        background-color: var(--select-button-left-color) !important;
        color: var(--main-text-color) !important;
    }

    .settings-title {
        font-size: 14px;
        font-weight: 500;
        color: var(--secondary-text-color);
        padding-left: 15px;
        max-width: 100%;
        margin-bottom: 10px;
    }

    .settings-left-menu {
        flex: 0 0 210px;
        min-width: 0;
        box-sizing: border-box;
        background-color: var(--alt-background-color);
        align-items: stretch;
        overflow-y: auto;
        padding: 28px 10px;
    }

    .settings-category {
        margin-top: 2px;
        min-height: 34px;
        width: 100%;
        box-sizing: border-box;
        text-align: left;
        justify-content: flex-start;
        align-items: center;
        padding: 7px 8px;
        margin-right: 0;
        border-radius: 10px;
        color: var(--secondary-text-color);
        flex-shrink: 0;
        transition: background-color 0.2s ease-in-out;
    }

    .settings-category:hover {
        background-color: var(--select-button-color);
        color: var(--main-text-color);
    }
    @media (max-width: 760px) {
        .settings { flex-direction: column; overflow-y: auto; }
        .settings-left-menu { flex: 0 0 auto; padding: 16px; overflow: visible; }
        .settings-page { flex: 1 0 auto; overflow: visible; }
    }
</style>