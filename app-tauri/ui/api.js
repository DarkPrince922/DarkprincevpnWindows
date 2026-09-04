// Клиент кабинета Bedolaga.
//
// Запросы уходят не из страницы, а через Rust — у окна приложения свой
// источник, и браузерное правило одного источника наружу бы его не пустило.
// Адрес по умолчанию — наш сайт: он переносит запросы в кабинет, поэтому
// приложению достаточно одного домена, а адрес панели наружу не торчит.

const DEFAULT_BASE = "https://dprince.online/api";

const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);

const store = {
    get base() {
        return localStorage.getItem("dp_base") || DEFAULT_BASE;
    },
    get access() {
        return localStorage.getItem("dp_access");
    },
    get refresh() {
        return localStorage.getItem("dp_refresh");
    },
    get expiresAt() {
        return Number(localStorage.getItem("dp_expires") || 0);
    },
    get loggedIn() {
        return Boolean(this.refresh);
    },
    /// Ссылка, которой поделился владелец подписки. Она живёт отдельно от
    /// токенов кабинета: гость может войти в свой аккаунт и не потерять VPN,
    /// пока не оформит собственную подписку.
    get guestSubscription() {
        return localStorage.getItem("dp_guest_subscription") || "";
    },
    set guestSubscription(url) {
        if (url) localStorage.setItem("dp_guest_subscription", url);
        else localStorage.removeItem("dp_guest_subscription");
    },
    /// Версия обновления, полосу про которую закрыли крестиком. Переживает
    /// перезапуск: иначе полоса возвращалась бы при каждом запуске. Выход из
    /// аккаунта её не сбрасывает — обновление к аккаунту отношения не имеет.
    get updateHidden() {
        return localStorage.getItem("dp_update_hidden") || "";
    },
    set updateHidden(version) {
        localStorage.setItem("dp_update_hidden", version);
    },
    save(auth) {
        if (!auth || !auth.access_token) return false;
        localStorage.setItem("dp_access", auth.access_token);
        if (auth.refresh_token) localStorage.setItem("dp_refresh", auth.refresh_token);
        const seconds = Number(auth.expires_in || 0);
        localStorage.setItem("dp_expires", String(seconds > 0 ? Date.now() + seconds * 1000 : 0));
        return true;
    },
    clear() {
        ["dp_access", "dp_refresh", "dp_expires", "dp_subscription"].forEach((key) =>
            localStorage.removeItem(key)
        );
    },
    clearGuest() {
        localStorage.removeItem("dp_guest_subscription");
    },
};

/// Хвост ?subscription_id=… для адресов кабинета, которые умеют мультитариф.
/// Пусто, если номера нет: тогда кабинет решает сам, и это правильно —
/// подписка у человека одна.
function forSub(subscriptionId) {
    return subscriptionId ? `?subscription_id=${encodeURIComponent(subscriptionId)}` : "";
}

function messageForStatus(status, serverMessage) {
    if (serverMessage) return serverMessage;
    if (status === 400 || status === 422) return "Неверные данные. Проверьте введённые значения.";
    if (status === 401) return "Неверный логин или пароль.";
    if (status === 403) return "Доступ запрещён.";
    if (status === 404) return "Сервис не найден.";
    if (status === 429) return "Слишком много попыток. Подождите немного.";
    if (status >= 500) return "Сервер временно недоступен.";
    return `Ошибка сервера (${status}).`;
}

function extractMessage(body) {
    try {
        const data = JSON.parse(body);
        const raw = data.detail ?? data.message ?? data.error;
        if (typeof raw === "string") return raw;
        if (Array.isArray(raw) && typeof raw[0]?.msg === "string") return raw[0].msg;
    } catch {
        // не JSON — сообщение возьмём по коду
    }
    return null;
}

// Обновление строго одиночное: несколько экранов, открывшихся разом, иначе
// отправили бы столько же одинаковых запросов на обновление. Ротации при
// этом нет — /cabinet/auth/refresh возвращает тот же refresh-токен обратно.
let refreshing = null;

async function refreshTokens() {
    if (refreshing) return refreshing;
    const token = store.refresh;
    if (!token) return null;

    refreshing = (async () => {
        try {
            const response = await invoke("http", {
                request: {
                    method: "POST",
                    url: `${store.base}/cabinet/auth/refresh`,
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ refresh_token: token }),
                },
            });
            if (response.status < 200 || response.status >= 300) {
                // Выходим из аккаунта только когда сервер сказал именно это:
                // токен не принят. Раньше сюда попадал любой ответ 4xx, и
                // человек оказывался на экране входа из-за 429 «слишком
                // часто» или 404 от случайной страницы провайдера — при
                // живой сессии. Остальные коды считаем временными.
                if (response.status === 401 || response.status === 403) store.clear();
                return null;
            }
            const auth = JSON.parse(response.body);
            return store.save(auth) ? auth.access_token : null;
        } catch {
            return store.access;
        } finally {
            setTimeout(() => (refreshing = null), 0);
        }
    })();

    return refreshing;
}

async function validToken() {
    const token = store.access;
    if (!token) return null;
    const expiresAt = store.expiresAt;
    if (expiresAt > 0 && Date.now() > expiresAt - 30000) return refreshTokens();
    return token;
}

const AUTH_FREE = /\/cabinet\/auth\/(deeplink|email|password|refresh)/;

async function request(path, { method = "GET", body, raw = false } = {}) {
    const url = `${store.base}/${path}`;
    const needsAuth = !AUTH_FREE.test(url);

    const send = async (token) => {
        const headers = {};
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (token) headers.Authorization = `Bearer ${token}`;
        return invoke("http", {
            request: {
                method,
                url,
                headers,
                body: body === undefined ? null : JSON.stringify(body),
            },
        });
    };

    let response = await send(needsAuth ? await validToken() : null);

    if (response.status === 401 && needsAuth && store.refresh) {
        const token = await refreshTokens();
        if (token) response = await send(token);
    }

    if (raw) return response;
    if (response.status < 200 || response.status >= 300) {
        throw new Error(messageForStatus(response.status, extractMessage(response.body)));
    }
    try {
        return JSON.parse(response.body || "{}");
    } catch {
        return {};
    }
}

const api = {
    deepLinkRequest: () => request("cabinet/auth/deeplink/request", { method: "POST", body: {} }),
    deepLinkPoll: (token) =>
        request("cabinet/auth/deeplink/poll", { method: "POST", body: { token }, raw: true }),
    emailLogin: (email, password) =>
        request("cabinet/auth/email/login", { method: "POST", body: { email, password } }),
    emailRegister: (email, password, referralCode) =>
        request("cabinet/auth/email/register/standalone", {
            method: "POST",
            body: {
                email,
                password,
                language: "ru",
                referral_code: referralCode || undefined,
            },
        }),
    forgotPassword: (email) =>
        request("cabinet/auth/password/forgot", { method: "POST", body: { email } }),
    logout: (refreshToken) =>
        request("cabinet/auth/logout", { method: "POST", body: { refresh_token: refreshToken } }),
    subscriptions: () => request("cabinet/subscriptions"),
    subscription: () => request("cabinet/subscription"),
    connectionLink: () => request("cabinet/subscription/connection-link"),

    // --- тарифы, продление, баланс ---
    // Те же адреса, что у кабинета на сайте. Считает всё сервер: приложение
    // показывает варианты и отправляет выбор, цен само не выдумывает.
    purchaseOptions: () => request("cabinet/subscription/purchase-options"),
    purchaseTariff: (tariffId, periodDays) =>
        request("cabinet/subscription/purchase-tariff", {
            method: "POST",
            body: { tariff_id: tariffId, period_days: periodDays },
        }),
    // Номер подписки обязателен при мультитарифе: без него кабинет выбирает
    // «текущую» сам, и продление уходит не в ту, на которую нажали, а цены
    // показываются от чужой подписки.
    renewalOptions: (subscriptionId) =>
        request(`cabinet/subscription/renewal-options${forSub(subscriptionId)}`),
    renew: (periodDays, subscriptionId) =>
        request(`cabinet/subscription/renew${forSub(subscriptionId)}`, {
            method: "POST",
            body: { period_days: periodDays },
        }),
    balance: () => request("cabinet/balance"),

    // --- устройства, промокоды, рефералы ---
    devices: (subscriptionId) =>
        request(`cabinet/subscription/devices${forSub(subscriptionId)}`),
    removeDevice: (hwid, subscriptionId) =>
        request(
            `cabinet/subscription/devices/${encodeURIComponent(hwid)}${forSub(subscriptionId)}`,
            { method: "DELETE" }
        ),
    activatePromo: (code) =>
        request("cabinet/promocode/activate", { method: "POST", body: { code } }),
    referral: () => request("cabinet/referral"),
};
