// Бэкенд проигрывателя: находит реплеи, распаковывает их и сохраняет снимки и видео.
// Цель (файл реплея, папка реплеев или папка запуска) задаётся первым аргументом.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use extract_moon_shell::{job_text, open_dir, write_output};
use flate2::read::GzDecoder;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

const SUFFIX: &str = ".jsonl.gz";

struct Target(Option<PathBuf>);

#[derive(Serialize)]
struct Stage {
    name: String,
    update: Option<u32>,
}

#[derive(Serialize)]
struct Stages {
    stages: Vec<Stage>,
    current: Option<String>,
}

fn replay_name(path: &Path) -> String {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    name.strip_suffix(SUFFIX).unwrap_or(&name).to_string()
}

/// Номер обновления из имени матча этапа: u000600_seed1000 → 600.
fn stage_update(name: &str) -> Option<u32> {
    let (head, seed) = name.split_once("_seed")?;
    let digits = head.strip_prefix('u')?;
    seed.parse::<u64>().ok()?;
    digits.parse().ok()
}

fn replays_in(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map(|it| it.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    files.retain(|p| p.to_string_lossy().ends_with(SUFFIX));
    files.sort();
    files
}

/// Список заново читается с диска: во время обучения появляются новые этапы.
/// У файла-этапа соседние этапы того же запуска тоже доступны для переключения.
fn scan(target: &Path) -> (Vec<PathBuf>, Option<PathBuf>) {
    if target.is_file() {
        let is_stage = |p: &PathBuf| stage_update(&replay_name(p)).is_some();
        let path = target.to_path_buf();
        let mut files = if is_stage(&path) {
            replays_in(target.parent().unwrap_or(Path::new(".")))
        } else {
            vec![path.clone()]
        };
        if is_stage(&path) {
            files.retain(is_stage);
        }
        return (files, Some(path));
    }
    let nested = target.join("replays");
    let files = replays_in(if nested.is_dir() { &nested } else { target });
    let last = files.last().cloned();
    (files, last)
}

#[tauri::command]
fn stages(target: State<Target>) -> Stages {
    let Some(path) = &target.0 else {
        return Stages { stages: vec![], current: None };
    };
    let (files, current) = scan(path);
    let stages = files
        .iter()
        .map(|p| {
            let name = replay_name(p);
            Stage { update: stage_update(&name), name }
        })
        .collect();
    Stages { stages, current: current.as_deref().map(replay_name) }
}

fn find(target: &State<Target>, name: &str) -> Result<PathBuf, String> {
    let path = target.0.as_ref().ok_or("реплей не задан")?;
    scan(path)
        .0
        .into_iter()
        .find(|p| replay_name(p) == name)
        .ok_or_else(|| format!("реплей не найден: {name}"))
}

/// Текст JSON Lines отдаётся одним блоком, разбирает его интерфейс.
#[tauri::command(async)]
fn load_stage(target: State<'_, Target>, name: String) -> Result<Response, String> {
    let file = fs::File::open(find(&target, &name)?).map_err(|e| e.to_string())?;
    let mut text = Vec::new();
    GzDecoder::new(file).read_to_end(&mut text).map_err(|e| e.to_string())?;
    Ok(Response::new(text))
}

/// Снимок идёт в папку screens рядом с реплеем, видео — рядом с реплеем, как в старом проигрывателе.
#[tauri::command(async)]
fn save_output(target: State<'_, Target>, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("ожидались двоичные данные".into());
    };
    let header = |key: &str| {
        request.headers().get(key).and_then(|v| v.to_str().ok()).ok_or(format!("нет заголовка {key}"))
    };
    let replay = find(&target, header("x-replay")?)?;
    let mut dir = replay.parent().ok_or("у реплея нет папки")?.to_path_buf();
    if header("x-kind")? == "shot" {
        dir.push("screens");
    }
    write_output(&dir, header("x-file")?, data)
}

#[tauri::command]
fn open_folder(target: State<Target>, name: String) -> Result<(), String> {
    let replay = find(&target, &name)?;
    open_dir(replay.parent().ok_or("у реплея нет папки")?)
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
    let target = std::env::args().nth(1).map(|a| fs::canonicalize(&a).unwrap_or_else(|_| PathBuf::from(a)));
    tauri::Builder::default()
        .manage(Target(target))
        .invoke_handler(tauri::generate_handler![stages, load_stage, save_output, open_folder, render_job, finish_job])
        .run(tauri::generate_context!())
        .expect("не удалось запустить окно проигрывателя");
}
