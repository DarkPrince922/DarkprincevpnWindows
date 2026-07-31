// окно у приложения своё, консольное открываться не должно
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Оболочка приложения: тонкая прослойка между интерфейсом и движком.
//!
//! Здесь нет ни логики подписки, ни работы с сетью — всё это в `dp-engine`,
//! который проверяется тестами отдельно. Оболочка отвечает за три вещи:
//! отдать интерфейсу команды, увести долгую работу с потока окна и
//! выполнить сетевые запросы, которым мешало бы правило одного источника.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use dp_engine::{Mode, Server, State, Vpn};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State as TauriState};

struct App {
    vpn: Arc<Mutex<Vpn>>,
    servers: Mutex<Vec<Server>>,
}

#[derive(Serialize)]
struct ServerView {
    index: usize,
    name: String,
    transport: String,
}

#[derive(Serialize)]
struct Status {
    state: State,
    mode: Mode,
    elevated: bool,
}

#[derive(Deserialize)]
struct Request {
    method: String,
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Serialize)]
struct Response {
    status: u16,
    body: String,
}

/// Загружает подписку и запоминает список серверов.
#[tauri::command]
async fn load_subscription(
    url: String,
    hwid: String,
    app: TauriState<'_, App>,
) -> Result<Vec<ServerView>, String> {
    let text = fetch_subscription(&url, &hwid).await?;
    let servers = dp_engine::subscription::parse(&text);
    if servers.is_empty() {
        return Err("подписка пуста или в незнакомом формате".into());
    }
    let view = servers
        .iter()
        .enumerate()
        .map(|(index, server)| ServerView {
            index,
            name: server.name.clone(),
            transport: server.transport_label(),
        })
        .collect();
    *app.servers.lock().unwrap() = servers;
    Ok(view)
}

/// Подключение. Работа долгая и блокирующая — уводим её с потока окна,
/// иначе интерфейс перестанет перерисовываться и Windows покажет белый
/// прямоугольник «программа не отвечает».
#[tauri::command]
async fn connect(index: usize, tun: bool, app: TauriState<'_, App>) -> Result<(), String> {
    let server = {
        let servers = app.servers.lock().unwrap();
        servers.get(index).cloned().ok_or("сервер не выбран")?
    };
    let mode = if tun { Mode::Tun } else { Mode::Proxy };
    let vpn = Arc::clone(&app.vpn);
    match tauri::async_runtime::spawn_blocking(move || vpn.lock().unwrap().connect(&server, mode)).await {
        Ok(result) => result,
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn disconnect(app: TauriState<'_, App>) -> Result<(), String> {
    let vpn = Arc::clone(&app.vpn);
    tauri::async_runtime::spawn_blocking(move || vpn.lock().unwrap().disconnect())
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn status(app: TauriState<'_, App>) -> Status {
    let vpn = app.vpn.lock().unwrap();
    Status {
        state: vpn.state(),
        mode: vpn.mode(),
        elevated: dp_engine::tun::is_elevated(),
    }
}

/// Перезапуск с правами администратора — иначе режим «весь трафик»
/// невозможен: без них не создать адаптер и не править маршруты.
#[tauri::command]
fn restart_elevated(app_handle: tauri::AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let script = format!(
        "Start-Process -FilePath '{}' -Verb RunAs",
        exe.to_string_lossy().replace('\'', "''")
    );
    dp_engine::sys::powershell(&script);
    app_handle.exit(0);
    Ok(())
}

#[tauri::command]
fn open_url(url: String) {
    // ссылку открываем в браузере по умолчанию
    dp_engine::sys::command("cmd").args(["/C", "start", "", &url]).spawn().ok();
}

/// Запрос в кабинет. Идёт из Rust, а не из страницы: у окна свой источник,
/// и браузерное правило одного источника не пустило бы его наружу.
#[tauri::command]
async fn http(request: Request) -> Result<Response, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;

    let method = reqwest::Method::from_bytes(request.method.to_uppercase().as_bytes())
        .map_err(|_| "неизвестный метод запроса".to_string())?;
    let mut builder = client.request(method, &request.url);
    for (name, value) in request.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }

    let response = builder
        .send()
        .await
        .map_err(|_| "нет соединения с сервером. Проверьте интернет.".to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    Ok(Response { status, body })
}

/// Скачивание подписки. Заголовки здесь не украшение:
///
/// * панель отдаёт формат по клиенту — без `User-Agent` известного клиента
///   вместо конфига Xray приходит совсем другое, и разбирать нечего;
/// * по `x-hwid` и соседям панель ведёт учёт устройств. Без них компьютер не
///   появится в списке устройств кабинета, а лимит тарифа не сработает.
async fn fetch_subscription(url: &str, hwid: &str) -> Result<String, String> {
    let mut headers = HashMap::new();
    headers.insert("User-Agent".to_string(), "v2rayNG/1.10.7".to_string());
    headers.insert("Accept".to_string(), "text/plain".to_string());
    headers.insert("x-hwid".to_string(), hwid.to_string());
    headers.insert("x-device-os".to_string(), "Windows".to_string());
    headers.insert("x-ver-os".to_string(), os_version());
    headers.insert("x-device-model".to_string(), machine_name());

    let response = http(Request {
        method: "GET".into(),
        url: url.to_string(),
        headers,
        body: None,
    })
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(format!("сервер подписки ответил {}", response.status));
    }
    Ok(response.body)
}

fn machine_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows PC".to_string())
}

/// Версия системы спрашивается один раз за запуск: ответ не меняется, а
/// вызов стоит около четверти секунды.
fn os_version() -> String {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION
        .get_or_init(|| {
            dp_engine::sys::powershell("[System.Environment]::OSVersion.Version.ToString()")
                .unwrap_or_else(|| "10.0".to_string())
        })
        .clone()
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let resources = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
            let core_dir = resources.join("core");
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));

            // следы прошлого запуска, если его завершили жёстко
            Vpn::clear_stale_state(&core_dir);

            app.manage(App {
                vpn: Arc::new(Mutex::new(Vpn::new(core_dir, data_dir))),
                servers: Mutex::new(Vec::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_subscription,
            connect,
            disconnect,
            status,
            restart_elevated,
            open_url,
            http
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить приложение");
}
