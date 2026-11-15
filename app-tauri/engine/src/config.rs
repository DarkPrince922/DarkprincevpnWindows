//! Подготовка конфига для ядра Xray.
//!
//! Конфиг узла берётся из подписки целиком — вместе с роутингом, правилами и
//! балансировщиками панели. Меняются только входы: локальный SOCKS для
//! туннеля и локальный HTTP для системного прокси (Windows умеет ходить
//! через прокси только по HTTP-настройке).
//!
//! Чтобы правила панели после этого продолжали работать, делается ещё две
//! вещи. Правила, привязанные к входам панели (`inboundTag`), переводятся на
//! наши входы — иначе они молча перестают совпадать. А в режиме «весь
//! трафик» выходы ядра привязываются к физическому интерфейсу — иначе
//! соединение, которое правило отправило напрямую, попадает обратно в
//! туннель и ходит по кругу.

use serde_json::{json, Value};

/// Порты по умолчанию. Если заняты — берём любые свободные: занять их мог
/// другой VPN-клиент, и убивать его процессы мы не вправе.
pub const SOCKS_PORT: u16 = 10808;
pub const HTTP_PORT: u16 = 10809;

/// Теги наших входов. По ним же считается трафик.
const SOCKS_TAG: &str = "socks";
const HTTP_TAG: &str = "http";

/// Возвращает готовый конфиг ядра или ошибку, если узел содержит не JSON.
///
/// `interface` — физический интерфейс для режима «весь трафик»; в режиме
/// прокси `None`.
pub fn build(
    raw_config: &str,
    socks_port: u16,
    http_port: u16,
    interface: Option<&str>,
) -> Result<String, String> {
    let mut config: Value = serde_json::from_str(raw_config)
        .map_err(|error| format!("конфиг сервера не разобрать: {error}"))?;

    let object = config
        .as_object_mut()
        .ok_or_else(|| "конфиг сервера должен быть объектом".to_string())?;

    // до подмены входов: потом теги панели уже не узнать
    adopt_inbound_tags(object);
    object.insert(
        "inbounds".into(),
        json!([socks_inbound(socks_port), http_inbound(http_port)]),
    );
    if let Some(interface) = interface.filter(|name| !name.is_empty()) {
        bind_outbounds(object, interface);
    }
    object.entry("log").or_insert_with(|| json!({"loglevel": "warning"}));
    object.entry("stats").or_insert_with(|| json!({}));
    object.entry("policy").or_insert_with(|| {
        json!({"system": {"statsOutboundUplink": true, "statsOutboundDownlink": true}})
    });

    Ok(config.to_string())
}

/// Тот же конфиг, но со службой статистики ядра на локальном порту: по ней
/// приложение показывает, сколько получено и отправлено.
///
/// Считаем по входам (socks и http): через них идёт весь трафик программ, и в
/// туннеле, и в режиме прокси, — какой бы выход ни выбрали правила панели.
pub fn build_with_stats(
    raw_config: &str,
    socks_port: u16,
    http_port: u16,
    api_port: u16,
    interface: Option<&str>,
) -> Result<String, String> {
    let mut config: Value =
        serde_json::from_str(&build(raw_config, socks_port, http_port, interface)?)
        .map_err(|error| error.to_string())?;
    let object = config.as_object_mut().ok_or("конфиг сервера должен быть объектом")?;

    object.insert("api".into(), json!({"tag": "api", "services": ["StatsService"]}));
    object.insert("stats".into(), json!({}));
    let policy = object.entry("policy").or_insert_with(|| json!({}));
    if let Some(policy) = policy.as_object_mut() {
        let system = policy.entry("system").or_insert_with(|| json!({}));
        if let Some(system) = system.as_object_mut() {
            system.insert("statsInboundUplink".into(), json!(true));
            system.insert("statsInboundDownlink".into(), json!(true));
        }
    }
    if let Some(inbounds) = object.get_mut("inbounds").and_then(Value::as_array_mut) {
        inbounds.push(json!({
            "tag": "api",
            "listen": "127.0.0.1",
            "port": api_port,
            "protocol": "dokodemo-door",
            "settings": {"address": "127.0.0.1"}
        }));
    }
    // запросы к статистике — самым первым правилом, раньше правил панели
    let routing = object.entry("routing").or_insert_with(|| json!({}));
    if let Some(routing) = routing.as_object_mut() {
        let rules = routing.entry("rules").or_insert_with(|| json!([]));
        if let Some(rules) = rules.as_array_mut() {
            rules.insert(0, json!({"type": "field", "inboundTag": ["api"], "outboundTag": "api"}));
        }
    }
    Ok(config.to_string())
}

/// Сумма (отправлено, получено) из ответа `xray api statsquery`.
pub fn parse_traffic(answer: &str) -> Option<(u64, u64)> {
    let parsed: Value = serde_json::from_str(answer).ok()?;
    let mut up = 0u64;
    let mut down = 0u64;
    for stat in parsed.get("stat")?.as_array()? {
        let name = stat.get("name").and_then(Value::as_str).unwrap_or("");
        // нулевое значение ядро не присылает вовсе; число бывает и строкой
        let value = match stat.get("value") {
            Some(Value::String(text)) => text.parse().unwrap_or(0),
            Some(value) => value.as_u64().unwrap_or(0),
            None => 0,
        };
        if !name.starts_with("inbound>>>") || name.starts_with("inbound>>>api>>>") {
            continue;
        }
        if name.ends_with(">>>uplink") {
            up += value;
        } else if name.ends_with(">>>downlink") {
            down += value;
        }
    }
    Some((up, down))
}

/// Переводит правила панели с её входов на наши.
///
/// В шаблоне панели правило может быть привязано к входу: «всё, что пришло
/// через `socks-in`, на рекламные адреса — блокировать». Входы панели мы
/// заменяем своими, с другими тегами, и такое правило переставало совпадать
/// без единой ошибки: реклама шла в прокси, «свои» сайты — не напрямую.
///
/// Берём только входы, через которые ходят программы (socks, http, mixed).
/// Служебные — например, вход для DNS — не трогаем: их правила к трафику
/// программ не относятся, и переводить их на наши входы было бы ошибкой.
fn adopt_inbound_tags(object: &mut serde_json::Map<String, Value>) {
    let panel_tags: Vec<String> = object
        .get("inbounds")
        .and_then(Value::as_array)
        .map(|inbounds| {
            inbounds
                .iter()
                .filter(|inbound| {
                    let protocol = inbound
                        .get("protocol")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_lowercase();
                    matches!(protocol.as_str(), "socks" | "http" | "mixed")
                })
                .filter_map(|inbound| inbound.get("tag").and_then(Value::as_str))
                .filter(|tag| !tag.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if panel_tags.is_empty() {
        return;
    }

    let Some(rules) = object
        .get_mut("routing")
        .and_then(|routing| routing.get_mut("rules"))
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for rule in rules {
        let Some(field) = rule.get_mut("inboundTag") else { continue };
        // ядро принимает и список, и строку через запятую
        let mut tags: Vec<String> = match field {
            Value::Array(items) => {
                items.iter().filter_map(Value::as_str).map(str::to_string).collect()
            }
            Value::String(text) => text.split(',').map(|tag| tag.trim().to_string()).collect(),
            _ => continue,
        };
        if !tags.iter().any(|tag| panel_tags.contains(tag)) {
            continue;
        }
        for ours in [SOCKS_TAG, HTTP_TAG] {
            if !tags.iter().any(|tag| tag == ours) {
                tags.push(ours.to_string());
            }
        }
        *field = json!(tags);
    }
}

/// Привязывает выходы ядра к физическому интерфейсу.
///
/// В режиме «весь трафик» в туннель уходит всё, включая соединения самого
/// ядра. Мимо туннеля проложен путь только до сервера, а правило панели
/// «российские сайты — напрямую» открывает соединение на произвольный адрес:
/// оно попадало в туннель, возвращалось в ядро, снова шло «напрямую» — и так
/// по кругу. Сайты из таких правил не открывались вовсе.
///
/// Привязанный к интерфейсу сокет в туннель попасть не может. Заодно это
/// закрывает случай с несколькими серверами и балансировщиком: путь мимо
/// туннеля есть у каждого выхода, а не только у первого.
///
/// Свою привязку панели не трогаем. Выходы, которые сети не касаются
/// (blackhole, dns, loopback), пропускаем.
fn bind_outbounds(object: &mut serde_json::Map<String, Value>, interface: &str) {
    let Some(outbounds) = object.get_mut("outbounds").and_then(Value::as_array_mut) else {
        return;
    };
    for outbound in outbounds {
        let protocol = outbound
            .get("protocol")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        if matches!(protocol.as_str(), "" | "blackhole" | "dns" | "loopback") {
            continue;
        }
        let Some(outbound) = outbound.as_object_mut() else { continue };
        let stream = outbound.entry("streamSettings").or_insert_with(|| json!({}));
        let Some(stream) = stream.as_object_mut() else { continue };
        let sockopt = stream.entry("sockopt").or_insert_with(|| json!({}));
        let Some(sockopt) = sockopt.as_object_mut() else { continue };
        let already = sockopt
            .get("interface")
            .and_then(Value::as_str)
            .is_some_and(|name| !name.is_empty());
        if !already {
            sockopt.insert("interface".into(), json!(interface));
        }
    }
}

/// Что ядро распознаёт в трафике, чтобы правила по доменам работали и там,
/// где программа пришла с голым IP-адресом — то есть во всём режиме «весь
/// трафик». `quic` нужен браузерам: HTTP/3 идёт поверх UDP, и без него
/// правила по доменам на такой трафик не действовали.
fn sniffing() -> Value {
    json!({"enabled": true, "destOverride": ["http", "tls", "quic"], "routeOnly": false})
}

fn socks_inbound(port: u16) -> Value {
    json!({
        "tag": SOCKS_TAG,
        "listen": "127.0.0.1",
        "port": port,
        "protocol": "socks",
        "settings": {"auth": "noauth", "udp": true},
        "sniffing": sniffing()
    })
}

fn http_inbound(port: u16) -> Value {
    json!({
        "tag": HTTP_TAG,
        "listen": "127.0.0.1",
        "port": port,
        "protocol": "http",
        "settings": {},
        "sniffing": sniffing()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_inbounds_and_keeps_the_rest() {
        let raw = r#"{"outbounds":[{"protocol":"vless","tag":"proxy"}],
                      "routing":{"rules":[{"type":"field","outboundTag":"direct"}]},
                      "inbounds":[{"port":1080}]}"#;
        let built: Value = serde_json::from_str(&build(raw, SOCKS_PORT, HTTP_PORT, None).unwrap()).unwrap();

        let inbounds = built["inbounds"].as_array().unwrap();
        assert_eq!(inbounds.len(), 2);
        assert_eq!(inbounds[0]["port"], SOCKS_PORT);
        assert_eq!(inbounds[1]["port"], HTTP_PORT);
        // роутинг панели обязан дойти до ядра нетронутым
        assert_eq!(built["routing"]["rules"][0]["outboundTag"], "direct");
        assert_eq!(built["outbounds"][0]["protocol"], "vless");
    }

    #[test]
    fn own_log_settings_win() {
        let raw = r#"{"log":{"loglevel":"debug"},"outbounds":[]}"#;
        let built: Value = serde_json::from_str(&build(raw, SOCKS_PORT, HTTP_PORT, None).unwrap()).unwrap();
        assert_eq!(built["log"]["loglevel"], "debug");
    }

    #[test]
    fn stats_service_is_reachable_before_panel_rules() {
        let raw = r#"{"outbounds":[{"protocol":"vless","tag":"proxy"}],
                      "routing":{"rules":[{"type":"field","outboundTag":"block"}]}}"#;
        let built: Value =
            serde_json::from_str(&build_with_stats(raw, SOCKS_PORT, HTTP_PORT, 10813, None).unwrap()).unwrap();
        assert_eq!(built["inbounds"][2]["port"], 10813);
        assert_eq!(built["inbounds"][2]["tag"], "api");
        assert_eq!(built["routing"]["rules"][0]["outboundTag"], "api");
        assert_eq!(built["routing"]["rules"][1]["outboundTag"], "block");
        assert_eq!(built["policy"]["system"]["statsInboundDownlink"], true);
    }

    #[test]
    fn traffic_sums_program_inbounds_only() {
        let answer = r#"{"stat":[
            {"name":"inbound>>>socks>>>traffic>>>uplink","value":"100"},
            {"name":"inbound>>>socks>>>traffic>>>downlink","value":"1000"},
            {"name":"inbound>>>http>>>traffic>>>downlink","value":24},
            {"name":"inbound>>>http>>>traffic>>>uplink"},
            {"name":"inbound>>>api>>>traffic>>>downlink","value":"999"},
            {"name":"outbound>>>proxy>>>traffic>>>downlink","value":"5"}]}"#;
        assert_eq!(parse_traffic(answer), Some((100, 1024)));
        assert_eq!(parse_traffic("{}"), None);
    }

    /// Правило панели, привязанное к её входу, обязано действовать и на
    /// наши входы: иначе оно молча перестаёт совпадать.
    #[test]
    fn rules_bound_to_panel_inbounds_follow_ours() {
        let raw = r#"{"inbounds":[{"tag":"socks-in","protocol":"socks"},
                                  {"tag":"http-in","protocol":"HTTP"},
                                  {"tag":"dns-in","protocol":"dokodemo-door"}],
                      "outbounds":[{"protocol":"vless","tag":"proxy"}],
                      "routing":{"rules":[
                        {"type":"field","inboundTag":["socks-in"],"outboundTag":"block"},
                        {"type":"field","inboundTag":"http-in, other","outboundTag":"direct"},
                        {"type":"field","inboundTag":["dns-in"],"outboundTag":"dns-out"},
                        {"type":"field","domain":["domain:ru"],"outboundTag":"direct"}]}}"#;
        let built: Value =
            serde_json::from_str(&build(raw, SOCKS_PORT, HTTP_PORT, None).unwrap()).unwrap();
        let rules = built["routing"]["rules"].as_array().unwrap();
        assert_eq!(rules[0]["inboundTag"], json!(["socks-in", "socks", "http"]));
        assert_eq!(rules[1]["inboundTag"], json!(["http-in", "other", "socks", "http"]));
        // служебный вход — не трафик программ, его правило не наше
        assert_eq!(rules[2]["inboundTag"], json!(["dns-in"]));
        assert!(rules[3].get("inboundTag").is_none());
    }

    /// В режиме «весь трафик» выход «напрямую» без привязки к интерфейсу
    /// возвращался бы в туннель и ходил по кругу.
    #[test]
    fn outbounds_are_bound_to_the_physical_interface_in_tun_mode() {
        let raw = r#"{"outbounds":[
            {"protocol":"vless","tag":"proxy","streamSettings":{"network":"tcp"}},
            {"protocol":"freedom","tag":"direct"},
            {"protocol":"freedom","tag":"own","streamSettings":{"sockopt":{"interface":"wg0"}}},
            {"protocol":"blackhole","tag":"block"},
            {"protocol":"dns","tag":"dns-out"}]}"#;
        let built: Value =
            serde_json::from_str(&build(raw, SOCKS_PORT, HTTP_PORT, Some("wlan0")).unwrap()).unwrap();
        let outbounds = built["outbounds"].as_array().unwrap();
        assert_eq!(outbounds[0]["streamSettings"]["sockopt"]["interface"], "wlan0");
        assert_eq!(outbounds[0]["streamSettings"]["network"], "tcp");
        assert_eq!(outbounds[1]["streamSettings"]["sockopt"]["interface"], "wlan0");
        assert_eq!(outbounds[2]["streamSettings"]["sockopt"]["interface"], "wg0");
        assert!(outbounds[3].get("streamSettings").is_none());
        assert!(outbounds[4].get("streamSettings").is_none());
    }

    #[test]
    fn proxy_mode_leaves_outbounds_alone() {
        let raw = r#"{"outbounds":[{"protocol":"freedom","tag":"direct"}]}"#;
        let built: Value =
            serde_json::from_str(&build(raw, SOCKS_PORT, HTTP_PORT, None).unwrap()).unwrap();
        assert!(built["outbounds"][0].get("streamSettings").is_none());
    }

    /// Без `quic` правила по доменам не действовали на HTTP/3 в туннеле.
    #[test]
    fn inbounds_recognise_quic() {
        let built: Value =
            serde_json::from_str(&build(r#"{"outbounds":[]}"#, SOCKS_PORT, HTTP_PORT, None).unwrap())
                .unwrap();
        for inbound in built["inbounds"].as_array().unwrap() {
            assert!(inbound["sniffing"]["destOverride"].as_array().unwrap().contains(&json!("quic")));
        }
    }

    #[test]
    fn broken_config_reports_error() {
        assert!(build("не json", SOCKS_PORT, HTTP_PORT, None).is_err());
    }
}
