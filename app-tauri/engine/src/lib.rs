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
use std::thread::sleep;
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

        let result = self.bring_up(server, mode);
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
                self.tunnel
                    .start(&bridge, &[server.address.clone()], config::SOCKS_PORT)?;
            }
        }
        Ok(())
    }

    fn start_xray(&mut self, server: &Server) -> Result<(), String> {
        let core = self.core_dir.join("xray.exe");
        if !core.exists() {
            return Err(format!(
                "не найдено ядро Xray: {}. Переустановите приложение.",
                core.display()
            ));
        }

        std::fs::create_dir_all(&self.data_dir).ok();
        let config_path = self.data_dir.join("xray-config.json");
        std::fs::write(&config_path, config::build(&server.raw_config)?)
            .map_err(|error| format!("не удалось сохранить конфиг ядра: {error}"))?;

        let mut child = sys::command(&core.to_string_lossy())
            .args(["run", "-c", &config_path.to_string_lossy()])
            .current_dir(&self.core_dir)
            .env("XRAY_LOCATION_ASSET", &self.core_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("не удалось запустить ядро: {error}"))?;

        // ядро падает сразу, если конфиг не принят, — даём ему мгновение
        sleep(Duration::from_millis(700));
        if matches!(child.try_wait(), Ok(Some(_))) {
            return Err("ядро завершилось сразу после запуска — конфиг сервера не принят".into());
        }
        self.xray = Some(child);
        Ok(())
    }

    pub fn disconnect(&mut self) {
        // системный прокси гасим только свой: пользователь мог настроить
        // собственный, и затирать его чужими руками нельзя
        if proxy::is_ours(config::HTTP_PORT) {
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
        let _ = core_dir;
        sys::run("taskkill", &["/F", "/IM", "xray.exe"]);
        tun::clear_stale_state();
    }
}

impl Drop for Vpn {
    fn drop(&mut self) {
        self.disconnect();
    }
}
