// Оболочка проводника запусков. Данные и действия даёт сервис на Python (extract-moon explorer-app):
// он запускает это окно и передаёт адрес и токен через переменные окружения.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;

use extract_moon_shell::Backend;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
fn backend(state: State<Backend>) -> Backend {
    state.inner().clone()
}

/// Диалог сохранения видео. Отмена даёт None, поле ввода в окне экспорта остаётся прежним.
#[tauri::command(async)]
fn pick_video(app: AppHandle, current: String) -> Option<String> {
    let path = Path::new(&current);
    let mut dialog = app.dialog().file().set_title("Сохранить видео").add_filter("Видео MP4", &["mp4"]);
    if let Some(dir) = path.parent().filter(|d| d.is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    if let Some(name) = path.file_name() {
        dialog = dialog.set_file_name(name.to_string_lossy());
    }
    dialog.blocking_save_file().map(|p| p.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Backend::from_env())
        .invoke_handler(tauri::generate_handler![backend, pick_video])
        .run(tauri::generate_context!())
        .expect("не удалось запустить окно проводника");
}
