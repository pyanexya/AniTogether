<script>
    import { Pages } from '../pages.js';
    import { Lottie } from 'lottie-svelte'
    import BaseMainButton from '../components/buttons/BaseMainButton.svelte';
</script>

<div class="container">
    <div class="auth flex-column">
        <div class="lottie-container">
            <Lottie path="./assets/lottie/auth-anim.json" autoplay="true" renderer="svg"></Lottie>
        </div>
        <div class="text-auth flex-column">
            <span class="title">Данный функционал доступен только авторизованным пользователям</span>
            <span class="bottom">Пожалуйста, авторизуйтесь для использования данного функционала</span>
        </div>
        <BaseMainButton style="primary" width="60%" borderRadius={6} onClickCallback={() => {updateViewportComponent(Pages.LOGIN)}}>Авторизоваться</BaseMainButton>
    </div>
</div>

<style>
    .lottie-container {
        width: min(100%, 320px);
        aspect-ratio: 1;
        flex-shrink: 0;
        display: flex
    }

    .title {
        font-size: clamp(20px, 2.2vw, 30px);
        font-weight: 500;
        text-align: center;
    }

    .text-auth {
        display: flex;
        align-items: center;
        margin-bottom: 10px;
    }

    .container {
        width: 100%;
        min-width: 0;
        align-items: center;
        display: flex;
        justify-content: center;
    }

    .auth {
        box-sizing: border-box;
        padding: 16px 24px 32px;
        gap: 12px;
        overflow-wrap: anywhere;
        justify-content: center;
        align-items: center;
        position: relative;
        width: 100%;
        min-width: 0;
    }
</style>