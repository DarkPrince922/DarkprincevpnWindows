// окно у приложения своё, консольное открываться не должно
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Оболочка приложения: тонкая прослойка между интерфейсом и движком.
//!
//! Здесь нет ни логики подписки, ни работы с сетью — всё это в `dp-engine`,
//! который проверяется тестами отдельно. Оболочка отвечает за три вещи:
//! отдать интерфейсу команды, увести долгую работу с потока окна и
//! выполнить сетевые запросы, которым мешало бы правило одного источника.

mod update;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dp_engine::{Mode, Server, State, Vpn};
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, State as TauriState, WindowEvent};

struct App {
    vpn: Arc<Mutex<Vpn>>,
    servers: Mutex<Vec<Server>>,
    /// Нужен при выходе: по этим путям добиваем свои процессы.
    core_dir: PathBuf,
}

/// Выход уже начат. Флаг разрывает круг: `exit` закрывает окно, окно снова
/// присылает «просят закрыть», а тот обработчик закрытие отменяет.
static QUITTING: AtomicBool = AtomicBool::new(false);

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
///
/// Повышенная копия должна стартовать строго после того, как уйдёт нынешняя.
/// Приложение теперь пускает себя в одном экземпляре, и копия, начатая
/// слишком рано, увидела бы работающего предшественника и молча закрылась —
/// перезапуск выглядел бы как «ничего не произошло». Поэтому запуск отдаём
/// отдельной команде: она сперва дожидается конца нашего процесса.
#[tauri::command]
fn restart_elevated(app_handle: tauri::AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let script = format!(
        "Wait-Process -Id {pid} -Timeout 40 -ErrorAction SilentlyContinue; \
         Start-Process -FilePath '{exe}' -Verb RunAs",
        pid = std::process::id(),
        exe = exe.to_string_lossy().replace('\'', "''"),
    );
    dp_engine::sys::command("powershell")
        .args([
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .spawn()
        .map_err(|error| format!("не удалось запустить перезапуск: {error}"))?;

    // Уходим по-хорошему: соединение снимаем, процессы закрываем. Иначе
    // повышенная копия столкнулась бы с занятыми портами и живым ядром.
    quit(&app_handle);
    Ok(())
}

/// Разрешает обычному запуску разбудить приложение, работающее от
/// администратора.
///
/// Второй запуск просит первый показаться сообщением окна. Windows не
/// пропускает сообщения от менее привилегированного процесса к более
/// привилегированному, а для режима «весь трафик» приложение работает от
/// администратора. Без этого разрешения ярлык на рабочем столе перестал бы
/// открывать уже работающее приложение: нажатие уходило бы в никуда.
#[cfg(windows)]
fn allow_wakeup_from_normal_user(identifier: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        ChangeWindowMessageFilterEx, FindWindowW, MSGFLT_ALLOW, WM_COPYDATA,
    };

    let wide = |text: String| {
        text.encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    // имена окна задаёт сам плагин: идентификатор приложения и суффикс
    let class = wide(format!("{identifier}-sic"));
    let name = wide(format!("{identifier}-siw"));

    // окно плагина создаётся не мгновенно — подождём его появления
    std::thread::spawn(move || {
        for _ in 0..30 {
            let window = unsafe { FindWindowW(class.as_ptr(), name.as_ptr()) };
            if !window.is_null() {
                unsafe {
                    ChangeWindowMessageFilterEx(
                        window,
                        WM_COPYDATA,
                        MSGFLT_ALLOW,
                        std::ptr::null_mut(),
                    );
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });
}

#[cfg(not(windows))]
fn allow_wakeup_from_normal_user(_identifier: &str) {}

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Полный выход по кнопке из окна.
#[tauri::command]
fn quit_app(app_handle: tauri::AppHandle) {
    quit(&app_handle);
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

/// Полный выход: снять соединение, вернуть системный прокси, убить свои
/// процессы и освободить порты — и только потом закрыться.
///
/// Всё это делается на отдельном потоке. На потоке окна нельзя: разбор
/// туннеля ходит в `route` и `netsh`, каждый вызов — десятые доли секунды,
/// а пока поток окна занят, Windows рисует поверх приложения белый
/// прямоугольник «программа не отвечает».
fn quit(app: &tauri::AppHandle) {
    // второе нажатие «Выход», пока идёт первое, ничего не меняет
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }

    let handle = app.clone();
    let core_dir = app
        .try_state::<App>()
        .map(|state| state.core_dir.clone())
        .unwrap_or_default();

    // Страховка на случай, если замок занят долгим подключением: выйти
    // приложение обязано в любом случае, иначе значок останется висеть —
    // ровно та беда, от которой мы уходим.
    let failsafe = core_dir.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(25));
        dp_engine::sys::log("выход затянулся — закрываемся принудительно");
        Vpn::clear_stale_state(&failsafe);
        std::process::exit(0);
    });

    std::thread::spawn(move || {
        if let Some(state) = handle.try_state::<App>() {
            if let Ok(mut vpn) = state.vpn.lock() {
                vpn.disconnect();
            }
        }
        // Своё, что могло пережить прошлый обрыв: процессы ядра и моста,
        // маршруты туннеля. Без этого порт останется занят уже после нашего
        // ухода, и следующий запуск начнётся с чужого порта.
        Vpn::clear_stale_state(&core_dir);
        dp_engine::sys::log("--- выход ---");
        handle.exit(0);
    });
}

fn main() {
    tauri::Builder::default()
        // Второй запуск не поднимает второе приложение, а показывает уже
        // работающее. Без этого каждый повторный запуск вешал в трей ещё
        // один значок: приложение живёт с закрытым окном, ярлык об этом не
        // знает, и значки копились по числу запусков.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_window(app);
        }))
        // Обновления: плагин скачивает установщик и проверяет его подпись.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let resources = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
            let core_dir = resources.join("core");
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));

            std::fs::create_dir_all(&data_dir).ok();
            dp_engine::sys::set_log_path(data_dir.join("app.log"));
            dp_engine::sys::log(&format!(
                "--- запуск {} ---\nядро ищем в {}",
                env!("CARGO_PKG_VERSION"),
                core_dir.display()
            ));

            allow_wakeup_from_normal_user(&app.config().identifier);

            // следы прошлого запуска, если его завершили жёстко
            Vpn::clear_stale_state(&core_dir);

            app.manage(App {
                vpn: Arc::new(Mutex::new(Vpn::new(core_dir.clone(), data_dir))),
                servers: Mutex::new(Vec::new()),
                core_dir,
            });

            // Значок в панели задач. Приложение продолжает работать с
            // закрытым окном: соединение живёт, пока его не выключат явно.
            let open = MenuItem::with_id(app, "open", "Открыть", true, None::<&str>)?;
            let connect = MenuItem::with_id(app, "connect", "Подключиться", true, None::<&str>)?;
            let disconnect =
                MenuItem::with_id(app, "disconnect", "Отключиться", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &connect, &disconnect, &quit_item])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("DarkPrince VPN")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_window(app),
                    // подключением занимается страница: она знает выбранный
                    // сервер и режим, и делает это тем же путём, что и кнопка
                    "connect" => {
                        let _ = app.emit("tray", "connect");
                    }
                    "disconnect" => {
                        let _ = app.emit("tray", "disconnect");
                    }
                    "quit" => quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { button, .. } = event {
                        if button == tauri::tray::MouseButton::Left {
                            show_window(tray.app_handle());
                        }
                    }
                })
                .build(app)?;

            // Крестик сам по себе ничего не решает: закрыть окно и закрыть
            // приложение — разные вещи, а соединение переживает закрытое
            // окно. Спрашиваем, и спрашивает страница — своим окном, а не
            // системным, чтобы вопрос не выглядел чужим.
            if let Some(window) = app.get_webview_window("main") {
                let handle = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        if QUITTING.load(Ordering::SeqCst) {
                            return; // выход уже идёт — не мешаем
                        }
                        api.prevent_close();
                        let _ = handle.show();
                        let _ = handle.unminimize();
                        let _ = handle.set_focus();
                        let _ = handle.emit("close-requested", ());
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_subscription,
            connect,
            disconnect,
            status,
            restart_elevated,
            open_url,
            quit_app,
            http,
            update::check_update,
            update::install_update
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить приложение");
}
