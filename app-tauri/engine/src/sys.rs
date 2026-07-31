//! Запуск системных программ без мелькающих чёрных окон.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::{Mutex, OnceLock};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Готовит команду так, чтобы она не показывала консольное окно.
pub fn command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.stdin(Stdio::null());
    command
}

/// Выполняет команду и ждёт её завершения. `true` — код возврата нулевой.
pub fn run(program: &str, args: &[&str]) -> bool {
    match output(program, args) {
        Some(result) => result.status.success(),
        None => false,
    }
}

pub fn output(program: &str, args: &[&str]) -> Option<Output> {
    command(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()
}

/// Однострочный ответ PowerShell. Системные сведения берём через него, а не
/// разбором вывода route и netsh: те переводятся на язык системы, и на
/// русской Windows разбор ломается.
pub fn powershell(script: &str) -> Option<String> {
    let result = output(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", script],
    )?;
    if !result.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&result.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Куда писать журнал. Задаётся один раз при запуске приложения.
static LOG_PATH: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

pub fn set_log_path(path: PathBuf) {
    let cell = LOG_PATH.get_or_init(|| Mutex::new(None));
    *cell.lock().unwrap() = Some(path);
}

/// Запись в журнал. Без него причина отказа видна только на машине
/// пользователя и только на словах — а слов обычно не хватает.
pub fn log(message: &str) {
    let cell = match LOG_PATH.get() {
        Some(cell) => cell,
        None => return,
    };
    let path = match cell.lock().unwrap().clone() {
        Some(path) => path,
        None => return,
    };
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{message}");
    }
}

/// Файл для вывода запускаемой программы. Ядро и мост объясняют свои
/// отказы только в вывод, и без него отказ выглядит как молчание.
pub fn log_file(path: &std::path::Path) -> Stdio {
    match std::fs::File::create(path) {
        Ok(file) => Stdio::from(file),
        Err(_) => Stdio::null(),
    }
}

/// Ждёт, пока по адресу начнут принимать соединения.
pub fn wait_for_port(port: u16, timeout: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    false
}

/// Свободный порт: сначала пробуем желаемый, иначе просим систему выдать
/// любой. Занять наш порт мог другой VPN-клиент — это не повод ни падать,
/// ни убивать чужой процесс.
pub fn pick_port(preferred: u16) -> u16 {
    if std::net::TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .unwrap_or(preferred)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn free_port_is_taken_as_is() {
        let port = TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port(); // слушателя тут же роняем — порт снова свободен
        assert_eq!(pick_port(port), port);
    }

    #[test]
    fn busy_port_sends_us_elsewhere() {
        let squatter = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let busy = squatter.local_addr().unwrap().port();
        let picked = pick_port(busy);
        assert_ne!(picked, busy, "занятый порт брать нельзя");
        assert!(TcpListener::bind(("127.0.0.1", picked)).is_ok(), "выданный порт занят");
    }
}

/// Снимает только свои забытые процессы — по полному пути к файлу.
/// Снимать по имени нельзя: `xray.exe` есть у половины VPN-клиентов, и
/// чужой процесс — не наша собственность.
pub fn kill_our(path: &std::path::Path) {
    let name = match path.file_stem().and_then(|stem| stem.to_str()) {
        Some(name) => name,
        None => return,
    };
    let full = path.to_string_lossy().replace('\'', "''");
    powershell(&format!(
        "Get-Process '{name}' -ErrorAction SilentlyContinue | \
         Where-Object {{ $_.Path -eq '{full}' }} | Stop-Process -Force"
    ));
}
