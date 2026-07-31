//! Режим системного прокси: правка настроек интернета Windows.
//!
//! Пишем в ветку текущего пользователя — прав администратора не нужно.
//! После правки система оповещается, иначе уже запущенные программы
//! продолжают ходить напрямую, пока их не перезапустят.

use crate::sys;

const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
const BYPASS: &str = "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;\
172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;\
172.31.*;192.168.*;<local>";

pub fn enable(port: u16) -> Result<(), String> {
    let server = format!("127.0.0.1:{port}");
    let ok = sys::run("reg", &["add", KEY, "/v", "ProxyServer", "/t", "REG_SZ", "/d", &server, "/f"])
        && sys::run("reg", &["add", KEY, "/v", "ProxyOverride", "/t", "REG_SZ", "/d", BYPASS, "/f"])
        && sys::run("reg", &["add", KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"]);
    if !ok {
        return Err("не удалось записать настройки прокси Windows".into());
    }
    notify_windows();
    Ok(())
}

pub fn disable() {
    sys::run("reg", &["add", KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"]);
    notify_windows();
}

/// Наш ли прокси сейчас прописан. Чужой не трогаем: пользователь мог
/// настроить свой, и затирать его — дурной тон.
pub fn is_ours(port: u16) -> bool {
    let enabled = sys::output("reg", &["query", KEY, "/v", "ProxyEnable"])
        .map(|out| String::from_utf8_lossy(&out.stdout).contains("0x1"))
        .unwrap_or(false);
    if !enabled {
        return false;
    }
    sys::output("reg", &["query", KEY, "/v", "ProxyServer"])
        .map(|out| String::from_utf8_lossy(&out.stdout).contains(&format!("127.0.0.1:{port}")))
        .unwrap_or(false)
}

#[cfg(windows)]
fn notify_windows() {
    // INTERNET_OPTION_SETTINGS_CHANGED = 39, INTERNET_OPTION_REFRESH = 37
    unsafe {
        windows_sys::Win32::Networking::WinInet::InternetSetOptionW(
            std::ptr::null_mut(),
            39,
            std::ptr::null_mut(),
            0,
        );
        windows_sys::Win32::Networking::WinInet::InternetSetOptionW(
            std::ptr::null_mut(),
            37,
            std::ptr::null_mut(),
            0,
        );
    }
}

#[cfg(not(windows))]
fn notify_windows() {}
