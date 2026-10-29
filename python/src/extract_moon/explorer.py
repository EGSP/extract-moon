"""Проводник запусков: дерево запусков и кнопки, открывающие их матчи и графики.

Дообученные запуски показаны веткой под родителем. Проигрыватель и графики
открываются отдельными окнами, поэтому можно смотреть несколько запусков сразу.
Список обновляется сам: видно, какие запуски сейчас обучаются.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
import tkinter as tk
from tkinter import messagebox, ttk

from . import provenance
from .metrics_view import load_metrics
from .paths import DATA_DIR, RUNS_DIR

REFRESH_MS = 10_000


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
    best = max((float(r["launch_rate"]) for r in rows if r.get("launch_rate")), default=None)
    return {"dir": d, "info": info, "last": last, "total": total, "state": state, "update": upd, "best": best,
            "parent": (info.get("parent") or {}).get("run")}


def launch(*args: str) -> None:
    # Отдельный процесс: окно проигрывателя или графиков не блокирует проводник.
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.Popen([sys.executable, "-m", "extract_moon.cli", *args], creationflags=flags)


class Explorer:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("Extract Moon — запуски")
        root.geometry("1280x660")
        style = ttk.Style()
        style.configure("Treeview", rowheight=26, font=("Segoe UI", 10))
        style.configure("Treeview.Heading", font=("Segoe UI", 10, "bold"))
        style.configure("TButton", font=("Segoe UI", 10), padding=6)

        main = ttk.PanedWindow(root, orient="horizontal")
        main.pack(fill="both", expand=True, padx=8, pady=8)

        left = ttk.Frame(main)
        cols = ("state", "rules", "progress", "launch", "best")
        self.tree = ttk.Treeview(left, columns=cols, selectmode="browse")
        for col, title, w in (("#0", "Запуск", 230), ("state", "Состояние", 100), ("rules", "Правила", 70),
                              ("progress", "Обновлений", 100), ("launch", "Взлёты сейчас", 110),
                              ("best", "Лучшие взлёты", 110)):
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
        self.details = tk.Text(right, wrap="word", font=("Segoe UI", 10), relief="flat", background="#f6f6f8",
                               padx=10, pady=8)
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
