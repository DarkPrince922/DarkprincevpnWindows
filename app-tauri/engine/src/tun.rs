//! Режим TUN: виртуальный адаптер забирает весь трафик системы.
//!
//! Главная тонкость — не зациклить трафик. Ядро ходит к серверу через
//! обычную сеть, и если весь трафик уйдёт в туннель, оно начнёт слать пакеты
//! в собственный туннель. Поэтому до адресов серверов прокладываются
//! отдельные маршруты через физический шлюз, и делать это надо ДО поднятия
//! туннеля, пока DNS ещё отвечает напрямую.
//!
//! Маршрут до сервера привязан к шлюзу текущей сети. Сменилась сеть —
//! другой Wi-Fi, кабель — и он ведёт в никуда: трафик ядра уходит в
//! собственный туннель, интернет пропадает. Поэтому, пока туннель поднят,
//! шлюз сверяется раз в несколько секунд и маршруты переносятся на новый
//! (см. [`Tunnel::follow_gateways`]). Права на это есть: режим работает
//! только от администратора.
//!
//! IPv6 уводится в туннель так же, если он в системе есть. Без этого сайты
//! с IPv6 открывались мимо VPN, с настоящим адресом.

use std::net::ToSocketAddrs;
use std::path::Path;
use std::process::{Child, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::sys;

pub const ADAPTER: &str = "DarkPrinceTun";
const ADDRESS: &str = "198.18.0.1";
const MASK: &str = "255.255.255.0";
/// Адрес туннеля в IPv6 — из частного диапазона, наружу не виден. Windows
/// берёт адрес отправителя с того интерфейса, куда уходит пакет, и без
/// своего адреса у туннеля IPv6-трафику не с чего было бы уходить.
const ADDRESS6: &str = "fd66:6470:7276::1/64";
/// Две половинки IPv6 вместо маршрута по умолчанию — как и в IPv4.
const HALVES6: [&str; 2] = ["::/1", "8000::/1"];

/// Шлюз IPv6: адрес и номер интерфейса. У IPv6 шлюз почти всегда
/// link-local (fe80::…), и без интерфейса такой адрес ничего не значит.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gateway6 {
    pub next_hop: String,
    pub if_index: u32,
}

pub struct Tunnel {
    process: Option<Child>,
    /// Адреса серверов и шлюз, через который до них проложены маршруты.
    servers: Vec<String>,
    servers6: Vec<String>,
    server_routes: Vec<String>,
    server_routes6: Vec<String>,
    gateway: Option<String>,
    gateway6: Option<Gateway6>,
    default_routes: bool,
    tun_index: Option<u32>,
}

impl Tunnel {
    pub fn new() -> Self {
        Self {
            process: None,
            servers: Vec::new(),
            servers6: Vec::new(),
            server_routes: Vec::new(),
            server_routes6: Vec::new(),
            gateway: None,
            gateway6: None,
            default_routes: false,
            tun_index: None,
        }
    }

    pub fn is_up(&self) -> bool {
        self.default_routes
    }

    fn add_server_routes(&mut self, gateway: &str) {
        for ip in &self.servers {
            let route = format!("add {ip} mask 255.255.255.255 {gateway} metric 1");
            let args: Vec<&str> = route.split(' ').collect();
            if sys::run("route", &args) {
                self.server_routes.push(ip.clone());
            }
        }
        self.gateway = Some(gateway.to_string());
    }

    fn drop_server_routes(&mut self) {
        for ip in std::mem::take(&mut self.server_routes) {
            sys::run("route", &["delete", &ip, "mask", "255.255.255.255"]);
        }
    }

    fn add_server_routes6(&mut self, gateway: &Gateway6) {
        for ip in &self.servers6 {
            if netsh(&route6_args("add", &format!("{ip}/128"), gateway.if_index,
                                              Some(&gateway.next_hop))) {
                self.server_routes6.push(ip.clone());
            }
        }
        self.gateway6 = Some(gateway.clone());
    }

    fn drop_server_routes6(&mut self) {
        let Some(gateway) = self.gateway6.clone() else { return };
        for ip in std::mem::take(&mut self.server_routes6) {
            netsh(&route6_args("delete", &format!("{ip}/128"), gateway.if_index,
                                           Some(&gateway.next_hop)));
        }
    }

    /// Сеть сменилась — переносим маршруты до серверов на новый шлюз.
    ///
    /// Шлюзы узнаются заранее, без замка движка ([`current_gateways`]):
    /// PowerShell отвечает долго, и держать всё это время замок значило бы
    /// подвешивать окно. Здесь только сравнение и, если надо, перестройка.
    pub fn follow_gateways(&mut self, gateway: Option<String>, gateway6: Option<Gateway6>) {
        if !self.default_routes {
            return;
        }
        // Шлюза нет вовсе — сеть пропала. Старые маршруты не трогаем: если
        // вернётся та же сеть, они снова заработают сами.
        if let Some(gateway) = gateway {
            if self.gateway.as_deref() != Some(gateway.as_str()) {
                sys::log(&format!("сеть сменилась: шлюз {gateway}, переношу маршруты до сервера"));
                self.drop_server_routes();
                self.add_server_routes(&gateway);
            }
        }
        if let Some(gateway6) = gateway6 {
            if self.gateway6.as_ref() != Some(&gateway6) && !self.servers6.is_empty() {
                sys::log(&format!("сменился шлюз IPv6: {}", gateway6.next_hop));
                self.drop_server_routes6();
                self.add_server_routes6(&gateway6);
            }
        }
    }

    pub fn start(
        &mut self,
        bridge: &Path,
        servers: &[String],
        socks_port: u16,
        log_dir: &Path,
    ) -> Result<(), String> {
        if !bridge.exists() {
            return Err(format!(
                "не найден мост tun2socks: {}. Переустановите приложение.",
                bridge.display()
            ));
        }

        // Прошлый запуск мог быть снят жёстко — уберём его следы, иначе
        // трафик пойдёт в туннель, которого больше нет.
        clear_stale_state(bridge.parent().unwrap_or(Path::new(".")));

        let gateway = default_gateway()
            .ok_or("не удалось определить основной шлюз — проверьте подключение к сети")?;
        sys::log(&format!("шлюз: {gateway}"));

        // 1. Маршруты до серверов мимо туннеля, пока DNS ещё прямой
        let (v4, v6) = resolve(servers);
        self.servers = v4;
        self.servers6 = v6;
        self.add_server_routes(&gateway);
        sys::log(&format!("маршруты до серверов: {:?}", self.server_routes));
        let gateway6 = default_gateway6();
        if let Some(gateway6) = &gateway6 {
            self.add_server_routes6(gateway6);
            sys::log(&format!("IPv6 есть, маршруты до серверов: {:?}", self.server_routes6));
        }
        if self.server_routes.is_empty() {
            return Err("не удалось проложить маршрут до сервера. Без него весь трафик, \
включая трафик самого ядра, ушёл бы в туннель и соединение зациклилось бы."
                .into());
        }

        // 2. Мост TUN → SOCKS. Флаги строго с двумя дефисами: мост разбирает
        //    их pflag, и «-loglevel» он читает как набор коротких флагов.
        let child = sys::command(&bridge.to_string_lossy())
            .args([
                "--device",
                &format!("tun://{ADAPTER}"),
                "--proxy",
                &format!("socks5://127.0.0.1:{socks_port}"),
                "--loglevel",
                "warning",
            ])
            .current_dir(bridge.parent().unwrap_or(Path::new(".")))
            .stdout(Stdio::null())
            .stderr(sys::log_file(&log_dir.join("tun2socks.log")))
            .spawn()
            .map_err(|error| format!("не удалось запустить мост: {error}"))?;
        self.process = Some(child);

        // 3. Адаптер появляется не мгновенно
        let index = match self.wait_for_adapter(Duration::from_secs(12)) {
            Some(index) => index,
            None => {
                let tail = std::fs::read_to_string(log_dir.join("tun2socks.log"))
                    .unwrap_or_default();
                let tail: String = tail.lines().rev().take(3).collect::<Vec<_>>().join(" ");
                self.stop();
                return Err(format!(
                    "виртуальный адаптер не появился. Проверьте, что рядом с приложением \
лежит wintun.dll. {tail}"
                ));
            }
        };

        sys::log(&format!("адаптер поднят, индекс {index}"));
        sys::run("netsh", &["interface", "ip", "set", "address",
                            &format!("name={ADAPTER}"), "static", ADDRESS, MASK]);
        sys::run("netsh", &["interface", "ip", "set", "dns",
                            &format!("name={ADAPTER}"), "static", "1.1.1.1"]);
        sys::run("netsh", &["interface", "ip", "add", "dns",
                            &format!("name={ADAPTER}"), "8.8.8.8", "index=2"]);

        // 4. Две половинки вместо маршрута по умолчанию: исходный маршрут
        //    остаётся на месте, восстанавливать его потом не нужно.
        let index = index.to_string();
        self.default_routes = sys::run("route", &["add", "0.0.0.0", "mask", "128.0.0.0",
                                                  ADDRESS, "metric", "1", "if", &index])
            && sys::run("route", &["add", "128.0.0.0", "mask", "128.0.0.0",
                                   ADDRESS, "metric", "1", "if", &index]);
        if !self.default_routes {
            self.stop();
            return Err("не удалось направить трафик в туннель — маршруты не добавились".into());
        }
        self.tun_index = index.parse().ok();

        // 5. IPv6 — тоже в туннель, если он в системе есть. Отказ здесь не
        //    ломает подключение: IPv4 уже работает, а утечку по IPv6 мы хотя
        //    бы попытались закрыть и записали, если не вышло.
        if gateway6.is_some() {
            let index: u32 = self.tun_index.unwrap_or_default();
            sys::run("netsh", &["interface", "ipv6", "add", "address",
                                &format!("interface={index}"), &format!("address={ADDRESS6}"),
                                "store=active"]);
            let routed = HALVES6.iter().all(|prefix| {
                netsh(&route6_args("add", prefix, index, None))
            });
            if !routed {
                sys::log("IPv6 в туннель направить не удалось — IPv6 может идти мимо VPN");
            }
        }
        Ok(())
    }

    pub fn stop(&mut self) {
        if self.default_routes {
            sys::run("route", &["delete", "0.0.0.0", "mask", "128.0.0.0", ADDRESS]);
            sys::run("route", &["delete", "128.0.0.0", "mask", "128.0.0.0", ADDRESS]);
            self.default_routes = false;
        }
        if let Some(index) = self.tun_index.take() {
            for prefix in HALVES6 {
                netsh(&route6_args("delete", prefix, index, None));
            }
        }
        self.drop_server_routes();
        self.drop_server_routes6();
        self.gateway = None;
        self.gateway6 = None;
        self.servers.clear();
        self.servers6.clear();
        if let Some(mut child) = self.process.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn wait_for_adapter(&mut self, timeout: Duration) -> Option<u32> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            // мост мог упасть на старте — ждать тогда нечего
            if let Some(child) = self.process.as_mut() {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return None;
                }
            }
            if let Some(index) = adapter_index() {
                return Some(index);
            }
            sleep(Duration::from_millis(300));
        }
        None
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Шлюз, через который система выходит в сеть.
pub fn default_gateway() -> Option<String> {
    sys::powershell(
        "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | \
         Where-Object { $_.NextHop -ne '0.0.0.0' } | \
         Sort-Object RouteMetric | Select-Object -First 1).NextHop",
    )
}

/// Шлюз IPv6 по умолчанию; нет его — нет и IPv6 наружу, уводить нечего.
pub fn default_gateway6() -> Option<Gateway6> {
    let text = sys::powershell(
        "$r = Get-NetRoute -AddressFamily IPv6 -DestinationPrefix '::/0' -ErrorAction SilentlyContinue | \
         Where-Object { $_.NextHop -ne '::' } | Sort-Object RouteMetric | Select-Object -First 1; \
         if ($r) { \"$($r.NextHop) $($r.ifIndex)\" }",
    )?;
    parse_gateway6(&text)
}

fn parse_gateway6(text: &str) -> Option<Gateway6> {
    let mut parts = text.split_whitespace();
    let next_hop = parts.next()?.to_string();
    let if_index = parts.next()?.parse().ok()?;
    Some(Gateway6 { next_hop, if_index })
}

/// Шлюзы обоих протоколов — с фонового потока, без замка движка.
pub fn current_gateways() -> (Option<String>, Option<Gateway6>) {
    (default_gateway(), default_gateway6())
}

/// Аргументы `netsh interface ipv6 add|delete route`. Только в активное
/// хранилище: после перезагрузки маршрутов остаться не должно.
fn route6_args(action: &str, prefix: &str, index: u32, next_hop: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "interface".to_string(),
        "ipv6".to_string(),
        action.to_string(),
        "route".to_string(),
        format!("prefix={prefix}"),
        format!("interface={index}"),
    ];
    if let Some(next_hop) = next_hop {
        args.push(format!("nexthop={next_hop}"));
    }
    if action == "add" {
        args.push("metric=1".to_string());
        args.push("store=active".to_string());
    }
    args
}

fn netsh(args: &[String]) -> bool {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    sys::run("netsh", &args)
}

fn adapter_index() -> Option<u32> {
    sys::powershell(&format!(
        "(Get-NetAdapter -Name '{ADAPTER}' -ErrorAction SilentlyContinue).ifIndex"
    ))
    .and_then(|text| text.lines().next()?.trim().parse().ok())
}

/// Следы предыдущего запуска, оборванного не по-хорошему.
pub fn clear_stale_state(core_dir: &Path) {
    sys::run("route", &["delete", "0.0.0.0", "mask", "128.0.0.0", ADDRESS]);
    sys::run("route", &["delete", "128.0.0.0", "mask", "128.0.0.0", ADDRESS]);
    sys::kill_our(&core_dir.join("tun2socks.exe"));
}

/// Запущено ли приложение с правами администратора.
pub fn is_elevated() -> bool {
    sys::powershell(
        "([Security.Principal.WindowsPrincipal] \
         [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(\
         [Security.Principal.WindowsBuiltinRole]::Administrator)",
    )
    .map(|text| text.trim().eq_ignore_ascii_case("true"))
    .unwrap_or(false)
}

/// Адреса серверов: отдельно IPv4 и IPv6. В конфиге с балансировщиком
/// серверов несколько — маршрут нужен до каждого. IPv6 тоже: ядро вправе
/// пойти к серверу по нему, и без маршрута такой путь ушёл бы в туннель.
fn resolve(servers: &[String]) -> (Vec<String>, Vec<String>) {
    let mut v4: Vec<String> = Vec::new();
    let mut v6: Vec<String> = Vec::new();
    for address in servers {
        if let Ok(addresses) = (address.as_str(), 443u16).to_socket_addrs() {
            for socket in addresses {
                let ip = socket.ip().to_string();
                let list = if socket.is_ipv4() { &mut v4 } else { &mut v6 };
                if !list.contains(&ip) {
                    list.push(ip);
                }
            }
        }
    }
    (v4, v6)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipv6_gateway_is_read_with_its_interface() {
        assert_eq!(
            parse_gateway6("fe80::1 12"),
            Some(Gateway6 { next_hop: "fe80::1".into(), if_index: 12 })
        );
        assert_eq!(parse_gateway6("fe80::1"), None, "без интерфейса link-local шлюз бесполезен");
    }

    #[test]
    fn ipv6_routes_stay_until_reboot_only() {
        let args = route6_args("add", "::/1", 7, None);
        assert!(args.contains(&"prefix=::/1".to_string()));
        assert!(args.contains(&"interface=7".to_string()));
        assert!(args.contains(&"store=active".to_string()), "маршрут не должен пережить перезагрузку");
        let delete = route6_args("delete", "2001:db8::7/128", 3, Some("fe80::1"));
        assert!(delete.contains(&"nexthop=fe80::1".to_string()));
        assert!(!delete.contains(&"store=active".to_string()));
    }

    #[test]
    fn nothing_to_follow_while_the_tunnel_is_down() {
        let mut tunnel = Tunnel::new();
        tunnel.follow_gateways(Some("192.168.1.1".into()), None);
        assert_eq!(tunnel.gateway, None, "без поднятого туннеля маршруты трогать нельзя");
    }
}
