/** Request ownership for auth screens: never apply a response to an abandoned form. */
export function createAuthRequestGate() {
    let sequence = 0;
    let active = null;
    let disposed = false;
    return {
        get busy() { return active !== null; },
        begin() {
            if (disposed || active !== null) return null;
            active = ++sequence;
            return active;
        },
        isCurrent(request) { return !disposed && request !== null && request === active; },
        finish(request) {
            if (disposed || request === null || request !== active) return false;
            active = null;
            return true;
        },
        invalidate() { sequence++; active = null; },
        dispose() { disposed = true; sequence++; active = null; },
    };
}

export function readAuthSession(response) {
    const id = response?.profile?.id;
    const token = response?.profileToken?.token;
    if (!Number.isSafeInteger(id) || id <= 0 || typeof token !== "string" || !token.trim()) return null;
    return { id, token };
}

export function registrationOutcome(response, okCode, codes, previousHash = "") {
    if (response?.code === okCode || response?.code === codes.CodeAlreadySend) {
        const hash = typeof response.hash === "string" && response.hash ? response.hash : previousHash;
        return hash
            ? { step: 2, hash, error: "" }
            : { step: 1, hash: "", error: "Код уже мог быть отправлен, но сервер не вернул подтверждение запроса. Подождите и повторите регистрацию." };
    }
    const messages = new Map([
        [codes.InvalidLogin, "Этот логин недопустим. Попробуйте другой."],
        [codes.InvalidEmail, "Проверьте адрес электронной почты."],
        [codes.InvalidPassword, "Пароль не принят. Попробуйте более надёжный."],
        [codes.LoginAlreadyTaken, "Этот логин уже занят. Выберите другой."],
        [codes.EmailAlreadyTaken, "Эта почта уже зарегистрирована. Перейдите ко входу."],
        [codes.TooManyRegistrations, "Слишком много попыток регистрации. Попробуйте позже."],
    ]);
    return { step: 1, hash: "", error: messages.get(response?.code) || (typeof response?.message === "string" ? response.message : "Не удалось создать аккаунт. Попробуйте ещё раз.") };
}

export function verificationOutcome(response, okCode, codes) {
    if (response?.code === okCode) return { success: true, reset: false, error: "" };
    if (response?.code === codes.InvalidHash) return { success: false, reset: true, error: "Запрос регистрации истёк. Отправьте данные ещё раз." };
    return { success: false, reset: false, error: typeof response?.message === "string" ? response.message : "Код не подошёл. Проверьте письмо и попробуйте снова." };
}
