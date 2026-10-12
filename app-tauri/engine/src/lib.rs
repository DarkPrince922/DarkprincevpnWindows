//! Движок клиента DarkPrince VPN.
//!
//! Здесь всё, что делает приложение приложением: разбор подписки, подготовка
//! конфига ядра, запуск ядра и моста, системный прокси и туннель. Интерфейс
//! сюда не заглядывает — он вызывает `Vpn` и читает состояние.
//!
//! Движок не зависит ни от Tauri, ни от Windows-крейтов там, где без них
//! можно обойтись: с системой он общается её же программами (route, netsh,
//! reg, powershell). Благодаря этому его проверяет компилятор на любой
//! машине, а не только сборка под Windows.

pub mod config;
pub mod proxy;
pub mod subscription;
pub mod sys;
pub mod tun;

use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::Duration;

use serde::Serialize;
pub use subscription::Server;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Системный прокси: без прав администратора, но не для всех программ.
    Proxy,
    /// Виртуальный адаптер: весь трафик системы, нужны права администратора.
    Tun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Disconnected,
    Connecting,
    Connected,
}

pub struct Vpn {
    core_dir: PathBuf,
    data_dir: PathBuf,
    xray: Option<Child>,
    tunnel: tun::Tunnel,
    state: State,
    mode: Mode,
    /// Порты выбираются при каждом подключении: желаемые могут быть заняты
    /// другим VPN-клиентом. Помним выбранные, чтобы правильно погасить
    /// системный прокси при отключении.
    socks_port: u16,
    http_port: u16,
}

impl Vpn {
    pub fn new(core_dir: PathBuf, data_dir: PathBuf) -> Self {
        Self {
            core_dir,
            data_dir,
            xray: None,
            tunnel: tun::Tunnel::new(),
            state: State::Disconnected,
            mode: Mode::Proxy,
            socks_port: config::SOCKS_PORT,
            http_port: config::HTTP_PORT,
        }
    }

    pub fn state(&self) -> State {
        self.state
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    /// Пока поднят туннель, вести маршруты до сервера за сменой сети.
    /// Шлюзы узнаются заранее, без замка: см. [`tun::current_gateways`].
    pub fn follow_gateways(&mut self, gateway: Option<String>, gateway6: Option<tun::Gateway6>) {
        if self.state == State::Connected && self.mode == Mode::Tun {
            self.tunnel.follow_gateways(gateway, gateway6);
        }
    }

    /// Поднят ли туннель — чтобы фоновая проверка сети не ходила зря.
    pub fn tunnel_up(&self) -> bool {
        self.state == State::Connected && self.mode == Mode::Tun && self.tunnel.is_up()
    }

    /// Порт HTTP-входа ядра, если подключены. Через него идёт проверка связи.
    pub fn http_port(&self) -> Option<u16> {
        (self.state == State::Connected).then_some(self.http_port)
    }

    /// Поднимает соединение. Всё внутри блокирующее: запуск процессов,
    /// разрешение имён, вызовы route и netsh — вызывать только с фонового
    /// потока, иначе окно перестанет перерисовываться.
    pub fn connect(&mut self, server: &Server, mode: Mode) -> Result<(), String> {
        self.disconnect();
        self.state = State::Connecting;
        self.mode = mode;

        if mode == Mode::Tun && !tun::is_elevated() {
            self.state = State::Disconnected;
            return Err("режим «весь трафик» требует запуска от имени администратора".into());
        }

        // Порты выбираем заново на каждое подключение: привычные могли
        // занять другим VPN-клиентом, пока мы стояли. Чужой процесс за это
        // снимать нельзя — просто уходим на свободный порт.
        self.socks_port = sys::pick_port(config::SOCKS_PORT);
        self.http_port = loop {
            let port = sys::pick_port(config::HTTP_PORT);
            if port != self.socks_port {
                break port;
            }
        };
        if (self.socks_port, self.http_port) != (config::SOCKS_PORT, config::HTTP_PORT) {
            sys::log(&format!(
                "привычные порты заняты, берём свои: socks {}, http {}",
                self.socks_port, self.http_port
            ));
        }

        sys::log(&format!(
            "подключение: сервер «{}», режим {}",
            server.name,
            if mode == Mode::Tun { "весь трафик" } else { "прокси" }
        ));
        let result = self.bring_up(server, mode);
        if let Err(error) = &result {
            sys::log(&format!("отказ: {error}"));
        }
        match result {
            Ok(()) => {
                self.state = State::Connected;
                Ok(())
            }
            Err(error) => {
                self.disconnect();
                Err(error)
            }
        }
    }

    fn bring_up(&mut self, server: &Server, mode: Mode) -> Result<(), String> {
        self.start_xray(server)?;
        match mode {
            Mode::Proxy => proxy::enable(self.http_port)?,
            Mode::Tun => {
                let bridge = self.core_dir.join("tun2socks.exe");
                self.tunnel.start(
                    &bridge,
                    &[server.address.clone()],
                    self.socks_port,
                    &self.data_dir,
                )?;
            }
        }
        Ok(())
    }

    fn start_xray(&mut self, server: &Server) -> Result<(), String> {
        let core = self.core_dir.join("xray.exe");
        sys::log(&format!("ядро: {}", core.display()));
        if !core.exists() {
            return Err(format!(
                "не найдено ядро Xray: {}. Переустановите приложение.",
                core.display()
            ));
        }

        std::fs::create_dir_all(&self.data_dir).ok();
        let config_path = self.data_dir.join("xray-config.json");
        std::fs::write(
            &config_path,
            config::build(&server.raw_config, self.socks_port, self.http_port)?,
        )
            .map_err(|error| format!("не удалось сохранить конфиг ядра: {error}"))?;
        sys::log(&format!("конфиг: {}", config_path.display()));

        // вывод ядра — в файл: свои отказы оно объясняет только там
        let log_path = self.data_dir.join("xray.log");
        let child = sys::command(&core.to_string_lossy())
            .args(["run", "-c", &config_path.to_string_lossy()])
            .current_dir(&self.core_dir)
            .env("XRAY_LOCATION_ASSET", &self.core_dir)
            .stdout(sys::log_file(&log_path))
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("не удалось запустить ядро: {error}"))?;
        self.xray = Some(child);

        // Мало запустить — надо дождаться, пока ядро начнёт принимать
        // соединения. Без этой проверки сломанный конфиг выглядел бы как
        // успешное подключение, у которого просто «не работает интернет».
        if !sys::wait_for_port(self.socks_port, Duration::from_secs(6)) {
            let tail = tail_of(&log_path);
            sys::log(&format!("ядро не открыло порт. Хвост журнала:\n{tail}"));
            return Err(format!(
                "ядро не приняло конфиг сервера и не открыло порт.\n{tail}"
            ));
        }
        sys::log("ядро слушает порт");
        Ok(())
    }

    pub fn disconnect(&mut self) {
        // системный прокси гасим только свой: пользователь мог настроить
        // собственный, и затирать его чужими руками нельзя
        if proxy::is_ours(self.http_port) {
            proxy::disable();
        }
        self.tunnel.stop();
        if let Some(mut child) = self.xray.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.state = State::Disconnected;
    }

    /// Уборка следов прошлого запуска, оборванного жёстко.
    pub fn clear_stale_state(core_dir: &Path) {
        sys::kill_our(&core_dir.join("xray.exe"));
        tun::clear_stale_state(core_dir);
    }
}

impl Drop for Vpn {
    fn drop(&mut self) {
        self.disconnect();
    }
}

/// Узел ходит поверх UDP (QUIC и подобное). До такого узла TCP-соединение не
/// установить, и обычный замер показывал бы «не отвечает» у рабочего сервера.
pub fn over_udp(server: &Server) -> bool {
    let protocol = server.protocol.to_ascii_lowercase();
    let network = server.network.to_ascii_lowercase();
    matches!(protocol.as_str(), "hysteria" | "hysteria2" | "tuic" | "wireguard")
        || matches!(network.as_str(), "kcp" | "mkcp" | "quic" | "hysteria")
}

/// Задержка до узла через само ядро, в миллисекундах; -1 — не ответил.
///
/// Для узлов поверх UDP: поднимаем отдельное ядро с конфигом узла на
/// свободных портах и делаем два запроса. Первый устанавливает соединение
/// (QUIC, авторизация), второй идёт по готовому — его время и показываем:
/// оно сравнимо с замером остальных узлов, где время — одно соединение TCP.
/// Блокирующая, до пары секунд — только с фонового потока.
pub fn real_delay(core_dir: &Path, work_dir: &Path, server: &Server) -> i64 {
    let core = core_dir.join("xray.exe");
    if !core.exists() {
        return -1;
    }
    let socks = sys::free_port();
    let http = (0..5).map(|_| sys::free_port()).find(|port| *port != socks).unwrap_or(0);
    let Ok(built) = config::build(&server.raw_config, socks, http) else {
        return -1;
    };
    std::fs::create_dir_all(work_dir).ok();
    let config_path = work_dir.join(format!("ping-{http}.json"));
    if std::fs::write(&config_path, built).is_err() {
        return -1;
    }
    let child = sys::command(&core.to_string_lossy())
        .args(["run", "-c", &config_path.to_string_lossy()])
        .current_dir(core_dir)
        .env("XRAY_LOCATION_ASSET", core_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let result = match child {
        Ok(mut child) => {
            let delay = if sys::wait_for_port(http, Duration::from_secs(4)) {
                match timed_probe(http) {
                    Some(first) => timed_probe(http).unwrap_or(first) as i64,
                    None => -1,
                }
            } else {
                -1
            };
            let _ = child.kill();
            let _ = child.wait();
            delay
        }
        Err(_) => -1,
    };
    std::fs::remove_file(&config_path).ok();
    result
}

/// Время удачного запроса через HTTP-вход ядра.
fn timed_probe(port: u16) -> Option<u128> {
    PROBE_TARGETS.iter().find_map(|(host, path)| {
        let start = std::time::Instant::now();
        request_via_http_proxy(port, host, path, Duration::from_secs(4))
            .then(|| start.elapsed().as_millis())
    })
}

/// Адреса для проверки связи. Два разных: правила маршрутизации из подписки
/// могут пустить один из них мимо прокси или заблокировать, и тогда «нет
/// связи» было бы ложным. Обычный HTTP: ответ 204 без тела, шифровать нечего.
const PROBE_TARGETS: [(&str, &str); 2] = [
    ("cp.cloudflare.com", "/generate_204"),
    ("www.gstatic.com", "/generate_204"),
];

/// Ходит ли через ядро трафик на самом деле.
///
/// Подключение ещё не значит, что интернет пошёл: ядро запускается и с
/// мёртвым сервером, и «Подключено» горело бы при полном отсутствии связи.
/// Запрос идёт в HTTP-вход ядра, то есть тем же путём, что и трафик
/// программ, до того же сервера.
///
/// Блокирующая и может занять до двенадцати секунд — только с фонового
/// потока и без захваченного замка движка.
pub fn probe(http_port: u16) -> bool {
    PROBE_TARGETS
        .iter()
        .any(|(host, path)| probe_via_http_proxy(http_port, host, path))
}

fn probe_via_http_proxy(port: u16, host: &str, path: &str) -> bool {
    request_via_http_proxy(port, host, path, Duration::from_secs(6))
}

fn request_via_http_proxy(port: u16, host: &str, path: &str, read_timeout: Duration) -> bool {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};

    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_secs(2)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(read_timeout));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let request =
        format!("GET http://{host}{path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 64];
    let Ok(read) = stream.read(&mut head) else {
        return false;
    };
    // «HTTP/1.1 204 No Content»
    String::from_utf8_lossy(&head[..read])
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .is_some_and(|code| (200..400).contains(&code))
}

#[cfg(test)]
mod probe_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn answer_once(reply: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 512];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        port
    }

    #[test]
    fn answer_204_means_traffic_flows() {
        let port = answer_once("HTTP/1.1 204 No Content\r\n\r\n");
        assert!(probe_via_http_proxy(port, "cp.cloudflare.com", "/generate_204"));
    }

    #[test]
    fn proxy_error_means_no_traffic() {
        let port = answer_once("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        assert!(!probe_via_http_proxy(port, "cp.cloudflare.com", "/generate_204"));
    }

    #[test]
    fn nobody_listening_means_no_traffic() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(!probe_via_http_proxy(port, "cp.cloudflare.com", "/generate_204"));
    }
}

fn tail_of(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
    lines
        .iter()
        .rev()
        .take(4)
        .rev()
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
}
