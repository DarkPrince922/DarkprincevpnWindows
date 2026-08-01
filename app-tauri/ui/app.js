// Поведение приложения: вход, подписка, подключение.

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const win = window.__TAURI__.window.getCurrentWindow();

const state = {
    servers: [],
    selected: 0,
    tun: localStorage.getItem("dp_tun") === "1",
    subscription: null,
    subscriptions: [],
    subIndex: 0,
    balanceKopeks: null,
    busy: false,
    connected: false,
};

const money = (kopeks) =>
    `${(Number(kopeks || 0) / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ₽`;

// ================= окно =================

// Свернуть — обычное сворачивание: кнопка остаётся на панели задач внизу,
// значок — в трее. Приложение никуда не девается.
$("#minimize").addEventListener("click", () => win.minimize());

// Крестик спрашивает. Раньше он молча прятал окно, и это сбивало с толку:
// человек «закрыл» приложение, запустил снова — и в трее стало два значка.
// Теперь у него два ясных исхода, и оба он выбирает сам.
$("#close").addEventListener("click", () => win.close());

// Закрыть могут и мимо нашей кнопки: Alt+F4, «Закрыть окно» на панели
// задач. Rust такое закрытие отменяет и присылает сюда — вопрос один и
// тот же, откуда бы ни пришли.
window.__TAURI__.event.listen("close-requested", askBeforeExit);

function askBeforeExit() {
    $("#exitHint").textContent = state.connected
        ? "«Свернуть» — VPN продолжит работать, приложение останется в трее. "
        + "«Выйти» — соединение разорвётся, процессы закроются, порты освободятся."
        : "«Свернуть» — приложение останется в трее и откроется по значку. "
        + "«Выйти» — закроется полностью, вместе со своими процессами.";
    $("#exitAsk").classList.remove("hidden");
    $("#exitHide").focus();
}

const closeAsk = () => $("#exitAsk").classList.add("hidden");

$("#exitCancel").addEventListener("click", closeAsk);
$("#exitAsk").addEventListener("click", (event) => {
    if (event.target === $("#exitAsk")) closeAsk();
});
document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!$("#exitAsk").classList.contains("hidden")) closeAsk();
    else if (!$("#pickSheet").classList.contains("hidden")) $("#pickSheet").classList.add("hidden");
    else if (!$("#sheet").classList.contains("hidden")) $("#sheet").classList.add("hidden");
});

$("#exitHide").addEventListener("click", () => {
    closeAsk();
    win.hide();
});

$("#exitQuit").addEventListener("click", () => {
    // Уборка занимает время: разбор туннеля ходит в route и netsh. Пусть
    // человек видит, что приложение занято делом, а не зависло.
    $("#exitQuit").disabled = true;
    $("#exitHide").disabled = true;
    $("#exitCancel").disabled = true;
    $("#exitHint").textContent = "Отключаюсь и закрываю процессы…";
    invoke("quit_app");
});

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
    loadBalance(); // не ждём: баланс не мешает подключению
    try {
        const data = await api.subscriptions();
        const list = Array.isArray(data.subscriptions) ? data.subscriptions : [];

        // Подписок может быть несколько. Раньше бралась первая активная, а
        // остальные пропадали молча — человек с двумя тарифами видел один и
        // не понимал, куда делся второй.
        state.subscriptions = list;
        if (state.subIndex >= list.length) state.subIndex = 0;
        if (!list.some(isActive)) state.subIndex = 0;
        else if (!isActive(list[state.subIndex])) {
            state.subIndex = list.findIndex(isActive);
        }

        let current = list[state.subIndex] || null;
        if (!current) {
            const single = await api.subscription().catch(() => null);
            if (single && (single.id || single.subscription_url)) {
                current = single;
                state.subscriptions = [single];
                state.subIndex = 0;
            }
        }
        state.subscription = current;
        renderSubscription();
        renderSubSwitcher();

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

const subTitle = (sub) =>
    sub.tariff_name || (sub.is_trial ? "Пробная подписка" : `Подписка №${sub.id ?? "—"}`);

// ================= несколько подписок =================

function renderSubSwitcher() {
    const many = state.subscriptions.length > 1;
    $("#subSwitcher").classList.toggle("hidden", !many);
    if (!many) return;

    const sub = state.subscription;
    $("#subPickName").textContent = sub ? subTitle(sub) : "—";
    $("#subPickHint").textContent = `подписок: ${state.subscriptions.length} · нажмите, чтобы переключить`;
}

$("#subPick").addEventListener("click", () => {
    openPicker(
        "Ваши подписки",
        state.subscriptions.map((sub, index) => ({
            title: subTitle(sub),
            subtitle: isActive(sub)
                ? `активна${sub.end_date ? ` · ${daysUntil(sub.end_date)} дн.` : ""}`
                : "неактивна",
            selected: index === state.subIndex,
        })),
        async (index) => {
            if (index === state.subIndex) return;
            state.subIndex = index;
            // серверы принадлежат подписке: переключились — перечитываем
            if (state.connected) await disconnectNow();
            await loadSubscription();
        }
    );
});

// ================= общий выбор =================

function openPicker(title, items, onPick, note) {
    $("#pickTitle").textContent = title;
    message($("#pickMessage"), note || "", "info");
    const list = $("#pickList");
    list.innerHTML = "";

    items.forEach((item, index) => {
        const button = document.createElement("button");
        button.className = "server";
        button.setAttribute("aria-selected", String(Boolean(item.selected)));
        button.innerHTML =
            `<span class="grow"><span class="ellipsis" style="display:block">${escape(item.title)}</span>` +
            `<span class="tiny muted">${escape(item.subtitle || "")}</span></span>` +
            (item.right ? `<span class="gold">${escape(item.right)}</span>` : "");
        button.addEventListener("click", async () => {
            $("#pickSheet").classList.add("hidden");
            await onPick(index);
        });
        list.append(button);
    });

    if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "tiny muted";
        empty.style.padding = "4px 4px 10px";
        empty.textContent = "Вариантов нет.";
        list.append(empty);
    }
    $("#pickSheet").classList.remove("hidden");
}

$("#pickSheet").addEventListener("click", (event) => {
    if (event.target === $("#pickSheet")) $("#pickSheet").classList.add("hidden");
});

// ================= баланс, тарифы, продление =================

async function loadBalance() {
    try {
        const data = await api.balance();
        state.balanceKopeks = data.balance_kopeks ?? data.balance ?? null;
        $("#balanceValue").textContent =
            state.balanceKopeks === null ? "—" : money(state.balanceKopeks);
    } catch {
        $("#balanceValue").textContent = "—";
    }
}

// Пополнение уводим в кабинет намеренно: у платёжных систем свои страницы
// с переадресациями и подтверждениями, и тащить их в окно приложения —
// значит отвечать за чужой платёжный процесс.
$("#topup").addEventListener("click", () =>
    invoke("open_url", { url: "https://dprince.online/cabinet.html#balance" })
);

$("#openTariffs").addEventListener("click", async () => {
    let options;
    try {
        options = await api.purchaseOptions();
    } catch (error) {
        message($("#homeMessage"), error.message);
        return;
    }
    const tariffs = options.tariffs || options.items || [];
    if (!tariffs.length) {
        message(
            $("#homeMessage"),
            "Сменить тариф сейчас не на что. Возможны ограничения: понижение тарифа может быть "
            + "выключено, а тарифы, на которые подписка уже есть, не предлагаются."
        );
        return;
    }

    openPicker(
        "Выберите тариф",
        tariffs.map((tariff) => ({
            title: tariff.name || `Тариф №${tariff.id}`,
            subtitle: tariffHint(tariff),
        })),
        (index) => pickPeriod(tariffs[index]),
        state.balanceKopeks === null ? "" : `На балансе ${money(state.balanceKopeks)}`
    );
});

function tariffHint(tariff) {
    const parts = [];
    const traffic = tariff.traffic_limit_gb;
    if (traffic === 0 || traffic === null) parts.push("трафик без ограничений");
    else if (traffic) parts.push(`${traffic} ГБ`);
    if (tariff.device_limit) parts.push(`${tariff.device_limit} устр.`);
    return parts.join(" · ");
}

/// Сроки и цены приходят с сервера — сами ничего не считаем.
function periodsOf(item) {
    const raw = item.periods || item.period_prices || item.prices || {};
    return Object.entries(raw)
        .map(([days, price]) => ({ days: Number(days), price: Number(price) }))
        .filter((period) => Number.isFinite(period.days) && period.days > 0)
        .sort((a, b) => a.days - b.days);
}

async function pickPeriod(tariff) {
    const periods = periodsOf(tariff);
    if (!periods.length) {
        message($("#homeMessage"), `У тарифа «${tariff.name}» не задано ни одного срока.`);
        return;
    }
    openPicker(
        `Срок · ${tariff.name}`,
        periods.map((period) => ({
            title: `${period.days} ${plural(period.days, "день", "дня", "дней")}`,
            subtitle: state.balanceKopeks !== null && period.price > state.balanceKopeks
                ? "не хватает на балансе"
                : "спишется с баланса",
            right: money(period.price),
        })),
        async (index) => {
            const period = periods[index];
            await buy(() => api.purchaseTariff(tariff.id, period.days), "Тариф изменён.");
        },
        state.balanceKopeks === null ? "" : `На балансе ${money(state.balanceKopeks)}`
    );
}

$("#renewButton").addEventListener("click", async () => {
    let options;
    try {
        options = await api.renewalOptions();
    } catch (error) {
        message($("#homeMessage"), error.message);
        return;
    }
    const periods = periodsOf(options);
    if (!periods.length) {
        message($("#homeMessage"), "Продлевать нечего: сроков для текущего тарифа не предлагается.");
        return;
    }
    openPicker(
        "На сколько продлить",
        periods.map((period) => ({
            title: `${period.days} ${plural(period.days, "день", "дня", "дней")}`,
            subtitle: state.balanceKopeks !== null && period.price > state.balanceKopeks
                ? "не хватает на балансе"
                : "спишется с баланса",
            right: money(period.price),
        })),
        async (index) => {
            await buy(() => api.renew(periods[index].days), "Подписка продлена.");
        },
        state.balanceKopeks === null ? "" : `На балансе ${money(state.balanceKopeks)}`
    );
});

// ================= устройства, промокоды, рефералы =================

$("#openDevices").addEventListener("click", async () => {
    let data;
    try {
        data = await api.devices(state.subscription?.id);
    } catch (error) {
        message($("#homeMessage"), error.message);
        return;
    }
    const devices = data.devices || data.items || [];
    const limit = state.subscription?.device_limit;

    openPicker(
        "Подключённые устройства",
        devices.map((device) => ({
            title: device.device_model || device.name || device.hwid || "Устройство",
            subtitle: [device.platform || device.device_os, device.last_seen_at || device.updated_at]
                .filter(Boolean).join(" · ") || "нажмите, чтобы отключить",
        })),
        (index) => confirmRemoveDevice(devices[index]),
        limit ? `Занято ${devices.length} из ${limit}` : ""
    );
});

/// Отключение спрашивает подтверждение: место освободится сразу, а вот
/// заново подключиться человеку придётся руками на самом устройстве.
function confirmRemoveDevice(device) {
    const hwid = device.hwid || device.id;
    const name = device.device_model || device.name || "устройство";
    if (!hwid) {
        message($("#homeMessage"), "У этого устройства нет опознавателя — отключить его можно только в кабинете.");
        return;
    }
    openPicker(
        `Отключить «${name}»?`,
        [
            { title: "Отключить", subtitle: "освободит место в лимите тарифа" },
            { title: "Отмена", subtitle: "оставить как есть" },
        ],
        async (index) => {
            if (index !== 0) return;
            message($("#homeMessage"), "Отключаю…", "info");
            try {
                await api.removeDevice(hwid);
                await loadSubscription();
                message($("#homeMessage"), `Устройство «${name}» отключено.`, "info");
            } catch (error) {
                message($("#homeMessage"), error.message);
            }
        }
    );
}

$("#promoForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = $("#promoCode").value.trim();
    if (!code) return;
    $("#promoSubmit").disabled = true;
    message($("#homeMessage"), "Проверяю промокод…", "info");
    try {
        const result = await api.activatePromo(code);
        $("#promoCode").value = "";
        await loadSubscription();
        message($("#homeMessage"), result.message || "Промокод применён.", "info");
    } catch (error) {
        message($("#homeMessage"), error.message);
    } finally {
        $("#promoSubmit").disabled = false;
    }
});

$("#openReferral").addEventListener("click", async () => {
    let data;
    try {
        data = await api.referral();
    } catch (error) {
        message($("#homeMessage"), error.message);
        return;
    }
    const link = data.referral_link || data.link || "";
    const invited = data.invited_count ?? data.total_invited ?? 0;
    const earned = data.earned_kopeks ?? data.total_earned_kopeks;

    openPicker(
        "Приглашайте друзей",
        [
            { title: link || "Ссылки пока нет", subtitle: "нажмите, чтобы открыть в Telegram" },
        ],
        () => { if (link) invoke("open_url", { url: link }); },
        `Приглашено: ${invited}${earned === undefined ? "" : ` · заработано ${money(earned)}`}`
    );
});

/// Общая часть покупки: платит сервер, мы показываем итог и перечитываем
/// состояние. Ошибку показываем как есть — в ней написана причина отказа,
/// чаще всего нехватка денег.
async function buy(action, successText) {
    message($("#homeMessage"), "Отправляю…", "info");
    try {
        await action();
        // Порядок важен: loadSubscription чистит сообщения, поэтому итог
        // пишется после неё, иначе он гаснет сразу же после появления.
        await loadSubscription();
        message($("#homeMessage"), successText, "info");
    } catch (error) {
        message($("#homeMessage"), error.message);
    }
}

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
