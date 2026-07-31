//! Подготовка конфига для ядра Xray.
//!
//! Конфиг узла берётся из подписки целиком — вместе с роутингом, правилами и
//! балансировщиками панели. Меняются только входы: локальный SOCKS для
//! туннеля и локальный HTTP для системного прокси (Windows умеет ходить
//! через прокси только по HTTP-настройке).

use serde_json::{json, Value};

pub const SOCKS_PORT: u16 = 10808;
pub const HTTP_PORT: u16 = 10809;

/// Возвращает готовый конфиг ядра или ошибку, если узел содержит не JSON.
pub fn build(raw_config: &str) -> Result<String, String> {
    let mut config: Value = serde_json::from_str(raw_config)
        .map_err(|error| format!("конфиг сервера не разобрать: {error}"))?;

    let object = config
        .as_object_mut()
        .ok_or_else(|| "конфиг сервера должен быть объектом".to_string())?;

    object.insert("inbounds".into(), json!([socks_inbound(), http_inbound()]));
    object.entry("log").or_insert_with(|| json!({"loglevel": "warning"}));
    object.entry("stats").or_insert_with(|| json!({}));
    object.entry("policy").or_insert_with(|| {
        json!({"system": {"statsOutboundUplink": true, "statsOutboundDownlink": true}})
    });

    Ok(config.to_string())
}

fn socks_inbound() -> Value {
    json!({
        "tag": "socks",
        "listen": "127.0.0.1",
        "port": SOCKS_PORT,
        "protocol": "socks",
        "settings": {"auth": "noauth", "udp": true},
        "sniffing": {"enabled": true, "destOverride": ["http", "tls"], "routeOnly": false}
    })
}

fn http_inbound() -> Value {
    json!({
        "tag": "http",
        "listen": "127.0.0.1",
        "port": HTTP_PORT,
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
        let built: Value = serde_json::from_str(&build(raw).unwrap()).unwrap();

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
        let built: Value = serde_json::from_str(&build(raw).unwrap()).unwrap();
        assert_eq!(built["log"]["loglevel"], "debug");
    }

    #[test]
    fn broken_config_reports_error() {
        assert!(build("не json").is_err());
    }
}
