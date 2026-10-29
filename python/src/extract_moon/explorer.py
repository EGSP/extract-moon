"""Проводник запусков: дерево запусков и кнопки, открывающие их матчи и графики.

Дообученные запуски показаны веткой под родителем. У выбранного запуска —
сохранённые модели на шкале обновлений поверх кривой взлётов: видно, какая
модель была удачной и от какой пошли дообученные ветки. Проигрыватель и
графики открываются отдельными окнами. Список обновляется сам.
"""

from __future__ import annotations

import os
import random
import re
import subprocess
import sys
import time
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, ttk

from . import provenance
from .metrics_view import ema, load_metrics
from .paths import DATA_DIR, RUNS_DIR

REFRESH_MS = 10_000
# Доля взлётов по меньшему числу матчей слишком шумная: в начале запуска это 1-2 матча.
MIN_EPISODES = 50
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
        for text, cmd in (("Матчи", self.open_replays), ("Графики", self.open_metrics),
                          ("Сравнить с родителем", self.compare), ("Папка", self.open_folder)):
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
                          ("Команда дообучения", self.copy_finetune)):
            ttk.Button(actions, text=text, command=cmd).pack(side="left", padx=(0, 6))
        self.details = tk.Text(right, wrap="word", font=("Segoe UI", 10), relief="flat", background="#f6f6f8",
                               padx=10, pady=8, height=12)
        self.details.pack(fill="both", expand=True, pady=(8, 0))
        bottom = ttk.Frame(right)
        bottom.pack(fill="x", pady=(8, 0))
        ttk.Button(bottom, text="Журнал запусков", command=lambda: self.open_path(DATA_DIR / "journal.md")).pack(side="left")
        ttk.Button(bottom, text="Обновить", command=self.refresh).pack(side="right")
        main.add(right, weight=2)

        self.runs: dict[str, dict] = {}
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

    @staticmethod
    def timeline_range(r: dict) -> tuple[int, int]:
        lo = r["parent_update"] if r["parent"] else 0
        hi = max(r["total"] or 0, r["update"], *(u for u, _ in r["checkpoints"]), lo + 1)
        return lo, hi

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
        pts = [(int(row["update"]), float(row["launch_rate"])) for row in r["rows"] if reliable(row)]
        if len(pts) > 1:
            smooth = ema([v for _, v in pts])
            coords = [p for (u, _), v in zip(pts, smooth) for p in (x(u), y(v))]
            c.create_line(*coords, fill="#5b9bd5", width=2)
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

    @staticmethod
    def open_path(path):
        os.startfile(path)  # noqa: S606 — открыть в программе по умолчанию (Windows)


def run_explorer() -> None:
    root = tk.Tk()
    Explorer(root)
    root.mainloop()
