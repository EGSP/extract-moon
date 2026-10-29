"""Командная строка: extract-moon train | watch | plot | record | view | gif."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .config import Config
from .paths import REPLAYS_DIR, RUNS_DIR


def resolve_checkpoint(value: str | None) -> Path | None:
    """Принимает путь к .pt или имя запуска (тогда берётся его latest.pt)."""
    if not value:
        return None
    p = Path(value)
    if p.exists():
        return p
    run = RUNS_DIR / value / "checkpoints" / "latest.pt"
    if run.exists():
        return run
    raise FileNotFoundError(f"чекпойнт не найден: {value}")


def main(argv: list[str] | None = None) -> None:
    sys.stdout.reconfigure(errors="replace")  # консоль Windows может быть в cp1251
    ap = argparse.ArgumentParser(prog="extract-moon")
    sub = ap.add_subparsers(dest="cmd", required=True)

    t = sub.add_parser("train", help="обучить политику PPO")
    t.add_argument("--run", default=None, help="имя запуска (по умолчанию — дата и время)")
    t.add_argument("--config", type=Path, default=None, help="JSON-конфиг")
    t.add_argument("--resume", default=None, help="продолжить с чекпойнта или запуска")
    t.add_argument("--set", nargs="*", default=[], metavar="SECTION.KEY=VALUE", help="переопределить параметры")

    r = sub.add_parser("record", help="записать реплей матча")
    r.add_argument("--checkpoint", default=None, help="путь к .pt или имя запуска; без него — необученная сеть")
    r.add_argument("--seed", type=int, default=0, help="seed карты")
    r.add_argument("--out", type=Path, default=None)
    r.add_argument("--greedy", action="store_true", help="выбирать самое вероятное действие")

    w = sub.add_parser("watch", help="живые графики обучения (одного или нескольких запусков)")
    w.add_argument("runs", nargs="+", help="имена запусков в data/runs или пути к ним")
    w.add_argument("--interval", type=float, default=5.0, help="период обновления, с")

    p = sub.add_parser("plot", help="сохранить графики обучения в PNG")
    p.add_argument("runs", nargs="+")
    p.add_argument("--out", type=Path, default=None)

    v = sub.add_parser("view", help="открыть реплей, папку реплеев или все этапы запуска")
    v.add_argument("replay", help="файл .jsonl.gz, папка или имя запуска")
    v.add_argument("--cell", type=int, default=28)

    g = sub.add_parser("gif", help="экспортировать реплей в GIF")
    g.add_argument("replay", type=Path)
    g.add_argument("--out", type=Path, default=None)
    g.add_argument("--cell", type=int, default=20)
    g.add_argument("--fps", type=int, default=8)

    a = ap.parse_args(argv)
    if a.cmd == "train":
        from .train import train

        cfg = Config.load(a.config) if a.config else Config()
        cfg = cfg.override(a.set)
        run = a.run or time.strftime("%Y%m%d_%H%M%S")
        train(cfg, run, resolve_checkpoint(a.resume))
    elif a.cmd == "record":
        from .replay import record_episode

        ck = resolve_checkpoint(a.checkpoint)
        tag = ck.parent.parent.name + "_" + ck.stem if ck else "untrained"
        out = a.out or REPLAYS_DIR / f"{tag}_seed{a.seed}.jsonl.gz"
        res = record_episode(out, ck, a.seed, greedy=a.greedy)
        print(f"реплей: {out}")
        print(json.dumps(res, ensure_ascii=False))
    elif a.cmd == "view":
        from .viewer import run_viewer

        target = Path(a.replay)
        if not target.exists() and (RUNS_DIR / a.replay).is_dir():
            target = RUNS_DIR / a.replay
        run_viewer(target, a.cell)
    elif a.cmd == "watch":
        from .metrics_view import watch

        watch(a.runs, a.interval)
    elif a.cmd == "plot":
        from .metrics_view import plot

        print(plot(a.runs, a.out))
    elif a.cmd == "gif":
        from .viewer import export_gif

        out = a.out or a.replay.with_suffix("").with_suffix(".gif")
        print(f"GIF: {export_gif(a.replay, out, a.cell, a.fps)}")


if __name__ == "__main__":
    main()
