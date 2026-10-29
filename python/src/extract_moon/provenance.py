"""Паспорт запуска: из какого кода, от какой модели и зачем он обучен.

Пишется в runs/<запуск>/run.json при старте и дополняется итогом в конце.
Незакоммиченные правки кода сохраняются рядом в code.diff, иначе по хэшу
коммита нельзя было бы восстановить, что именно обучалось.
"""

from __future__ import annotations

import json
import platform
import subprocess
import sys
import time
from pathlib import Path

from .paths import PROJECT_ROOT


def git(*args: str) -> str:
    try:
        out = subprocess.run(["git", *args], cwd=PROJECT_ROOT, capture_output=True, text=True,
                             encoding="utf-8", check=True)
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def code_state(run_dir: Path) -> dict:
    status = git("status", "--porcelain", "--", "python", "README.md")
    state = {"commit": git("rev-parse", "HEAD"), "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
             "dirty": bool(status)}
    if status:
        (run_dir / "code.diff").write_text(git("diff", "HEAD", "--", "python") + "\n", encoding="utf-8")
        state["untracked"] = [line[3:] for line in status.splitlines() if line.startswith("??")]
    return state


def environment() -> dict:
    import numpy
    import torch

    env = {"python": platform.python_version(), "torch": torch.__version__, "numpy": numpy.__version__,
           "cuda": torch.version.cuda, "platform": platform.platform()}
    if torch.cuda.is_available():
        env["gpu"] = torch.cuda.get_device_name(0)
    return env


def start(run_dir: Path, rules: int, note: str, parent: dict | None) -> None:
    path = run_dir / "run.json"
    info = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    session = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "command": sys.argv,
               "code": code_state(run_dir), "environment": environment()}
    info.setdefault("name", run_dir.name)
    info["rules"] = rules
    if note:
        info["note"] = note
    if parent:
        info.setdefault("parent", parent)
    # Повторный старт того же запуска (после остановки) — отдельная сессия со своей версией кода.
    info.setdefault("sessions", []).append(session)
    path.write_text(json.dumps(info, indent=2, ensure_ascii=False), encoding="utf-8")


def finish(run_dir: Path, last_row: dict) -> None:
    path = run_dir / "run.json"
    info = json.loads(path.read_text(encoding="utf-8"))
    info["sessions"][-1]["finished"] = time.strftime("%Y-%m-%d %H:%M:%S")
    info["result"] = last_row
    path.write_text(json.dumps(info, indent=2, ensure_ascii=False), encoding="utf-8")


def load(run_dir: Path) -> dict:
    path = run_dir / "run.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
