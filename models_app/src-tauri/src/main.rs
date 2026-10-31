// Оболочка справочника архитектур. Данные даёт сервис на Python (extract-moon models):
// он запускает это окно и передаёт адрес и токен через переменные окружения.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use tauri::{Manager, State};

#[derive(Clone, Serialize)]
struct Backend {
    api: String,
    token: String,
}

#[tauri::command]
fn backend(state: State<Backend>) -> Backend {
    state.inner().clone()
}

fn main() {
    let env = |key| std::env::var(key).unwrap_or_default();
    let state = Backend { api: env("EXTRACT_MOON_API"), token: env("EXTRACT_MOON_TOKEN") };
    tauri::Builder::default()
        // Второй запуск только поднимает уже открытое окно и завершается вместе со своим сервисом.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(state)
        .invoke_handler(tauri::generate_handler![backend])
        .run(tauri::generate_context!())
        .expect("не удалось запустить окно справочника");
}
