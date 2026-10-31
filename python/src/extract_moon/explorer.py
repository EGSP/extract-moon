"""Проводник запусков: дерево запусков и кнопки, открывающие их матчи и графики.

Дообученные запуски показаны веткой под родителем. У выбранного запуска —
сохранённые модели на шкале обновлений поверх кривой взлётов: видно, какая
модель была удачной и от какой пошли дообученные ветки. Проигрыватель и
графики открываются отдельными окнами. Окно анимации проигрывает графики по
обновлениям и сохраняет их в MP4. Список обновляется сам.
"""

from __future__ import annotations

import os
import queue
import random
import re
import subprocess
import sys
import threading
import time
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from . import provenance
from .metrics_view import MIN_EPISODES, MetricsAnimation, all_panels, ema, load_metrics
from .model_viewer import ensure_service
from .paths import DATA_DIR, PLAYER_EXE, RUNS_DIR

REFRESH_MS = 10_000
FRAME_MS = 33
# В запусках 60-900 обновлений: при 30 в секунду анимация идёт от 2 до 30 секунд.
DEFAULT_SPEED = 30
FRAME_RE = re.compile(r"кадр (\d+)/(\d+)")
# Доля взлётов по меньшему числу матчей слишком шумная: в начале запуска это 1-2 матча.
# Цвета кусков ветки, как у линий в графиках matplotlib.
SEGMENT_COLORS = ("#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b")
ALL_PANELS = "Все графики"
LAUNCH_PANEL = 1  # «Матчи, где корабль улетел» в metrics_view.PANELS
CKPT_RE = re.compile(r"model_(\d+)\.pt$")
STAGE_RE = re.compile(r"u(\d+)_seed\d+\.jsonl\.gz$")


def run_info(d) -> dict:
    info = provenance.load(d)
    rows = load_metrics(str(d))
    last = rows[-1] if rows else {}
    total = None
    cfg = d / "config.json"
    if cfg.exists():
        import json

        total = json.loads(cfg.read_text(encoding="utf-8"))["train"]["total_updates"]
    metrics = d / "metrics.csv"
    fresh = metrics.exists() and time.time() - metrics.stat().st_mtime < 180
    upd = int(last["update"]) if last else 0
    if total and upd >= total:
        state = "готов"
    elif fresh:
        state = "обучается"
    else:
        state = "остановлен" if rows else "нет метрик"
    best = max((float(r["launch_rate"]) for r in rows if reliable(r)), default=None)
    checkpoints = sorted((int(m.group(1)), p) for p in (d / "checkpoints").glob("model_*.pt")
                         if (m := CKPT_RE.search(p.name)))
    stages = {int(m.group(1)): p for p in (d / "replays").glob("*.jsonl.gz") if (m := STAGE_RE.search(p.name))}
    parent = info.get("parent") or {}
    return {"dir": d, "info": info, "rows": rows, "last": last, "total": total, "state": state, "update": upd,
            "best": best, "parent": parent.get("run"), "parent_update": parent.get("update", 0),
            "checkpoints": checkpoints, "stages": stages, "children": []}


def reliable(row: dict) -> bool:
    return bool(row.get("launch_rate")) and int(row.get("episodes") or 0) >= MIN_EPISODES


def launch(*args: str) -> None:
    # Отдельный процесс: окно проигрывателя или графиков не блокирует проводник.
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.Popen([sys.executable, "-m", "extract_moon.cli", *args], creationflags=flags)


def in_background(root: tk.Tk, work, on_event) -> None:
    """work(emit) идёт в потоке; emit и итог приходят в on_event(kind, value) в потоке окна.

    kind: progress (из emit), done (результат work) или error (её исключение). Из потока к tkinter
    обращаться нельзя, поэтому окно само забирает события из очереди.
    """
    events: queue.Queue = queue.Queue()

    def body():
        try:
            events.put(("done", work(lambda value: events.put(("progress", value)))))
        except Exception as e:  # показать пользователю, а не потерять в потоке
            events.put(("error", e))

    def poll():
        try:
            while True:
                kind, value = events.get_nowait()
                on_event(kind, value)
                if kind != "progress":
                    return
        except queue.Empty:
            root.after(100, poll)

    threading.Thread(target=body, daemon=True).start()
    poll()


def parse_speed(text: str) -> float | None:
    try:
        speed = float(text.replace(",", "."))
    except ValueError:
        return None
    return speed if speed > 0 else None


def export_process(run: Path, out: Path, speed: float, panel: int | None, emit) -> None:
    """Экспорт отдельным процессом: matplotlib в потоке мешал бы окну и не потокобезопасен."""
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    cmd = [sys.executable, "-m", "extract_moon.cli", "plot-video", str(run), "--out", str(out), "--speed", str(speed)]
    if panel is not None:
        cmd += ["--panel", str(panel)]
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env,
                            encoding="utf-8", errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    other = []
    for line in proc.stdout:
        if m := FRAME_RE.match(line):
            emit((int(m.group(1)), int(m.group(2))))
        else:
            other.append(line)
    if proc.wait():
        raise RuntimeError(other[-1].strip() if other else f"код завершения {proc.returncode}")


class Explorer:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("Extract Moon — запуски")
        root.geometry("1400x840")
        style = ttk.Style()
        style.configure("Treeview", rowheight=26, font=("Segoe UI", 10))
        style.configure("Treeview.Heading", font=("Segoe UI", 10, "bold"))
        style.configure("TButton", font=("Segoe UI", 10), padding=6)

        main = ttk.PanedWindow(root, orient="horizontal")
        main.pack(fill="both", expand=True, padx=8, pady=8)

        left = ttk.Frame(main)
        cols = ("state", "rules", "progress", "launch", "best")
        self.tree = ttk.Treeview(left, columns=cols, selectmode="browse")
        for col, title, w in (("#0", "Запуск", 200), ("state", "Состояние", 95), ("rules", "Правила", 65),
                              ("progress", "Обновлений", 90), ("launch", "Взлёты сейчас", 105),
                              ("best", "Лучшие взлёты", 105)):
            self.tree.heading(col, text=title)
            self.tree.column(col, width=w, anchor="w" if col == "#0" else "center")
        self.tree.pack(fill="both", expand=True)
        self.tree.bind("<<TreeviewSelect>>", lambda _: self.show())
        self.tree.bind("<Double-1>", lambda _: self.open_replays())
        ttk.Label(left, text="Ветка под запуском — модели, дообученные от него. Двойной щелчок открывает матчи.",
                  foreground="#666").pack(anchor="w", pady=(4, 0))
        main.add(left, weight=3)

        right = ttk.Frame(main)
        buttons = ttk.Frame(right)
        buttons.pack(fill="x")
        for text, cmd in (("Матчи", self.open_replays), ("Новый плеер", self.open_player), ("Графики", self.open_metrics),
                          ("Сравнить с родителем", self.compare), ("Папка", self.open_folder),
                          ("Визуализатор", self.open_visualizer)):
            ttk.Button(buttons, text=text, command=cmd).pack(side="left", padx=(0, 6))
        models = ttk.LabelFrame(right, text="Сохранённые модели", padding=6)
        models.pack(fill="x", pady=(8, 0))
        self.timeline = tk.Canvas(models, height=150, background="white", highlightthickness=0)
        self.timeline.pack(fill="x")
        self.timeline.bind("<Button-1>", self.timeline_click)
        self.timeline.bind("<Configure>", lambda _: self.draw_timeline())
        cols = ("steps", "launch", "stage", "children")
        self.ckpts = ttk.Treeview(models, columns=cols, height=6, selectmode="browse")
        for col, title, w in (("#0", "Модель (обновление)", 150), ("steps", "Опыт, робот-тактов", 130),
                              ("launch", "Взлёты в этот момент", 140), ("stage", "Матч этапа", 90),
                              ("children", "Дообучены от неё", 180)):
            self.ckpts.heading(col, text=title)
            self.ckpts.column(col, width=w, anchor="w" if col in ("#0", "children") else "center")
        self.ckpts.pack(fill="x", pady=(6, 0))
        self.ckpts.bind("<<TreeviewSelect>>", lambda _: self.draw_timeline())
        self.ckpts.bind("<Double-1>", lambda _: self.play_model())
        actions = ttk.Frame(models)
        actions.pack(fill="x", pady=(6, 0))
        for text, cmd in (("Сыграть новый матч", self.play_model), ("Матч этапа", self.open_stage),
                          ("Команда дообучения", self.copy_finetune), ("Анимация графика", self.open_launch_animation)):
            ttk.Button(actions, text=text, command=cmd).pack(side="left", padx=(0, 6))
        self.details = tk.Text(right, wrap="word", font=("Segoe UI", 10), relief="flat", background="#f6f6f8",
                               padx=10, pady=8, height=12)
        self.details.pack(fill="both", expand=True, pady=(8, 0))
        bottom = ttk.Frame(right)
        bottom.pack(fill="x", pady=(8, 0))
        ttk.Button(bottom, text="Журнал запусков", command=lambda: self.open_path(DATA_DIR / "journal.md")).pack(side="left")
        ttk.Button(bottom, text="Анимация графиков", command=self.open_animation).pack(side="left", padx=(6, 0))
        ttk.Button(bottom, text="Обновить", command=self.refresh).pack(side="right")
        main.add(right, weight=2)

        self.runs: dict[str, dict] = {}
        self.visualizer_busy = False
        self.visualizer_proc: subprocess.Popen | None = None
        root.protocol("WM_DELETE_WINDOW", self.close)
        self.tick()

    def tick(self):
        self.refresh()
        self.root.after(REFRESH_MS, self.tick)

    def refresh(self):
        selected = self.selected_name()
        self.tree.delete(*self.tree.get_children())
        dirs = sorted((p for p in RUNS_DIR.iterdir() if p.is_dir()), key=lambda p: p.stat().st_ctime) if RUNS_DIR.exists() else []
        self.runs = {d.name: run_info(d) for d in dirs}
        for r in self.runs.values():
            if r["parent"] in self.runs:
                self.runs[r["parent"]]["children"].append((r["parent_update"], r["dir"].name))
        pending = list(self.runs)
        while pending:  # родитель вставляется раньше детей
            rest = []
            for name in pending:
                r = self.runs[name]
                parent = r["parent"] if r["parent"] in self.runs else ""
                if parent and not self.tree.exists(parent):
                    rest.append(name)
                    continue
                last = r["last"]
                self.tree.insert(parent, "end", iid=name, text=name, open=True, values=(
                    r["state"], f"r{r['info']['rules']}" if "rules" in r["info"] else "?",
                    f"{r['update']}/{r['total'] or '?'}", last.get("launch_rate", "—"),
                    f"{r['best']:.2f}" if r["best"] is not None else "—"))
            if len(rest) == len(pending):  # родитель удалён — показываем сиротой
                for name in rest:
                    self.runs[name]["parent"] = None
            pending = rest
        if selected and self.tree.exists(selected):
            self.tree.selection_set(selected)
        elif self.runs:
            self.tree.selection_set(next(reversed(self.runs)))
        self.show()

    def selected_name(self) -> str | None:
        sel = self.tree.selection() if hasattr(self, "tree") else ()
        return sel[0] if sel else None

    def current(self) -> dict | None:
        name = self.selected_name()
        return self.runs.get(name) if name else None

    def show(self):
        r = self.current()
        self.details.configure(state="normal")
        self.details.delete("1.0", "end")
        if not r:
            self.details.insert("end", "Запусков пока нет. Обучение запускается командой extract-moon train.")
            self.details.configure(state="disabled")
            return
        info, last = r["info"], r["last"]
        lines = [r["dir"].name, ""]
        if info.get("note"):
            lines += [f"Зачем: {info['note']}", ""]
        parent = info.get("parent")
        lines.append(f"От модели: {parent['run']}, обновление {parent['update']}" if parent else "Обучен с нуля")
        lines.append(f"Правила: r{info['rules']}" if "rules" in info else "Правила: неизвестны")
        sessions = info.get("sessions") or []
        if sessions:
            code = sessions[-1].get("code", {})
            commit = code.get("commit", "")[:7]
            lines.append(f"Код: коммит {commit}" + (" + незакоммиченные правки" if code.get("dirty") else ""))
            lines.append(f"Начат: {sessions[0].get('started', '?')}" +
                         (f", закончен: {sessions[-1]['finished']}" if sessions[-1].get("finished") else ""))
        lines.append(f"Состояние: {r['state']}, обновление {r['update']} из {r['total'] or '?'}")
        if last:
            lines += ["", "Последние 200 матчей:",
                      f"  корабль улетел: {float(last.get('launch_rate') or 0) * 100:.0f} %",
                      f"  заряд к концу матча: {float(last.get('charge_frac') or 0) * 100:.0f} %",
                      f"  пассажиров: {last.get('passengers', '—')}",
                      f"  длина матча: {last.get('ep_length', '—')} тактов",
                      f"  убийств за матч: {last.get('kills', '—')}",
                      f"  опыта: {int(last['steps']):,} робот-тактов".replace(",", " ")]
            if r["best"] is not None:
                lines.append(f"  лучшая доля взлётов за запуск: {r['best'] * 100:.0f} %")
        n_replays = len(list((r["dir"] / "replays").glob("*.jsonl.gz")))
        lines += ["", f"Матчей-этапов для проигрывателя: {n_replays}"]
        self.details.insert("end", "\n".join(lines))
        self.details.configure(state="disabled")
        self.fill_checkpoints(r)

    # ------------------------------------------------------- модели запуска

    def fill_checkpoints(self, r: dict):
        keep = self.ckpts.selection()
        keep = keep[0] if keep and keep[0].startswith(r["dir"].name + "|") else None
        self.ckpts.delete(*self.ckpts.get_children())
        by_update = {int(row["update"]): row for row in r["rows"]}
        if r["parent"] in self.runs:  # родительская модель — по метрикам родителя
            for row in self.runs[r["parent"]]["rows"]:
                if int(row["update"]) == r["parent_update"]:
                    by_update.setdefault(r["parent_update"], row)
        children = {}
        for upd, name in r["children"]:
            children.setdefault(upd, []).append(name)
        for upd, path in reversed(r["checkpoints"]):
            row = by_update.get(upd, {})
            launch_rate = row.get("launch_rate")
            label = f"{upd}" + ("  (родительская)" if r["parent"] and upd == r["parent_update"] else "")
            self.ckpts.insert("", "end", iid=f"{r['dir'].name}|{upd}", text=label, values=(
                f"{int(row['steps']):,}".replace(",", " ") if row else "—",
                f"{float(launch_rate) * 100:.0f} %" if launch_rate else "—",
                "есть" if upd in r["stages"] else "—", ", ".join(children.get(upd, [])) or "—"))
        if keep and self.ckpts.exists(keep):
            self.ckpts.selection_set(keep)
        self.draw_timeline()

    def selected_checkpoint(self) -> tuple[dict, int, Path] | None:
        r = self.current()
        sel = self.ckpts.selection()
        if not r or not sel or not sel[0].startswith(r["dir"].name + "|"):
            return None
        upd = int(sel[0].split("|")[1])
        path = dict(r["checkpoints"]).get(upd)
        return (r, upd, path) if path else None

    def branch(self, r: dict) -> list[list[dict]]:
        """Метрики запуска и его предков от корня, каждый предок до точки ветвления."""
        parts, seen, limit = [], set(), None
        while r and r["dir"].name not in seen:
            seen.add(r["dir"].name)
            parts.append([row for row in r["rows"] if limit is None or int(row["update"]) <= limit])
            limit = r["parent_update"]
            r = self.runs.get(r["parent"])
        return parts[::-1]

    @staticmethod
    def timeline_range(r: dict) -> tuple[int, int]:
        return 0, max(r["total"] or 0, r["update"], *(u for u, _ in r["checkpoints"]), 1)

    def draw_timeline(self):
        c = self.timeline
        c.delete("all")
        r = self.current()
        if not r:
            return
        W, H = max(c.winfo_width(), 200), int(c["height"])
        left, right, top, bottom = 40, 16, 24, H - 30
        lo, hi = self.timeline_range(r)

        def x(u):
            return left + (u - lo) / (hi - lo) * (W - left - right)

        def y(v):
            return bottom - v * (bottom - top)

        # Сетка и подписи: доля взлётов по вертикали, обновления по горизонтали.
        for v in (0, 0.5, 1):
            c.create_line(left, y(v), W - right, y(v), fill="#eee")
            c.create_text(left - 6, y(v), text=f"{v:.0%}", anchor="e", fill="#888", font=("Segoe UI", 8))
        step = max(50, round((hi - lo) / 8 / 50) * 50)
        for u in range((lo // step) * step, hi + 1, step):
            if u >= lo:
                c.create_line(x(u), bottom, x(u), bottom + 4, fill="#999")
                c.create_text(x(u), bottom + 6, text=str(u), anchor="n", fill="#666", font=("Segoe UI", 8))
        c.create_text(left, 2, text="доля матчей, где корабль улетел; по горизонтали — номер обновления",
                      anchor="nw", fill="#888", font=("Segoe UI", 8))
        if r["state"] == "обучается" and r["update"] < hi:
            c.create_rectangle(x(r["update"]), top, W - right, bottom, fill="#f4f4f4", outline="")
            c.create_text((x(r["update"]) + W - right) / 2, (top + bottom) / 2, text="ещё обучается",
                          fill="#aaa", font=("Segoe UI", 8))
        # Кривая склеена с предками; сглаживание идёт через стыки, чтобы на них не было ложного скачка.
        branch = self.branch(r)
        parts = [[(int(row["update"]), float(row["launch_rate"])) for row in part if reliable(row)] for part in branch]
        flat = [p for part in parts for p in part]
        smooth = ema([v for _, v in flat])
        start = 0
        for i, part in enumerate(parts):
            end = start + len(part)
            lo_i = max(start - 1, 0)  # кусок начинается с конца предыдущего, чтобы линия была сплошной
            coords = [p for (u, _), v in zip(flat[lo_i:end], smooth[lo_i:end]) for p in (x(u), y(v))]
            if len(coords) >= 4:
                c.create_line(*coords, fill=SEGMENT_COLORS[i % len(SEGMENT_COLORS)], width=2)
            start = end
        for part in branch[:-1]:
            if part:
                u = int(part[-1]["update"])
                c.create_line(x(u), top, x(u), bottom, fill="#555", dash=(4, 3))
                c.create_text(x(u) + 3, top + 1, text=f"u{u}", anchor="nw", fill="#555", font=("Segoe UI", 8))
        sel = self.selected_checkpoint()
        sel_upd = sel[1] if sel else None
        for upd, _ in r["checkpoints"]:
            px, chosen = x(upd), upd == sel_upd
            c.create_line(px, top, px, bottom, fill="#d04040" if chosen else "#d8d8d8", width=2 if chosen else 1)
            rad = 6 if chosen else 4
            fill = "#d04040" if chosen else ("#555" if upd in r["stages"] else "white")
            c.create_oval(px - rad, bottom - rad, px + rad, bottom + rad, fill=fill, outline="#555")
        for upd, name in r["children"]:
            px = x(upd)
            c.create_polygon(px, top - 9, px + 6, top - 3, px, top + 3, px - 6, top - 3, fill="#e8912d", outline="")
            c.create_text(px + 9, top - 3, text=name, anchor="w", fill="#b86a10", font=("Segoe UI", 8))
        c.create_text(W - right, H - 1, anchor="se", fill="#888", font=("Segoe UI", 8),
                      text="● модель с записанным матчем   ○ модель   ◆ дообучение от модели   клик — выбрать")

    def timeline_click(self, event):
        r = self.current()
        if not r or not r["checkpoints"]:
            return
        W = max(self.timeline.winfo_width(), 200)
        lo, hi = self.timeline_range(r)
        u = lo + (event.x - 40) / (W - 56) * (hi - lo)
        upd = min((cu for cu, _ in r["checkpoints"]), key=lambda cu: abs(cu - u))
        iid = f"{r['dir'].name}|{upd}"
        self.ckpts.selection_set(iid)
        self.ckpts.see(iid)

    def need_checkpoint(self):
        sel = self.selected_checkpoint()
        if not sel:
            messagebox.showinfo("Extract Moon", "Выберите модель в списке или на шкале.")
        return sel

    def play_model(self):
        sel = self.need_checkpoint()
        if sel:
            # На CPU: видеокарта может быть занята обучением.
            launch("record", "--checkpoint", str(sel[2]), "--seed", str(random.randint(0, 99_999)),
                   "--device", "cpu", "--view")

    def open_stage(self):
        sel = self.need_checkpoint()
        if not sel:
            return
        r, upd, _ = sel
        if upd not in r["stages"]:
            messagebox.showinfo("Extract Moon", "Для этой модели матч этапа не записан. Нажмите «Сыграть новый матч».")
            return
        launch("view", str(r["stages"][upd]))

    def copy_finetune(self):
        sel = self.need_checkpoint()
        if not sel:
            return
        r, upd, _ = sel
        name = r["dir"].name
        cmd = (f'uv run extract-moon train --run {name}-u{upd}--МЕТКА --resume {name}:{upd} '
               f'--set train.total_updates={upd + 300} --note "ЗАЧЕМ"')
        self.root.clipboard_clear()
        self.root.clipboard_append(cmd)
        messagebox.showinfo("Extract Moon", f"Команда скопирована (запускать из папки python):\n\n{cmd}")

    def need(self) -> dict | None:
        r = self.current()
        if not r:
            messagebox.showinfo("Extract Moon", "Выберите запуск в списке.")
        return r

    def open_replays(self):
        r = self.need()
        if not r:
            return
        if not list((r["dir"] / "replays").glob("*.jsonl.gz")):
            messagebox.showinfo("Extract Moon", "У этого запуска пока нет записанных матчей.")
            return
        launch("view", str(r["dir"]))

    def open_player(self):
        """Матч выбранной модели, а без выбранной модели — последний этап запуска."""
        r = self.need()
        if not r:
            return
        if not PLAYER_EXE.exists():
            messagebox.showinfo("Extract Moon", "Новый плеер не собран. Команда сборки — в player/README.md.")
            return
        sel = self.selected_checkpoint()
        if sel and sel[1] in r["stages"]:
            launch("player", str(r["stages"][sel[1]]))
        elif sel:  # у модели нет матча этапа: записываем новый, на CPU, как «Сыграть новый матч»
            launch("record", "--checkpoint", str(sel[2]), "--seed", str(random.randint(0, 99_999)),
                   "--device", "cpu", "--player")
        elif list((r["dir"] / "replays").glob("*.jsonl.gz")):
            launch("player", str(r["dir"]))
        else:
            messagebox.showinfo("Extract Moon", "У этого запуска пока нет записанных матчей.")

    def open_metrics(self):
        r = self.need()
        if r:
            launch("watch", str(r["dir"]))

    def compare(self):
        r = self.need()
        if not r:
            return
        parent = (r["info"].get("parent") or {}).get("run")
        if not parent or parent not in self.runs:
            messagebox.showinfo("Extract Moon", "Этот запуск обучен с нуля — сравнивать не с чем.")
            return
        launch("watch", str(self.runs[parent]["dir"]), str(r["dir"]))

    def open_folder(self):
        r = self.need()
        if r:
            self.open_path(r["dir"])

    def open_animation(self):
        r = self.need()
        if not r:
            return
        if not r["rows"]:
            messagebox.showinfo("Extract Moon", "У этого запуска пока нет метрик.")
            return
        MetricsPlayer(self.root, r)

    def open_launch_animation(self):
        """Анимация графика взлётов, который виден на шкале моделей."""
        r = self.need()
        if not r:
            return
        if not any(self.branch(r)):
            messagebox.showinfo("Extract Moon", "У этого запуска пока нет метрик.")
            return
        MetricsPlayer(self.root, r, LAUNCH_PANEL)

    def open_visualizer(self):
        """Открывает работающий сервис; если его нет, поднимает его в фоне и ждёт готовности."""
        if self.visualizer_busy:
            return
        self.visualizer_busy = True

        def finished(kind, value):
            self.visualizer_busy = False
            if kind == "error":
                messagebox.showerror("Extract Moon", f"Не удалось запустить визуализатор:\n{value}")
                return
            url, proc = value
            if proc:
                self.visualizer_proc = proc
            webbrowser.open(url)

        in_background(self.root, lambda _: ensure_service(), finished)

    def close(self):
        # Сервис, запущенный этим проводником, живёт не дольше него: скрытый процесс некому остановить.
        if self.visualizer_proc:
            self.visualizer_proc.terminate()
        self.root.destroy()

    @staticmethod
    def open_path(path):
        os.startfile(path)  # noqa: S606 — открыть в программе по умолчанию (Windows)


class MetricsPlayer:
    """Окно с графиками запуска: линии строятся от первого обновления к последнему."""

    def __init__(self, root: tk.Tk, r: dict, panel: int | None = None):
        from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
        from matplotlib.figure import Figure

        self.root, self.run, self.panel = root, r, panel
        self.win = tk.Toplevel(root)
        self.win.title(f"Анимация графиков: {r['dir'].name}")
        self.win.protocol("WM_DELETE_WINDOW", self.close)

        # Пропорции как у окна «Графики», масштаб под экран.
        dpi = min(100, (root.winfo_screenwidth() - 60) / 19, (root.winfo_screenheight() - 180) / 11)
        self.fig = Figure(figsize=(19, 11), dpi=dpi)
        self.canvas = FigureCanvasTkAgg(self.fig, master=self.win)
        self.anim = MetricsAnimation(self.fig, str(r["dir"]), panel)
        self.fig.set_layout_engine("tight")  # подписи не наезжают друг на друга после изменения размера окна

        controls = ttk.Frame(self.win, padding=6)
        controls.pack(side="bottom", fill="x")
        self.titles = [ALL_PANELS] + [title for title, _, _ in all_panels(str(r["dir"]))]
        self.choice = tk.StringVar(value=self.titles[0 if panel is None else panel + 1])
        chooser = ttk.Combobox(controls, textvariable=self.choice, values=self.titles, state="readonly", width=30)
        chooser.pack(side="left", padx=(0, 6))
        chooser.bind("<<ComboboxSelected>>", lambda _: self.switch())
        self.play_button = ttk.Button(controls, text="Проиграть", command=self.toggle)
        self.play_button.pack(side="left", padx=(0, 6))
        self.last = len(self.anim.marks) - 1
        self.scale = ttk.Scale(controls, from_=0, to=max(self.last, 1), command=self.seek)
        self.scale.pack(side="left", fill="x", expand=True, padx=(0, 10))
        ttk.Label(controls, text="Обновлений в секунду:").pack(side="left", padx=(0, 4))
        self.speed = tk.StringVar(value=str(DEFAULT_SPEED))
        ttk.Spinbox(controls, from_=1, to=300, increment=5, width=6, textvariable=self.speed).pack(side="left", padx=(0, 10))
        ttk.Button(controls, text="Экспорт анимации", command=self.export).pack(side="left")
        self.canvas.get_tk_widget().pack(fill="both", expand=True)

        self.pos = float(self.last)  # сначала весь график, «Проиграть» начинает с первого обновления
        self.stamp = 0.0
        self.job = None
        self.render()

    def switch(self):
        """Другой график: все или один. Положение сбрасывается на конец, как при открытии окна."""
        self.stop()
        index = self.titles.index(self.choice.get())
        self.panel = index - 1 if index else None
        self.anim.close()
        self.anim = MetricsAnimation(self.fig, str(self.run["dir"]), self.panel)
        self.pos = float(self.last)
        self.render()

    def render(self):
        self.anim.show(int(self.pos))
        self.canvas.blit(self.fig.bbox)
        self.scale.set(self.pos)

    def seek(self, value):
        if abs(float(value) - self.pos) < 1e-6:  # scale.set из render вызывает этот же обработчик
            return
        self.pos = min(float(value), self.last)
        self.stamp = time.perf_counter()
        self.render()

    def toggle(self):
        if self.job:
            self.stop()
            return
        if self.pos >= self.last:
            self.pos = 0.0
        self.stamp = time.perf_counter()
        self.play_button.configure(text="Пауза")
        self.step()

    def stop(self):
        if self.job:
            self.win.after_cancel(self.job)
        self.job = None
        self.play_button.configure(text="Проиграть")

    def step(self):
        now = time.perf_counter()
        # По реальному времени: если кадр рисовался долго, скорость всё равно та, что выбрана.
        self.pos = min(self.pos + (parse_speed(self.speed.get()) or DEFAULT_SPEED) * (now - self.stamp), self.last)
        self.stamp = now
        self.render()
        if self.pos < self.last:
            self.job = self.win.after(FRAME_MS, self.step)
        else:
            self.job = None
            self.stop()

    def export(self):
        ExportDialog(self.root, self.run, parse_speed(self.speed.get()) or DEFAULT_SPEED, len(self.anim.marks), self.panel)

    def close(self):
        self.stop()
        self.win.destroy()


class ExportDialog:
    """Параметры экспорта графиков в MP4. Видео собирает отдельный процесс, окна проводника не ждут его."""

    def __init__(self, root: tk.Tk, r: dict, speed: float, updates: int, panel: int | None = None):
        self.root, self.run, self.updates, self.panel = root, r, updates, panel
        self.win = tk.Toplevel(root)
        self.win.title("Экспорт анимации")
        self.win.resizable(False, False)
        frame = ttk.Frame(self.win, padding=12)
        frame.pack(fill="both", expand=True)

        ttk.Label(frame, text="Обновлений в секунду:").grid(row=0, column=0, sticky="w", pady=(0, 6))
        self.speed = tk.StringVar(value=f"{speed:g}")
        ttk.Spinbox(frame, from_=1, to=300, increment=5, width=8, textvariable=self.speed).grid(
            row=0, column=1, sticky="w", pady=(0, 6))
        self.duration = ttk.Label(frame, foreground="#666")
        self.duration.grid(row=0, column=2, sticky="w", padx=(8, 0), pady=(0, 6))
        self.speed.trace_add("write", lambda *_: self.show_duration())

        ttk.Label(frame, text="Файл:").grid(row=1, column=0, sticky="w")
        self.path = tk.StringVar(value=str(r["dir"] / ("metrics.mp4" if panel is None else f"metrics_{panel + 1}.mp4")))
        ttk.Entry(frame, textvariable=self.path, width=60).grid(row=1, column=1, columnspan=2, sticky="ew")
        ttk.Button(frame, text="Обзор", command=self.browse).grid(row=1, column=3, padx=(6, 0))

        self.bar = ttk.Progressbar(frame, maximum=1.0)
        self.bar.grid(row=2, column=0, columnspan=4, sticky="ew", pady=(10, 4))
        self.status = ttk.Label(frame, text="", wraplength=560)
        self.status.grid(row=3, column=0, columnspan=4, sticky="w")

        buttons = ttk.Frame(frame)
        buttons.grid(row=4, column=0, columnspan=4, sticky="e", pady=(10, 0))
        self.save_button = ttk.Button(buttons, text="Сохранить", command=self.start)
        self.save_button.pack(side="left", padx=(0, 6))
        self.open_button = ttk.Button(buttons, text="Открыть файл", state="disabled", command=self.open_result)
        self.open_button.pack(side="left", padx=(0, 6))
        ttk.Button(buttons, text="Закрыть", command=self.win.destroy).pack(side="left")
        self.show_duration()

    def seconds(self, speed: float) -> float:
        return (self.updates - 1) / speed

    def show_duration(self):
        speed = parse_speed(self.speed.get())
        self.duration.configure(text=f"видео на {self.seconds(speed):.1f} с, обновлений {self.updates}" if speed
                                else "скорость должна быть больше нуля")

    def browse(self):
        current = Path(self.path.get())
        name = filedialog.asksaveasfilename(parent=self.win, title="Сохранить видео", defaultextension=".mp4",
                                            filetypes=[("Видео MP4", "*.mp4")], initialdir=current.parent,
                                            initialfile=current.name)
        if name:
            self.path.set(name)

    def start(self):
        speed = parse_speed(self.speed.get())
        out = self.path.get().strip()
        if not speed:
            messagebox.showinfo("Extract Moon", "Скорость должна быть числом больше нуля.", parent=self.win)
            return
        if not out:
            messagebox.showinfo("Extract Moon", "Выберите файл.", parent=self.win)
            return
        self.result = Path(out)
        self.save_button.configure(state="disabled")
        self.open_button.configure(state="disabled")
        self.bar.configure(value=0)
        self.status.configure(text="Подготовка графиков…")
        in_background(self.root, lambda emit: export_process(self.run["dir"], self.result, speed, self.panel, emit),
                      self.on_event)

    def on_event(self, kind, value):
        alive = self.win.winfo_exists()
        if kind == "progress":
            if alive:
                self.bar.configure(value=value[0] / value[1])
                self.status.configure(text=f"Кадр {value[0]} из {value[1]}")
            return
        if not alive:  # окно закрыли во время экспорта: итог всё равно нужно показать
            if kind == "error":
                messagebox.showerror("Extract Moon", f"Экспорт не удался:\n{value}")
            else:
                messagebox.showinfo("Extract Moon", f"Видео сохранено: {self.result}")
            return
        self.save_button.configure(state="normal")
        if kind == "error":
            self.status.configure(text=f"Экспорт не удался: {value}")
        else:
            self.bar.configure(value=1.0)
            self.status.configure(text=f"Готово: {self.result}")
            self.open_button.configure(state="normal")

    def open_result(self):
        os.startfile(self.result)  # noqa: S606 — открыть в программе по умолчанию (Windows)


def run_explorer() -> None:
    root = tk.Tk()
    Explorer(root)
    root.mainloop()
