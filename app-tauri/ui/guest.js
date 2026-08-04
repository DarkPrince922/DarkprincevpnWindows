// Гостевой вход по ссылке подписки и QR-коду из локального изображения.
// Файл читается только в WebView приложения и никуда не загружается.

(function (root) {
    "use strict";

    const MAX_FILE_BYTES = 12 * 1024 * 1024;
    const MAX_IMAGE_PIXELS = 40 * 1000 * 1000;
    const MAX_DECODE_SIDE = 2200;

    // Принимаем только https. Ссылка подписки — это доступ к VPN целиком:
    // по http её прочитал бы любой на пути, а именно от этого приложение и
    // защищает. Схему darkprincevpn:// разбираем сами, но URL внутри неё
    // проверяем так же.
    function parseSharedSubscription(raw) {
        const text = String(raw || "").trim();
        if (!text) return null;

        if (/^https:\/\//i.test(text)) return text;
        if (!/^darkprincevpn:\/\//i.test(text)) return null;

        try {
            const link = new URL(text);
            const queryUrl = link.searchParams.get("url");
            if (queryUrl && /^https:\/\//i.test(queryUrl)) return queryUrl;
        } catch {
            // Старый вариант ссылки разберём ниже без URL API.
        }

        const pathUrl = text.replace(/^darkprincevpn:\/\/sub\//i, "");
        if (/^https:\/\//i.test(pathUrl)) return pathUrl;
        try {
            const decoded = decodeURIComponent(pathUrl);
            return /^https:\/\//i.test(decoded) ? decoded : null;
        } catch {
            return null;
        }
    }

    function readAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error("Не удалось прочитать изображение."));
            reader.readAsDataURL(file);
        });
    }

    function loadImage(source) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error("Файл не похож на поддерживаемое изображение."));
            image.src = source;
        });
    }

    function scanAtScale(image, scale, decoder) {
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Не удалось открыть изображение для чтения QR-кода.");
        context.imageSmoothingEnabled = false;
        context.drawImage(image, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height);
        return decoder(pixels.data, width, height, { inversionAttempts: "attemptBoth" });
    }

    async function decodeQrFile(file, decoder = root.jsQR) {
        if (!file) throw new Error("Выберите изображение с QR-кодом.");
        if (file.size > MAX_FILE_BYTES) {
            throw new Error("Изображение слишком большое. Максимальный размер — 12 МБ.");
        }
        if (typeof decoder !== "function") {
            throw new Error("Модуль чтения QR-кода не загрузился. Перезапустите приложение.");
        }

        const image = await loadImage(await readAsDataUrl(file));
        const pixels = image.naturalWidth * image.naturalHeight;
        if (!image.naturalWidth || !image.naturalHeight || pixels > MAX_IMAGE_PIXELS) {
            throw new Error("Изображение слишком большое или повреждено.");
        }

        const fit = Math.min(1, MAX_DECODE_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
        const scales = [fit];
        const enlarged = Math.min(2, MAX_DECODE_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
        if (enlarged > fit * 1.2) scales.push(enlarged);

        for (const scale of scales) {
            const result = scanAtScale(image, scale, decoder);
            if (result && result.data) return result.data.trim();
        }
        throw new Error("QR-код не распознан. Выберите более чёткое изображение.");
    }

    const guestAccess = { parseSharedSubscription, decodeQrFile };
    root.GuestAccess = guestAccess;
    if (typeof module === "object" && module.exports) module.exports = guestAccess;
})(typeof globalThis !== "undefined" ? globalThis : this);
