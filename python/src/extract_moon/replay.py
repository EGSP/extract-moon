"""Запись и чтение реплеев.

Формат — gzip JSON Lines: первая строка — заголовок (версия формата, конфиг,
карта), далее по строке на такт с полным состоянием мира и вероятностями
решений каждого бодрствующего робота. Хранится состояние, а не действия,
поэтому реплей остаётся воспроизводимым после изменения правил.
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np

from .config import Config
from .env import MAIN_NAMES, UPGRADE_NAMES, ExtractMoonEnv

FORMAT = "extract_moon_replay"
VERSION = 1


def record_episode(out_path: Path, checkpoint: Path | None, seed: int, cfg: Config | None = None,
                   device: str = "auto", greedy: bool = False) -> dict:
    """Прогоняет один матч на карте seed и записывает реплей. Без чекпойнта — необученная сеть."""
    import torch  # импорт здесь, чтобы проигрыватель открывался без загрузки torch

    from .model import Policy, pick_device
    from .train import load_checkpoint, sample_actions, to_torch

    dev = pick_device(device)
    if checkpoint is not None:
        model, cfg, ck = load_checkpoint(checkpoint, dev)
        model_info = {"checkpoint": str(checkpoint), "update": ck["update"], "steps": ck["steps"]}
    else:
        cfg = cfg or Config()
        env_probe = ExtractMoonEnv(cfg, 1, seed=seed)
        model = Policy(cfg, env_probe.vec_dim).to(dev).eval()
        model_info = {"checkpoint": None, "update": 0, "steps": 0}
    torch.manual_seed(seed)
    env = ExtractMoonEnv(cfg, 1, seed=seed)
    state = model.initial_state(env.R, dev)
    obs = env.observe()
    header = {"format": FORMAT, "version": VERSION, "seed": seed, "model": model_info,
              "map": env.map_info(0), "config": cfg.to_dict(),
              "names": {"main": MAIN_NAMES, "upgrade": UPGRADE_NAMES,
                        "symbols": ["—"] + list("αβγδεζηθικλμνξοπρστυφχψω")[:cfg.world.signal_symbols]}}
    frames = [{**env.snapshot(0), "decisions": {}}]
    result = None
    with torch.no_grad():
        while result is None:
            obs_t = to_torch(obs, dev)
            out, state = model.step(obs_t["grid"], obs_t["vec"], state, obs_t["new_slot"])
            actions, _, dists = sample_actions(out, obs_t)
            if greedy:
                actions = tuple(d.probs.argmax(-1) for d in dists)
            probs = [d.probs.cpu().numpy() for d in dists]
            value = out["value"].cpu().numpy()
            acts = [a.view(1, -1).cpu().numpy() for a in actions]
            decisions = {}
            for r in np.nonzero(obs["acting"][0])[0]:
                decisions[str(int(env.uid[0, r]))] = {
                    "main": np.round(probs[0][r], 3).tolist(), "upgrade": np.round(probs[1][r], 3).tolist(),
                    "symbol": np.round(probs[2][r], 3).tolist(), "value_level": np.round(probs[3][r], 3).tolist(),
                    "chosen": [int(a[0, r]) for a in acts], "critic": round(float(value[r]), 3),
                }
            # Решения принимаются по кадру до шага — прикрепляем их к нему.
            frames[-1]["decisions"] = decisions
            _, _, info = env.step(*acts)
            frames.append({**env.snapshot(0), "decisions": {}})
            if info["episodes"]:
                result = info["episodes"][0]
            obs = env.observe()
    header["result"] = result
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(out_path, "wt", encoding="utf-8") as f:
        f.write(json.dumps(header, ensure_ascii=False) + "\n")
        for fr in frames:
            f.write(json.dumps(fr, ensure_ascii=False, separators=(",", ":")) + "\n")
    return result


def load_replay(path: Path) -> tuple[dict, list[dict]]:
    with gzip.open(path, "rt", encoding="utf-8") as f:
        header = json.loads(f.readline())
        if header.get("format") != FORMAT:
            raise ValueError(f"{path}: не реплей Extract Moon")
        frames = [json.loads(line) for line in f if line.strip()]
    return header, frames
