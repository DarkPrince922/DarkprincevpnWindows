// Карта соединения за кнопкой подключения.
//
// То же, что в приложении на Android: снимок Земли ночью, приближенный к
// маршруту от примерного региона устройства к стране выбранного узла. Пока
// туннель опущен, огни городов почти погашены; при подключении карта
// разгорается и по дуге бежит искра.
//
// Геолокацию не спрашиваем и не можем: начало маршрута — регион из настроек
// системы, то есть страна целиком, а не координата. Конец — страна узла,
// опознанная по флагу в его имени. Всё рисуется на месте, наружу не уходит
// ничего.

// Центры стран по коду ISO 3166-1 alpha-2: «код широта долгота» через запятую.
// Строкой, а не объектом на две сотни ключей: разбирается один раз, зато файл
// остаётся обозримым.
const CENTERS_RAW =
    "AD42.5 1.5,AE24.2 54.2,AF34.8 67.8,AL41.3 20.1,AM39.9 45.3," +
    "AO-10.9 17.4,AQ-73.0 -2.7,AR-37.0 -65.1,AT47.6 13.5,AU-23.8 133.2," +
    "AZ40.4 47.4,BA44.2 17.9,BD23.4 90.6,BE50.7 4.4,BF12.1 -1.9," +
    "BG42.9 24.7,BH26.0 50.5,BI-3.2 30.0,BJ9.8 2.3,BN4.7 115.0," +
    "BO-16.3 -64.1,BR-9.7 -56.9,BS24.5 -77.9,BT27.5 90.6,BW-22.5 24.5," +
    "BY53.3 28.3,BZ17.4 -88.6,CA56.4 -91.1,CD-3.8 23.1,CF6.3 20.7," +
    "CG-0.9 14.9,CH46.8 8.3,CI7.9 -6.3,CL-38.1 -71.4,CM6.9 13.2," +
    "CN37.3 105.7,CO4.5 -72.7,CR9.8 -84.2,CU21.7 -79.7,CY35.1 33.4," +
    "CZ49.8 15.8,DE51.0 10.7,DJ11.8 42.5,DK56.3 9.6,DO18.7 -70.5," +
    "DZ29.7 3.0,EC-1.6 -78.7,EE58.7 26.1,EG28.2 31.7,EH24.8 -12.0," +
    "ER14.7 39.6,ES40.2 -4.5,ET9.0 39.2,FI65.2 25.9,FJ-17.7 178.0," +
    "FK-51.7 -59.6,FR47.0 3.3,GA-0.3 11.9,GB53.9 -3.1,GE42.3 43.4," +
    "GH8.3 -1.0,GL74.1 -41.0,GM13.5 -15.3,GN10.4 -11.0,GQ1.6 10.1," +
    "GR39.8 23.1,GT15.5 -90.3,GW12.0 -15.2,GY4.5 -58.9,HK22.3 114.2," +
    "HN14.7 -86.3,HR44.8 16.4,HT18.8 -72.7,HU47.4 19.2,ID0.1 114.0," +
    "IE53.5 -7.7,IL32.0 35.1,IN24.0 83.6,IQ33.4 44.4,IR33.4 53.2," +
    "IS65.3 -19.3,IT43.1 12.6,JM18.2 -77.3,JO31.1 36.7,JP35.7 136.0," +
    "KE1.1 37.8,KG41.4 74.0,KH12.6 104.9,KP39.9 127.4,KR36.7 127.5," +
    "KW29.3 47.7,KZ47.3 65.3,LA18.3 103.7,LB33.8 35.9,LI47.2 9.5," +
    "LK7.6 80.9,LR6.8 -9.1,LS-29.6 28.4,LT55.2 24.0,LU49.8 6.1," +
    "LV56.9 24.9,LY28.5 16.6,MA28.8 -9.4,MC43.7 7.4,MD47.0 28.5," +
    "ME42.7 19.4,MG-18.0 47.0,MK41.7 21.6,ML14.1 -5.8,MM20.0 97.2," +
    "MN47.2 104.6,MR18.8 -12.4,MT35.9 14.4,MU-20.3 57.6,MW-12.9 34.1," +
    "MX23.9 -103.1,MY3.7 114.8,MZ-17.7 35.0,NA-21.6 17.9,NC-21.2 165.5," +
    "NE15.5 8.7,NG9.7 8.3,NI13.1 -85.0,NL52.1 5.5,NO66.2 18.1," +
    "NP28.2 84.6,NZ-43.5 171.0,OM20.9 56.6,PA8.5 -80.3,PE-7.8 -74.1," +
    "PG-7.8 146.2,PH15.4 121.8,PK30.8 69.4,PL51.7 19.5,PR18.3 -66.4," +
    "PS31.8 35.2,PT39.8 -8.0,PY-23.3 -57.6,QA25.3 51.2,RO45.9 25.2," +
    "RS43.9 20.9,RU59.1 90.9,RW-2.0 29.9,SA24.0 43.6,SB-7.9 159.1," +
    "SD12.8 29.3,SE62.7 16.6,SG1.4 103.8,SI46.1 15.0,SK48.8 19.4," +
    "SL8.6 -11.7,SM43.9 12.5,SN13.9 -14.6,SO6.6 46.9,SR3.7 -55.9," +
    "SS8.0 30.1,SV13.9 -88.9,SY35.1 38.0,SZ-26.4 31.4,TD13.0 18.0," +
    "TF-49.1 69.5,TG8.9 0.9,TH13.2 100.7,TJ38.5 70.8,TL-8.7 125.9," +
    "TM39.3 58.5,TN34.0 9.8,TR38.4 36.9,TT10.5 -61.5,TW23.9 121.1," +
    "TZ-6.5 34.3,UA48.7 30.5,UG1.3 32.0,US38.3 -90.4,UY-32.7 -56.1," +
    "UZ41.2 65.3,VE7.2 -66.9,VN16.7 105.9,VU-15.4 166.9,XK42.5 21.0," +
    "YE15.5 46.5,ZA-28.6 24.7,ZM-12.8 28.0,ZW-18.9 29.7,";

// Центры расселения для стран, у которых геометрический центр никуда не
// годится: центр России по контуру — середина Сибири, и маршрут для человека
// из Москвы начинался бы за три тысячи километров от него.
const POPULATED = {
    RU: [55.5, 42.0], US: [39.5, -86.0], CA: [45.4, -78.0], BR: [-19.0, -45.0],
    AU: [-33.0, 147.0], CN: [33.0, 113.0], KZ: [49.0, 72.0], ID: [-7.0, 110.0],
};

const centers = {};
for (const entry of CENTERS_RAW.split(",")) {
    if (entry.length < 5) continue;
    const parts = entry.slice(2).split(" ");
    const lat = Number.parseFloat(parts[0]);
    const lon = Number.parseFloat(parts[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) centers[entry.slice(0, 2)] = [lat, lon];
}

/**
 * Код страны из флага в начале имени узла.
 *
 * Флаг в Unicode — пара региональных индикаторов, и она буквально содержит
 * код страны: 🇵🇱 это U+1F1F5 U+1F1F1, то есть «PL». Поэтому список стран
 * вести не нужно: узел с флагом опознаётся сам, как бы его ни назвали.
 */
function countryOf(name) {
    const text = (name || "").trimStart();
    if (!text) return null;
    const first = text.codePointAt(0);
    if (first < 0x1f1e6 || first > 0x1f1ff) return null;
    const second = text.codePointAt(String.fromCodePoint(first).length);
    if (!second || second < 0x1f1e6 || second > 0x1f1ff) return null;
    return String.fromCharCode(65 + (first - 0x1f1e6), 65 + (second - 0x1f1e6));
}

function centerOf(code) {
    if (!code) return null;
    const key = code.toUpperCase();
    return POPULATED[key] || centers[key] || null;
}

/** Регион устройства из настроек системы. Страна целиком, не координата. */
function deviceRegion() {
    const tags = [navigator.language, ...(navigator.languages || [])];
    for (const tag of tags) {
        const region = /-([A-Z]{2})\b/.exec(tag || "");
        if (region && centerOf(region[1])) return region[1];
    }
    return null;
}

const MIN_SPAN = 72;      // уже этого не приближаем: снимок 2048 точек в ширину
const ROUTE_TOP = 0.19;   // маршрут держим выше центра — в центре кнопка
const ROUTE_LIFT = 0.32;  // насколько дуга выгибается вверх, доля её длины
const VIEW_TOP = 80;
const VIEW_BOTTOM = -70;

function frameFor(a, b, w, h) {
    const aspect = w / h;
    const lonSpan = Math.min(
        Math.max(Math.max(Math.abs(a[1] - b[1]) * 1.45, Math.abs(a[0] - b[0]) * 1.9 * aspect), MIN_SPAN),
        360,
    );
    const latSpan = Math.min(lonSpan / aspect, VIEW_TOP - VIEW_BOTTOM);
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    return {
        lonLeft: clamp((a[1] + b[1]) / 2 - lonSpan / 2, -180, 180 - lonSpan),
        lonSpan,
        latTop: clamp((a[0] + b[0]) / 2 + latSpan * ROUTE_TOP, VIEW_BOTTOM + latSpan, VIEW_TOP),
        latSpan,
        w,
        h,
    };
}

const project = (f, lat, lon) => [
    ((lon - f.lonLeft) / f.lonSpan) * f.w,
    ((f.latTop - lat) / f.latSpan) * f.h,
];

const textures = {};
function texture(light) {
    const src = light ? "world-day.webp" : "world-night.webp";
    if (!textures[src]) {
        const img = new Image();
        img.src = src;
        textures[src] = img;
    }
    return textures[src];
}

/**
 * Рисует карту в canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{serverName: string|null, label: string|null, light: boolean, accent: string, panel: string, text: string}} view
 * @param {number} glow 0 — огни погашены, 1 — горят
 * @param {number} spark положение искры на дуге, 0…1
 * @returns {boolean} false, если снимок ещё не догрузился и рисовать нечего
 */
function drawMap(canvas, view, glow, spark) {
    const ratio = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return false;
    if (canvas.width !== Math.round(w * ratio)) {
        canvas.width = Math.round(w * ratio);
        canvas.height = Math.round(h * ratio);
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const earth = texture(view.light);
    if (!earth.complete || !earth.naturalWidth) return false;

    // без узла показываем Европу: там стоит большинство наших серверов
    const to = centerOf(countryOf(view.serverName));
    const from = centerOf(deviceRegion()) || [52, 15];
    const frame = frameFor(from, to || from, w, h);

    // --- снимок, вырезанный по кадру
    const sx = ((frame.lonLeft + 180) / 360) * earth.naturalWidth;
    const sy = ((90 - frame.latTop) / 180) * earth.naturalHeight;
    const sw = (frame.lonSpan / 360) * earth.naturalWidth;
    const sh = (frame.latSpan / 180) * earth.naturalHeight;

    ctx.save();
    // тёмная графика по светлой теме и так заметна — её приглушаем
    const strength = view.light ? 0.6 : 1;
    // До полной яркости снимок не доводим даже при живом туннеле: огни
    // городов в Европе такие плотные, что тонкая дуга маршрута тонет в них.
    ctx.globalAlpha = (0.3 + 0.55 * glow) * strength;
    ctx.drawImage(earth, sx, sy, sw, sh, 0, 0, w, h);
    ctx.globalAlpha = 1;

    // Края растворяем в прозрачность, а не закрашиваем фоном: под картой
    // живой фон окна, и сплошная заливка поверх него читалась бы как
    // вставленный прямоугольник.
    ctx.globalCompositeOperation = "destination-in";
    let mask = ctx.createLinearGradient(0, 0, 0, h);
    mask.addColorStop(0, "rgba(0,0,0,0)");
    mask.addColorStop(0.14, "#000");
    mask.addColorStop(0.7, "#000");
    mask.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = mask;
    ctx.fillRect(0, 0, w, h);
    mask = ctx.createLinearGradient(0, 0, w, 0);
    mask.addColorStop(0, "rgba(0,0,0,0)");
    mask.addColorStop(0.1, "#000");
    mask.addColorStop(0.9, "#000");
    mask.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = mask;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    if (!to) return true;
    const end = project(frame, to[0], to[1]);

    // --- дуга маршрута
    if (glow > 0.01) {
        const start = project(frame, from[0], from[1]);
        const lift = Math.hypot(end[0] - start[0], end[1] - start[1]) * ROUTE_LIFT;
        const ctrl = [(start[0] + end[0]) / 2, Math.min(start[1], end[1]) - lift];
        const at = (t) => {
            const u = 1 - t;
            return [
                u * u * start[0] + 2 * u * t * ctrl[0] + t * t * end[0],
                u * u * start[1] + 2 * u * t * ctrl[1] + t * t * end[1],
            ];
        };

        ctx.lineCap = "round";
        let prev = at(0);
        for (let i = 1; i <= 64; i += 1) {
            const point = at(i / 64);
            // линия разгорается к концу: видно, куда идёт трафик, без стрелок
            const ramp = 0.3 + (i / 64) * 0.7;
            ctx.strokeStyle = view.accent;
            ctx.globalAlpha = 0.22 * ramp * glow;
            ctx.lineWidth = 6 * ramp;
            ctx.beginPath();
            ctx.moveTo(prev[0], prev[1]);
            ctx.lineTo(point[0], point[1]);
            ctx.stroke();
            ctx.globalAlpha = 0.95 * ramp * glow;
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.moveTo(prev[0], prev[1]);
            ctx.lineTo(point[0], point[1]);
            ctx.stroke();
            prev = point;
        }

        const head = at(spark);
        const fade = 1 - spark * spark;
        ctx.globalAlpha = 0.2 * glow * fade;
        ctx.fillStyle = view.accent;
        ctx.beginPath();
        ctx.arc(head[0], head[1], 13, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.95 * glow * fade;
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(head[0], head[1], 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    // --- точка страны назначения
    ctx.fillStyle = view.accent;
    ctx.globalAlpha = 0.1 + 0.16 * glow;
    ctx.beginPath();
    ctx.arc(end[0], end[1], 10 + 10 * glow, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.45 + 0.55 * glow;
    ctx.beginPath();
    ctx.arc(end[0], end[1], 3.5 + 1.5 * glow, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // --- подпись страны
    if (glow > 0.05 && view.label) {
        ctx.font = "500 11px system-ui, sans-serif";
        const width = ctx.measureText(view.label).width + 20;
        const height = 22;
        const above = end[1] - height - 16 > 0;
        const top = above ? end[1] - height - 16 : end[1] + 16;
        const left = Math.min(Math.max(end[0] - width / 2, 4), w - width - 4);

        ctx.globalAlpha = 0.9 * glow;
        ctx.fillStyle = view.panel;
        roundRect(ctx, left, top, width, height, height / 2);
        ctx.fill();
        ctx.globalAlpha = 0.5 * glow;
        ctx.strokeStyle = view.accent;
        ctx.lineWidth = 1;
        roundRect(ctx, left, top, width, height, height / 2);
        ctx.stroke();
        ctx.globalAlpha = glow;
        ctx.fillStyle = view.text;
        ctx.textBaseline = "middle";
        ctx.fillText(view.label, left + 10, top + height / 2);
        ctx.globalAlpha = 1;
    }

    return true;
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(x, y, w, h, r);
        return;
    }
    // старые webview на Linux ещё не знают roundRect
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/** Название страны на языке системы плюс её флаг: «🇵🇱 Польша». */
function countryLabel(code) {
    if (!code) return null;
    const flag = String.fromCodePoint(0x1f1e6 + code.charCodeAt(0) - 65) +
        String.fromCodePoint(0x1f1e6 + code.charCodeAt(1) - 65);
    try {
        // Интерфейс клиента русский целиком, поэтому и страну называем
        // по-русски, а не на языке системы: «🇵🇱 Poland» посреди русских
        // подписей читается как чужая строка.
        const names = new Intl.DisplayNames(["ru"], { type: "region" });
        return `${flag} ${names.of(code) || code}`;
    } catch {
        return `${flag} ${code}`;
    }
}

// app.js — обычный скрипт, а не модуль: api.js и guest.js делят с ним
// глобальные функции. Ради одной карты переводить всё на модули значило бы
// переписать три файла, поэтому наружу отдаём один объект.
window.DPMap = { countryOf, countryLabel, drawMap };
