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

SYMBOLS = "αβγδεζηθικλμνξοπ"

# (заголовок, пояснение, [(колонка, подпись линии)]). Всё «за матч» — среднее по последним 200 матчам.
PANELS = [
    ("Средняя награда робота за такт", "все награды и штрафы ÷ такты роботов", [("reward_per_step", None)]),
    ("Матчи, где корабль улетел", "доля от последних 200 матчей, 1 = всегда", [("launch_rate", None)]),
    ("Заряд корабля к концу матча", "доля от нужной энергии, 1 = полностью", [("charge_frac", None)]),
    ("Пассажиров в корабле", "сколько роботов улетело за матч", [("passengers", None)]),
    ("Длина матча, тактов", "короче — корабль заряжают быстрее", [("ep_length", None)]),
    ("Роботов в матче", "живых, включая пассажиров", [("pop_max", "макс."), ("pop_mean", "среднее"), ("pop_min", "мин.")]),
    ("Убийств за матч", "пассажиры — атакованные в корабле", [("kills", "всего"), ("passenger_kills", "пассажиров")]),
    ("Рождений за матч", "", [("births", None)]),
    ("Передач энергии за матч", "робот отдаёт энергию союзнику", [("gives", None)]),
    ("Случайность решений", "энтропия: выше — сеть чаще выбирает наугад", [("entropy", None)]),
    ("Ошибка прогноза награды", "сеть предсказывает свою награду — это её ошибка", [("value_loss", None)]),
    ("Изменение сети за обновление", "KL: сдвиг вероятностей действий", [("approx_kl", None)]),
]


def signal_panel(n: int) -> tuple:
    """Все символы на одном графике: у каждого своя линия."""
    return ("Сигналов за матч по символам", "сколько раз подан каждый символ",
            [(f"sig_{i + 1}", SYMBOLS[i]) for i in range(n)])


def line_style(i_run: int, j_key: int, n_runs: int, n_keys: int) -> tuple[str, str]:
    """Цвет и тип линии. На графике с многими линиями цвет — линия, тип — запуск."""
    if n_keys > 3:
        return f"C{j_key % 10}", ["-", "--", ":", "-."][(i_run + j_key // 10) % 4]
    if n_runs > 1:
        return f"C{i_run}", ["-", "--", ":"][j_key % 3]
    return f"C{j_key}", "-"


def n_symbols(names: list[str]) -> int:
    for name in names:
        cfg = run_dir(name) / "config.json"
        if cfg.exists():
            return json.loads(cfg.read_text(encoding="utf-8"))["world"]["signal_symbols"]
    return 8


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
    if len(recent) > 1 and total and upd < total:
        per_update = (float(recent[-1]["time"]) - float(recent[0]["time"])) / (
            int(recent[-1]["update"]) - int(recent[0]["update"]))
        text += f", осталось ≈ {per_update * (total - upd) / 60:.0f} мин"
    ago = time.time() - (d / "metrics.csv").stat().st_mtime
    if ago > 120 and total and upd < total:
        text += f", последняя запись {ago / 60:.0f} мин назад"
    elif total and upd >= total:
        text += ", завершено"
    return text


def draw(fig, names: list[str]) -> None:
    fig.clf()
    panels = PANELS + [signal_panel(n_symbols(names))]
    cols = 5
    axes = fig.subplots((len(panels) + cols - 1) // cols, cols, squeeze=False).flatten().tolist()
    lines = []
    for i, name in enumerate(names):
        rows = load_metrics(name)
        lines.append(summary(name, rows))
        for ax, (_, _, keys) in zip(axes, panels):
            for j, (key, label) in enumerate(keys):
                xs, ys = series(rows, key)
                if not xs:
                    continue
                color, ls = line_style(i, j, len(names), len(keys))
                if len(names) == 1 and len(keys) == 1:
                    ax.plot(xs, ys, color=color, alpha=0.25, lw=0.8)
                if len(keys) > 3:
                    tag = label if i == 0 else None  # типы линий запусков подписаны на первом графике
                else:
                    tag = run_dir(name).name if len(names) > 1 else label
                ax.plot(xs, ema(ys), color=color, lw=1.4, label=tag, ls=ls)
    for ax, (title, note, keys) in zip(axes, panels):
        if len(keys) > 3 and len(names) > 1:
            note = ", ".join(f"{['—', '--', '··', '-·'][i % 4]} {run_dir(n).name}" for i, n in enumerate(names))
        ax.set_title(title + (f"\n{note}" if note else ""), fontsize=9)
        ax.grid(alpha=0.3)
        ax.tick_params(labelsize=7)
        ax.xaxis.get_offset_text().set_fontsize(7)
        if len(keys) > 3 and ax.lines:
            ax.legend(fontsize=7, ncol=2 if len(keys) <= 8 else 4, handlelength=1.5, columnspacing=0.8)
        elif len(keys) > 1 and ax.lines and len(names) == 1:
            ax.legend(fontsize=7)
    for ax in axes[len(panels):]:
        ax.set_visible(False)
    if len(names) > 1:
        axes[0].legend(fontsize=8)
    fig.supxlabel("робот-тактов опыта", fontsize=9)
    fig.suptitle("\n".join(lines), fontsize=10)
    fig.tight_layout()


def plot(names: list[str], out: Path | None = None) -> Path:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig = plt.figure(figsize=(19, 11))
    draw(fig, names)
    out = out or (run_dir(names[0]) / "metrics.png")
    fig.savefig(out, dpi=100)
    plt.close(fig)
    return out


def watch(names: list[str], interval: float = 5.0) -> None:
    import matplotlib.pyplot as plt

    plt.ion()
    fig = plt.figure(figsize=(19, 11))
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
