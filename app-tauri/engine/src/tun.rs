//! Режим TUN: виртуальный адаптер забирает весь трафик системы.
//!
//! Главная тонкость — не зациклить трафик. Ядро ходит к серверу через
//! обычную сеть, и если весь трафик уйдёт в туннель, оно начнёт слать пакеты
//! в собственный туннель. Поэтому до адресов серверов прокладываются
//! отдельные маршруты через физический шлюз, и делать это надо ДО поднятия
//! туннеля, пока DNS ещё отвечает напрямую.

use std::net::ToSocketAddrs;
use std::path::Path;
use std::process::{Child, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::sys;

pub const ADAPTER: &str = "DarkPrinceTun";
const ADDRESS: &str = "198.18.0.1";
const MASK: &str = "255.255.255.0";

pub struct Tunnel {
    process: Option<Child>,
    server_routes: Vec<String>,
    default_routes: bool,
}

impl Tunnel {
    pub fn new() -> Self {
        Self { process: None, server_routes: Vec::new(), default_routes: false }
    }

    pub fn start(&mut self, bridge: &Path, servers: &[String], socks_port: u16) -> Result<(), String> {
        if !bridge.exists() {
            return Err(format!(
                "не найден мост tun2socks: {}. Переустановите приложение.",
                bridge.display()
            ));
        }

        // Прошлый запуск мог быть снят жёстко — уберём его следы, иначе
        // трафик пойдёт в туннель, которого больше нет.
        clear_stale_state();

        let gateway = default_gateway()
            .ok_or("не удалось определить основной шлюз — проверьте подключение к сети")?;

        // 1. Маршруты до серверов мимо туннеля, пока DNS ещё прямой
        for ip in resolve(servers) {
            let route = format!("add {ip} mask 255.255.255.255 {gateway} metric 1");
            let args: Vec<&str> = route.split(' ').collect();
            if sys::run("route", &args) {
                self.server_routes.push(ip);
            }
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
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("не удалось запустить мост: {error}"))?;
        self.process = Some(child);

        // 3. Адаптер появляется не мгновенно
        let index = match self.wait_for_adapter(Duration::from_secs(12)) {
            Some(index) => index,
            None => {
                self.stop();
                return Err("виртуальный адаптер не появился. Проверьте, что рядом с \
приложением лежит wintun.dll."
                    .into());
            }
        };

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
        Ok(())
    }

    pub fn stop(&mut self) {
        if self.default_routes {
            sys::run("route", &["delete", "0.0.0.0", "mask", "128.0.0.0", ADDRESS]);
            sys::run("route", &["delete", "128.0.0.0", "mask", "128.0.0.0", ADDRESS]);
            self.default_routes = false;
        }
        for ip in std::mem::take(&mut self.server_routes) {
            sys::run("route", &["delete", &ip, "mask", "255.255.255.255"]);
        }
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

fn adapter_index() -> Option<u32> {
    sys::powershell(&format!(
        "(Get-NetAdapter -Name '{ADAPTER}' -ErrorAction SilentlyContinue).ifIndex"
    ))
    .and_then(|text| text.lines().next()?.trim().parse().ok())
}

/// Следы предыдущего запуска, оборванного не по-хорошему.
pub fn clear_stale_state() {
    sys::run("route", &["delete", "0.0.0.0", "mask", "128.0.0.0", ADDRESS]);
    sys::run("route", &["delete", "128.0.0.0", "mask", "128.0.0.0", ADDRESS]);
    sys::run("taskkill", &["/F", "/IM", "tun2socks.exe"]);
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

/// Адреса серверов, приведённые к IPv4. В конфиге с балансировщиком
/// серверов несколько — маршрут нужен до каждого.
fn resolve(servers: &[String]) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for address in servers {
        if let Ok(addresses) = (address.as_str(), 443u16).to_socket_addrs() {
            for socket in addresses {
                if socket.is_ipv4() {
                    let ip = socket.ip().to_string();
                    if !result.contains(&ip) {
                        result.push(ip);
                    }
                }
            }
        }
    }
    result
}
