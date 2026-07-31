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
            Mode::Proxy => proxy::enable(config::HTTP_PORT)?,
            Mode::Tun => {
                let bridge = self.core_dir.join("tun2socks.exe");
                self.tunnel.start(
                    &bridge,
                    &[server.address.clone()],
                    config::SOCKS_PORT,
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
