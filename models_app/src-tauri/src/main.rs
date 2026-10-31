// Оболочка справочника архитектур. Данные даёт сервис на Python (extract-moon models):
// он запускает это окно и передаёт адрес, токен и папку видео через переменные окружения.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use extract_moon_shell::{focus_main, job_text, write_output, Backend};
use tauri::ipc::{InvokeBody, Request};
use tauri::State;

#[tauri::command]
fn backend(state: State<Backend>) -> Backend {
    state.inner().clone()
}

#[tauri::command(async)]
fn save_output(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("ожидались двоичные данные".into());
    };
    let file = request.headers().get("x-file").and_then(|v| v.to_str().ok()).ok_or("нет заголовка x-file")?;
    let dir = std::env::var("EXTRACT_MOON_OUT").map_err(|_| "папка видео не задана")?;
    write_output(&PathBuf::from(dir), file, data)
}

#[tauri::command]
fn render_job() -> Result<Option<String>, String> {
    job_text()
}

#[tauri::command]
fn finish_job(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        // Второй запуск только поднимает уже открытое окно и завершается вместе со своим сервисом.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| focus_main(app)))
        .manage(Backend::from_env())
        .invoke_handler(tauri::generate_handler![backend, save_output, render_job, finish_job])
        .run(tauri::generate_context!())
        .expect("не удалось запустить окно справочника");
}
