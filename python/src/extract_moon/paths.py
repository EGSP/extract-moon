"""Пути проекта: данные лежат в extract_moon/data, рядом с папкой python."""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = PROJECT_ROOT / "data"
RUNS_DIR = DATA_DIR / "runs"
REPLAYS_DIR = DATA_DIR / "replays"
PLAYER_EXE = PROJECT_ROOT / "player" / "src-tauri" / "target" / "release" / "extract-moon-player.exe"
EXPLORER_EXE = PROJECT_ROOT / "explorer_app" / "src-tauri" / "target" / "release" / "extract-moon-explorer.exe"
EXPLORER_DIST = PROJECT_ROOT / "explorer_app" / "dist"
