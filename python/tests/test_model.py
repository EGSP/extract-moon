import torch

from extract_moon.config import Config
from extract_moon.env import ExtractMoonEnv
from extract_moon.model import Policy
from extract_moon.train import to_torch


def test_param_count_in_budget():
    cfg = Config()
    env = ExtractMoonEnv(cfg, 1)
    n = sum(p.numel() for p in Policy(cfg, env.vec_dim).parameters())
    assert 1e6 <= n <= 5e6, n


def test_sequence_matches_steps():
    """Прогон последовательности при обучении даёт то же, что потактовый прогон при сборе опыта."""
    torch.manual_seed(0)
    cfg = Config()
    env = ExtractMoonEnv(cfg, 1, seed=0)
    model = Policy(cfg, env.vec_dim).eval()
    obs_t = to_torch(env.observe(), "cpu")
    T, B = 6, env.R
    grid = obs_t["grid"].expand(T, *obs_t["grid"].shape) + torch.randn(T, *obs_t["grid"].shape) * 0.1
    vec = obs_t["vec"].expand(T, *obs_t["vec"].shape) + torch.randn(T, *obs_t["vec"].shape) * 0.1
    reset = torch.zeros(T, B, dtype=torch.bool)
    reset[0] = True
    reset[3, :5] = True
    s0 = model.initial_state(B)
    with torch.no_grad():
        seq = model.sequence(grid, vec, s0, reset)
        s, vals = s0, []
        for t in range(T):
            out, s = model.step(grid[t], vec[t], s, reset[t])
            vals.append(out["main"])
    assert torch.allclose(seq["main"], torch.stack(vals), atol=1e-5)


def test_memory_changes_output():
    torch.manual_seed(0)
    cfg = Config()
    env = ExtractMoonEnv(cfg, 1, seed=0)
    model = Policy(cfg, env.vec_dim)
    for p in model.parameters():  # выходные проекции инициализированы нулями — оживим их для теста
        if p.dim() > 1:
            torch.nn.init.normal_(p, std=0.05)
    obs_t = to_torch(env.observe(), "cpu")
    reset = torch.ones(env.R, dtype=torch.bool)
    with torch.no_grad():
        a, s = model.step(obs_t["grid"], obs_t["vec"], model.initial_state(env.R), reset)
        b, _ = model.step(obs_t["grid"], obs_t["vec"], s, ~reset)
    assert not torch.allclose(a["value"], b["value"])


def test_chunked_wkv_matches_steps_with_memory_and_resets():
    """Блочный WKV совпадает с потактовым на нескольких блоках, со сбросами внутри блока и на границе,
    с ненулевой начальной памятью. Выходные веса time-mix случайные, иначе WKV не влиял бы на ответ."""
    torch.manual_seed(1)
    cfg = Config()
    env = ExtractMoonEnv(cfg, 1, seed=0)
    model = Policy(cfg, env.vec_dim).eval()
    with torch.no_grad():
        for blk in model.blocks:
            blk.att.output.weight.normal_(0, 0.3)
            blk.att.time_decay.add_(torch.randn_like(blk.att.time_decay))
    obs_t = to_torch(env.observe(), "cpu")
    T, B = 21, env.R
    grid = obs_t["grid"].expand(T, *obs_t["grid"].shape) + torch.randn(T, *obs_t["grid"].shape) * 0.3
    vec = obs_t["vec"].expand(T, *obs_t["vec"].shape) + torch.randn(T, *obs_t["vec"].shape) * 0.3
    reset = torch.zeros(T, B, dtype=torch.bool)
    reset[3, :5] = True
    reset[8, 5:9] = True  # на границе блока
    reset[13, ::3] = True
    with torch.no_grad():
        s0 = model.initial_state(B)
        for t in range(4):  # набрать память до начала последовательности
            _, s0 = model.step(grid[t] * 0.5, vec[t] * 0.5, s0, torch.zeros(B, dtype=torch.bool))
        seq = model.sequence(grid, vec, s0, reset)
        s, mains, values = s0, [], []
        for t in range(T):
            out, s = model.step(grid[t], vec[t], s, reset[t])
            mains.append(out["main"])
            values.append(out["value"])
    assert torch.allclose(seq["main"], torch.stack(mains), atol=1e-4)
    assert torch.allclose(seq["value"], torch.stack(values), atol=1e-4)
