"""Скорость симуляции и инференса политики: сколько робот-тактов в секунду."""

import argparse
import time

import numpy as np
import torch

from extract_moon.config import Config
from extract_moon.env import ExtractMoonEnv
from extract_moon.model import Policy, pick_device
from extract_moon.train import sample_actions, to_torch


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--envs", type=int, default=16)
    ap.add_argument("--steps", type=int, default=200)
    ap.add_argument("--device", default="auto")
    a = ap.parse_args()

    cfg = Config()
    env = ExtractMoonEnv(cfg, a.envs, seed=0)
    dev = pick_device(a.device)
    model = Policy(cfg, env.vec_dim).to(dev).eval()
    state = model.initial_state(env.E * env.R, dev)
    obs = env.observe()
    t_env = t_net = 0.0
    robot_steps = 0
    with torch.no_grad():
        for _ in range(a.steps):
            t0 = time.perf_counter()
            obs_t = to_torch(obs, dev)
            out, state = model.step(obs_t["grid"], obs_t["vec"], state, obs_t["new_slot"])
            actions, _, _ = sample_actions(out, obs_t)
            acts = [x.view(env.E, env.R).cpu().numpy() for x in actions]
            t1 = time.perf_counter()
            _, _, info = env.step(*acts)
            env.reset_finished(info["finished_envs"])
            obs = env.observe()
            t2 = time.perf_counter()
            t_net += t1 - t0
            t_env += t2 - t1
            robot_steps += int(np.sum(obs["active"]))
    n = a.steps
    print(f"устройство {dev}, матчей {a.envs}")
    print(f"симуляция: {1000 * t_env / n:.2f} мс/такт, сеть: {1000 * t_net / n:.2f} мс/такт")
    print(f"итого {robot_steps / (t_env + t_net):,.0f} робот-тактов/с")


if __name__ == "__main__":
    main()
