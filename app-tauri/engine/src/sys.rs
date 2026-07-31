//! Запуск системных программ без мелькающих чёрных окон.

use std::process::{Command, Output, Stdio};

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
