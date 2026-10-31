//! Общая часть окон Extract Moon: связь с сервисом на Python, запись файлов и пакетное задание.
//! Команды Tauri объявляет каждое окно само, здесь лежит то, что они вызывают.

use std::fs;
use std::path::Path;
use std::process::Command;

use serde::Serialize;
use tauri::Manager;

/// Адрес и токен сервиса: их передаёт через окружение процесс на Python, запустивший окно.
#[derive(Clone, Serialize)]
pub struct Backend {
    pub api: String,
    pub token: String,
}

impl Backend {
    pub fn from_env() -> Self {
        let env = |key| std::env::var(key).unwrap_or_default();
        Backend { api: env("EXTRACT_MOON_API"), token: env("EXTRACT_MOON_TOKEN") }
    }
}

/// Пишет файл в папку и возвращает путь для сообщения. Из имени берётся только последняя часть.
pub fn write_output(dir: &Path, file: &str, data: &[u8]) -> Result<String, String> {
    let file = Path::new(file).file_name().ok_or("неверное имя файла")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let out = dir.join(file);
    fs::write(&out, data).map_err(|e| e.to_string())?;
    // canonicalize на Windows добавляет к пути префикс \\?\, в сообщении он не нужен.
    let shown = out.to_string_lossy();
    Ok(shown.strip_prefix(r"\\?\").unwrap_or(&shown).to_string())
}

pub fn open_dir(dir: &Path) -> Result<(), String> {
    Command::new("explorer").arg(dir).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Текст задания рендера из файла EXTRACT_MOON_JOB: интерфейс снимает ролик и закрывает окно.
pub fn job_text() -> Result<Option<String>, String> {
    let Ok(path) = std::env::var("EXTRACT_MOON_JOB") else { return Ok(None) };
    fs::read_to_string(path).map(Some).map_err(|e| e.to_string())
}

/// Выводит открытое окно на передний план при повторном запуске.
pub fn focus_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
