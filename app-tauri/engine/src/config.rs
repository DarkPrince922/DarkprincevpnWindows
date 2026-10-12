//! Подготовка конфига для ядра Xray.
//!
//! Конфиг узла берётся из подписки целиком — вместе с роутингом, правилами и
//! балансировщиками панели. Меняются только входы: локальный SOCKS для
//! туннеля и локальный HTTP для системного прокси (Windows умеет ходить
//! через прокси только по HTTP-настройке).

use serde_json::{json, Value};

/// Порты по умолчанию. Если заняты — берём любые свободные: занять их мог
/// другой VPN-клиент, и убивать его процессы мы не вправе.
pub const SOCKS_PORT: u16 = 10808;
pub const HTTP_PORT: u16 = 10809;

/// Возвращает готовый конфиг ядра или ошибку, если узел содержит не JSON.
pub fn build(raw_config: &str, socks_port: u16, http_port: u16) -> Result<String, String> {
    let mut config: Value = serde_json::from_str(raw_config)
        .map_err(|error| format!("конфиг сервера не разобрать: {error}"))?;

    let object = config
        .as_object_mut()
        .ok_or_else(|| "конфиг сервера должен быть объектом".to_string())?;

    object.insert(
        "inbounds".into(),
        json!([socks_inbound(socks_port), http_inbound(http_port)]),
    );
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
) -> Result<String, String> {
    let mut config: Value = serde_json::from_str(&build(raw_config, socks_port, http_port)?)
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

fn socks_inbound(port: u16) -> Value {
    json!({
        "tag": "socks",
        "listen": "127.0.0.1",
        "port": port,
        "protocol": "socks",
        "settings": {"auth": "noauth", "udp": true},
        "sniffing": {"enabled": true, "destOverride": ["http", "tls"], "routeOnly": false}
    })
}

fn http_inbound(port: u16) -> Value {
    json!({
        "tag": "http",
        "listen": "127.0.0.1",
        "port": port,
        "protocol": "http",
        "settings": {},
        "sniffing": {"enabled": true, "destOverride": ["http", "tls"], "routeOnly": false}
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
        let built: Value = serde_json::from_str(&build(raw, SOCKS_PORT, HTTP_PORT).unwrap()).unwrap();

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
        let built: Value = serde_json::from_str(&build(raw, SOCKS_PORT, HTTP_PORT).unwrap()).unwrap();
        assert_eq!(built["log"]["loglevel"], "debug");
    }

    #[test]
    fn stats_service_is_reachable_before_panel_rules() {
        let raw = r#"{"outbounds":[{"protocol":"vless","tag":"proxy"}],
                      "routing":{"rules":[{"type":"field","outboundTag":"block"}]}}"#;
        let built: Value =
            serde_json::from_str(&build_with_stats(raw, SOCKS_PORT, HTTP_PORT, 10813).unwrap()).unwrap();
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

    #[test]
    fn broken_config_reports_error() {
        assert!(build("не json", SOCKS_PORT, HTTP_PORT).is_err());
    }
}
