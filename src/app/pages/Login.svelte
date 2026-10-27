<script>
    import { localStorageWritable } from "@babichjacob/svelte-localstorage";
    import { DefaultResult, LoginResult, RegisterResult, RegisterVerifyResult } from "anixartjs";
    import MetaInfo from "../components/gui/MetaInfo.svelte";
    import { onDestroy } from "svelte";
    import { createAuthRequestGate, readAuthSession, registrationOutcome, verificationOutcome } from "../utils/authFlow.js";

    const user = localStorageWritable("user_token", null);
    const requestGate = createAuthRequestGate();
    let activeTab = "login";
    let registerStep = 1;
    let lastError = "";
    let isLoading = false;
    let disposed = false;
    let showPassword = false;
    let loginVal = "";
    let passwordVal = "";
    let emailVal = "";
    let confirmPasswordVal = "";
    let codeVal = "";
    let registerHash = "";

    onDestroy(() => {
        disposed = true;
        requestGate.dispose();
        passwordVal = "";
        confirmPasswordVal = "";
        codeVal = "";
        registerHash = "";
    });

    function changeTab(tab) {
        if (isLoading || activeTab === tab) return;
        requestGate.invalidate();
        activeTab = tab;
        lastError = "";
        showPassword = false;
        registerStep = 1;
        registerHash = "";
        codeVal = "";
        passwordVal = "";
        confirmPasswordVal = "";
    }

    function finishAuthentication(response) {
        if (disposed) return;
        const session = readAuthSession(response);
        if (!session) {
            lastError = "Сервер не вернул данные для входа. Попробуйте ещё раз.";
            return;
        }
        user.set(JSON.stringify(session));
        passwordVal = "";
        confirmPasswordVal = "";
        codeVal = "";
        registerHash = "";
        location.reload();
    }

    async function submit() {
        if (isLoading || disposed) return;
        lastError = "";
        loginVal = loginVal.trim();
        emailVal = emailVal.trim();
        if (activeTab === "register" && registerStep === 2) {
            if (!codeVal.trim()) { lastError = "Введите код подтверждения из письма."; return; }
            if (!registerHash) { registerStep = 1; lastError = "Запрос регистрации истёк. Проверьте данные и отправьте форму снова."; return; }
        } else if (!loginVal || !passwordVal || (activeTab === "register" && (!emailVal || !confirmPasswordVal))) {
            lastError = "Заполните все поля, чтобы продолжить.";
            return;
        }
        if (activeTab === "register" && registerStep === 1) {
            if (passwordVal !== confirmPasswordVal) { lastError = "Пароли не совпадают. Проверьте повторный ввод."; return; }
            if (passwordVal.length < 6) { lastError = "Для регистрации нужен пароль не короче 6 символов."; return; }
        }
        const request = requestGate.begin();
        if (request === null) return;
        isLoading = true;
        try {
            if (activeTab === "login") {
                const response = await anixApi.auth.signIn({ login: loginVal, password: passwordVal });
                if (!requestGate.isCurrent(request)) return;
                if (response.code === DefaultResult.Ok) finishAuthentication(response);
                else if (response.code === LoginResult.InvalidLogin || response.code === LoginResult.InvalidPassword) lastError = "Не удалось войти. Проверьте логин и пароль.";
                else lastError = typeof response.message === "string" ? response.message : "Вход пока недоступен. Попробуйте ещё раз.";
            } else if (registerStep === 1) {
                const response = await anixApi.auth.signUp({ email: emailVal, login: loginVal, password: passwordVal });
                if (!requestGate.isCurrent(request)) return;
                const outcome = registrationOutcome(response, DefaultResult.Ok, RegisterResult, registerHash);
                registerStep = outcome.step;
                registerHash = outcome.hash;
                lastError = outcome.error;
                if (outcome.step === 2) { codeVal = ""; showPassword = false; }
            } else {
                const response = await anixApi.auth.signUpVerify({ email: emailVal, login: loginVal, password: passwordVal, hash: registerHash, code: codeVal.trim() });
                if (!requestGate.isCurrent(request)) return;
                const outcome = verificationOutcome(response, DefaultResult.Ok, RegisterVerifyResult);
                if (outcome.success) finishAuthentication(response);
                else {
                    if (outcome.reset) { registerHash = ""; codeVal = ""; registerStep = 1; }
                    lastError = outcome.error;
                }
            }
        } catch {
            if (requestGate.isCurrent(request)) lastError = "Не удалось связаться с Anixart. Проверьте интернет и повторите попытку.";
        } finally {
            if (requestGate.finish(request) && !disposed) isLoading = false;
        }
    }

    function backToRegistration() {
        if (isLoading) return;
        requestGate.invalidate();
        registerStep = 1;
        registerHash = "";
        codeVal = "";
        lastError = "";
    }
</script>

<MetaInfo subTitle={activeTab === "login" ? "Вход" : "Регистрация"} />
<section class="auth-page" aria-label="Аккаунт Anixart">
    <div class="auth-intro">
        <div class="identity"><img src="./assets/icons/anixartix.png" alt="" width="44" height="44" /><span>AnixArtix</span></div>
        <span class="eyebrow">ВАШЕ МЕСТО ДЛЯ АНИМЕ</span>
        <h1>Ваши истории.<br />Всегда рядом.</h1>
        <p>Войдите в аккаунт Anixart, чтобы продолжить с вашей библиотекой, историей и друзьями.</p>
        <ul>
            <li><span aria-hidden="true">01</span><div><strong>Любимое в одном месте</strong><small>Списки просмотра и сохранённые тайтлы.</small></div></li>
            <li><span aria-hidden="true">02</span><div><strong>Продолжайте свою историю</strong><small>История просмотра вашего аккаунта.</small></div></li>
            <li><span aria-hidden="true">03</span><div><strong>Не смотрите в одиночку</strong><small>Друзья и совместный просмотр в плеере.</small></div></li>
        </ul>
        <div class="disclaimer">Неофициальный клиент Anixart. Для входа используется ваш аккаунт сервиса.</div>
    </div>
    <div class="auth-card">
        <div class="tabs" role="group" aria-label="Вход или регистрация">
            <button type="button" class:active={activeTab === "login"} aria-pressed={activeTab === "login"} disabled={isLoading} onclick={() => changeTab("login")}>Вход</button>
            <button type="button" class:active={activeTab === "register"} aria-pressed={activeTab === "register"} disabled={isLoading} onclick={() => changeTab("register")}>Регистрация</button>
        </div>
        <header>
            <h2>{activeTab === "login" ? "С возвращением" : registerStep === 1 ? "Начнём новую историю" : "Проверьте почту"}</h2>
            <p>{activeTab === "login" ? "Рады видеть вас снова. Введите данные Anixart." : registerStep === 1 ? "Создайте аккаунт Anixart для вашей библиотеки." : `Введите код из письма, отправленного на ${emailVal}.`}</p>
        </header>
        <form onsubmit={event => { event.preventDefault(); submit(); }} aria-busy={isLoading}>
            {#if lastError}<div class="auth-error" id="auth-error" role="alert">{lastError}</div>{/if}
            <fieldset disabled={isLoading}>
                {#if activeTab === "register" && registerStep === 2}
                    <div class="field"><label for="verification-code">Код подтверждения</label><input id="verification-code" name="verification-code" autocomplete="one-time-code" bind:value={codeVal} placeholder="Код из письма" required aria-describedby={lastError ? "auth-error" : undefined} /></div>
                    <p class="field-help">Нет письма? Проверьте папку «Спам» и правильность адреса.</p>
                {:else}
                    {#if activeTab === "register"}
                        <div class="field"><label for="auth-email">Электронная почта</label><input id="auth-email" name="email" type="email" autocomplete="email" bind:value={emailVal} placeholder="you@example.com" required /></div>
                    {/if}
                    <div class="field"><label for="auth-login">{activeTab === "login" ? "Логин или почта" : "Логин"}</label><input id="auth-login" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" bind:value={loginVal} placeholder={activeTab === "login" ? "Ваш логин Anixart" : "Как вас называть?"} required /></div>
                    <div class="field"><label for="auth-password">Пароль</label><div class="password-field"><input id="auth-password" name="password" type={showPassword ? "text" : "password"} autocomplete={activeTab === "login" ? "current-password" : "new-password"} bind:value={passwordVal} placeholder={activeTab === "login" ? "Ваш пароль" : "Не меньше 6 символов"} required /><button class="reveal" type="button" aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"} aria-pressed={showPassword} onclick={() => showPassword = !showPassword}>{showPassword ? "Скрыть" : "Показать"}</button></div></div>
                    {#if activeTab === "register"}
                        <div class="field"><label for="confirm-password">Повторите пароль</label><input id="confirm-password" name="confirm-password" type={showPassword ? "text" : "password"} autocomplete="new-password" bind:value={confirmPasswordVal} placeholder="Ещё раз, без ошибок" required /></div>
                    {/if}
                {/if}
                <button class="submit" type="submit">{#if isLoading}<span class="spinner" aria-hidden="true"></span>{/if}{isLoading ? "Подождите…" : activeTab === "login" ? "Войти в аккаунт" : registerStep === 1 ? "Создать аккаунт" : "Подтвердить почту"}<span aria-hidden="true">→</span></button>
                {#if activeTab === "register" && registerStep === 2}<button class="back" type="button" onclick={backToRegistration}>← Изменить данные</button>{/if}
            </fieldset>
            <p class="form-footnote">{activeTab === "login" ? "Уже пользуетесь Anixart на телефоне? Подойдёт тот же аккаунт." : "Аккаунт создаётся в Anixart, а не в отдельном сервисе AnixArtix."}</p>
        </form>
    </div>
</section>

<style>
    .auth-page { min-height:100%; box-sizing:border-box; display:grid; grid-template-columns:minmax(250px,420px) minmax(320px,420px); align-content:center; justify-content:center; gap:clamp(35px,6vw,90px); padding:52px 40px; }
    .auth-intro { align-self:center; }
    .identity { display:flex; align-items:center; gap:12px; font-size:21px; font-weight:750; letter-spacing:-.7px; margin-bottom:38px; }
    .identity img { object-fit:contain; }
    .eyebrow { color:var(--accent-color); font-size:9px; font-weight:650; letter-spacing:2px; }
    h1 { font-size:clamp(30px,3.6vw,44px); line-height:1.17; letter-spacing:-1.5px; margin:14px 0 19px; font-weight:700; }
    .auth-intro>p { font-size:13px; line-height:1.8; color:var(--secondary-text-color); max-width:340px; margin:0; }
    ul { list-style:none; padding:0; margin:32px 0; display:grid; gap:19px; }
    li { display:flex; gap:14px; align-items:center; }
    li>span { color:var(--accent-color); background:var(--accent-soft); width:32px; height:32px; border:1px solid var(--accent-border); display:grid; place-items:center; border-radius:9px; font-size:10px; }
    li strong { display:block; font-size:12px; font-weight:600; }
    li small { display:block; margin-top:3px; color:var(--third-text-color); font-size:10px; }
    .disclaimer { max-width:330px; color:var(--third-text-color); font-size:10px; line-height:1.7; border-top:1px solid var(--border-color); padding-top:18px; }
    .auth-card { padding:28px; background:var(--alt-background-color); border:1px solid var(--border-color); border-radius:20px; align-self:center; box-shadow:0 16px 48px #0000000a; min-width:0; }
    .tabs { display:flex; background:var(--background-color); border:1px solid var(--border-color); border-radius:10px; padding:4px; gap:4px; margin-bottom:28px; }
    .tabs button { flex:1; padding:10px; color:var(--secondary-text-color); font-size:12px; border-radius:7px; font-weight:600; }
    .tabs button.active { background:var(--surface-raised); color:var(--main-text-color); box-shadow:0 2px 7px #00000010; }
    h2 { margin:0 0 8px; font-size:22px; letter-spacing:-.6px; line-height:1.3; font-weight:650; }
    header>p { color:var(--secondary-text-color); font-size:12px; line-height:1.65; margin:0 0 25px; overflow-wrap:anywhere; }
    fieldset { border:0; padding:0; margin:0; min-width:0; }
    .field { margin-bottom:16px; }
    label { display:block; color:var(--secondary-text-color); font-size:11px; font-weight:550; margin-bottom:7px; }
    input { width:100%; box-sizing:border-box; min-width:0; height:43px; padding:0 13px; border:1px solid var(--border-color); border-radius:9px; background:var(--background-color); color:var(--main-text-color); font-size:12px; outline:none; transition:border-color .15s; }
    input::placeholder { color:var(--third-text-color); }
    input:focus { border-color:var(--accent-color); box-shadow:0 0 0 3px var(--accent-soft); }
    .password-field { position:relative; }
    .password-field input { padding-right:80px; }
    .reveal { position:absolute; right:6px; top:6px; height:31px; padding:0 8px; font-size:10px; color:var(--secondary-text-color); border-radius:5px; }
    .reveal:hover { background:var(--hover-color); color:var(--main-text-color); }
    .submit { display:flex; align-items:center; justify-content:center; gap:10px; width:100%; border-radius:9px; background:var(--accent-color); color:var(--accent-contrast); min-height:44px; padding:12px; font-size:12px; font-weight:700; margin-top:24px; }
    .submit:hover { filter:brightness(1.07); }
    .submit>span:last-child { margin-left:auto; } .submit::before { content:""; margin-right:auto; }
    button:disabled, fieldset:disabled button { cursor:wait; opacity:.6; }
    input:disabled { opacity:.6; }
    .auth-error { color:var(--main-text-color); border:1px solid #df647b55; border-left:3px solid #df647b; background:#df647b0c; padding:12px 13px; border-radius:8px; margin-bottom:20px; font-size:12px; line-height:1.6; overflow-wrap:anywhere; }
    .form-footnote,.field-help { color:var(--third-text-color); font-size:10px; line-height:1.7; margin:17px 0 0; text-align:center; }
    .field-help { text-align:left; margin-top:-6px; }
    .back { width:100%; padding:12px; margin-top:6px; font-size:11px; color:var(--secondary-text-color); }
    .spinner { width:12px; height:12px; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; animation:spin .8s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    @media (max-width:1050px) { .auth-page { grid-template-columns:minmax(0,420px); padding:32px 22px; gap:25px; } .auth-intro { text-align:center; } .identity { justify-content:center; margin-bottom:0; } .auth-intro .eyebrow,.auth-intro h1,.auth-intro>p,.auth-intro ul,.disclaimer { display:none; } }
    @media (max-width:450px) { .auth-page { padding:24px 14px; } .auth-card { padding:21px; border-radius:14px; } h2 { font-size:20px; } }
</style>
