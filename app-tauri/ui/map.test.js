"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/**
 * map.js — обычный скрипт для окна браузера, а не модуль: наружу он отдаёт
 * один объект через window. Здесь мы даём ему пустое «окно» и забираем то,
 * что он в него положил. Ни canvas, ни картинка при загрузке не нужны — они
 * появляются только внутри отрисовки, которую мы не трогаем.
 */
function load() {
    const source = fs.readFileSync(path.join(__dirname, "map.js"), "utf8");
    const context = { window: {}, navigator: { language: "ru-RU" }, Intl };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "map.js" });
    return context.window.DPMap;
}

const { countryOf, countryLabel } = load();

test("страна берётся из флага в названии узла", () => {
    assert.equal(countryOf("🇵🇱 Польша · Варшава"), "PL");
    assert.equal(countryOf("🇳🇱 Амстердам"), "NL");
});

test("флаг ищем только в начале имени", () => {
    // Флаг — это опознавательный знак узла, а не украшение где-то в
    // середине строки. Внутри имени пара индикаторов может оказаться
    // случайно, и промахнуться картой хуже, чем не показать её вовсе.
    assert.equal(countryOf("Узел 🇵🇱 второй"), null);
});

test("узнаём только по флагу, названия стран не угадываем", () => {
    // Список названий пришлось бы вести на трёх языках и всё равно
    // ошибаться на «Грузия / Georgia» и «Чехия / Czechia». Узел без флага
    // просто оставляет карту на виде по умолчанию.
    assert.equal(countryOf("Germany · Frankfurt"), null);
    assert.equal(countryOf("cdn-nl-3"), null);
});

test("пустое имя не роняет разбор", () => {
    assert.equal(countryOf("Сервер 7"), null);
    assert.equal(countryOf(""), null);
    assert.equal(countryOf(null), null);
    assert.equal(countryOf(undefined), null);
});

test("подпись собирается из флага и русского названия", () => {
    assert.equal(countryLabel("PL"), "🇵🇱 Польша");
    assert.equal(countryLabel(null), null);
});
