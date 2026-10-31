"""Просмотр обучения: графики метрик одного или нескольких запусков.

`plot` сохраняет PNG, `watch` открывает окно и перерисовывает его, пока идёт
обучение (metrics.csv перечитывается каждые несколько секунд). Один запуск показан
склеенным с предками, с отметками ветвлений. `MetricsAnimation` проигрывает графики
от первого обновления к последнему, все или один, `export_animation` сохраняет
это проигрывание в MP4.
"""

from __future__ import annotations

import csv
import json
import time
from bisect import bisect_right
from pathlib import Path

from .paths import RUNS_DIR

SYMBOLS = "αβγδεζηθικλμνξοπ"
MIN_EPISODES = 50  # меньше — доля взлётов ещё шумная
# Считаются по тактам обновления, а не по окну последних матчей.
STEP_KEYS = {"reward_per_step", "entropy", "value_loss", "approx_kl"}

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
    steps = f"{int(last['steps']):,}".replace(",", " ")
    text += f", {steps} робот-тактов, {last['sps']} такт/с"
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


def lineage(name: str) -> list[tuple[str, list[dict]]]:
    """Запуск и его предки от корня: (имя, метрики до обновления, с которого пошёл потомок)."""
    chain, seen, limit, d = [], set(), None, run_dir(name)
    while d.name not in seen:
        seen.add(d.name)
        rows = load_metrics(str(d))
        chain.append((d.name, rows if limit is None else [r for r in rows if int(r["update"]) <= limit]))
        info = d / "run.json"
        parent = json.loads(info.read_text(encoding="utf-8")).get("parent") if info.exists() else None
        if not parent or not parent.get("run") or not (d.parent / parent["run"]).is_dir():
            break
        d, limit = d.parent / parent["run"], parent["update"]
    return chain[::-1]


def chain_series(rows: list[dict], key: str) -> tuple[list[int], list[float]]:
    """Как series, но без значений по нескольким матчам: окно из 200 матчей копится заново после ветвления."""
    if key not in STEP_KEYS:
        rows = [r for r in rows if r.get("episodes") in (None, "") or int(r["episodes"]) >= MIN_EPISODES]
    return series(rows, key)


def segment_label(chain: list[tuple[str, list[dict]]], i: int) -> str:
    name, parent = chain[i][0], chain[i - 1][0] if i else ""
    return name.removeprefix(f"{parent}-") if parent else name


def draw_chain(ax, chain: list[tuple[str, list[dict]]], keys: list[tuple]) -> None:
    """Панель склеенной ветки. Сглаживание идёт через стыки, чтобы на них не было ложного скачка."""
    for j, (key, label) in enumerate(keys):
        parts = [chain_series(rows, key) for _, rows in chain]
        xs = [x for part in parts for x in part[0]]
        ys = [y for part in parts for y in part[1]]
        if not xs:
            continue
        smooth = ema(ys)
        if len(keys) > 1:
            ax.plot(xs, smooth, color=f"C{j % 10}", lw=1.4, label=label)
            continue
        ax.plot(xs, ys, color="#888888", alpha=0.25, lw=0.8)
        start = 0
        for i, part in enumerate(parts):
            end = start + len(part[0])
            if end > start:
                lo = max(start - 1, 0)  # кусок начинается с конца предыдущего, чтобы линия была сплошной
                ax.plot(xs[lo:end], smooth[lo:end], color=f"C{i % 10}", lw=1.4, label=segment_label(chain, i))
                if i and start:
                    ax.plot([xs[start - 1]], [smooth[start - 1]], "o", color="black", ms=4)
            start = end
    for _, rows in chain[:-1]:
        if rows:
            ax.axvline(int(rows[-1]["steps"]), color="#555555", ls="--", lw=0.8)
            ax.text(int(rows[-1]["steps"]), 0.98, f" u{rows[-1]['update']}", transform=ax.get_xaxis_transform(),
                    fontsize=6, va="top", color="#555555")


def all_panels(name: str) -> list[tuple]:
    return PANELS + [signal_panel(n_symbols([name]))]


def draw_branch(fig, name: str, panel: int | None = None) -> None:
    """Графики запуска, склеенные с предками: все или один с номером panel."""
    fig.clf()
    chain = lineage(name)
    panels = all_panels(name)
    if panel is not None:
        panels = [panels[panel]]
    cols = 5 if len(panels) > 1 else 1
    axes = fig.subplots((len(panels) + cols - 1) // cols, cols, squeeze=False).flatten().tolist()
    for ax, (title, note, keys) in zip(axes, panels):
        draw_chain(ax, chain, keys)
        ax.set_title(title + (f"\n{note}" if note else ""), fontsize=9)
        ax.grid(alpha=0.3)
        ax.tick_params(labelsize=7)
        ax.xaxis.get_offset_text().set_fontsize(7)
        # Подписи кусков ветки достаточно показать на взлётах.
        shown = len(keys) > 1 or keys[0][0] == "launch_rate" and len(chain) > 1
        if shown and ax.get_legend_handles_labels()[0]:
            ax.legend(fontsize=7, ncol=1 if len(keys) == 1 else 2 if len(keys) <= 8 else 4,
                      handlelength=1.5, columnspacing=0.8)
    for ax in axes[len(panels):]:
        ax.set_visible(False)
    fig.supxlabel("робот-тактов опыта", fontsize=9)
    title = summary(name, load_metrics(name))
    if len(chain) > 1:
        title = "Вся ветка: " + " → ".join(segment_label(chain, i) for i in range(len(chain))) + "\n" + title
    fig.suptitle(title, fontsize=10)
    fig.tight_layout()


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


def draw_view(fig, names: list[str], own: bool) -> None:
    """Обычный вид: один запуск склеен с предками, несколько сравниваются; own показывает только сам запуск."""
    if own or len(names) > 1:
        draw(fig, names)
    else:
        draw_branch(fig, names[0])


def plot(names: list[str], out: Path | None = None, own: bool = False) -> Path:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig = plt.figure(figsize=(19, 11))
    draw_view(fig, names, own)
    out = out or (run_dir(names[0]) / "metrics.png")
    fig.savefig(out, dpi=100)
    plt.close(fig)
    return out


class MetricsAnimation:
    """Склеенные графики запуска, линии которых строятся от первого обновления к последнему.

    Оси, сетка и подписи один раз попадают в фон с конечным масштабом, а на кадр
    перерисовываются только линии: полная отрисовка тринадцати графиков слишком долгая.
    Работает и в окне (show, затем canvas.blit), и без него (rgb).
    """

    def __init__(self, fig, name: str, panel: int | None = None):
        rows = [row for _, part in lineage(name) for row in part]
        if not rows:
            raise ValueError(f"нет метрик: {name}")
        self.marks = [(int(r["update"]), int(r["steps"])) for r in rows]
        self.fig, self.canvas = fig, fig.canvas
        draw_branch(fig, name, panel)
        self.lines = []
        for ax in fig.axes:
            for line in ax.get_lines():
                line.set_animated(True)
                self.lines.append((line, list(line.get_xdata()), list(line.get_ydata())))
        self.label = fig.text(0.995, 0.99, "", ha="right", va="top", fontsize=10, animated=True)
        self.background = None
        self.frame = len(self.marks) - 1
        self.handlers = [self.canvas.mpl_connect("draw_event", self._on_draw),
                         self.canvas.mpl_connect("resize_event", self._on_resize)]

    def close(self) -> None:
        for handler in self.handlers:
            self.canvas.mpl_disconnect(handler)

    def _on_draw(self, _event) -> None:
        self.background = self.canvas.copy_from_bbox(self.fig.bbox)
        self._paint()

    def _on_resize(self, _event) -> None:
        self.background = None

    def _paint(self) -> None:
        update, steps = self.marks[self.frame]
        for line, xs, ys in self.lines:
            n = bisect_right(xs, steps)
            line.set_data(xs[:n], ys[:n])
            line.axes.draw_artist(line)
        self.label.set_text(f"обновление {update}")
        self.fig.draw_artist(self.label)

    def show(self, frame: int) -> None:
        """Рисует графики на момент обновления с индексом frame в metrics.csv."""
        self.frame = frame
        if self.background is None:
            self.canvas.draw()  # _on_draw сохранит фон и нарисует кадр
        else:
            self.canvas.restore_region(self.background)
            self._paint()

    def rgb(self) -> bytes:
        import numpy as np

        return np.asarray(self.canvas.buffer_rgba())[:, :, :3].tobytes()


def frame_count(updates: int, speed: float, fps: int) -> int:
    """Кадров видео при speed обновлений в секунду; последний кадр показывает конечное обновление."""
    return max(round((updates - 1) / speed * fps), 1) + 1


def export_animation(name: str, out: Path, speed: float = 30, fps: int = 30, progress=None,
                     panel: int | None = None) -> Path:
    """MP4, в котором графики запуска (или один с номером panel) строятся за (обновлений - 1) / speed секунд."""
    from matplotlib.backends.backend_agg import FigureCanvasAgg
    from matplotlib.figure import Figure

    from .video import encoder

    fig = Figure(figsize=(19, 11) if panel is None else (12, 7), dpi=100)
    FigureCanvasAgg(fig)
    anim = MetricsAnimation(fig, name, panel)
    last = len(anim.marks) - 1
    total = frame_count(len(anim.marks), speed, fps)
    width, height = fig.canvas.get_width_height()
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with encoder(out, width, height, fps) as write:
        for j in range(total):
            anim.show(round(j * last / (total - 1)))
            write(anim.rgb())
            if progress and (j % 20 == 0 or j == total - 1):
                progress(j + 1, total)
    return out


def watch(names: list[str], interval: float = 5.0, own: bool = False) -> None:
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
            draw_view(fig, names, own)
            fig.canvas.draw_idle()
        plt.pause(interval)
