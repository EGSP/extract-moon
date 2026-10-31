"""Сервис нового проводника запусков: данные и действия для окна на Tauri.

Склейка веток, сглаживание и экспорт остаются в metrics_view, здесь они
превращаются в JSON. Окно explorer_app/ только рисует. Сервис слушает 127.0.0.1,
все запросы к /api требуют токен, потому что через него запускаются процессы.
Папка запусков только читается; записывают в неё лишь действия, которые выбрал
пользователь: новый матч и экспорт видео.
"""

from __future__ import annotations

import json
import mimetypes
import os
import random
import re
import secrets
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import provenance
from .metrics_view import (MIN_EPISODES, all_panels, chain_series, ema, line_style, lineage, load_metrics, n_symbols,
                           PANELS, segment_label, series, signal_panel, summary)
from .model_viewer import Server, ensure_service
from .paths import DATA_DIR, EXPLORER_DIST, EXPLORER_EXE, PLAYER_EXE, RUNS_DIR

CKPT_RE = re.compile(r"model_(\d+)\.pt$")
STAGE_RE = re.compile(r"u(\d+)_seed\d+\.jsonl\.gz$")
FRAME_RE = re.compile(r"кадр (\d+)/(\d+)")
FRESH_SECONDS = 180  # столько после последней записи метрик запуск считается обучающимся
DASHES = {"-": "сплошная", "--": "штрих", ":": "точки", "-.": "штрихпунктир"}
LAST_FIELDS = ("launch_rate", "charge_frac", "passengers", "ep_length", "kills", "steps", "sps", "episodes")


class UserError(Exception):
    """Причина, которую надо показать пользователю: не сбой, а невозможное действие."""


def num(value) -> float | None:
    return float(value) if value not in (None, "") else None


def short(values: list[float]) -> list[float]:
    """Шесть значащих цифр: JSON всех графиков ветки становится заметно меньше, форма линии не меняется."""
    return [float(f"{v:.6g}") for v in values]


def stamp(path: Path) -> tuple[int, int]:
    try:
        st = path.stat()
    except OSError:
        return 0, 0
    return st.st_mtime_ns, st.st_size


def reliable(row: dict) -> bool:
    return bool(row.get("launch_rate")) and int(row.get("episodes") or 0) >= MIN_EPISODES


def plain_note(note: str) -> str:
    """Пояснения PANELS написаны для matplotlib; в интерфейсе длинное тире не используется."""
    return note.replace(" — ", ", ")


def segments(parts: list[list], labels: list[str]) -> tuple[list[dict], list[int]]:
    """Куски склеенной линии и индексы стыков. Кусок начинается с конца предыдущего, чтобы линия была сплошной."""
    out, joints, start = [], [], 0
    for i, part in enumerate(parts):
        end = start + len(part)
        if end > start:
            out.append({"from": max(start - 1, 0), "to": end, "color": i, "label": labels[i]})
            if i and start:
                joints.append(start - 1)
        start = end
    return out, joints


def branch_marks(chain: list[tuple[str, list[dict]]]) -> list[dict]:
    """Точки ветвления: последний кадр каждого предка."""
    return [{"update": int(rows[-1]["update"]), "steps": int(rows[-1]["steps"])} for _, rows in chain[:-1] if rows]


def chain_chart(path: Path, chain: list[tuple[str, list[dict]]]) -> dict:
    """Графики запуска, склеенные с предками: те же данные, что рисует metrics_view.draw_chain."""
    labels = [segment_label(chain, i) for i in range(len(chain))]
    panels = []
    for title, note, keys in all_panels(str(path)):
        lines = []
        for j, (key, label) in enumerate(keys):
            parts = [chain_series(rows, key) for _, rows in chain]
            xs = [x for part in parts for x in part[0]]
            ys = [y for part in parts for y in part[1]]
            if not xs:
                continue
            line = {"key": key, "label": label, "color": j % 10, "dash": ["-", "--", ":", "-."][j // 10 % 4], "xs": xs,
                    "smooth": short(ema(ys))}
            if len(keys) == 1:
                line["ys"] = short(ys)
                line["segments"], line["joints"] = segments([part[0] for part in parts], labels)
            lines.append(line)
        panels.append({"title": title, "note": plain_note(note), "lines": lines, "legend": len(keys) > 1})
    return {"mode": "chain", "panels": panels, "chain": [{"name": n, "label": labels[i], "color": i}
                                                         for i, (n, _) in enumerate(chain)],
            "branches": branch_marks(chain), "marks": [[int(r["update"]), int(r["steps"])] for _, rows in chain for r in rows]}


def plain_chart(paths: list[Path]) -> dict:
    """Один запуск без предков (режим own) или сравнение нескольких, каждый со всей своей веткой."""
    names = [str(p) for p in paths]
    source = PANELS + [signal_panel(n_symbols(names))]
    compare = len(paths) > 1
    pick = chain_series if compare else series
    chains = [lineage(name) if compare else [(path.name, load_metrics(name))] for name, path in zip(names, paths)]
    panels = []
    for title, note, keys in source:
        lines = []
        for i, (path, chain) in enumerate(zip(paths, chains)):
            for j, (key, label) in enumerate(keys):
                parts = [pick(rows, key) for _, rows in chain]
                xs = [x for part in parts for x in part[0]]
                ys = [y for part in parts for y in part[1]]
                if not xs:
                    continue
                color, dash = line_style(i, j, len(paths), len(keys))
                if len(keys) > 3:
                    tag = label if i == 0 else None  # типы линий запусков подписаны в пояснении
                else:
                    tag = path.name if len(paths) > 1 else label
                line = {"key": key, "label": tag, "color": int(color[1:]), "dash": dash, "xs": xs, "smooth": short(ema(ys))}
                if compare:
                    line["joints"] = segments([part[0] for part in parts], [""] * len(parts))[1]
                if len(paths) == 1 and len(keys) == 1:
                    line["ys"] = short(ys)
                lines.append(line)
        if len(keys) > 3 and len(paths) > 1:
            styles = (DASHES[line_style(i, 0, len(paths), len(keys))[1]] for i in range(len(paths)))
            note = ", ".join(f"{style}: {p.name}" for style, p in zip(styles, paths))
        panels.append({"title": title, "note": plain_note(note), "lines": lines,
                       "legend": len(keys) > 3 or len(keys) > 1 and len(paths) == 1 or len(paths) > 1})
    return {"mode": "compare" if len(paths) > 1 else "own", "panels": panels, "branches": [], "chain": [], "marks": [],
            "runs": [{"name": p.name, "color": i} for i, p in enumerate(paths)]}


class Catalog:
    """Запуски на диске. Метрики и графики перечитываются, только когда изменился metrics.csv."""

    def __init__(self, runs_dir: Path = RUNS_DIR):
        self.runs_dir = Path(runs_dir)
        self.rows_cache: dict[str, tuple[tuple[int, int], list[dict]]] = {}
        self.charts: dict[tuple, dict] = {}
        self.lock = threading.Lock()

    def path(self, name: str) -> Path:
        """Папка запуска. Имя приходит извне, поэтому оно должно быть именем папки внутри runs_dir."""
        if not name or Path(name).name != name or name.startswith(".") or not (self.runs_dir / name).is_dir():
            raise UserError(f"запуск не найден: {name}")
        return self.runs_dir / name

    def rows(self, d: Path) -> list[dict]:
        key = stamp(d / "metrics.csv")
        with self.lock:
            cached = self.rows_cache.get(d.name)
        if cached and cached[0] == key:
            return cached[1]
        rows = load_metrics(str(d))
        with self.lock:
            self.rows_cache[d.name] = (key, rows)
        return rows

    def total(self, d: Path) -> int | None:
        cfg = d / "config.json"
        return json.loads(cfg.read_text(encoding="utf-8"))["train"]["total_updates"] if cfg.exists() else None

    def brief(self, d: Path) -> dict:
        info, rows = provenance.load(d), self.rows(d)
        last = rows[-1] if rows else {}
        total = self.total(d)
        update = int(last["update"]) if last else 0
        parent = info.get("parent") or {}
        metrics = d / "metrics.csv"
        if total and update >= total:
            state = "готов"
        elif metrics.exists() and time.time() - metrics.stat().st_mtime < FRESH_SECONDS:
            state = "обучается"
        else:
            state = "остановлен" if rows else "нет метрик"
        return {"name": d.name, "state": state, "rules": info.get("rules"), "update": update, "total": total,
                "launch": num(last.get("launch_rate")),
                "best": max((float(r["launch_rate"]) for r in rows if reliable(r)), default=None),
                "parent": parent.get("run"), "parent_update": parent.get("update", 0)}

    def dirs(self) -> list[Path]:
        if not self.runs_dir.exists():
            return []
        return sorted((p for p in self.runs_dir.iterdir() if p.is_dir()), key=lambda p: p.stat().st_ctime)

    def runs(self) -> list[dict]:
        """Плоский список в порядке дерева: у каждого запуска глубина, дети идут сразу за родителем."""
        items = {d.name: self.brief(d) for d in self.dirs()}
        children: dict[str, list[str]] = {}
        for name, r in items.items():
            if r["parent"] not in items:
                r["parent"] = None  # родитель удалён: показываем запуск корнем, как старый проводник
            else:
                children.setdefault(r["parent"], []).append(name)
        out, seen = [], set()

        def walk(name: str, depth: int) -> None:
            if name in seen:
                return
            seen.add(name)
            kids = children.get(name, [])
            out.append({**items[name], "depth": depth, "branches": len(kids)})
            for kid in kids:
                walk(kid, depth + 1)

        for name, r in items.items():
            if not r["parent"]:
                walk(name, 0)
        for name in items:  # цикл родителей, например после ручной правки run.json
            walk(name, 0)
        return out

    def checkpoints(self, d: Path) -> dict[int, Path]:
        return dict(sorted((int(m.group(1)), p) for p in (d / "checkpoints").glob("model_*.pt")
                           if (m := CKPT_RE.search(p.name))))

    def stages(self, d: Path) -> dict[int, Path]:
        return {int(m.group(1)): p for p in (d / "replays").glob("*.jsonl.gz") if (m := STAGE_RE.search(p.name))}

    def timeline(self, d: Path) -> dict:
        """Шкала моделей: кривая взлётов по обновлениям, склеенная с предками, со сглаживанием через стыки."""
        chain = lineage(str(d))
        parts = [[(int(r["update"]), float(r["launch_rate"])) for r in rows if reliable(r)] for _, rows in chain]
        flat = [p for part in parts for p in part]
        labels = [segment_label(chain, i) for i in range(len(chain))]
        segs, joints = segments(parts, labels)
        return {"xs": [u for u, _ in flat], "smooth": short(ema([v for _, v in flat])), "segments": segs, "joints": joints,
                "branches": branch_marks(chain), "chain": [{"name": n, "label": labels[i], "color": i}
                                                           for i, (n, _) in enumerate(chain)]}

    def detail(self, name: str) -> dict:
        d = self.path(name)
        info, rows = provenance.load(d), self.rows(d)
        brief = self.brief(d)
        known = {p.name for p in self.dirs()}
        parent = brief["parent"] if brief["parent"] in known else None
        kids: dict[int, list[str]] = {}
        for other in self.dirs():
            up = provenance.load(other).get("parent") or {}
            if up.get("run") == name:
                kids.setdefault(up.get("update", 0), []).append(other.name)
        by_update = {int(r["update"]): r for r in rows}
        if parent:  # родительская модель описана метриками родителя
            for row in self.rows(self.runs_dir / parent):
                if int(row["update"]) == brief["parent_update"]:
                    by_update.setdefault(brief["parent_update"], row)
        stages, ckpts = self.stages(d), self.checkpoints(d)
        models = [{"update": u, "steps": int(by_update[u]["steps"]) if u in by_update else None,
                   "launch": num(by_update.get(u, {}).get("launch_rate")), "stage": u in stages,
                   "children": kids.get(u, []), "inherited": bool(brief["parent"]) and u == brief["parent_update"]}
                  for u in reversed(ckpts)]
        sessions = info.get("sessions") or []
        code = sessions[-1].get("code", {}) if sessions else {}
        last = rows[-1] if rows else {}
        return {**brief, "folder": str(d), "note": info.get("note"), "parent": parent, "lost_parent": brief["parent"] if not parent else None,
                "commit": code.get("commit", "")[:7], "dirty": bool(code.get("dirty")),
                "started": sessions[0].get("started") if sessions else None,
                "finished": sessions[-1].get("finished") if sessions else None,
                "summary": summary(str(d), rows), "last": {k: num(last.get(k)) for k in LAST_FIELDS},
                "replays": len(list((d / "replays").glob("*.jsonl.gz"))), "models": models,
                "children": [{"update": u, "name": n} for u, names in kids.items() for n in names],
                "range": max(brief["total"] or 0, brief["update"], *ckpts, 1), "timeline": self.timeline(d)}

    def ancestors(self, d: Path) -> list[Path]:
        out, seen = [], set()
        while d.name not in seen and d.is_dir():
            seen.add(d.name)
            out.append(d)
            up = provenance.load(d).get("parent") or {}
            if not up.get("run"):
                break
            d = d.parent / up["run"]
        return out

    def chart(self, names: list[str], own: bool = False) -> dict:
        """Данные графиков. stamp меняется вместе с метриками, по нему окно понимает, что перерисовка не нужна."""
        paths = [self.path(n) for n in names]
        if not paths:
            raise UserError("запуск не выбран")
        plain = own or len(paths) > 1
        tracked = paths if own else [a for p in paths for a in self.ancestors(p)]
        version = "-".join("{}.{}".format(*stamp(p / "metrics.csv")) for p in tracked)
        key = (tuple(names), plain)
        with self.lock:
            cached = self.charts.get(key)
        if cached and cached["stamp"] == version:
            return cached
        if plain:
            chart = plain_chart(paths)
        else:
            chain = lineage(str(paths[0]))
            chart = chain_chart(paths[0], chain)
        chart["stamp"] = version
        chart["summary"] = [summary(str(p), self.rows(p)) for p in paths]
        with self.lock:
            self.charts[key] = chart
        return chart


def launch(*args: str) -> None:
    """Отдельный процесс: окна матчей и плеера живут сами по себе, как в старом проводнике."""
    subprocess.Popen([sys.executable, "-m", "extract_moon.cli", *args], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def open_path(path: Path) -> None:
    os.startfile(path)  # noqa: S606 (открыть в программе по умолчанию, Windows)


def copy_text(text: str) -> bool:
    """Буфер обмена через clip.exe: из webview запись зависит от фокуса окна и может не завершиться."""
    try:
        return subprocess.run(["clip"], input=text.encode("utf-16-le"), check=False, timeout=5,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


class Actions:
    """Кнопки проводника. Тексты ошибок те же, что в старом окне."""

    def __init__(self, catalog: Catalog, run=launch, opener=open_path, journal: Path = DATA_DIR / "journal.md",
                 copier=copy_text):
        self.catalog, self.run, self.opener, self.journal, self.copier = catalog, run, opener, journal, copier
        self.visualizer: subprocess.Popen | None = None
        self.visualizer_lock = threading.Lock()

    def model(self, name: str, update) -> tuple[Path, int, Path]:
        d = self.catalog.path(name)
        path = self.catalog.checkpoints(d).get(update) if isinstance(update, int) else None
        if not path:
            raise UserError("Выберите модель в списке или на шкале.")
        return d, update, path

    def has_replays(self, d: Path) -> bool:
        return any((d / "replays").glob("*.jsonl.gz"))

    def record(self, path: Path, *view: str) -> None:
        # На CPU: видеокарта может быть занята обучением.
        self.run("record", "--checkpoint", str(path), "--seed", str(random.randint(0, 99_999)), "--device", "cpu", *view)

    def do(self, action: str, run: str | None = None, update=None) -> dict:
        if action == "journal":
            self.opener(self.journal)
            return {}
        if action == "visualizer":
            with self.visualizer_lock:  # второе нажатие ждёт первое и не поднимает ещё один сервис
                url, proc = ensure_service()
                if proc:
                    self.visualizer = proc
            webbrowser.open(url)
            return {"url": url}
        d = self.catalog.path(run or "")
        if action == "replays":
            if not self.has_replays(d):
                raise UserError("У этого запуска пока нет записанных матчей.")
            self.run("view", str(d))
        elif action == "player":
            self.open_player(d, update)
        elif action == "folder":
            self.opener(d)
        elif action == "play":
            self.record(self.model(run, update)[2], "--view")
        elif action == "stage":
            _, upd, _ = self.model(run, update)
            stage = self.catalog.stages(d).get(upd)
            if not stage:
                raise UserError("Для этой модели матч этапа не записан. Сыграйте новый матч.")
            self.run("view", str(stage))
        elif action == "finetune":
            _, upd, _ = self.model(run, update)
            command = (f'uv run extract-moon train --run {run}-u{upd}--МЕТКА --resume {run}:{upd} '
                       f'--set train.total_updates={upd + 300} --note "ЗАЧЕМ"')
            return {"command": command, "copied": self.copier(command)}
        else:
            raise UserError(f"неизвестное действие: {action}")
        return {}

    def open_player(self, d: Path, update) -> None:
        """Матч выбранной модели, а без выбранной модели последний этап запуска."""
        if not PLAYER_EXE.exists():
            raise UserError("Новый плеер не собран. Команда сборки: в player/README.md.")
        if update is not None:
            _, upd, path = self.model(d.name, update)
            stage = self.catalog.stages(d).get(upd)
            if stage:
                self.run("player", str(stage))
            else:  # у модели нет матча этапа: записываем новый
                self.record(path, "--player")
        elif self.has_replays(d):
            self.run("player", str(d))
        else:
            raise UserError("У этого запуска пока нет записанных матчей.")

    def close(self) -> None:
        # Сервис, запущенный проводником, живёт не дольше него: скрытый процесс некому остановить.
        if self.visualizer:
            self.visualizer.terminate()


class Exports:
    """Видео собирает extract-moon plot-video отдельным процессом: matplotlib тяжёлый и не потокобезопасен."""

    def __init__(self, catalog: Catalog):
        self.catalog = catalog
        self.jobs: dict[str, dict] = {}

    def start(self, run: str, out: str, speed: float, panel: int | None) -> str:
        d = self.catalog.path(run)
        if not isinstance(speed, (int, float)) or speed <= 0:
            raise UserError("Скорость должна быть числом больше нуля.")
        if not out.strip():
            raise UserError("Выберите файл.")
        path = Path(out.strip())
        if not path.is_absolute():
            raise UserError("Укажите полный путь к файлу.")
        if path.suffix.lower() != ".mp4":
            path = path.with_name(path.name + ".mp4")
        job = {"state": "running", "done": 0, "total": 0, "out": str(path), "error": None}
        key = secrets.token_hex(8)
        self.jobs[key] = job
        threading.Thread(target=self.work, args=(job, d, path, speed, panel), daemon=True).start()
        return key

    def work(self, job: dict, d: Path, out: Path, speed: float, panel: int | None) -> None:
        cmd = [sys.executable, "-m", "extract_moon.cli", "plot-video", str(d), "--out", str(out), "--speed", str(speed)]
        if panel is not None:
            cmd += ["--panel", str(panel)]
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    env={**os.environ, "PYTHONIOENCODING": "utf-8"}, encoding="utf-8", errors="replace",
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            other = []
            for line in proc.stdout:
                if m := FRAME_RE.match(line):
                    job["done"], job["total"] = int(m.group(1)), int(m.group(2))
                else:
                    other.append(line)
            if proc.wait():
                raise RuntimeError(other[-1].strip() if other else f"код завершения {proc.returncode}")
            job["state"] = "done"
        except Exception as e:  # показать пользователю, а не потерять в потоке
            job["state"], job["error"] = "error", str(e)

    def job(self, key: str) -> dict:
        if key not in self.jobs:
            raise UserError("экспорт не найден")
        return self.jobs[key]


def make_handler(catalog: Catalog, actions: Actions, exports: Exports, token: str, dist: Path):
    class Handler(BaseHTTPRequestHandler):
        def do_OPTIONS(self):  # окно Tauri и сервис на разных адресах: браузер сначала спрашивает разрешение
            self.send_response(204)
            self.cors()
            self.end_headers()

        def do_GET(self):
            url = urlparse(self.path)
            if url.path.startswith("/api/"):
                query = parse_qs(url.query)
                return self.api(lambda: self.read(url.path, query), query.get("token", [""])[0])
            self.static(url.path)

        def do_POST(self):
            size = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(size) or b"{}")
            except ValueError:
                return self.reply({"error": "неверный JSON"}, 400)
            self.api(lambda: self.write(urlparse(self.path).path, body))

        def api(self, work, query_token: str = ""):
            if not secrets.compare_digest((self.headers.get("X-Token") or query_token).encode(), token.encode()):
                return self.reply({"error": "нет доступа"}, 403)
            try:
                self.reply(work())
            except UserError as e:
                self.reply({"error": str(e)}, 400)
            except Exception as e:  # например, строка metrics.csv ещё дописывается: окно повторит запрос
                self.reply({"error": repr(e)}, 500)

        def read(self, path: str, query: dict):
            if path == "/api/runs":
                return {"runs": catalog.runs()}
            if path.startswith("/api/run/"):
                return catalog.detail(unquote(path.removeprefix("/api/run/")))
            if path == "/api/chart":
                return catalog.chart(query.get("run", []), query.get("own", ["0"])[0] == "1")
            if path.startswith("/api/export/"):
                return exports.job(path.removeprefix("/api/export/"))
            raise UserError("неизвестный запрос")

        def write(self, path: str, body: dict):
            if path == "/api/action":
                return actions.do(body.get("action", ""), body.get("run"), body.get("update"))
            if path == "/api/export":
                return {"id": exports.start(body.get("run", ""), body.get("out", ""), body.get("speed"), body.get("panel"))}
            if path.startswith("/api/export/") and path.endswith("/open"):
                job = exports.job(path.split("/")[3])
                if job["state"] != "done":
                    raise UserError("видео ещё не готово")
                actions.opener(Path(job["out"]))
                return {}
            raise UserError("неизвестный запрос")

        def cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "X-Token, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

        def reply(self, data: dict, code: int = 200):
            self.send(json.dumps(data, ensure_ascii=False).encode(), "application/json", code)

        def send(self, body: bytes, kind: str, code: int = 200):
            self.send_response(code)
            self.cors()
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def static(self, path: str):
            """Собранный интерфейс: окно Tauri носит его в себе, а это для проверки в браузере."""
            file = (dist / (path.lstrip("/") or "index.html")).resolve()
            if dist.resolve() not in file.parents or not file.is_file():
                return self.send(b"not found", "text/plain", 404)
            kind = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
            self.send(file.read_bytes(), kind + ("; charset=utf-8" if kind.startswith("text/") else ""))

        def log_message(self, *args):  # тихо: у окна нет консоли
            pass

    return Handler


def make_server(runs_dir: Path = RUNS_DIR, port: int = 0, token: str | None = None, run=launch, opener=open_path,
                dist: Path = EXPLORER_DIST):
    """Сервер на 127.0.0.1. Порт 0 значит свободный. Возвращает сервер, токен и действия."""
    mimetypes.add_type("application/javascript", ".js")
    token = token or secrets.token_urlsafe(24)
    catalog = Catalog(runs_dir)
    actions = Actions(catalog, run, opener)
    return Server(("127.0.0.1", port), make_handler(catalog, actions, Exports(catalog), token, dist)), token, actions


def run_app(runs_dir: Path = RUNS_DIR, port: int = 0, window: bool = True) -> None:
    """Открывает окно и держит сервис, пока окно не закрыто. Без окна сервис работает до Ctrl+C."""
    if window and not EXPLORER_EXE.exists():
        raise FileNotFoundError(f"новый проводник не собран: {EXPLORER_EXE}. Сборка описана в explorer_app/README.md")
    server, token, actions = make_server(runs_dir, port)
    address = f"http://127.0.0.1:{server.server_port}"
    try:
        if window:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            env = {**os.environ, "EXTRACT_MOON_API": address, "EXTRACT_MOON_TOKEN": token}
            subprocess.run([str(EXPLORER_EXE)], env=env, stdin=subprocess.DEVNULL, check=False)
            server.shutdown()
        else:
            print(f"проводник: {address}/?token={token} (Ctrl+C: остановить)", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        actions.close()
        server.server_close()
