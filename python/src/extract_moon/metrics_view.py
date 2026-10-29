"""Просмотр обучения: графики метрик одного или нескольких запусков.

`plot` сохраняет PNG, `watch` открывает окно и перерисовывает его, пока идёт
обучение (metrics.csv перечитывается каждые несколько секунд).
"""

from __future__ import annotations

import csv
import json
import time
from pathlib import Path

from .paths import RUNS_DIR

PANELS = [
    ("reward_per_step", "Награда за такт"),
    ("launch_rate", "Доля улетевших кораблей"),
    ("charge_frac", "Заряд корабля к концу матча"),
    ("passengers", "Пассажиров за матч"),
    ("ep_length", "Длина матча, тактов"),
    ("kills", "Убийств за матч"),
    ("signals", "Сигналов за матч"),
    ("births", "Рождений за матч"),
    ("gives", "Передач энергии за матч"),
    ("entropy", "Энтропия политики"),
    ("value_loss", "Ошибка критика"),
    ("approx_kl", "KL между политиками"),
]


def run_dir(name: str) -> Path:
    p = Path(name)
    return p if p.is_dir() else RUNS_DIR / name


def load_metrics(name: str) -> list[dict]:
    path = run_dir(name) / "metrics.csv"
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


def series(rows: list[dict], key: str) -> tuple[list[int], list[float]]:
    xs, ys = [], []
    for r in rows:
        v = r.get(key)
        if v not in (None, ""):
            xs.append(int(r["steps"]))
            ys.append(float(v))
    return xs, ys


def ema(ys: list[float], alpha: float = 0.1) -> list[float]:
    out, m = [], None
    for y in ys:
        m = y if m is None else m + alpha * (y - m)
        out.append(m)
    return out


def summary(name: str, rows: list[dict]) -> str:
    """Строка состояния запуска: прогресс, скорость, оценка оставшегося времени."""
    d = run_dir(name)
    if not rows:
        return f"{d.name}: метрик пока нет"
    last = rows[-1]
    total = None
    cfg = d / "config.json"
    if cfg.exists():
        total = json.loads(cfg.read_text(encoding="utf-8"))["train"]["total_updates"]
    upd = int(last["update"])
    text = f"{d.name}: обновление {upd}" + (f"/{total}" if total else "")
    text += f", {int(last['steps']):,} робот-тактов, {last['sps']} такт/с".replace(",", " ")
    recent = [r for r in rows[-20:] if r.get("time")]
    if len(recent) > 1 and total:
        per_update = (float(recent[-1]["time"]) - float(recent[0]["time"])) / (
            int(recent[-1]["update"]) - int(recent[0]["update"]))
        text += f", осталось ≈ {per_update * (total - upd) / 60:.0f} мин"
    ago = time.time() - (d / "metrics.csv").stat().st_mtime
    if ago > 120:
        text += f", последняя запись {ago / 60:.0f} мин назад"
    return text


def draw(fig, names: list[str]) -> None:
    fig.clf()
    axes = fig.subplots(3, 4)
    lines = []
    for i, name in enumerate(names):
        rows = load_metrics(name)
        lines.append(summary(name, rows))
        color = f"C{i}"
        for ax, (key, title) in zip(axes.flat, PANELS):
            xs, ys = series(rows, key)
            if xs:
                if len(names) == 1:
                    ax.plot(xs, ys, color=color, alpha=0.25, lw=0.8)
                ax.plot(xs, ema(ys), color=color, lw=1.6, label=run_dir(name).name)
    for ax, (_, title) in zip(axes.flat, PANELS):
        ax.set_title(title, fontsize=10)
        ax.grid(alpha=0.3)
        ax.tick_params(labelsize=8)
        ax.xaxis.get_offset_text().set_fontsize(7)
    if len(names) > 1:
        axes.flat[0].legend(fontsize=8)
    fig.suptitle("\n".join(lines), fontsize=10)
    fig.tight_layout()


def plot(names: list[str], out: Path | None = None) -> Path:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig = plt.figure(figsize=(18, 10))
    draw(fig, names)
    out = out or (run_dir(names[0]) / "metrics.png")
    fig.savefig(out, dpi=100)
    plt.close(fig)
    return out


def watch(names: list[str], interval: float = 5.0) -> None:
    import matplotlib.pyplot as plt

    plt.ion()
    fig = plt.figure(figsize=(18, 10))
    fig.canvas.manager.set_window_title("Extract Moon — обучение")
    stamp = None
    while plt.fignum_exists(fig.number):
        files = [run_dir(n) / "metrics.csv" for n in names]
        new = tuple(f.stat().st_mtime if f.exists() else 0 for f in files)
        if new != stamp:
            stamp = new
            draw(fig, names)
            fig.canvas.draw_idle()
        plt.pause(interval)
