import numpy as np

from extract_moon.config import Config
from extract_moon.env import ASLEEP, AWAKE, BOARDED, EMPTY, GRID_CHANNELS, N_MAIN, N_UPGRADE, ExtractMoonEnv


def random_actions(env, obs, rng):
    E, R = env.E, env.R
    logits = rng.random((E, R, N_MAIN)) * obs["main_mask"]
    main = logits.argmax(-1)
    upg = (rng.random((E, R, N_UPGRADE)) * obs["upg_mask"]).argmax(-1) * (rng.random((E, R)) < 0.05)
    sym = rng.integers(0, env.n_symbols, (E, R)) * (rng.random((E, R)) < 0.2)
    val = rng.integers(0, env.n_levels, (E, R))
    return main, upg, sym, val


def test_observation_shapes():
    cfg = Config()
    env = ExtractMoonEnv(cfg, 3, seed=1)
    obs = env.observe()
    K = 2 * cfg.world.view_radius + 1
    assert obs["grid"].shape == (3, cfg.world.max_robots, len(GRID_CHANNELS), K, K)
    assert obs["vec"].shape == (3, cfg.world.max_robots, env.vec_dim)
    assert obs["new_slot"].sum() == (env.status != EMPTY).sum()


def test_same_seed_same_map():
    a, b = ExtractMoonEnv(Config(), 1, seed=7), ExtractMoonEnv(Config(), 1, seed=7)
    assert np.array_equal(a.source, b.source) and np.array_equal(a.pos, b.pos)


def test_random_rollout_invariants():
    cfg = Config()
    env = ExtractMoonEnv(cfg, 4, seed=2)
    rng = np.random.default_rng(0)
    obs = env.observe()
    episodes = []
    for _ in range(700):
        rew, done, info = env.step(*random_actions(env, obs, rng))
        assert np.isfinite(rew).all()
        cap = env.energy_cap()
        on = (env.status == AWAKE) | (env.status == ASLEEP)
        assert (env.energy[on] <= cap[on] + 1e-4).all()
        assert (env.energy[env.status == AWAKE] > 0).all()
        assert (env.passengers <= env.seats).all()
        assert (env.passengers == (env.status == BOARDED).sum(-1)).all() or info["finished_envs"]
        assert (env.ship_charge <= env.ship_cap + 1e-3).all()
        assert (env.source >= -1e-4).all()
        episodes += info["episodes"]
        env.reset_finished(info["finished_envs"])
        obs = env.observe()
        assert np.isfinite(obs["vec"]).all() and np.isfinite(obs["grid"]).all()
        assert obs["main_mask"][..., 0].all()
    assert episodes, "за 700 тактов не закончился ни один матч"


def test_deposit_and_launch():
    """Роботы, стоящие у корабля и отдающие энергию, заряжают его, садятся и улетают."""
    cfg = Config()
    cfg.world.ship_capacity_min = cfg.world.ship_capacity_max = 8.0
    env = ExtractMoonEnv(cfg, 1, seed=3)
    alive = np.nonzero(env.status[0] == AWAKE)[0]
    env.pos[0, alive] = env.ship_pos[0]
    env.energy[0, alive] = 10
    obs = env.observe()
    z = np.zeros((1, env.R), np.int64)
    main = z.copy()
    main[0, alive] = 6  # DEPOSIT
    rew, done, info = env.step(main, z, z, z)
    assert env.ship_charge[0] >= 8 - 1e-4
    assert rew[0, alive].sum() > 0
    obs = env.observe()
    main = z.copy()
    main[0, alive] = 7  # BOARD
    rew, done, info = env.step(main, z, z, z)
    assert info["episodes"] and info["episodes"][0]["launched"]
    assert info["episodes"][0]["passengers"] == min(len(alive), env.seats[0])
    assert done[0, alive].all()
