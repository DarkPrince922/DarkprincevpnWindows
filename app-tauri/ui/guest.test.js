// Разбор гостевой ссылки: чистая функция, а краевых случаев много —
// два формата ссылки, двойное кодирование, чужие схемы.
//
//   node --test ui/guest.test.js
//
// Тот же файл лежит в клиенте для Windows. Если правите здесь — правьте и
// там: guest.js у клиентов побайтово одинаковый, и разъезжаться ему нельзя.

const test = require("node:test");
const assert = require("node:assert");

const { parseSharedSubscription } = require("./guest.js");

test("обычная ссылка проходит как есть", () => {
    assert.strictEqual(
        parseSharedSubscription("https://panel.example/sub/abc"),
        "https://panel.example/sub/abc"
    );
});

test("пробелы по краям срезаются", () => {
    assert.strictEqual(
        parseSharedSubscription("  https://panel.example/sub/abc\n"),
        "https://panel.example/sub/abc"
    );
});

test("своя схема с адресом в параметре", () => {
    assert.strictEqual(
        parseSharedSubscription(
            "darkprincevpn://sub?url=https%3A%2F%2Fpanel.example%2Fsub%2Fabc"
        ),
        "https://panel.example/sub/abc"
    );
});

test("своя схема со старым форматом, адрес прямо в пути", () => {
    assert.strictEqual(
        parseSharedSubscription("darkprincevpn://sub/https://panel.example/sub/abc"),
        "https://panel.example/sub/abc"
    );
});

test("своя схема со старым форматом и закодированным адресом", () => {
    assert.strictEqual(
        parseSharedSubscription(
            "darkprincevpn://sub/https%3A%2F%2Fpanel.example%2Fsub%2Fabc"
        ),
        "https://panel.example/sub/abc"
    );
});

test("схема приложения регистр не важен", () => {
    assert.strictEqual(
        parseSharedSubscription("DarkPrinceVPN://sub/https://panel.example/s"),
        "https://panel.example/s"
    );
});

// Ссылка подписки — это доступ к VPN целиком. По http её прочитал бы любой
// на пути, поэтому такие ссылки не принимаем ни в одном из форматов.
test("http отвергается", () => {
    assert.strictEqual(parseSharedSubscription("http://panel.example/sub/abc"), null);
});

test("http внутри своей схемы тоже отвергается", () => {
    assert.strictEqual(
        parseSharedSubscription("darkprincevpn://sub?url=http%3A%2F%2Fpanel.example%2Fs"),
        null
    );
    assert.strictEqual(
        parseSharedSubscription("darkprincevpn://sub/http://panel.example/s"),
        null
    );
});

test("чужие схемы отвергаются", () => {
    for (const link of [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "vless://uuid@host:443",
        "ftp://panel.example/sub",
    ]) {
        assert.strictEqual(parseSharedSubscription(link), null, link);
    }
});

test("пустое и мусор отвергаются", () => {
    for (const link of ["", "   ", null, undefined, "просто текст", "darkprincevpn://"]) {
        assert.strictEqual(parseSharedSubscription(link), null, String(link));
    }
});

test("не строки не роняют разбор", () => {
    for (const value of [42, {}, [], true]) {
        assert.strictEqual(parseSharedSubscription(value), null, String(value));
    }
});
