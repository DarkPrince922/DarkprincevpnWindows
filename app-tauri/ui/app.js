// Поведение приложения: вход, подписка, подключение.

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const win = window.__TAURI__.window.getCurrentWindow();

const state = {
    servers: [],
    selected: 0,
    tun: localStorage.getItem("dp_tun") === "1",
    subscription: null,
    busy: false,
    connected: false,
};

// ================= окно =================

$("#minimize").addEventListener("click", () => win.minimize());

// Крестик прячет приложение в панель задач, а не закрывает: соединение
// должно переживать закрытие окна. Полный выход — из меню значка.
$("#close").addEventListener("click", () => win.hide());

// Команды из меню значка. Подключением занимается страница: она знает
// выбранный сервер и режим, поэтому путь остаётся один и тот же.
window.__TAURI__.event.listen("tray", async (event) => {
    if (event.payload === "connect" && !state.connected && !state.busy) await connect();
    if (event.payload === "disconnect" && state.connected && !state.busy) await disconnectNow();
});

function message(node, text, type = "err") {
    node.className = `msg ${type}`;
    node.textContent = text || "";
    node.classList.toggle("hidden", !text);
}

// ================= вход =================

let registerMode = false;

$("#toggleRegister").addEventListener("click", () => {
    registerMode = !registerMode;
    $("#authTitle").textContent = registerMode ? "Регистрация" : "Вход";
    $("#emailSubmit").textContent = registerMode ? "Зарегистрироваться" : "Войти";
    $("#toggleRegister").textContent = registerMode
        ? "Уже есть аккаунт? Войти"
        : "Нет аккаунта? Регистрация";
    $("#referralField").classList.toggle("hidden", !registerMode);
    $("#forgot").classList.toggle("hidden", registerMode);
    message($("#authMessage"), "");
});

$("#emailForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("#email").value.trim();
    const password = $("#password").value;
    const button = $("#emailSubmit");
    message($("#authMessage"), "");
    button.disabled = true;
    try {
        if (registerMode) {
            const auth = await api.emailRegister(email, password, $("#referral").value.trim());
            if (store.save(auth)) await enter();
            else message($("#authMessage"), auth.message
                || "Подтвердите почту по ссылке из письма, затем войдите.", "info");
        } else {
            const auth = await api.emailLogin(email, password);
            if (store.save(auth)) await enter();
            else message($("#authMessage"), auth.message || "Не удалось войти.");
        }
    } catch (error) {
        message($("#authMessage"), error.message);
    } finally {
        button.disabled = false;
    }
});

$("#forgot").addEventListener("click", async () => {
    const email = $("#email").value.trim();
    if (!email.includes("@")) {
        message($("#authMessage"), "Введите почту, на которую зарегистрирован аккаунт.");
        return;
    }
    try {
        await api.forgotPassword(email);
    } catch {
        // ответ намеренно одинаковый: существование почты не подтверждаем
    }
    message($("#authMessage"), "Если такая почта у нас есть, письмо уже отправлено.", "info");
});

let polling = false;

$("#telegramButton").addEventListener("click", async () => {
    if (polling) return;
    message($("#authMessage"), "");

    let request;
    try {
        request = await api.deepLinkRequest();
    } catch (error) {
        message($("#authMessage"), error.message);
        return;
    }
    if (!request.bot_username) {
        message($("#authMessage"), "Сервер не вернул имя бота.");
        return;
    }

    invoke("open_url", { url: `https://t.me/${request.bot_username}?start=webauth_${request.token}` });
    message($("#authMessage"), "Подтвердите вход в Telegram — я подожду.", "info");

    polling = true;
    $("#telegramButton").disabled = true;
    const deadline = Date.now() + (Number(request.expires_in) || 300) * 1000;
    try {
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            let response;
            try {
                response = await api.deepLinkPoll(request.token);
            } catch {
                continue; // сеть моргнула — ждём дальше
            }
            if (response.status === 200) {
                if (store.save(JSON.parse(response.body))) {
                    await enter();
                    return;
                }
                message($("#authMessage"), "Сервер вернул пустой ответ.");
                return;
            }
            if (response.status === 410) {
                message($("#authMessage"), "Время авторизации истекло, попробуйте ещё раз.");
                return;
            }
        }
        message($("#authMessage"), "Время авторизации истекло, попробуйте ещё раз.");
    } finally {
        polling = false;
        $("#telegramButton").disabled = false;
    }
});

$("#logout").addEventListener("click", async () => {
    try {
        await invoke("disconnect");
        if (store.refresh) await api.logout(store.refresh);
    } catch {
        // сервер мог не ответить — локальную сессию всё равно чистим
    }
    store.clear();
    location.reload();
});

// ================= подписка и серверы =================

async function enter() {
    $("#auth").classList.add("hidden");
    $("#home").classList.remove("hidden");
    renderMode();
    await loadSubscription();
}

async function loadSubscription() {
    message($("#homeMessage"), "");
    try {
        const data = await api.subscriptions();
        const list = Array.isArray(data.subscriptions) ? data.subscriptions : [];
        let current = list.find(isActive) || list[0] || null;
        if (!current) {
            const single = await api.subscription().catch(() => null);
            if (single && (single.id || single.subscription_url)) current = single;
        }
        state.subscription = current;
        renderSubscription();

        let url = current?.subscription_url;
        if (!url) {
            const link = await api.connectionLink().catch(() => null);
            url = link?.subscription_url;
        }
        if (!url) {
            message($("#homeMessage"), "Подписки нет. Оформите тариф в личном кабинете.");
            $("#serverName").textContent = "Нет подписки";
            return;
        }
        await loadServers(url);
    } catch (error) {
        message($("#homeMessage"), error.message);
    }
}

const isActive = (sub) =>
    ["active", "trial"].includes(String(sub.status || "").toLowerCase()) || sub.is_active === true;

// Идентификатор этого компьютера для учёта в панели. Живёт один на
// установку: переустановка приложения не должна съедать ещё одно место
// в лимите устройств.
function deviceId() {
    let id = localStorage.getItem("dp_hwid");
    if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID())
            || `win-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        localStorage.setItem("dp_hwid", id);
    }
    return id;
}

async function loadServers(url) {
    try {
        state.servers = await invoke("load_subscription", { url, hwid: deviceId() });
        const saved = Number(localStorage.getItem("dp_server") || 0);
        state.selected = saved < state.servers.length ? saved : 0;
        renderServer();
    } catch (error) {
        $("#serverName").textContent = "Серверы не загрузились";
        message($("#homeMessage"), String(error));
    }
}

function renderSubscription() {
    const sub = state.subscription;
    if (!sub) return;
    $("#planName").textContent = sub.tariff_name || (sub.is_trial ? "Пробная подписка" : "Подписка");
    $("#planState").textContent = isActive(sub) ? "Активна" : "Неактивна";

    const days = sub.days_left ?? daysUntil(sub.end_date);
    $("#days").textContent = days === null ? "—" : String(days);
    $("#daysWord").textContent = days === null ? "" : `${plural(days, "день", "дня", "дней")} осталось`;

    const used = Number(sub.traffic_used_gb ?? 0);
    const limit = sub.traffic_limit_gb;
    const unlimited = limit === null || limit === undefined || Number(limit) === 0;
    $("#traffic").textContent = unlimited
        ? `${used.toFixed(1)} ГБ · безлимит`
        : `${used.toFixed(1)} из ${Number(limit).toFixed(0)} ГБ`;
    const share = unlimited ? 0 : Math.min(1, used / Number(limit));
    $("#trafficBar").classList.toggle("hidden", unlimited);
    $("#trafficBar").firstElementChild.style.width = `${Math.round(share * 100)}%`;
    $("#devices").textContent = sub.device_limit ?? "—";
}

function renderServer() {
    const server = state.servers[state.selected];
    $("#serverName").textContent = server ? server.name : "Сервер не выбран";
    $("#serverTransport").textContent = server ? server.transport : "";
}

$("#serverPick").addEventListener("click", () => {
    const list = $("#serverList");
    list.innerHTML = "";
    state.servers.forEach((server, index) => {
        const button = document.createElement("button");
        button.className = "server";
        button.setAttribute("aria-selected", String(index === state.selected));
        button.innerHTML =
            `<span class="grow"><span class="ellipsis" style="display:block">${escape(server.name)}</span>` +
            `<span class="tiny muted">${escape(server.transport)}</span></span>`;
        button.addEventListener("click", async () => {
            state.selected = index;
            localStorage.setItem("dp_server", String(index));
            renderServer();
            $("#sheet").classList.add("hidden");
            if (state.connected) await connect(); // на лету переключаемся на выбранный узел
        });
        list.append(button);
    });
    $("#sheet").classList.remove("hidden");
});

$("#sheet").addEventListener("click", (event) => {
    if (event.target === $("#sheet")) $("#sheet").classList.add("hidden");
});

$("#refresh").addEventListener("click", loadSubscription);
$("#openCabinet").addEventListener("click", () =>
    invoke("open_url", { url: "https://dprince.online/cabinet.html" })
);

const escape = (text) =>
    String(text).replace(/[&<>"]/g, (char) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char])
    );

// ================= режим и подключение =================

$$("#modes button").forEach((button) => {
    button.addEventListener("click", () => {
        if (state.busy || state.connected) return;
        state.tun = button.dataset.mode === "tun";
        localStorage.setItem("dp_tun", state.tun ? "1" : "0");
        renderMode();
    });
});

function renderMode() {
    $$("#modes button").forEach((button) =>
        button.setAttribute("aria-selected", String((button.dataset.mode === "tun") === state.tun))
    );
    $("#modeHint").textContent = state.tun
        ? "Перехватывает трафик всех программ. Нужен запуск от имени администратора."
        : "Без прав администратора. Браузеры и большинство программ.";
}

$("#power").addEventListener("click", async () => {
    if (state.busy) return;
    if (state.connected) {
        await disconnectNow();
        return;
    }
    await connect();
});

async function disconnectNow() {
    await setBusy(true, "Отключение…");
    try {
        await invoke("disconnect");
    } finally {
        state.connected = false;
        await setBusy(false);
    }
}

async function connect() {
    if (!state.servers.length) {
        message($("#homeMessage"), "Дождитесь загрузки подписки.");
        return;
    }
    message($("#homeMessage"), "");
    await setBusy(true, state.tun ? "Поднимаю туннель…" : "Подключение…");
    try {
        await invoke("connect", { index: state.selected, tun: state.tun });
        state.connected = true;
    } catch (error) {
        state.connected = false;
        const text = String(error);
        message($("#homeMessage"), text);
        // без прав администратора туннель невозможен — предложим перезапуск
        if (text.includes("администратор")) offerElevation();
    } finally {
        await setBusy(false);
    }
}

function offerElevation() {
    const node = $("#homeMessage");
    const button = document.createElement("button");
    button.className = "small";
    button.style.marginTop = "8px";
    button.textContent = "Перезапустить от администратора";
    button.addEventListener("click", () => invoke("restart_elevated"));
    node.append(document.createElement("br"), button);
}

async function setBusy(busy, text) {
    state.busy = busy;
    document.body.classList.toggle("busy", busy);
    document.body.classList.toggle("connected", state.connected && !busy);
    $("#power").disabled = busy;
    $("#stateText").textContent = busy
        ? text
        : state.connected
            ? state.tun ? "Подключено · весь трафик" : "Подключено · системный прокси"
            : "Нажмите для подключения";
}

// ================= мелочи =================

function plural(count, one, few, many) {
    const n = Math.abs(count) % 100;
    const n1 = n % 10;
    if (n > 10 && n < 20) return many;
    if (n1 > 1 && n1 < 5) return few;
    if (n1 === 1) return one;
    return many;
}

function daysUntil(endDate) {
    if (!endDate) return null;
    const end = new Date(endDate);
    if (Number.isNaN(end.getTime())) return null;
    return Math.max(0, Math.ceil((end.getTime() - Date.now()) / 86400000));
}

// ================= старт =================

(async () => {
    if (store.loggedIn) await enter();
    else $("#auth").classList.remove("hidden");
})();
