//! Обновление приложения.
//!
//! На Windows обновление ставится само: плагин скачивает установщик, проверяет
//! подпись и запускает его. Установщик собран в режиме currentUser, поэтому
//! прав администратора обновление не спрашивает — в отличие от режима «весь
//! трафик», которому они нужны для драйвера.
//!
//! Подпись проверяет сам плагин, и это не формальность: скачанный установщик —
//! это чужой код, запускаемый на машине пользователя, а одного HTTPS для
//! доверия к нему мало.

use serde::Serialize;
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

/// Сколько уже скачано. Уходит в окно событием `update-progress`.
#[derive(Serialize, Clone)]
struct Progress {
    downloaded: u64,
    /// Ноль означает «размер неизвестен» — полосу тогда не рисуем.
    total: u64,
}

/// Что показать пользователю.
#[derive(Serialize, Default)]
pub struct UpdateInfo {
    /// Версия из манифеста, если она новее установленной.
    pub version: Option<String>,
    pub notes: Option<String>,
    /// Можно ли нажать кнопку «Обновить». На Windows — всегда, когда есть что.
    pub can_install: bool,
    /// Проверка не удалась — сети нет или сайт недоступен. Не ошибка:
    /// приложение работает, просто молчим об обновлениях.
    pub failed: bool,
}

/// Спрашивает манифест и сравнивает версии.
#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> UpdateInfo {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            dp_engine::sys::log(&format!("обновления: апдейтер недоступен: {error}"));
            return UpdateInfo {
                failed: true,
                ..Default::default()
            };
        }
    };

    match updater.check().await {
        // манифест отдал версию новее установленной
        Ok(Some(update)) => UpdateInfo {
            version: Some(update.version.clone()),
            notes: update.body.clone(),
            can_install: true,
            failed: false,
        },
        // установлена свежая версия
        Ok(None) => UpdateInfo::default(),
        Err(error) => {
            dp_engine::sys::log(&format!("обновления: проверка не удалась: {error}"));
            UpdateInfo {
                failed: true,
                ..Default::default()
            }
        }
    }
}

/// Скачивает и ставит обновление.
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|error| format!("апдейтер недоступен: {error}"))?
        .check()
        .await
        .map_err(|error| format!("не удалось проверить обновление: {error}"))?
        .ok_or("обновлений нет")?;

    dp_engine::sys::log(&format!("обновления: ставим {}", update.version));

    // Качаем сами и показываем, сколько уже скачано: файл на десятки
    // мегабайт без полосы выглядит как зависшее приложение.
    let window = app.clone();
    let mut downloaded: u64 = 0;

    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = window.emit(
                    "update-progress",
                    Progress {
                        downloaded,
                        // сервер не обязан говорить размер заранее
                        total: total.unwrap_or(0),
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|error| format!("не удалось поставить обновление: {error}"))?;

    // Установщик просит закрыть приложение, поэтому уходим сами. Соединение
    // при этом снимается штатно: за выходом следит тот же обработчик, что и
    // при «Выйти полностью».
    app.restart();
}
