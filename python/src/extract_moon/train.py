"""Обучение PPO одной общей сетью для всех роботов всех фракций.

Каждый слот робота — отдельный поток с собственной памятью RWKV. Сбор опыта
идёт отрезками по rollout_len тактов; в начале отрезка запоминается память всех
потоков, и при обновлении сеть заново прогоняется по отрезку от этой памяти.
"""

from __future__ import annotations

import csv
import time
from collections import deque
from pathlib import Path

import numpy as np
import torch

from .config import Config
from .env import ExtractMoonEnv
from .model import Policy, distributions, joint_logprob_entropy, pick_device
from .paths import RUNS_DIR


def to_torch(obs: dict, device) -> dict:
    out = {}
    for k, v in obs.items():
        t = torch.from_numpy(np.ascontiguousarray(v))
        out[k] = t.reshape(-1, *t.shape[2:]).to(device, non_blocking=True)
    return out


def sample_actions(out: dict, obs_t: dict):
    dists = distributions(out, obs_t["main_mask"], obs_t["upg_mask"])
    actions = tuple(d.sample() for d in dists)
    logp, _ = joint_logprob_entropy(dists, actions)
    return actions, logp, dists


def save_checkpoint(path: Path, model: Policy, cfg: Config, vec_dim: int, update: int, steps: int) -> None:
    torch.save({"model": model.state_dict(), "config": cfg.to_dict(), "vec_dim": vec_dim,
                "update": update, "steps": steps}, path)


def load_checkpoint(path: Path, device) -> tuple[Policy, Config, dict]:
    ck = torch.load(path, map_location=device, weights_only=False)
    cfg = Config.from_dict(ck["config"])
    model = Policy(cfg, ck["vec_dim"]).to(device)
    model.load_state_dict(ck["model"])
    model.eval()
    return model, cfg, ck


def train(cfg: Config, run_name: str, resume: Path | None = None) -> Path:
    tc = cfg.train
    device = pick_device(tc.device)
    torch.manual_seed(tc.seed)
    run_dir = RUNS_DIR / run_name
    ck_dir = run_dir / "checkpoints"
    ck_dir.mkdir(parents=True, exist_ok=True)
    cfg.save(run_dir / "config.json")

    env = ExtractMoonEnv(cfg, tc.num_envs, seed=tc.seed)
    E, R, T = env.E, env.R, tc.rollout_len
    B = E * R
    model = Policy(cfg, env.vec_dim).to(device)
    start_update, total_steps = 0, 0
    if resume:
        ck = torch.load(resume, map_location=device, weights_only=False)
        model.load_state_dict(ck["model"])
        start_update, total_steps = ck["update"], ck["steps"]
    opt = torch.optim.Adam(model.parameters(), lr=tc.lr, eps=1e-5)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"устройство: {device}, параметров: {n_params / 1e6:.2f} млн, потоков: {B}, запуск: {run_dir}")

    metrics_path = run_dir / "metrics.csv"
    metrics_file = metrics_path.open("a", newline="", encoding="utf-8")
    writer = None
    recent = deque(maxlen=200)

    obs = env.observe()
    state = model.initial_state(B, device)
    if tc.replay_every and start_update == 0:
        snapshot_replay(run_dir, ck_dir, model, cfg, env.vec_dim, 0, 0)

    for update in range(start_update + 1, tc.total_updates + 1):
        t0 = time.time()
        init_state = state.clone()
        buf = {k: [] for k in ("grid", "vec", "main_mask", "upg_mask", "active", "acting", "new_slot",
                               "main", "upg", "sym", "val", "logp", "value", "reward", "done")}
        model.eval()
        with torch.no_grad():
            for _ in range(T):
                obs_t = to_torch(obs, device)
                out, state = model.step(obs_t["grid"], obs_t["vec"], state, obs_t["new_slot"])
                actions, logp, _ = sample_actions(out, obs_t)
                acts_np = [a.view(E, R).cpu().numpy() for a in actions]
                rew, done, info = env.step(*acts_np)
                env.reset_finished(info["finished_envs"])
                recent.extend(info["episodes"])
                for k in ("grid", "vec", "main_mask", "upg_mask", "active", "acting", "new_slot"):
                    buf[k].append(obs_t[k])
                for k, a in zip(("main", "upg", "sym", "val"), actions):
                    buf[k].append(a)
                buf["logp"].append(logp)
                buf["value"].append(out["value"])
                buf["reward"].append(torch.from_numpy(rew.reshape(-1)).to(device))
                buf["done"].append(torch.from_numpy(done.reshape(-1)).to(device))
                obs = env.observe()
            obs_t = to_torch(obs, device)
            out_last, _ = model.step(obs_t["grid"], obs_t["vec"], state, obs_t["new_slot"])
            last_value = out_last["value"]
        data = {k: torch.stack(v) for k, v in buf.items()}  # (T, B, ...)
        total_steps += int(data["active"].sum())

        # GAE по каждому потоку; done обрывает поток, неактивные такты не учитываются.
        active = data["active"].float()
        nonterm = 1 - data["done"].float()
        values = data["value"] * active
        adv = torch.zeros_like(values)
        last = torch.zeros(B, device=device)
        next_v = last_value * obs_t["active"].float()
        for t in reversed(range(T)):
            delta = data["reward"][t] + tc.gamma * next_v * nonterm[t] - values[t]
            last = (delta + tc.gamma * tc.gae_lambda * nonterm[t] * last) * active[t]
            adv[t] = last
            next_v = values[t]
        returns = adv + values
        acting = data["acting"].float()
        a_mean = (adv * acting).sum() / acting.sum().clamp(min=1)
        a_std = (((adv - a_mean) ** 2) * acting).sum() / acting.sum().clamp(min=1)
        adv_n = (adv - a_mean) / (a_std.sqrt() + 1e-8)

        # Обновление PPO по минибатчам потоков.
        model.train()
        stats = {"policy_loss": 0.0, "value_loss": 0.0, "entropy": 0.0, "clip_frac": 0.0, "approx_kl": 0.0}
        n_mb = 0
        mb_size = min(tc.minibatch_streams, B)
        for _ in range(tc.epochs):
            perm = torch.randperm(B, device=device)
            for i in range(0, B, mb_size):
                idx = perm[i:i + mb_size]
                if data["active"][:, idx].sum() == 0:
                    continue
                sub = {k: v[:, idx] for k, v in data.items()}
                out = model.sequence(sub["grid"], sub["vec"], init_state[idx], sub["new_slot"])
                dists = distributions(out, sub["main_mask"], sub["upg_mask"])
                logp, ent = joint_logprob_entropy(dists, (sub["main"], sub["upg"], sub["sym"], sub["val"]))
                act = acting[:, idx]
                act_n = act.sum().clamp(min=1)
                act_v = active[:, idx]
                ratio = torch.exp(logp - sub["logp"])
                a = adv_n[:, idx]
                pg = -torch.minimum(ratio * a, ratio.clamp(1 - tc.clip, 1 + tc.clip) * a)
                policy_loss = (pg * act).sum() / act_n
                value_loss = (((out["value"] - returns[:, idx]) ** 2) * act_v).sum() / act_v.sum().clamp(min=1)
                entropy = (ent * act).sum() / act_n
                loss = policy_loss + tc.value_coef * value_loss - tc.entropy_coef * entropy
                opt.zero_grad(set_to_none=True)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), tc.max_grad_norm)
                opt.step()
                with torch.no_grad():
                    stats["policy_loss"] += policy_loss.item()
                    stats["value_loss"] += value_loss.item()
                    stats["entropy"] += entropy.item()
                    stats["clip_frac"] += (((ratio - 1).abs() > tc.clip).float() * act).sum().item() / act_n.item()
                    stats["approx_kl"] += (((ratio - 1) - torch.log(ratio)) * act).sum().item() / act_n.item()
                n_mb += 1
        stats = {k: v / max(n_mb, 1) for k, v in stats.items()}

        dt = time.time() - t0
        row = {"update": update, "steps": total_steps, "time": round(time.time(), 1),
               "sps": round(int(data["active"].sum()) / dt),
               "reward_per_step": round(float((data["reward"] * active).sum() / active.sum().clamp(min=1)), 5),
               **{k: round(v, 5) for k, v in stats.items()}}
        if recent:
            eps = list(recent)
            row.update({
                "episodes": len(eps),
                "launch_rate": round(np.mean([e["launched"] for e in eps]), 3),
                "ep_length": round(np.mean([e["length"] for e in eps]), 1),
                "charge_frac": round(np.mean([e["charge_frac"] for e in eps]), 3),
                "passengers": round(np.mean([e["passengers"] for e in eps]), 2),
                "kills": round(np.mean([e["kills"] for e in eps]), 2),
                "births": round(np.mean([e["births"] for e in eps]), 2),
                "upgrades": round(np.mean([e["upgrades"] for e in eps]), 2),
                "signals": round(np.mean([e["signals"] for e in eps]), 1),
                "gives": round(np.mean([e["gives"] for e in eps]), 2),
                "leaves": round(np.mean([e["leaves"] for e in eps]), 2),
            })
        if writer is None:
            fields = list(row.keys()) + [k for k in ("episodes", "launch_rate", "ep_length", "charge_frac",
                                                     "passengers", "kills", "births", "upgrades", "signals",
                                                     "gives", "leaves") if k not in row]
            writer = csv.DictWriter(metrics_file, fieldnames=fields)
            if metrics_path.stat().st_size == 0:
                writer.writeheader()
        writer.writerow(row)
        metrics_file.flush()

        if update % tc.log_every == 0 or update == 1:
            print(f"[{update:5d}] шагов {total_steps:>9,} | {row['sps']:>5} шаг/с | "
                  f"награда/шаг {row['reward_per_step']:+.4f} | энтропия {stats['entropy']:.2f} | "
                  f"взлёт {row.get('launch_rate', 0):.2f} | заряд {row.get('charge_frac', 0):.2f} | "
                  f"пассажиров {row.get('passengers', 0):.1f} | убийств {row.get('kills', 0):.1f}")
        if update % tc.save_every == 0 or update == tc.total_updates:
            save_checkpoint(ck_dir / f"model_{update:06d}.pt", model, cfg, env.vec_dim, update, total_steps)
            save_checkpoint(ck_dir / "latest.pt", model, cfg, env.vec_dim, update, total_steps)
        if tc.replay_every and (update % tc.replay_every == 0 or update == tc.total_updates):
            snapshot_replay(run_dir, ck_dir, model, cfg, env.vec_dim, update, total_steps)

    metrics_file.close()
    return run_dir


def snapshot_replay(run_dir: Path, ck_dir: Path, model: Policy, cfg: Config, vec_dim: int,
                    update: int, steps: int) -> None:
    """Сохраняет чекпойнт этапа и записывает матч на постоянной карте replay_seed."""
    from .replay import record_episode

    ck = ck_dir / f"model_{update:06d}.pt"
    if not ck.exists():
        save_checkpoint(ck, model, cfg, vec_dim, update, steps)
    seed = cfg.train.replay_seed
    out = run_dir / "replays" / f"u{update:06d}_seed{seed}.jsonl.gz"
    # Реплей пишется на CPU: второй копии модели и её буферам не хватит места в 2 ГБ видеопамяти.
    res = record_episode(out, ck, seed, device="cpu")
    print(f"        реплей этапа {update}: {'взлёт' if res['launched'] else 'не взлетел'}, "
          f"заряд {res['charge_frac']:.2f}, пассажиров {res['passengers']}: {out.name}")
