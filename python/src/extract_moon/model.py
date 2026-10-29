"""Политика роботов: кодировщик → RWKV → головы решений.

RWKV реализован в рекуррентной форме (по одному такту за вызов), как в RWKV-4:
time-mix с поканальным затуханием и channel-mix. Состояние каждого слоя — это
пять векторов: вход прошлого такта для time-mix и для channel-mix, числитель и
знаменатель WKV и опорная экспонента для численной устойчивости. Состояние имеет
фиксированный размер, поэтому каждый такт стоит одинаково.
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.checkpoint import checkpoint

from .config import Config
from .env import GRID_CHANNELS, LEAVE, N_MAIN, N_UPGRADE, REPRODUCE

NEG_INF = -1e30
# Проверка аргументов распределений заметно замедляет каждый такт, а маски и так корректны.
torch.distributions.Distribution.set_default_validate_args(False)
STATE_SLOTS = 5  # att_x, aa, bb, pp, ffn_x


class TimeMix(nn.Module):
    def __init__(self, d: int, layer: int, n_layers: int):
        super().__init__()
        ratio = layer / max(n_layers - 1, 1)
        ch = torch.arange(d) / max(d - 1, 1)
        # Разные каналы помнят на разных масштабах времени: от нескольких тактов до сотен.
        self.time_decay = nn.Parameter(-6 + 8 * ch ** (0.7 + 1.3 * ratio))
        self.time_first = nn.Parameter(torch.full((d,), 0.5))
        self.mix_k = nn.Parameter(1 - ch * 0.5)
        self.mix_v = nn.Parameter(1 - ch * 0.4)
        self.mix_r = nn.Parameter(1 - ch * 0.5)
        self.key = nn.Linear(d, d, bias=False)
        self.value = nn.Linear(d, d, bias=False)
        self.receptance = nn.Linear(d, d, bias=False)
        self.output = nn.Linear(d, d, bias=False)
        nn.init.zeros_(self.output.weight)

    def forward(self, x, prev_x, aa, bb, pp):
        k = self.key(x * self.mix_k + prev_x * (1 - self.mix_k))
        v = self.value(x * self.mix_v + prev_x * (1 - self.mix_v))
        r = torch.sigmoid(self.receptance(x * self.mix_r + prev_x * (1 - self.mix_r)))
        w = -torch.exp(self.time_decay)
        ww = self.time_first + k
        p = torch.maximum(pp, ww)
        e1, e2 = torch.exp(pp - p), torch.exp(ww - p)
        wkv = (e1 * aa + e2 * v) / (e1 * bb + e2)
        ww = pp + w
        p = torch.maximum(ww, k)
        e1, e2 = torch.exp(ww - p), torch.exp(k - p)
        return self.output(r * wkv), e1 * aa + e2 * v, e1 * bb + e2, p

    def forward_seq(self, x, prev_x, aa, bb, pp, keep):
        """Вся последовательность (T, B, d) сразу: проекции считаются одним вызовом, а WKV —
        блоками по WKV_CHUNK тактов (см. wkv_chunk), а не поштучным циклом по тактам."""
        xx = shift(x, prev_x, keep)
        k = self.key(x * self.mix_k + xx * (1 - self.mix_k))
        v = self.value(x * self.mix_v + xx * (1 - self.mix_v))
        r = torch.sigmoid(self.receptance(x * self.mix_r + xx * (1 - self.mix_r)))
        w, u = -torch.exp(self.time_decay), self.time_first
        out = []
        for s in range(0, x.shape[0], WKV_CHUNK):
            args = (k[s:s + WKV_CHUNK], v[s:s + WKV_CHUNK], keep[s:s + WKV_CHUNK], w, u, aa, bb, pp)
            # Таблицы блока велики; при обучении их пересчитывают на обратном проходе, а не хранят.
            if torch.is_grad_enabled():
                o, aa, bb, pp = checkpoint(wkv_chunk, *args, use_reentrant=False)
            else:
                o, aa, bb, pp = wkv_chunk(*args)
            out.append(o)
        return self.output(r * torch.cat(out)), aa, bb, pp


# Длина блока WKV при обучении. Память блока растёт как квадрат длины, число запусков ядер — обратно ей.
WKV_CHUNK = 8


def wkv_chunk(k, v, keep, w, u, aa, bb, pp):
    """WKV для C тактов без цикла по времени. Даёт то же, что C шагов TimeMix.forward.

    Числитель на такте t — сумма вкладов прошлых тактов i < t с весом exp((t-1-i)·w + k_i)
    плюс начальное состояние с весом exp(t·w + pp); знаменатель — то же без v. Вклад
    отсекается, если между i и t память сбрасывалась (keep = 0). Все показатели степени
    собираются в таблицу (C+1, C, B, d) и нормируются на максимум, как в рекуррентной форме.
    Строка C таблицы — состояние после блока.
    """
    C = k.shape[0]
    t = torch.arange(C + 1, device=k.device)[:, None]
    i = torch.arange(C, device=k.device)[None, :]
    resets = torch.cumsum(1 - keep, 0)  # (C, B, 1): сколько сбросов было к такту
    resets_t = torch.cat([resets, resets[-1:]], 0)
    valid = (i < t)[:, :, None, None] & (resets_t[:, None] == resets[None])
    past = torch.where(valid, (t - 1 - i).to(k.dtype)[:, :, None, None] * w + k[None], NEG_INF)
    first = torch.where(resets_t == 0, t[..., None].to(k.dtype) * w + pp, NEG_INF)
    p = torch.maximum(past.amax(1), first)
    e_past, e_first = torch.exp(past - p[:, None]), torch.exp(first - p)
    num = (e_past * v[None]).sum(1) + e_first * aa
    den = e_past.sum(1) + e_first * bb
    # Текущий такт входит в выход с бонусом u, но не в состояние.
    cur = u + k
    q = torch.maximum(p[:C], cur)
    s_old, s_cur = torch.exp(p[:C] - q), torch.exp(cur - q)
    out = (num[:C] * s_old + s_cur * v) / (den[:C] * s_old + s_cur)
    return out, num[C], den[C], p[C]


def shift(x, prev_x, keep):
    """Сдвиг на такт назад: вход прошлого такта; после сброса памяти — нули."""
    return torch.cat([prev_x[None], x[:-1]], 0) * keep


class ChannelMix(nn.Module):
    def __init__(self, d: int, mult: int):
        super().__init__()
        ch = torch.arange(d) / max(d - 1, 1)
        self.mix_k = nn.Parameter(1 - ch * 0.5)
        self.mix_r = nn.Parameter(1 - ch * 0.5)
        self.key = nn.Linear(d, d * mult, bias=False)
        self.value = nn.Linear(d * mult, d, bias=False)
        self.receptance = nn.Linear(d, d, bias=False)
        nn.init.zeros_(self.value.weight)

    def forward(self, x, prev_x):
        k = torch.square(torch.relu(self.key(x * self.mix_k + prev_x * (1 - self.mix_k))))
        r = torch.sigmoid(self.receptance(x * self.mix_r + prev_x * (1 - self.mix_r)))
        return r * self.value(k)


class Block(nn.Module):
    def __init__(self, d: int, mult: int, layer: int, n_layers: int):
        super().__init__()
        self.ln1 = nn.LayerNorm(d)
        self.ln2 = nn.LayerNorm(d)
        self.att = TimeMix(d, layer, n_layers)
        self.ffn = ChannelMix(d, mult)

    def forward(self, x, s):  # s: (B, 5, d)
        h = self.ln1(x)
        out, aa, bb, pp = self.att(h, s[:, 0], s[:, 1], s[:, 2], s[:, 3])
        x = x + out
        h2 = self.ln2(x)
        x = x + self.ffn(h2, s[:, 4])
        return x, torch.stack([h, aa, bb, pp, h2], 1)

    def forward_seq(self, x, s, keep):  # x: (T, B, d), keep: (T, B, 1)
        h = self.ln1(x)
        out, aa, bb, pp = self.att.forward_seq(h, s[:, 0], s[:, 1], s[:, 2], s[:, 3], keep)
        x = x + out
        h2 = self.ln2(x)
        x = x + self.ffn(h2, shift(h2, s[:, 4], keep))
        return x, torch.stack([h[-1], aa, bb, pp, h2[-1]], 1)


def head(d: int, hidden: int, out: int) -> nn.Sequential:
    layer = nn.Linear(hidden, out)
    nn.init.orthogonal_(layer.weight, 0.01)
    nn.init.zeros_(layer.bias)
    return nn.Sequential(nn.Linear(d, hidden), nn.Tanh(), layer)


class Policy(nn.Module):
    def __init__(self, cfg: Config, vec_dim: int):
        super().__init__()
        m, w = cfg.model, cfg.world
        d = self.d = m.d_model
        self.n_layers = m.n_layers
        K = 2 * w.view_radius + 1
        self.conv = nn.Sequential(
            nn.Conv2d(len(GRID_CHANNELS), 32, 3, padding=1), nn.ReLU(),
            nn.Conv2d(32, 64, 3, stride=2, padding=1), nn.ReLU(),
            nn.Flatten(),
        )
        conv_out = 64 * ((K + 1) // 2) ** 2
        self.grid_proj = nn.Linear(conv_out, d)
        self.vec_proj = nn.Sequential(nn.Linear(vec_dim, d), nn.ReLU())
        self.merge = nn.Linear(2 * d, d)
        self.ln0 = nn.LayerNorm(d)
        self.blocks = nn.ModuleList(Block(d, m.ffn_mult, i, m.n_layers) for i in range(m.n_layers))
        self.ln_out = nn.LayerNorm(d)
        self.main_head = head(d, m.head_hidden, N_MAIN)
        self.upg_head = head(d, m.head_hidden, N_UPGRADE)
        self.sym_head = head(d, m.head_hidden, w.signal_symbols + 1)
        self.val_head = head(d, m.head_hidden, w.signal_levels)
        self.value_head = nn.Sequential(nn.Linear(d, m.head_hidden), nn.Tanh(), nn.Linear(m.head_hidden, 1))
        # Начальная склонность: дорогие и необратимые действия поначалу редки. Без этого случайная
        # сеть в первые же такты уходит из фракций, сжигает энергию на улучшения и сигналы и засыпает.
        with torch.no_grad():
            self.main_head[-1].bias[REPRODUCE] = -3.0
            self.main_head[-1].bias[LEAVE] = -5.0
            self.upg_head[-1].bias[0] = 5.0
            self.sym_head[-1].bias[0] = 4.0

    # Состояние: (B, n_layers, 5, d).
    def initial_state(self, batch: int, device=None) -> torch.Tensor:
        s = torch.zeros(batch, self.n_layers, STATE_SLOTS, self.d, device=device)
        s[:, :, 3] = NEG_INF
        return s

    def reset_state(self, state: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        fresh = self.initial_state(1, state.device)
        return torch.where(mask[:, None, None, None], fresh, state)

    def encode(self, grid: torch.Tensor, vec: torch.Tensor) -> torch.Tensor:
        g = F.relu(self.grid_proj(self.conv(grid)))
        return self.ln0(F.relu(self.merge(torch.cat([g, self.vec_proj(vec)], -1))))

    def core(self, x: torch.Tensor, state: torch.Tensor):
        new = []
        for i, block in enumerate(self.blocks):
            x, s = block(x, state[:, i])
            new.append(s)
        return self.ln_out(x), torch.stack(new, 1)

    def heads(self, h: torch.Tensor) -> dict:
        return {
            "main": self.main_head(h), "upg": self.upg_head(h), "sym": self.sym_head(h),
            "val": self.val_head(h), "value": self.value_head(h).squeeze(-1),
        }

    def step(self, grid, vec, state, reset):
        """Один такт для батча роботов. reset — маска роботов, чья память обнуляется перед тактом."""
        state = self.reset_state(state, reset)
        h, state = self.core(self.encode(grid, vec), state)
        return self.heads(h), state

    def sequence(self, grid, vec, state, reset):
        """Прогон по последовательности (T, B, ...) — для обучения с BPTT."""
        T, B = vec.shape[:2]
        g, v = grid.flatten(0, 1), vec.flatten(0, 1)
        if torch.is_grad_enabled():
            # Активации свёрток по всем окнам обзора — главный расход видеопамяти; пересчитываем их при backward.
            x = checkpoint(self.encode, g, v, use_reentrant=False)
        else:
            x = self.encode(g, v)
        x = x.view(T, B, -1)
        keep = (~reset).float()[..., None]
        # Слои RWKV зависят от прошлого только внутри себя, поэтому их можно считать слой за слоем.
        for i, block in enumerate(self.blocks):
            x, _ = block.forward_seq(x, state[:, i], keep)
        return self.heads(self.ln_out(x))


def masked_logits(logits: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    return logits.masked_fill(~mask, -1e9)


def distributions(out: dict, main_mask, upg_mask):
    return (
        torch.distributions.Categorical(logits=masked_logits(out["main"], main_mask)),
        torch.distributions.Categorical(logits=masked_logits(out["upg"], upg_mask)),
        torch.distributions.Categorical(logits=out["sym"]),
        torch.distributions.Categorical(logits=out["val"]),
    )


def joint_logprob_entropy(dists, actions):
    """Сумма логвероятностей голов. Значение сигнала учитывается, только если сигнал подан."""
    main, upg, sym, val = actions
    dm, du, ds, dv = dists
    speaking = (sym > 0).float()
    logp = dm.log_prob(main) + du.log_prob(upg) + ds.log_prob(sym) + dv.log_prob(val) * speaking
    ent = dm.entropy() + du.entropy() + ds.entropy() + dv.entropy() * speaking
    return logp, ent


def pick_device(name: str = "auto") -> torch.device:
    if name == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return torch.device(name)
