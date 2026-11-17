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
    pings: [],
    balanceKopeks: null,
    busy: false,
    connected: false,
    guestMode: false,
    usingSharedSubscription: false,
    connectedSince: 0,
    tariffs: null,        // null — ещё не загружали
    openTariff: null,     // id раскрытого тарифа
    periodPick: {},       // выбранный срок: ключ «t<id>» или «s<id>»
    renewals: {},         // сроки продления по id подписки
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
    else if (!$("#guestSheet").classList.contains("hidden")) closeSheet($("#guestSheet"));
    else if (!$("#pickSheet").classList.contains("hidden")) closeSheet($("#pickSheet"));
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

/// Нижняя панель уезжает вниз, а не пропадает разом: класс .closing
/// проигрывает обратное движение, потом панель прячется совсем.
function closeSheet(sheet) {
    if (!sheet || sheet.classList.contains("hidden") || sheet.classList.contains("closing")) return;
    sheet.classList.add("closing");
    setTimeout(() => {
        sheet.classList.remove("closing");
        sheet.classList.add("hidden");
    }, 220);
}

/// Два экрана: вход и само приложение. Нижний остров есть только у второго.
function showApp(inside) {
    $("#auth").classList.toggle("hidden", inside);
    $("#home").classList.toggle("hidden", !inside);
    document.body.classList.toggle("in-app", inside);
    if (inside) placePill();
}

/// Ожидание везде выглядит одинаково, как на Android: три бегущие точки.
/// Кнопка на время запроса показывает их вместо подписи и не нажимается;
/// ширину держит прежнюю, чтобы соседние кнопки не прыгали.
const DOTS = '<span class="dots"><i></i><i></i><i></i></span>';

function wait(button, on) {
    if (!button) return;
    button.classList.toggle("wait", on);
    button.disabled = on;
    button.querySelector(":scope > .dots.over")?.remove();
    if (on) button.insertAdjacentHTML("beforeend", DOTS.replace('"dots"', '"dots over"'));
}

/// Строка списка, которая открывает панель после запроса: вместо стрелки
/// бегут точки. Возвращает false, если запрос уже идёт.
function rowWait(row, on) {
    if (on && row.classList.contains("fetching")) return false;
    row.classList.toggle("fetching", on);
    row.querySelector(":scope > .dots")?.remove();
    if (on) row.insertAdjacentHTML("beforeend", DOTS);
    return true;
}

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
        : "Нет аккаунта? Зарегистрируйтесь";
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
    wait(button, true);
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
        wait(button, false);
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
let telegramCancelled = false;

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
    message($("#authMessage"), "Откройте Telegram и нажмите «Start», ждём подтверждения…", "info");

    polling = true;
    telegramCancelled = false;
    wait($("#telegramButton"), true);
    $("#telegramCancel").classList.remove("hidden");
    const deadline = Date.now() + (Number(request.expires_in) || 300) * 1000;
    try {
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            if (telegramCancelled) {
                message($("#authMessage"), "");
                return;
            }
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
        wait($("#telegramButton"), false);
        $("#telegramCancel").classList.add("hidden");
    }
});

$("#telegramCancel").addEventListener("click", () => {
    telegramCancelled = true;
    // ждать конца двухсекундного шага незачем: кнопку возвращаем сразу
    $("#telegramCancel").classList.add("hidden");
    message($("#authMessage"), "");
});

// Общая точка для вставленной ссылки и QR из файла. Ссылку сохраняем только
// после успешной загрузки серверов: битый QR не должен запирать приложение в
// пустом гостевом экране после перезапуска.
async function activateGuestSubscription(rawLink) {
    const url = GuestAccess.parseSharedSubscription(rawLink);
    if (!url) {
        message(
            $("#guestMessage"),
            "Ссылка не распознана. Нужна ссылка на подписку по https или QR из "
            + "приложения владельца."
        );
        return;
    }

    const controls = [$("#guestSubmit"), $("#guestQrButton")];
    controls.forEach((button) => (button.disabled = true));
    wait($("#guestSubmit"), true);
    message($("#guestMessage"), "");
    try {
        const { servers } = await fetchServers(url);
        store.guestSubscription = url;
        state.guestMode = !store.loggedIn;
        state.usingSharedSubscription = true;
        state.subscription = null;
        state.subscriptions = [];
        state.subIndex = 0;

        message($("#guestMessage"), "");
        closeSheet($("#guestSheet"));
        showApp(true);
        goTab("home");
        renderMode();
        renderAccessMode();
        renderSubscription();
        renderSubSwitcher();
        applyServers(servers);
        message($("#homeMessage"), "Гостевая подписка подключена.", "info");
    } catch (error) {
        message($("#guestMessage"), `Не удалось загрузить подписку: ${String(error)}`);
    } finally {
        wait($("#guestSubmit"), false);
        controls.forEach((button) => (button.disabled = false));
    }
}

$("#guestForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    message($("#guestMessage"), "");
    await activateGuestSubscription($("#guestLink").value);
});

$("#guestQrButton").addEventListener("click", () => {
    // Сбрасываем значение, чтобы повторный выбор того же файла снова дал
    // событие change (полезно после неудачного распознавания).
    $("#guestQrFile").value = "";
    $("#guestQrFile").click();
});

$("#guestQrFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    wait($("#guestQrButton"), true);
    message($("#guestMessage"), "");
    try {
        const rawLink = await GuestAccess.decodeQrFile(file);
        $("#guestLink").value = rawLink;
        await activateGuestSubscription(rawLink);
    } catch (error) {
        message($("#guestMessage"), error.message || String(error));
    } finally {
        wait($("#guestQrButton"), false);
    }
});

$("#guestOpen").addEventListener("click", () => {
    message($("#guestMessage"), "");
    $("#guestSheet").classList.remove("hidden");
    $("#guestLink").focus();
});

$("#guestSheet").addEventListener("click", (event) => {
    if (event.target === $("#guestSheet")) closeSheet($("#guestSheet"));
});

$("#logout").addEventListener("click", async () => {
    try {
        await invoke("disconnect");
        if (!state.guestMode && store.refresh) await api.logout(store.refresh);
    } catch {
        // сервер мог не ответить — локальную сессию всё равно чистим
    }
    if (state.guestMode) store.clearGuest();
    else store.clear();
    location.reload();
});

// ================= подписка и серверы =================

async function enter() {
    showApp(true);
    state.guestMode = !store.loggedIn && Boolean(store.guestSubscription);
    state.usingSharedSubscription = state.guestMode;
    renderMode();
    renderAccessMode();
    goTab("home");
    await loadSubscription();
}

async function loadSubscription() {
    message($("#homeMessage"), "");
    if (!state.servers.length) {
        $("#serverEmpty").innerHTML = loadingCapsule("Загружаем серверы");
        $("#serverEmpty").classList.remove("hidden");
    }
    if (!state.subscription && !state.usingSharedSubscription) {
        $("#planName").textContent = "Подписка";
        $("#planState").innerHTML = DOTS;
    }
    const sharedUrl = store.guestSubscription;
    state.guestMode = !store.loggedIn && Boolean(sharedUrl);
    state.usingSharedSubscription = state.guestMode;
    renderAccessMode();

    // Без аккаунта не обращаемся к закрытым endpoint кабинета. Это тот же
    // режим, что на Android: серверы берём прямо из ссылки владельца.
    if (state.guestMode) {
        state.subscription = null;
        state.subscriptions = [];
        state.subIndex = 0;
        renderSubscription();
        renderSubSwitcher();
        await loadServers(sharedUrl);
        return;
    }

    loadBalance(); // не ждём: баланс не мешает подключению
    loadAccount(); // тоже не ждём: нужна только для привязки почты
    let accountError = null;
    let ownUrl = null;
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
        ownUrl = current?.subscription_url || null;
        if (!ownUrl) {
            const link = await api.connectionLink().catch(() => null);
            ownUrl = link?.subscription_url || null;
        }
    } catch (error) {
        accountError = error;
        // Кабинет не ответил — берём последнее, что знали о подписках: адрес
        // подписки от этого не меняется, а узлы работают и без кабинета.
        const saved = readSavedSubscriptions();
        if (saved) {
            state.subscriptions = saved.list;
            state.subIndex = Math.min(state.subIndex, saved.list.length - 1);
            state.subscription = saved.list[state.subIndex] || null;
            ownUrl = state.subscription?.subscription_url || saved.url || null;
            accountError = null;
        } else {
            state.subscription = null;
            state.subscriptions = [];
            state.subIndex = 0;
        }
    }
    if (!accountError && ownUrl) saveSubscriptions(state.subscriptions, ownUrl);

    const url = ownUrl || sharedUrl;
    state.usingSharedSubscription = Boolean(sharedUrl && url === sharedUrl);
    renderAccessMode();
    renderSubscription();
    renderSubSwitcher();

    if (!url) {
        // Нет подписки — не ошибка: говорим спокойно и один раз, а не красным.
        if (accountError) message($("#homeMessage"), accountError.message);
        serverEmpty(accountError
            ? "Серверы не загрузились"
            : "Серверы появятся, когда будет подписка. Выберите тариф во вкладке «Тарифы».");
        return;
    }

    const loaded = await loadServers(url);
    if (loaded) await autoConnectOnce();
    // Как на Android: заработала собственная подписка — больше не занимаем
    // место в лимите устройств владельца общей ссылки.
    if (loaded && ownUrl && sharedUrl && ownUrl !== sharedUrl) {
        store.clearGuest();
        state.usingSharedSubscription = false;
        renderAccessMode();
    } else if (loaded && state.usingSharedSubscription && store.loggedIn) {
        message(
            $("#homeMessage"),
            "Пока у аккаунта нет своей подписки, используется гостевой доступ.",
            "info"
        );
    }
}

const isActive = (sub) =>
    ["active", "trial"].includes(String(sub.status || "").toLowerCase()) || sub.is_active === true;

const subTitle = (sub) =>
    sub.tariff_name || (sub.is_trial ? "Пробная подписка" : `Подписка №${sub.id ?? "—"}`);

function renderAccessMode() {
    $$(".account-only").forEach((node) =>
        node.classList.toggle("hidden", state.guestMode)
    );
    $("#logout b").textContent = state.guestMode
        ? "Отключить гостевой доступ"
        : "Выйти из аккаунта";
    // гостю тарифы и баланс недоступны: если он стоял на них — уводим домой
    if (state.guestMode && ["plans", "balance"].includes(document.body.dataset.tab)) goTab("home");
    placePill();

    const shared = state.guestMode || state.usingSharedSubscription;
    $("#guestAccessCard").classList.toggle("hidden", !shared);
    $("#guestAccountLogin").classList.toggle("hidden", !state.guestMode);
    $("#guestAccessText").textContent = state.guestMode
        ? "Серверы получены по ссылке владельца. Кабинет, покупки и устройства недоступны."
        : "Общая ссылка работает как запасная, пока у аккаунта нет своей подписки.";
}

$("#guestAccountLogin").addEventListener("click", async () => {
    if (state.connected) await disconnectNow();
    showApp(false);
    message($("#authMessage"), "Гостевая подписка сохранена. Войдите в свой аккаунт.", "info");
});

// ================= несколько подписок =================

function renderSubSwitcher() {
    $("#subMany").classList.toggle("hidden", state.subscriptions.length < 2);
}

// Как на Android: подписок несколько — карточка открывает выбор, одна —
// ведёт в «Тарифы».
$("#subscriptionCard").addEventListener("click", () => {
    if (state.subscriptions.length < 2) {
        if (!state.guestMode) goTab("plans");
        return;
    }
    openPicker(
        "Ваши подписки",
        state.subscriptions.map((sub, index) => ({
            title: subTitle(sub),
            subtitle: isActive(sub)
                ? `активна${sub.end_date ? ` · ${daysUntil(sub.end_date)} дн.` : ""}`
                : "неактивна",
            selected: index === state.subIndex,
        })),
        (index) => switchSubscription(index)
    );
});

async function switchSubscription(index) {
    if (index === state.subIndex) return;
    state.subIndex = index;
    // серверы принадлежат подписке: переключились — перечитываем
    if (state.connected) await disconnectNow();
    await loadSubscription();
}

// ================= общий выбор =================

function openPicker(title, items, onPick, note, emptyText) {
    $("#pickTitle").textContent = title;
    message($("#pickMessage"), note || "", "info");
    const list = $("#pickList");
    list.innerHTML = "";

    items.forEach((item, index) => {
        const button = document.createElement("button");
        button.className = "option";
        button.setAttribute("aria-selected", String(Boolean(item.selected)));
        button.innerHTML =
            `<span class="grow"><b class="ellipsis">${escape(item.title)}</b>` +
            `<span>${escape(item.subtitle || "")}</span></span>` +
            (item.right ? `<span class="price${item.danger ? " danger" : ""}">${escape(item.right)}</span>` : "");
        button.addEventListener("click", async () => {
            closeSheet($("#pickSheet"));
            await onPick(index);
        });
        list.append(button);
    });

    if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "hint";
        empty.textContent = emptyText || "Вариантов нет.";
        list.append(empty);
    }
    $("#pickSheet").classList.remove("hidden");
}

$("#pickSheet").addEventListener("click", (event) => {
    if (event.target === $("#pickSheet")) closeSheet($("#pickSheet"));
});

// ================= баланс, тарифы, продление =================

async function loadBalance() {
    if (state.balanceKopeks === null) $("#balanceValue").innerHTML = DOTS;
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

function tariffHint(tariff) {
    const parts = [];
    const traffic = tariff.traffic_limit_gb;
    if (traffic === 0 || traffic === null) parts.push("Безлимитный трафик");
    else if (traffic) parts.push(`${traffic} ГБ`);
    if (tariff.device_limit) parts.push(`до ${tariff.device_limit} устройств`);
    return parts.join(" · ");
}

/// Сроки и цены приходят с сервера — сами ничего не считаем.
///
/// Сервер присылает их списком объектов: у тарифа — в поле `periods`
/// ([{days, price_kopeks}]), у продления — прямо в корне ответа
/// ([{period_days, price_kopeks}]). Словарь вида {"14": 12000} по-прежнему
/// понимаем — на случай самодельного кабинета.
function periodsOf(source) {
    const raw = Array.isArray(source)
        ? source
        : source.periods || source.period_prices || source.prices || source.options || [];
    const list = Array.isArray(raw)
        ? raw.map((period) => ({
            days: Number(period.days ?? period.period_days),
            price: Number(period.price_kopeks ?? period.price),
        }))
        : Object.entries(raw).map(([days, price]) => ({ days: Number(days), price: Number(price) }));
    const periods = list.filter((period) =>
        Number.isFinite(period.days) && period.days > 0 && Number.isFinite(period.price));

    // У суточного тарифа сроков нет вовсе: цена за день, а срок в один день
    // сервер при покупке ставит сам.
    if (!periods.length && source.is_daily && source.daily_price_kopeks) {
        periods.push({ days: 1, price: Number(source.daily_price_kopeks), daily: true });
    }
    return periods.sort((a, b) => a.days - b.days);
}

const periodTitle = (period) => period.daily
    ? "Посуточно"
    : `${period.days} ${plural(period.days, "день", "дня", "дней")}`;

/// Капсула загрузки — та же, что на Android: три бегущие точки и подпись.
const loadingCapsule = (text) =>
    `<div class="loading"><span class="dots"><i></i><i></i><i></i></span>${escape(text)}</div>`;

/// Чипы сроков и кнопка с ценой. Общие для продления и покупки: разница
/// только в подписи кнопки и в том, какой запрос уйдёт.
function periodPicker(key, periods, verb, onPay) {
    const box = linkNode("div", { className: "periods" });
    if (!(state.periodPick[key] < periods.length)) state.periodPick[key] = 0;
    const chips = linkNode("div", { className: "chips" });
    const pay = linkNode("button", { className: "primary block needs-cabinet" });
    const note = linkNode("p", { className: "hint" });
    const paint = () => {
        const period = periods[state.periodPick[key]];
        [...chips.children].forEach((chip, index) =>
            chip.setAttribute("aria-selected", String(index === state.periodPick[key])));
        const short = state.balanceKopeks !== null && period.price > state.balanceKopeks;
        pay.textContent = short ? "Пополнить баланс" : `${verb} за ${money(period.price)}`;
        note.textContent = short
            ? `Нужно ${money(period.price)}, на балансе ${money(state.balanceKopeks)}`
            : period.daily ? "Списывается с баланса каждый день" : "Спишется с баланса";
        pay.onclick = () => (short ? goTab("balance") : onPay(period, pay));
    };
    periods.forEach((period, index) => {
        const chip = linkNode("button", { className: "chip-btn", textContent: periodTitle(period) });
        chip.addEventListener("click", () => {
            state.periodPick[key] = index;
            paint();
        });
        chips.append(chip);
    });
    paint();
    pay.disabled = serviceHealth.down === true;
    box.append(chips, pay, note);
    return box;
}

/// «Ваши подписки»: по карточке на каждую, с продлением прямо в ней.
function renderPlans() {
    const list = $("#subsList");
    list.innerHTML = "";
    if (!state.subscriptions.length) {
        list.append(linkNode("p", { className: "hint", textContent: "Подписки пока нет — выберите тариф ниже." }));
    }
    state.subscriptions.forEach((sub, index) => {
        const days = sub.days_left ?? daysUntil(sub.end_date);
        const [label, tone] = !isActive(sub) ? ["Не активна", "bad"]
            : days === null ? ["Активна", "ok"]
            : days <= 0 ? ["Последний день", "warn"]
            : [`${days} ${plural(days, "день", "дня", "дней")}`, days <= 7 ? "warn" : "ok"];
        const card = linkNode("div", { className: "card plan-card" });
        card.innerHTML =
            `<div class="plan-top"><span class="grow"><b class="ellipsis">${escape(subTitle(sub))}</b>` +
            `<span>${escape(sub.end_date ? `до ${dateShort(sub.end_date)}` : "Срок неизвестен")}</span></span>` +
            `<span class="chip ${tone}">${escape(label)}</span></div>` +
            `<div class="plan-facts">${escape(subFacts(sub))}</div>`;

        if (state.subscriptions.length > 1) {
            if (index === state.subIndex) {
                card.append(linkNode("p", { className: "hint current", textContent: "Подключение идёт по этой подписке" }));
            } else {
                const use = linkNode("button", { className: "small", textContent: "Подключаться по этой" });
                use.addEventListener("click", () => switchSubscription(index));
                card.append(use);
            }
        }

        const slot = linkNode("div", { className: "renew" });
        card.append(slot);
        list.append(card);
        fillRenewal(slot, sub);
    });
    renderTariffs();
}

function subFacts(sub) {
    const used = Number(sub.traffic_used_gb ?? 0);
    const limit = sub.traffic_limit_gb;
    const unlimited = limit === null || limit === undefined || Number(limit) === 0;
    const parts = [unlimited ? "Безлимитный трафик" : `${used.toFixed(1)} из ${Number(limit).toFixed(0)} ГБ`];
    if (sub.device_limit) parts.push(`до ${sub.device_limit} устройств`);
    return parts.join(" · ");
}

const dateShort = (raw) => {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? String(raw) : date.toLocaleDateString("ru-RU");
};

async function fillRenewal(slot, sub) {
    const key = `s${sub.id}`;
    if (!state.renewals[key]) {
        slot.innerHTML = loadingCapsule("Загружаем сроки");
        try {
            state.renewals[key] = periodsOf(await api.renewalOptions(sub.id));
        } catch {
            slot.innerHTML = "";
            return; // кабинет не ответил: о нём скажет полоса наверху
        }
    }
    const periods = state.renewals[key];
    slot.innerHTML = "";
    if (!periods.length) return;
    slot.append(periodPicker(key, periods, "Продлить", (period, button) =>
        buy(() => api.renew(period.days, sub.id), "Подписка продлена.", button)));
}

/// «Выберите тариф»: список раскрывается на месте, как на телефоне.
async function loadTariffs(force) {
    if (state.guestMode) return;
    if (state.tariffs && !force) return renderTariffs();
    if (!state.tariffs) $("#tariffList").innerHTML = loadingCapsule("Загружаем тарифы");
    try {
        const options = await api.purchaseOptions();
        state.tariffs = options.tariffs || options.items || [];
    } catch (error) {
        if (!state.tariffs) $("#tariffList").innerHTML = "";
        message($("#plansMessage"), error.message);
        return;
    }
    renderTariffs();
}

function renderTariffs() {
    const list = $("#tariffList");
    if (!state.tariffs) return;
    list.innerHTML = "";
    if (!state.tariffs.length) {
        list.append(linkNode("p", { className: "hint", textContent: state.subscriptions.length
            ? "Сменить тариф сейчас не на что. Понижение тарифа может быть выключено, а тарифы, "
              + "на которые подписка уже есть, не предлагаются."
            : "Тарифы сейчас недоступны. Попробуйте позже или откройте личный кабинет." }));
        return;
    }
    const box = linkNode("div", { className: "glass-list" });
    for (const tariff of state.tariffs) {
        const periods = periodsOf(tariff);
        const open = state.openTariff === tariff.id;
        const from = periods.length ? Math.min(...periods.map((period) => period.price)) : null;
        const row = linkNode("button", { className: "item tariff" });
        row.setAttribute("aria-expanded", String(open));
        row.innerHTML =
            `<span class="grow"><b>${escape(tariff.name || `Тариф №${tariff.id}`)}</b>` +
            `<span>${escape(tariffHint(tariff))}</span></span>` +
            (from === null ? "" : `<span class="price">${periods.length > 1 ? "от " : ""}${escape(money(from))}${periods[0].daily ? " / день" : ""}</span>`) +
            '<svg class="ic chev" viewBox="0 0 24 24"><use href="#i-chev"/></svg>';
        row.addEventListener("click", () => {
            state.openTariff = open ? null : tariff.id;
            renderTariffs();
        });
        box.append(row);
        if (open) {
            const body = linkNode("div", { className: "tariff-body" });
            if (tariff.description) body.append(linkNode("p", { className: "hint", textContent: tariff.description }));
            if (periods.length) {
                body.append(periodPicker(`t${tariff.id}`, periods, "Оформить", (period, button) =>
                    buy(() => api.purchaseTariff(tariff.id, period.days), "Тариф оформлен.", button)));
            } else {
                body.append(linkNode("p", { className: "hint", textContent: "У тарифа не задано ни одного срока." }));
            }
            box.append(body);
        }
    }
    list.append(box);
}

// ================= устройства, промокоды, рефералы =================

$("#openDevices").addEventListener("click", async () => {
    const row = $("#openDevices");
    if (!rowWait(row, true)) return;
    let data;
    try {
        data = await api.devices(state.subscription?.id);
    } catch (error) {
        message($("#moreMessage"), error.message);
        return;
    } finally {
        rowWait(row, false);
    }
    const devices = data.devices || data.items || [];
    const limit = state.subscription?.device_limit;

    openPicker(
        "Подключённые устройства",
        devices.map((device) => ({
            title: device.device_model || device.name || device.hwid || "Устройство",
            subtitle: [device.platform || device.device_os, device.last_seen_at || device.updated_at]
                .filter(Boolean).join(" · "),
            right: "Отключить",
            danger: true,
        })),
        (index) => confirmRemoveDevice(devices[index]),
        limit ? `Занято ${devices.length} из ${limit}` : "",
        "Подключённых устройств пока нет."
    );
});

/// Отключение спрашивает подтверждение: место освободится сразу, а вот
/// заново подключиться человеку придётся руками на самом устройстве.
function confirmRemoveDevice(device) {
    const hwid = device.hwid || device.id;
    const name = device.device_model || device.name || "устройство";
    if (!hwid) {
        message($("#moreMessage"), "У этого устройства нет опознавателя — отключить его можно только в кабинете.");
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
            message($("#moreMessage"), "");
            rowWait($("#openDevices"), true);
            try {
                await api.removeDevice(hwid, state.subscription?.id);
                await loadSubscription();
                message($("#moreMessage"), `Устройство «${name}» отключено.`, "info");
            } catch (error) {
                message($("#moreMessage"), error.message);
            } finally {
                rowWait($("#openDevices"), false);
            }
        }
    );
}

$("#promoForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = $("#promoCode").value.trim();
    if (!code) return;
    wait($("#promoSubmit"), true);
    message($("#balanceMessage"), "");
    try {
        const result = await api.activatePromo(code);
        $("#promoCode").value = "";
        await loadSubscription();
        message($("#balanceMessage"), result.message || "Промокод применён.", "info");
    } catch (error) {
        message($("#balanceMessage"), error.message);
    } finally {
        wait($("#promoSubmit"), false);
    }
});

$("#openReferral").addEventListener("click", async () => {
    const row = $("#openReferral");
    if (!rowWait(row, true)) return;
    let data;
    try {
        data = await api.referral();
    } catch (error) {
        message($("#moreMessage"), error.message);
        return;
    } finally {
        rowWait(row, false);
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
async function buy(action, successText, button) {
    if (button?.classList.contains("wait")) return; // второе нажатие — не вторая оплата
    message($("#plansMessage"), "");
    wait(button, true);
    try {
        await action();
        // Порядок важен: loadSubscription чистит сообщения, поэтому итог
        // пишется после неё, иначе он гаснет сразу же после появления.
        state.renewals = {};
        await loadSubscription();
        loadTariffs(true);
        message($("#plansMessage"), successText, "info");
    } catch (error) {
        message($("#plansMessage"), error.message);
        wait(button, false);
    }
    // итог написан наверху вкладки — показываем его, а не оставляем за краем
    $("main").scrollTo({ top: 0, behavior: "smooth" });
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
        const result = await fetchServers(url);
        applyServers(result.servers);
        // панель не ответила, серверы — из сохранённой копии: это тоже
        // недоступность сервиса, и сказать о ней надо тем же языком
        if (result.cached) serviceHealth.set(true);
        return true;
    } catch (error) {
        serverEmpty("Серверы не загрузились");
        message($("#homeMessage"), String(error));
        return false;
    }
}

// ================= привязка почты =================
//
// Кто вошёл через Telegram, может привязать почту: тогда в тот же аккаунт
// можно входить и без Telegram. Если почта занята другим аккаунтом, бот
// предлагает объединить их: шлёт на неё 6-значный код, показывает оба
// аккаунта и спрашивает, чью подписку оставить. Запросы — те, что есть у
// бота: POST /cabinet/auth/email/register, /email/merge/verify, GET и POST
// /cabinet/auth/merge/{token}.

const LINK_ERRORS = [
    ["already linked to your account", "Эта почта уже привязана к вашему аккаунту."],
    ["cannot be linked", "Эту почту привязать нельзя."],
    ["not configured", "Бот сейчас не может отправлять письма. Попробуйте позже."],
    ["Invalid confirmation code", "Неверный код. Проверьте письмо и попробуйте снова."],
    ["Too many invalid attempts", "Слишком много неверных попыток. Начните заново."],
    ["No pending account merge", "Время на подтверждение вышло. Начните заново."],
    ["invalid or expired", "Время на подтверждение вышло. Начните заново."],
    ["temporarily blocked", "Объединение пока недоступно. Попробуйте позже."],
    ["Too many requests", "Слишком часто. Подождите минуту и попробуйте снова."],
];

function linkErrorText(error) {
    const text = String(error?.message || error || "");
    const known = LINK_ERRORS.find(([marker]) => text.toLowerCase().includes(marker.toLowerCase()));
    return known ? known[1] : text || "Не получилось. Попробуйте позже.";
}

async function loadAccount() {
    const card = $("#emailLinkCard");
    // итог привязки показан — не затираем его обновлением экрана
    if (card.dataset.done) return;
    try {
        const user = await api.me();
        // почта уже есть — привязывать нечего
        // Как на Android: строка «Привязать почту», форма — по нажатию.
        $("#emailLinkOpen").classList.toggle("hidden", Boolean(user?.email));
        if (user?.email) card.classList.add("hidden");
    } catch {
        $("#emailLinkOpen").classList.add("hidden");
        card.classList.add("hidden");
    }
}

$("#emailLinkOpen").addEventListener("click", () => {
    const card = $("#emailLinkCard");
    const opening = card.classList.contains("hidden");
    if (opening && !card.dataset.done) showEmailForm(card);
    card.classList.toggle("hidden", !opening);
    $("#emailLinkOpen").setAttribute("aria-expanded", String(opening));
    if (opening) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
});

function linkNode(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...[].concat(children).filter(Boolean));
    return node;
}

function showEmailForm(card) {
    card.innerHTML = "";
    const note = linkNode("div", { className: "msg hidden" });
    const email = linkNode("input", { type: "email", placeholder: "Почта", autocomplete: "email" });
    const password = linkNode("input", { type: "password", placeholder: "Новый пароль, от 8 символов" });
    const repeat = linkNode("input", { type: "password", placeholder: "Пароль ещё раз" });
    const submit = linkNode("button", { className: "primary small", textContent: "Привязать почту" });
    submit.addEventListener("click", async () => {
        const address = email.value.trim();
        const problem = !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) ? "Проверьте адрес почты"
            : password.value.length < 8 ? "Пароль — не короче 8 символов"
            : password.value !== repeat.value ? "Пароли не совпадают" : "";
        if (problem) return message(note, problem);
        wait(submit, true);
        try {
            const result = await api.linkEmail(address, password.value);
            if (result.merge_required) return showMergeCode(card, address);
            const linked = /linked/i.test(result.message || "");
            showLinkDone(card, linked
                ? `Почта ${address} привязана: теперь в этот аккаунт можно входить и по ней.`
                : `Мы отправили письмо на ${address}. Перейдите по ссылке из него — после этого ` +
                  "в аккаунт можно будет входить и по почте. Письма нет — проверьте «Спам».");
        } catch (error) {
            message(note, linkErrorText(error));
        } finally {
            wait(submit, false);
        }
    });
    card.append(
        linkNode("p", { className: "hint", textContent:
            "Привяжите почту, чтобы входить в этот аккаунт и без Telegram." }),
        email, password, repeat,
        linkNode("div", { className: "row", style: "margin-top:8px" }, [submit]),
        note
    );
    [email, password, repeat].forEach((input) => (input.style.marginTop = "8px"));
}

function showMergeCode(card, address) {
    card.innerHTML = "";
    const note = linkNode("div", { className: "msg hidden" });
    const code = linkNode("input", { type: "text", inputMode: "numeric", maxLength: 6, placeholder: "Код из письма" });
    const submit = linkNode("button", { className: "primary small", textContent: "Подтвердить" });
    const back = linkNode("button", { className: "ghost small", textContent: "Другая почта" });
    back.addEventListener("click", () => showEmailForm(card));
    submit.addEventListener("click", async () => {
        const value = code.value.replace(/\D/g, "");
        if (value.length !== 6) return message(note, "Код — 6 цифр из письма");
        wait(submit, true);
        try {
            const result = await api.verifyEmailMerge(value);
            if (!result.merge_token) throw new Error("Бот не прислал подтверждение объединения");
            showMergeChoice(card, result.merge_token, await api.mergePreview(result.merge_token));
        } catch (error) {
            message(note, linkErrorText(error));
        } finally {
            wait(submit, false);
        }
    });
    card.append(
        linkNode("p", { className: "hint", textContent:
            `Почта ${address} уже есть у другого аккаунта — их можно объединить. ` +
            "Мы отправили на неё 6-значный код: введите его, чтобы подтвердить, что почта ваша." }),
        code,
        linkNode("div", { className: "row", style: "margin-top:8px" }, [submit, back]),
        note
    );
    code.style.marginTop = "8px";
}

// Выбрать надо только подписку: у аккаунта она одна, остальное бот сведёт сам.
function showMergeChoice(card, token, preview) {
    card.innerHTML = "";
    const note = linkNode("div", { className: "msg hidden" });
    let keep = preview.primary.id;
    const option = (label, user) => {
        const sub = user.subscription;
        const radio = linkNode("input", { type: "radio", name: "keepSub", checked: user.id === keep });
        radio.style.width = "auto";
        radio.addEventListener("change", () => (keep = user.id));
        const details = [
            sub?.end_date ? `до ${new Date(sub.end_date).toLocaleDateString("ru-RU")}` : null,
            `баланс ${((user.balance_kopeks || 0) / 100).toLocaleString("ru-RU")} ₽`,
            user.email || (user.username ? `@${user.username}` : null),
        ].filter(Boolean).join(" · ");
        return linkNode("label", { className: "switch-row" }, [
            linkNode("span", {}, [
                linkNode("span", { className: "hint", textContent: label }),
                linkNode("b", { textContent: " " + (sub ? sub.tariff_name || "Подписка" : "Без подписки") }),
                linkNode("div", { className: "hint", textContent: details }),
            ]),
            radio,
        ]);
    };
    const submit = linkNode("button", { className: "small", textContent: "Объединить аккаунты" });
    submit.addEventListener("click", async () => {
        if (!confirm("Объединить аккаунты? Вторая подписка пропадёт, отменить это нельзя.")) return;
        wait(submit, true);
        try {
            const result = await api.executeMerge(token, keep);
            store.save(result);
            showLinkDone(card, "Аккаунты объединены: в них можно входить и через Telegram, и по почте.");
            loadSubscription();
        } catch (error) {
            message(note, linkErrorText(error));
        } finally {
            wait(submit, false);
        }
    });
    card.append(
        linkNode("p", { className: "hint", textContent:
            "Какую подписку оставить? Вторая пропадёт — это нельзя будет отменить." }),
        option("Этот аккаунт", preview.primary),
        option("Аккаунт с почтой", preview.secondary),
        linkNode("div", { className: "row", style: "margin-top:8px" }, [submit]),
        note
    );
}

function showLinkDone(card, text) {
    card.dataset.done = "1";
    $("#emailLinkOpen").classList.add("hidden");
    card.innerHTML = "";
    card.append(linkNode("p", { className: "hint", textContent: text }));
}

// Последний удачный ответ кабинета о подписках — на случай, когда он лежит.
function saveSubscriptions(list, url) {
    try {
        localStorage.setItem("dp_last_subs", JSON.stringify({ list, url }));
    } catch {
        // переполнено хранилище — не страшно, просто не будет запаса
    }
}

function readSavedSubscriptions() {
    try {
        const saved = JSON.parse(localStorage.getItem("dp_last_subs") || "null");
        return saved && Array.isArray(saved.list) && (saved.list.length || saved.url) ? saved : null;
    } catch {
        return null;
    }
}

// Кнопки, которым нужен кабинет. Пока он лежит, их гасим заранее — нажать
// и получить ошибку хуже, чем видеть, что сейчас это недоступно.
const CABINET_BUTTONS = ["#topup", "#openDevices", "#promoSubmit", ".needs-cabinet"];

// Три разные надписи: лежим мы, у человека нет сети или оператор включил
// белые списки. Подписка сохранена во всех трёх случаях.
const SERVICE_TEXTS = {
    down: ["Сервис временно недоступен.",
        "VPN работает по сохранённой подписке. Оплата, продление и покупки станут доступны, когда сервис вернётся."],
    restricted: ["Интернет ограничен.",
        "Похоже, включены белые списки: зарубежные сайты и наш сервис отсюда не открываются. Подписка сохранена — " +
        "подключитесь к другой сети или к серверу, который работает при ограничениях."],
    offline: ["Нет подключения к интернету.",
        "Проверьте сеть. Подписка сохранена — VPN подключится, как только интернет появится."],
};

function renderServiceState(down, status = serviceHealth.status) {
    const banner = $("#serviceBanner");
    banner.classList.toggle("hidden", !down);
    const [title, text] = SERVICE_TEXTS[status] || SERVICE_TEXTS.down;
    banner.innerHTML = "";
    banner.append(Object.assign(document.createElement("b"), { textContent: title }), " " + text);
    for (const button of $$(CABINET_BUTTONS.join(","))) {
        button.disabled = down;
        button.title = down ? "Станет доступно, когда сервис вернётся" : "";
    }
    // ошибка запроса при лежащем кабинете — та же новость, что в полосе
    if (down && $("#homeMessage").classList.contains("err")) message($("#homeMessage"), "");
}

serviceHealth.onChange(renderServiceState);

function fetchServers(url) {
    return invoke("load_subscription", { url, hwid: deviceId() });
}

function applyServers(servers) {
    state.servers = servers;
    const saved = Number(localStorage.getItem("dp_server") || 0);
    state.selected = saved < state.servers.length ? saved : 0;
    renderServer();
}

function renderSubscription() {
    const sub = state.subscription;
    const chip = $("#days");
    const row = $("#trafficRow");
    chip.classList.add("hidden");
    row.classList.add("hidden");
    renderPlans();

    if (state.usingSharedSubscription) {
        $("#planName").textContent = "Гостевая подписка";
        $("#planState").textContent = "Активна по ссылке владельца";
        return;
    }
    if (!sub) {
        $("#planName").textContent = "Подписки нет";
        $("#planState").textContent = state.guestMode ? "" : "Нажмите, чтобы выбрать тариф";
        return;
    }
    $("#planName").textContent = sub.tariff_name || (sub.is_trial ? "Пробная подписка" : "Подписка");
    $("#planState").textContent = sub.end_date ? `до ${dateShort(sub.end_date)}` : "Срок неизвестен";

    // остаток — меткой: бирюзовая, на исходе (до недели) жёлтая, истекла — красная
    const days = sub.days_left ?? daysUntil(sub.end_date);
    if (days !== null) {
        const expired = days <= 0 && !isActive(sub);
        chip.textContent = expired ? "Истекла" : `${days} ${plural(days, "день", "дня", "дней")}`;
        chip.className = `chip ${expired ? "bad" : days <= 7 ? "warn" : "ok"}`;
    }

    const used = Number(sub.traffic_used_gb ?? 0);
    const limit = Number(sub.traffic_limit_gb ?? 0);
    if (limit > 0) {
        row.classList.remove("hidden");
        $("#traffic").textContent = `${used.toFixed(1)} / ${limit.toFixed(0)} ГБ`;
        $("#trafficBar").firstElementChild.style.width = `${Math.round(Math.min(1, used / limit) * 100)}%`;
    }
}

/// Пусто в списке серверов — говорим почему, одной строкой на его месте.
function serverEmpty(text) {
    $("#serverEmpty").textContent = text; // заодно снимает капсулу загрузки
    renderServer();
}

/// Флаг в начале названия: «🇩🇪 Германия · Франкфурт» → «🇩🇪».
function leadingFlag(name) {
    const match = String(name || "").trim()
        .match(/^(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}\uFE0F?)/u);
    return match ? match[0] : null;
}

/// Серверы прямо на главной: стеклянное окно со строками, как на телефоне.
function renderServer() {
    const list = $("#serverList");
    const has = state.servers.length > 0;
    $("#serversTitle").textContent = has ? `СЕРВЕРЫ · ${state.servers.length}` : "СЕРВЕРЫ";
    $("#serverEmpty").classList.toggle("hidden", has);
    list.classList.toggle("hidden", !has);
    list.innerHTML = "";

    state.servers.forEach((server, index) => {
        const button = document.createElement("button");
        button.className = "item server";
        button.setAttribute("aria-selected", String(index === state.selected));
        // подпись узла из панели, если её задали, иначе — метки транспорта
        const tags = server.description
            || (Array.isArray(server.transport) ? server.transport.join(" · ").toUpperCase() : "");
        button.innerHTML =
            `<span class="tile flag">${escape(leadingFlag(server.name) || "🌐")}</span>` +
            `<span class="grow"><b>${escape(nameWithoutFlag(server.name))}</b>` +
            (tags ? `<span class="tags ellipsis">${escape(tags)}</span>` : "") + "</span>" +
            pingChip(state.pings[index]);
        button.addEventListener("click", async () => {
            if (state.busy || index === state.selected) return;
            state.selected = index;
            localStorage.setItem("dp_server", String(index));
            renderServer();
            if (state.connected) await connect(); // на лету переключаемся на выбранный узел
        });
        list.append(button);
    });
    renderHeadConn();
}

// Пороги те же, что в приложении на Android: список серверов должен
// читаться одинаково, с какого бы устройства человек ни смотрел.
function pingChip(millis) {
    if (millis === undefined || millis === null) return "";
    if (millis < 0) return '<span class="ping dead">нет</span>';
    const grade = millis < 300 ? "good" : millis < 700 ? "fair" : "poor";
    return `<span class="ping ${grade}">${millis}<small>мс</small></span>`;
}

$("#pingButton").addEventListener("click", async () => {
    const button = $("#pingButton");
    if (button.classList.contains("working") || !state.servers.length) return;
    button.classList.add("working");
    button.insertAdjacentHTML("afterbegin", DOTS);
    try {
        state.pings = await invoke("ping_servers");
    } catch (error) {
        // Замер — вещь необязательная: список серверов остаётся рабочим
        // и без него, поэтому молчим в интерфейсе, а не пугаем ошибкой.
        console.error(error);
    } finally {
        button.classList.remove("working");
        button.querySelector(".dots")?.remove();
        renderServer();
    }
});

// «Обновить»: заново тянем подписку и список; пока идёт — значок крутится
async function refreshAll(button) {
    if (button.classList.contains("working")) return;
    button.classList.add("working");
    // Ответ бывает мгновенным, и без паузы нажатие выглядело бы пустым:
    // значок делает хотя бы один оборот, а итог пишем словами.
    const spun = new Promise((resolve) => setTimeout(resolve, 700));
    try {
        state.renewals = {};
        await loadSubscription();
        if (state.tariffs) loadTariffs(true);
        await spun;
        const note = $("#homeMessage");
        if (note.classList.contains("hidden") && state.servers.length) {
            message(note, `Список обновлён · серверов: ${state.servers.length}`, "info");
            setTimeout(() => {
                if (note.textContent.startsWith("Список обновлён")) message(note, "");
            }, 2500);
        }
    } finally {
        await spun;
        button.classList.remove("working");
    }
}

$("#refreshServers").addEventListener("click", () => refreshAll($("#refreshServers")));
$("#refresh").addEventListener("click", () => refreshAll($("#refresh")));

// ================= вкладки =================

/// Подложка активной вкладки едет к ней — как «остров» на Android.
function placePill() {
    const active = $("#dock button.active");
    const pill = $("#dock .pill");
    if (!active || !pill) return;
    pill.style.width = `${active.offsetWidth}px`;
    pill.style.transform = `translateX(${active.offsetLeft}px)`;
}

function goTab(name) {
    document.body.dataset.tab = name;
    $$("#dock button").forEach((node) => node.classList.toggle("active", node.dataset.go === name));
    $$("#home .tab").forEach((node) => node.classList.toggle("active", node.dataset.tab === name));
    $("main").scrollTop = 0;
    placePill();
    // подписи у вкладок раскрываются плавно — подложку ставим ещё раз по итогу
    setTimeout(placePill, 320);
    if (name === "plans") loadTariffs();
    if (name === "balance") loadBalance();
}

$$("#dock button").forEach((button) =>
    button.addEventListener("click", () => goTab(button.dataset.go)));
window.addEventListener("resize", placePill);

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
    // подложка выбранного режима едет к нему — см. .segmented::before
    $("#modes").dataset.active = state.tun ? "1" : "0";
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
        await verifyConnection();
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

/**
 * Подключились — ещё не значит, что интернет пошёл: ядро запускается и с
 * мёртвым сервером. Проверяем запросом через ядро; нет ответа — пробуем ещё
 * два узла, ближние по последнему замеру, прежде чем сдаться. Если не
 * ответил никто, возвращаемся к выбранному и честно об этом говорим:
 * скорее всего, дело не в серверах, а в сети.
 */
async function verifyConnection() {
    await setBusy(true, "Проверяю связь…");
    if (await invoke("probe")) return;

    const first = state.selected;
    const nameOf = (index) => state.servers[index]?.name || "сервер";
    const candidates = otherServersByPing(first).slice(0, 2);
    for (const index of candidates) {
        await setBusy(true, `«${nameOf(first)}» не отвечает · пробую «${nameOf(index)}»`);
        try {
            await invoke("connect", { index, tun: state.tun });
        } catch {
            continue;
        }
        if (await invoke("probe")) {
            // выбор человека не переписываем: это временная замена
            state.selected = index;
            renderServer();
            message(
                $("#homeMessage"),
                `«${nameOf(first)}» не ответил — подключились к «${nameOf(index)}»`,
                "info"
            );
            return;
        }
    }
    if (candidates.length) {
        await setBusy(true, "Возвращаюсь к выбранному серверу…");
        state.selected = first;
        renderServer();
        await invoke("connect", { index: first, tun: state.tun });
    }
    message(
        $("#homeMessage"),
        "Подключено, но интернет через сервер не идёт. Проверьте сеть или выберите другой сервер."
    );
}

/** Остальные узлы: сначала ответившие быстрее, неизмеренные — потом. */
function otherServersByPing(exclude) {
    const rank = (index) => {
        const ping = state.pings?.[index];
        return typeof ping === "number" && ping >= 0 ? ping : Number.MAX_SAFE_INTEGER;
    };
    return state.servers
        .map((_, index) => index)
        .filter((index) => index !== exclude)
        .sort((a, b) => rank(a) - rank(b));
}

async function setBusy(busy, text) {
    state.busy = busy;
    document.body.classList.toggle("busy", busy);
    document.body.classList.toggle("connected", state.connected && !busy);
    $("#power").disabled = busy;

    // Как на Android: крупное слово и строка под ним.
    const server = state.servers[state.selected];
    // Заголовок — одним словом; подробности вроде «Проверяю связь…» и
    // «пробую соседний сервер» — строкой под ним.
    const leaving = busy && /^Отключ/.test(text || "");
    const title = busy
        ? (leaving ? "Отключение…" : "Подключение…")
        : state.connected ? "Защищено" : "Не защищено";
    const line = busy
        ? (text && text !== title ? text : (server ? nameWithoutFlag(server.name) : ""))
        : state.connected ? trafficLine(0, 0) : "Нажмите, чтобы подключиться";
    if (state.connected && !busy) {
        if (!state.connectedSince) state.connectedSince = Date.now();
    } else if (!state.connected) {
        state.connectedSince = 0;
    }
    $("#power").title = state.connected ? "Отключиться" : "Подключиться";
    renderHeadConn();
    const status = $(".status");
    if ($("#stateTitle").textContent !== title) {
        status.classList.remove("changed");
        void status.offsetWidth; // перезапуск анимации
        status.classList.add("changed");
    }
    $("#stateTitle").textContent = title;
    $("#stateText").textContent = line;
    trafficWatch(state.connected && !busy);
}

/// Название узла без флага в начале: флаг уже стоит у страны на карте.
function nameWithoutFlag(name) {
    const text = String(name || "").trim();
    const stripped = text.replace(/^(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}\uFE0F?)\s*/u, "");
    return stripped.trim() || text;
}

// ================= получено и отправлено =================

let trafficTimer = null;
let clockTimer = null;

const trafficLine = (down, up) => `↓ ${formatBytes(down)} · ↑ ${formatBytes(up)}`;

/// Пока подключены, под словом «Защищено» идут счётчики. Спрашиваем ядро раз
/// в две секунды и только когда окно на экране: свёрнутому цифры не нужны.
function trafficWatch(on) {
    clearInterval(trafficTimer);
    clearInterval(clockTimer);
    trafficTimer = null;
    clockTimer = null;
    if (!on) return;
    const tick = async () => {
        if (document.hidden) return;
        try {
            const traffic = await invoke("traffic");
            if (!traffic || !state.connected || state.busy) return;
            $("#stateText").textContent = trafficLine(traffic.down || 0, traffic.up || 0);
        } catch {
            // счётчики — не главное: молчим, подключение от них не зависит
        }
    };
    tick();
    trafficTimer = setInterval(tick, 2000);
    clockTimer = setInterval(renderHeadConn, 1000);
}

/// В шапке, пока подключены: флаг, город и время на связи.
function renderHeadConn() {
    const node = $("#headConn");
    const server = state.servers[state.selected];
    const on = state.connected && !state.busy && Boolean(server);
    node.classList.toggle("hidden", !on);
    if (!on) return;
    const name = nameWithoutFlag(server.name);
    const city = name.includes(" · ") ? name.slice(name.indexOf(" · ") + 3) : name;
    const seconds = Math.max(0, Math.floor((Date.now() - (state.connectedSince || Date.now())) / 1000));
    const pad = (value) => String(value).padStart(2, "0");
    const time = `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
    node.textContent = `${[leadingFlag(server.name), city].filter(Boolean).join(" ")} · ${time}`;
}

/// Как на Android: «163,6 МБ».
function formatBytes(bytes) {
    const units = ["КБ", "МБ", "ГБ"];
    if (bytes < 1024) return `${bytes} Б`;
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(unit === 2 ? 2 : 1).replace(".", ",")} ${units[unit]}`;
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

// ================= обновления =================

// Проверяем при запуске и раз в шесть часов. Чаще незачем: приложение и так
// запускают часто, а манифест отдаётся без кеша и всегда свежий.
const UPDATE_EVERY = 6 * 60 * 60 * 1000;

const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} МБ`;

// Полосу закачки рисует Rust: он шлёт событие на каждый кусок. Подписываемся
// один раз при старте, а не на каждое нажатие, иначе обработчики копились бы.
window.__TAURI__.event.listen("update-progress", ({ payload }) => {
    const { downloaded, total } = payload;
    $("#updateProgress").textContent = total
        ? `${megabytes(downloaded)} из ${megabytes(total)}`
        : megabytes(downloaded);
    // размер известен не всегда — тогда показываем только числа
    if (total) $("#updateFill").style.width = `${Math.min(100, (downloaded / total) * 100)}%`;
});

async function checkUpdate() {
    let info;
    try {
        info = await invoke("check_update");
    } catch {
        return; // проверка обновлений не должна мешать работать
    }
    if (!info || info.failed || !info.version) return;
    // не показываем окно повторно, если от этой версии уже отказались
    if (store.updateHidden === info.version) return;

    $("#updateTitle").textContent = `Вышла версия ${info.version}`;
    const now = $("#updateNow");
    const later = $("#updateLater");

    if (info.can_install) {
        $("#updateNotes").textContent = info.notes
            || "Приложение скачает и поставит обновление само.";
        now.classList.remove("hidden");
        now.onclick = () => startUpdate(now, later);
    } else if (info.command) {
        // Пакет принадлежит пакетному менеджеру: сами не лезем, показываем чем
        $("#updateNotes").innerHTML =
            `Приложение установлено пакетом, поэтому обновляет его система:<br>` +
            `<span class="mono">${info.command}</span>`;
        now.classList.add("hidden");
    } else {
        // сборка из исходников — сказать про версию можно, советовать нечего
        $("#updateNotes").textContent = "Приложение собрано из исходников.";
        now.classList.add("hidden");
    }

    later.onclick = () => {
        store.updateHidden = info.version;
        $("#updateAsk").classList.add("hidden");
    };
    $("#updateAsk").classList.remove("hidden");
}

async function startUpdate(now, later) {
    now.disabled = true;
    later.disabled = true;
    now.textContent = "Обновляю…";
    $("#updateBar").classList.remove("hidden");
    $("#updateProgress").classList.remove("hidden");

    try {
        // при удаче приложение перезапустится и сюда не вернётся
        await invoke("install_update");
    } catch (error) {
        now.disabled = false;
        later.disabled = false;
        now.textContent = "Повторить";
        $("#updateBar").classList.add("hidden");
        $("#updateProgress").classList.add("hidden");
        $("#updateNotes").textContent = String(error);
    }
}

// ================= старт =================

(async () => {
    // Раньше входа: галочки должны показывать правду с первого кадра, а не
    // после того, как подписка загрузится.
    await initAutostart();

    renderThemes();
    placePill();
    // версия — мелкой строкой внизу «Ещё»; нет её — строка просто пустая
    window.__TAURI__.app?.getVersion?.()
        .then((version) => { $("#appVersion").textContent = `DarkPrince VPN ${version}`; })
        .catch(() => {});
    if (store.loggedIn || store.guestSubscription) await enter();
    else showApp(false);

    checkUpdate();
    setInterval(checkUpdate, UPDATE_EVERY);
})();

// ================= оформление =================

const THEMES = [
    { id: "night", title: "Аква" },
    { id: "sunset", title: "Закат" },
    { id: "indigo", title: "Индиго" },
    { id: "graphite", title: "Графит" },
];

// Названия ни о чём не говорят, пока не увидишь, поэтому у каждой темы —
// образец, нарисованный её же цветами: фон, два акцента и полоски вместо
// текста. Красит их CSS по data-theme, здесь только разметка.
function renderThemes() {
    const current = document.documentElement.dataset.theme;
    const list = $("#themeList");
    list.textContent = "";
    for (const theme of THEMES) {
        const button = document.createElement("button");
        button.className = "swatch";
        button.setAttribute("aria-selected", String(theme.id === current));
        // data-theme стоит на картинке, а не на кнопке: иначе подпись под ней
        // красилась бы цветами своей темы и на светлой странице «Ночь» и
        // «Закат» читались бы еле-еле
        button.innerHTML =
            `<span class="preview" data-theme="${theme.id}">` +
            '<span class="dots"><i></i><i></i></span>' +
            '<span class="lines"><i></i><i></i></span>' +
            '<svg class="ic tick" viewBox="0 0 24 24"><use href="#i-check"/></svg>' +
            "</span>" +
            `<span class="title">${theme.title}</span>`;
        button.addEventListener("click", () => applyTheme(theme.id));
        list.append(button);
    }
}

function applyTheme(id) {
    const known = THEMES.some((theme) => theme.id === id) ? id : "night";
    document.documentElement.dataset.theme = known;
    localStorage.setItem("dp_theme", known);
    renderThemes();
}

// ================= ЗАПУСК ВМЕСТЕ С СИСТЕМОЙ =================

/// Подключаться ли самим после загрузки подписки. Хранится на этой машине:
/// к аккаунту отношения не имеет, на другом компьютере решение своё.
const autoConnectWanted = () => localStorage.getItem("dp_autoconnect") === "1";

/// Подключаемся не чаще одного раза за запуск. loadSubscription зовут и
/// кнопкой «Обновить», и после покупки — а самовольно поднимать туннель в
/// ответ на нажатие «Обновить» приложение не должно.
let autoConnectDone = false;

async function autoConnectOnce() {
    if (autoConnectDone) return;
    autoConnectDone = true;
    if (!autoConnectWanted()) return;
    if (state.connected || !state.servers.length) return;
    await connect();
}

async function initAutostart() {
    const box = $("#autostart");
    const auto = $("#autoconnect");
    if (!box || !auto) return;

    // Состояние галочки — не наша выдумка, а то, что реально прописано в
    // системе: человек мог убрать автозапуск сам, мимо приложения.
    try {
        box.checked = await invoke("autostart_enabled");
    } catch (error) {
        box.checked = false;
    }
    auto.checked = autoConnectWanted();

    box.addEventListener("change", async () => {
        const wanted = box.checked;
        try {
            await invoke("set_autostart", { enabled: wanted });
        } catch (error) {
            // не получилось — возвращаем галочку, а не врём про состояние
            box.checked = !wanted;
            message($("#moreMessage"), `Не удалось изменить автозапуск: ${error}`);
        }
    });

    auto.addEventListener("change", () => {
        localStorage.setItem("dp_autoconnect", auto.checked ? "1" : "0");
    });
}
