//! Разбор подписки Remnawave.
//!
//! Панель отдаёт массив полных конфигов Xray — с роутингом, правилами и
//! балансировщиками. Конфиг сохраняется целиком и уходит ядру как есть:
//! подменяются только входы. Имя, адрес и транспорт достаются из первого
//! прокси-аутбаунда и нужны только для показа и для прокладки маршрута мимо
//! туннеля.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct Server {
    pub name: String,
    /// Полный конфиг Xray этого узла.
    pub raw_config: String,
    pub address: String,
    pub port: u16,
    /// Транспорт: tcp, ws, grpc, xhttp…
    pub network: String,
    /// tls, reality или none.
    pub security: String,
    /// Протокол так, как его назвала панель: vless, hysteria2, tuic…
    ///
    /// Раньше незнакомый протокол молча пропускался, и узел оставался с
    /// заготовкой «tcp» — в списке он врал про себя: сервер с именем
    /// «Sweden | HYSTERIA2» показывался как обычный tcp.
    pub protocol: String,
    /// Server Description из панели Remnawave. Задаётся каждому хосту
    /// отдельно и приходит только в формате XRAY_JSON.
    pub description: Option<String>,
}

impl Server {
    /// Подпись под именем сервера по частям: протокол, шифрование, транспорт.
    ///
    /// Списком, а не строкой: в интерфейсе каждая часть рисуется своей
    /// меткой и своим цветом, и склеивать их здесь, чтобы там разрезать
    /// обратно, незачем.
    ///
    /// Повторы отбрасываются: у Hysteria панель кладёт одно и то же имя и в
    /// протокол, и в сеть, и подпись выходила «hysteria · tls · hysteria».
    pub fn transport_parts(&self) -> Vec<String> {
        let mut parts: Vec<String> = Vec::new();
        let mut push = |value: &str| {
            let value = value.trim().to_lowercase();
            if value.is_empty() || value == "none" {
                return;
            }
            if parts.iter().any(|kept| *kept == value) {
                return;
            }
            parts.push(value);
        };

        push(&self.protocol);
        push(&self.security);
        // У Hysteria2, TUIC и WireGuard транспорта поверх нет: сам протокол
        // и есть транспорт, приписывать рядом «tcp» было бы неправдой.
        if !self.carries_own_transport() {
            push(&self.network);
        }
        parts
    }

    /// Подпись одной строкой — там, где нет места на отдельные метки.
    pub fn transport_label(&self) -> String {
        self.transport_parts().join(" · ")
    }

    fn carries_own_transport(&self) -> bool {
        matches!(
            self.protocol.as_str(),
            "hysteria" | "hysteria2" | "tuic" | "wireguard"
        )
    }
}

/// Разбирает содержимое подписки. Пустой список означает, что формат не
/// распознан — вызывающий код должен показать это пользователем, а не
/// молча остаться без серверов.
pub fn parse(content: &str) -> Vec<Server> {
    let text = content.trim();
    if text.starts_with('[') || text.starts_with('{') {
        let servers = parse_xray_json(text);
        if !servers.is_empty() {
            return servers;
        }
    }

    // Подписка может быть завёрнута в base64 — разворачиваем и пробуем снова.
    if let Some(decoded) = decode_base64(text) {
        let inner = decoded.trim();
        if inner.starts_with('[') || inner.starts_with('{') {
            return parse_xray_json(inner);
        }
    }

    Vec::new()
}

fn parse_xray_json(text: &str) -> Vec<Server> {
    let root: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };

    let configs: Vec<&Value> = match &root {
        Value::Array(items) => items.iter().filter(|item| item.is_object()).collect(),
        Value::Object(map) if map.contains_key("outbounds") => vec![&root],
        _ => Vec::new(),
    };

    let mut servers = Vec::new();
    for (index, config) in configs.iter().enumerate() {
        let outbounds = match config.get("outbounds").and_then(Value::as_array) {
            Some(list) => list,
            None => continue,
        };

        let mut address = String::new();
        let mut port = 443u16;
        let mut network = "tcp".to_string();
        let mut security = "none".to_string();
        let mut protocol = String::new();

        for outbound in outbounds {
            let name = outbound
                .get("protocol")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            // Служебные выходы есть в каждом конфиге и узлом не являются.
            if name.is_empty() || matches!(name.as_str(), "freedom" | "blackhole" | "dns" | "loopback") {
                continue;
            }
            protocol = name;
            if let Some(server) = first_server(outbound.get("settings")) {
                if let Some(value) = server.get("address").and_then(Value::as_str) {
                    address = value.to_string();
                }
                if let Some(value) = server.get("port").and_then(Value::as_u64) {
                    port = value as u16;
                }
            }
            if let Some(stream) = outbound.get("streamSettings") {
                if let Some(value) = stream.get("network").and_then(Value::as_str) {
                    network = value.to_string();
                }
                if let Some(value) = stream.get("security").and_then(Value::as_str) {
                    security = value.to_string();
                }
            }
            break;
        }

        // Remnawave кладёт Server Description в корень конфига. Оба написания:
        // панель отдаёт camelCase, но в самодельных шаблонах подписки
        // встречается и с подчёркиванием.
        let description = config
            .get("serverDescription")
            .or_else(|| config.get("server_description"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        let name = config
            .get("remarks")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.to_string())
            .unwrap_or_else(|| {
                if address.is_empty() {
                    format!("Сервер {}", index + 1)
                } else {
                    address.clone()
                }
            });

        servers.push(Server {
            name,
            raw_config: config.to_string(),
            address,
            port,
            network,
            security,
            protocol,
            description,
        });
    }
    servers
}

/// Адрес сервера лежит по-разному: у vless и vmess в `vnext`, у trojan и
/// shadowsocks в `servers`.
fn first_server(settings: Option<&Value>) -> Option<&Value> {
    let settings = settings?;
    for key in ["vnext", "servers"] {
        if let Some(list) = settings.get(key).and_then(Value::as_array) {
            if let Some(first) = list.first() {
                return Some(first);
            }
        }
    }
    None
}

fn decode_base64(text: &str) -> Option<String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let cleaned: Vec<u8> = text
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace() && *byte != b'=')
        .collect();
    if cleaned.is_empty() {
        return None;
    }

    let mut bits = 0u32;
    let mut count = 0u32;
    let mut out = Vec::with_capacity(cleaned.len() * 3 / 4);
    for byte in cleaned {
        // подписки встречаются и в url-safe варианте
        let byte = match byte {
            b'-' => b'+',
            b'_' => b'/',
            other => other,
        };
        let index = TABLE.iter().position(|candidate| *candidate == byte)? as u32;
        bits = (bits << 6) | index;
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUBSCRIPTION: &str = r#"[
      {"remarks":"DE WI-FI | Germany","outbounds":[
        {"protocol":"vless","settings":{"vnext":[{"address":"de.example.net","port":443}]},
         "streamSettings":{"network":"xhttp","security":"reality"}},
        {"protocol":"freedom","tag":"direct"}]},
      {"remarks":"NL","outbounds":[
        {"protocol":"trojan","settings":{"servers":[{"address":"nl.example.net","port":8443}]},
         "streamSettings":{"network":"grpc","security":"tls"}}]}
    ]"#;

    #[test]
    fn reads_servers_from_panel_subscription() {
        let servers = parse(SUBSCRIPTION);
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].name, "DE WI-FI | Germany");
        assert_eq!(servers[0].address, "de.example.net");
        assert_eq!(servers[0].port, 443);
        assert_eq!(servers[0].transport_label(), "vless · reality · xhttp");
        assert_eq!(servers[1].address, "nl.example.net");
        assert_eq!(servers[1].port, 8443);
        assert_eq!(servers[1].transport_label(), "trojan · tls · grpc");
    }

    /// Панель отдаёт Hysteria с одним и тем же именем в протоколе и в сети,
    /// и подпись выходила «hysteria · tls · hysteria». Плюс раньше такой узел
    /// вовсе не опознавался и показывался как обычный tcp.
    #[test]
    fn hysteria_does_not_repeat_itself() {
        let servers = parse(
            r#"[{"remarks":"SE | HYSTERIA2","serverDescription":"1 Гбит","outbounds":[
                {"protocol":"hysteria2","settings":{"servers":[{"address":"se.example.net","port":443}]},
                 "streamSettings":{"network":"hysteria","security":"tls"}}]}]"#,
        );
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].protocol, "hysteria2");
        assert_eq!(servers[0].transport_parts(), vec!["hysteria2", "tls"]);
        assert_eq!(servers[0].description.as_deref(), Some("1 Гбит"));
    }

    /// Незнакомый протокол должен называть себя своим именем, а не молча
    /// притворяться заготовкой.
    #[test]
    fn unknown_protocol_keeps_its_name() {
        let servers = parse(
            r#"[{"remarks":"X","outbounds":[
                {"protocol":"freedom","tag":"direct"},
                {"protocol":"chtoto-novoe","settings":{"address":"x.example.net","port":99}}]}]"#,
        );
        assert_eq!(servers[0].protocol, "chtoto-novoe");
        assert!(servers[0].transport_parts().contains(&"chtoto-novoe".to_string()));
    }

    #[test]
    fn description_is_absent_when_panel_did_not_set_it() {
        let servers = parse(SUBSCRIPTION);
        assert!(servers[0].description.is_none());
    }

    #[test]
    fn keeps_whole_config_untouched() {
        let servers = parse(SUBSCRIPTION);
        let value: serde_json::Value = serde_json::from_str(&servers[0].raw_config).unwrap();
        // роутинг и служебные аутбаунды панели должны дойти до ядра целиком
        assert_eq!(value["outbounds"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn unwraps_base64_subscription() {
        let encoded = to_base64(SUBSCRIPTION.as_bytes());
        assert_eq!(parse(&encoded).len(), 2);
    }

    #[test]
    fn unknown_format_gives_nothing() {
        assert!(parse("совершенно не подписка").is_empty());
    }

    fn to_base64(data: &[u8]) -> String {
        const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in data.chunks(3) {
            let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(TABLE[((n >> (18 - i * 6)) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }
}
