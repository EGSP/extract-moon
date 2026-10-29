"""Headless-симуляция Extract Moon.

Мир — клеточная карта; в одной клетке может стоять несколько роботов, поэтому
движения не конфликтуют. Симуляция векторизована по numpy: массивы имеют форму
(E, R, ...), где E — число параллельных матчей, R — число слотов под роботов.

Слот робота — это «поток» для обучения: он начинается при появлении робота
(старт матча или рождение) и заканчивается концом матча. Погибший робот
(при reward.dead_wait) остаётся в потоке без решений до конца матча, чтобы
получить долю награды за улетевших союзников.
"""

from __future__ import annotations

import math

import numpy as np

from .config import Config

# Состояния слота.
EMPTY, AWAKE, ASLEEP, BOARDED, DEAD = 0, 1, 2, 3, 4
STATUS_NAMES = {EMPTY: "empty", AWAKE: "awake", ASLEEP: "asleep", BOARDED: "boarded", DEAD: "dead"}

# Основное действие.
NOOP, UP, DOWN, LEFT, RIGHT, HARVEST, DEPOSIT, BOARD, GIVE, ATTACK, REPRODUCE, LEAVE = range(12)
N_MAIN = 12
MAIN_NAMES = ["noop", "up", "down", "left", "right", "harvest", "deposit", "board",
              "give", "attack", "reproduce", "leave"]
MOVES = np.zeros((N_MAIN, 2), dtype=np.int64)
MOVES[UP] = (0, -1)
MOVES[DOWN] = (0, 1)
MOVES[LEFT] = (-1, 0)
MOVES[RIGHT] = (1, 0)

# Улучшения тела: 0 — ничего, затем ёмкость, броня, скорость добычи.
UPGRADE_NAMES = ["none", "capacity", "armor", "harvest"]
N_UPGRADE = len(UPGRADE_NAMES)

LONER = -1  # фракция одиночки: союзников у него нет
GRID_CHANNELS = ["out_of_map", "source", "ship", "ally_awake", "ally_asleep", "other_awake", "other_asleep"]
NEVER_SEEN = 999


class ExtractMoonEnv:
    def __init__(self, cfg: Config, num_envs: int, seed: int = 0):
        self.cfg = cfg
        w = self.w = cfg.world
        self.rw = cfg.reward
        self.E, self.R, self.S = num_envs, w.max_robots, w.map_max
        self.P = w.view_radius
        self.K = 2 * self.P + 1
        self.sight = self.P if w.sight is None else min(w.sight, self.P)
        # Туман внутри окна обзора: клетки дальше sight (по Чебышёву) не видны.
        d = np.abs(np.arange(self.K) - self.P)
        self.fog = (np.maximum(d[:, None], d[None, :]) <= self.sight).astype(np.float32)
        self.Fm = w.factions_max
        self.n_symbols = w.signal_symbols + 1  # 0 — молчание
        self.n_levels = w.signal_levels
        self.map_rng = np.random.default_rng(seed)
        self.rng = np.random.default_rng(seed + 1_000_003)
        self.next_uid = 0

        E, R, S = self.E, self.R, self.S
        self.size = np.zeros(E, np.int64)
        self.n_factions = np.zeros(E, np.int64)
        self.t = np.zeros(E, np.int64)
        self.source = np.zeros((E, S, S), np.float32)
        self.source_max = np.zeros((E, S, S), np.float32)
        self.ship_pos = np.zeros((E, 2), np.int64)
        self.ship_cap = np.zeros(E, np.float32)
        self.ship_charge = np.zeros(E, np.float32)
        self.seats = np.zeros(E, np.int64)
        self.passengers = np.zeros(E, np.int64)
        self.passenger_faction = np.zeros((E, self.Fm), np.int64)
        self.launch_timer = np.full(E, -1, np.int64)
        self.deactivated = np.zeros((E, self.Fm), bool)

        self.status = np.zeros((E, R), np.int64)
        self.uid = np.full((E, R), -1, np.int64)
        self.pos = np.zeros((E, R, 2), np.int64)
        self.faction = np.zeros((E, R), np.int64)
        self.energy = np.zeros((E, R), np.float32)
        self.hp = np.zeros((E, R), np.float32)
        self.upg = np.zeros((E, R, N_UPGRADE - 1), np.int64)
        self.seen_charge = np.zeros((E, R), np.float32)
        self.seen_seats = np.zeros((E, R), np.float32)
        self.seen_ago = np.full((E, R), NEVER_SEEN, np.int64)
        self.prev_action = np.zeros((E, R), np.int64)
        self.new_slot = np.zeros((E, R), bool)

        # Сигналы, переданные на прошлом такте (их слышат в текущем наблюдении).
        self.sig_sym = np.zeros((E, R), np.int64)
        self.sig_val = np.zeros((E, R), np.int64)
        self.sig_pos = np.zeros((E, R, 2), np.int64)

        self.ep_stats = [self._empty_stats() for _ in range(E)]
        self.events: list[list[dict]] = [[] for _ in range(E)]
        for e in range(E):
            self._reset_env(e)

    # ------------------------------------------------------------------ сброс

    @staticmethod
    def _empty_stats() -> dict:
        return {"deposited": 0.0, "kills": 0, "passenger_kills": 0, "births": 0, "upgrades": 0, "signals": 0,
                "gives": 0, "rescues": 0, "leaves": 0, "attacks": 0,
                "pop_sum": 0, "pop_min": None, "pop_max": 0, "signals_by_symbol": None}

    def _reset_env(self, e: int) -> None:
        w, rng = self.w, self.map_rng
        S = int(rng.integers(w.map_min, w.map_max + 1))
        F = int(rng.integers(w.factions_min, w.factions_max + 1))
        self.size[e], self.n_factions[e], self.t[e] = S, F, 0
        self.source[e] = 0
        self.source_max[e] = 0
        c = S // 2
        self.ship_pos[e] = (c + rng.integers(-2, 3), c + rng.integers(-2, 3))
        self.ship_cap[e] = rng.uniform(w.ship_capacity_min, w.ship_capacity_max)
        self.ship_charge[e] = 0
        self.seats[e] = rng.integers(w.seats_min, w.seats_max + 1)
        self.passengers[e] = 0
        self.passenger_faction[e] = 0
        self.launch_timer[e] = -1
        self.deactivated[e] = False

        def clip(p):
            return np.clip(np.asarray(p, np.int64), 0, S - 1)

        def put_source(p, lo, hi):
            x, y = clip(p)
            amount = rng.uniform(lo, hi)
            self.source_max[e, y, x] = max(self.source_max[e, y, x], amount)
            self.source[e, y, x] = self.source_max[e, y, x]

        # Капсулы фракций — по кругу вокруг корабля.
        a0 = rng.uniform(0, 2 * math.pi)
        capsules = []
        for f in range(F):
            a = a0 + 2 * math.pi * f / F + rng.uniform(-0.3, 0.3)
            r = w.capsule_distance * S
            capsules.append(clip((round(c + r * math.cos(a)), round(c + r * math.sin(a)))))
            put_source(capsules[-1] + rng.integers(-2, 3, 2), w.source_amount_min * 0.5, w.source_amount_min)
        # Горячие точки — между капсулами и кораблём, общие для всех.
        for _ in range(int(rng.integers(w.hotspots_min, w.hotspots_max + 1))):
            a, r = rng.uniform(0, 2 * math.pi), rng.uniform(3, 0.42 * S)
            center = np.array((c + r * math.cos(a), c + r * math.sin(a)))
            for _ in range(w.sources_per_hotspot):
                put_source(np.round(center) + rng.integers(-1, 2, 2), w.source_amount_min, w.source_amount_max)

        self.status[e] = EMPTY
        self.uid[e] = -1
        self.sig_sym[e] = 0
        slot = 0
        for f in range(F):
            for _ in range(int(rng.integers(w.robots_per_faction_min, w.robots_per_faction_max + 1))):
                if slot >= self.R:
                    break
                self._spawn(e, slot, clip(capsules[f] + rng.integers(-1, 2, 2)), f, w.energy_start)
                slot += 1
        self.ep_stats[e] = self._empty_stats()

    def _spawn(self, e: int, r: int, pos, faction: int, energy: float) -> None:
        self.status[e, r] = AWAKE
        self.uid[e, r] = self.next_uid
        self.next_uid += 1
        self.pos[e, r] = pos
        self.faction[e, r] = faction
        self.energy[e, r] = energy
        self.hp[e, r] = self.w.hp_max
        self.upg[e, r] = 0
        self.seen_charge[e, r] = 0
        self.seen_seats[e, r] = 0
        self.seen_ago[e, r] = NEVER_SEEN
        self.prev_action[e, r] = NOOP
        self.sig_sym[e, r] = 0
        self.new_slot[e, r] = True

    # ------------------------------------------------------------- геометрия

    def energy_cap(self) -> np.ndarray:
        return self.w.energy_max + self.w.capacity_per_level * self.upg[..., 0]

    def _pairwise(self):
        on_map = (self.status == AWAKE) | (self.status == ASLEEP)
        d = self.pos[:, :, None, :] - self.pos[:, None, :, :]
        cheb = np.abs(d).max(-1)
        eye = np.eye(self.R, dtype=bool)[None]
        adj = (cheb <= 1) & on_map[:, :, None] & on_map[:, None, :] & ~eye
        f = self.faction
        ally = (f[:, :, None] == f[:, None, :]) & (f[:, :, None] >= 0)
        return on_map, cheb, adj, ally

    def _attackable(self, cheb: np.ndarray, adj: np.ndarray, ally: np.ndarray) -> np.ndarray:
        """Кого может атаковать робот: чужих рядом, а если разрешено — и чужих пассажиров (они в клетке корабля)."""
        cand = adj & ~ally
        if self.w.passenger_damage:
            awake = self.status == AWAKE
            boarded = self.status == BOARDED
            cand |= (cheb <= 1) & awake[:, :, None] & boarded[:, None, :] & ~ally
        return cand

    def _ship_dist(self) -> np.ndarray:
        return np.abs(self.pos - self.ship_pos[:, None, :]).max(-1)

    # ------------------------------------------------------------ наблюдения

    @property
    def vec_dim(self) -> int:
        n_self = 3 + (N_UPGRADE - 1) + 2 + 1 + self.Fm + 3 + 6 + 1 + N_MAIN
        n_signal = self.w.signals_heard * (2 + self.n_symbols + 1 + 2 + 1)
        return n_self + n_signal

    def observe(self) -> dict:
        E, R, S, P, K, Fm, w = self.E, self.R, self.S, self.P, self.K, self.Fm, self.w
        st = self.status
        on_map, cheb, adj, ally = self._pairwise()
        awake, asleep = st == AWAKE, st == ASLEEP
        loner = self.faction < 0
        ar_e = np.arange(E)

        # Глобальные слои с отступом P, из которых вырезаются окна обзора.
        G = np.zeros((E, 5 + 2 * Fm, S + 2 * P, S + 2 * P), np.float32)
        ar = np.arange(S)
        inside = (ar[None, :, None] < self.size[:, None, None]) & (ar[None, None, :] < self.size[:, None, None])
        G[:, 0] = 1
        G[:, 0, P:P + S, P:P + S] = ~inside
        G[:, 1, P:P + S, P:P + S] = self.source / w.source_amount_max
        G[ar_e, 2, self.ship_pos[:, 1] + P, self.ship_pos[:, 0] + P] = 1
        ei, ri = np.nonzero(on_map)
        ys, xs = self.pos[ei, ri, 1] + P, self.pos[ei, ri, 0] + P
        sl = asleep[ei, ri].astype(np.int64)
        np.add.at(G, (ei, 3 + sl, ys, xs), 1)
        f = self.faction[ei, ri]
        m = f >= 0
        np.add.at(G, (ei[m], 5 + 2 * f[m] + sl[m], ys[m], xs[m]), 1)

        # Окно (y, x) в буфере с отступом начинается ровно в координатах робота.
        windows = np.lib.stride_tricks.sliding_window_view(G, (K, K), axis=(2, 3))  # (E, C, S, S, K, K)
        patch = windows[ar_e[:, None], :, self.pos[:, :, 1], self.pos[:, :, 0]]  # (E, R, C, K, K)

        fac = np.clip(self.faction, 0, None)[:, :, None, None, None]
        own_aw = np.take_along_axis(patch[:, :, 5::2], fac, axis=2)[:, :, 0]
        own_sl = np.take_along_axis(patch[:, :, 6::2], fac, axis=2)[:, :, 0]
        own_aw[loner] = 0
        own_sl[loner] = 0
        other_aw = patch[:, :, 3] - own_aw
        other_sl = patch[:, :, 4] - own_sl
        # Убираем самого робота из подсчёта соседей.
        ally_aw, ally_sl = own_aw, own_sl
        ally_aw[:, :, P, P] -= (awake & ~loner)
        ally_sl[:, :, P, P] -= (asleep & ~loner)
        other_aw[:, :, P, P] -= (awake & loner)
        other_sl[:, :, P, P] -= (asleep & loner)
        counts = np.minimum(np.stack([ally_aw, ally_sl, other_aw, other_sl], 2), 3) / 3
        grid = np.concatenate([patch[:, :, :3], counts], axis=2).astype(np.float32)
        grid *= (st != EMPTY)[:, :, None, None, None] * self.fog

        # Векторные признаки.
        cap = self.energy_cap()
        ship_d = self._ship_dist()
        rel = (self.ship_pos[:, None, :] - self.pos) / S
        cell_src = self.source[ar_e[:, None], self.pos[:, :, 1], self.pos[:, :, 0]]
        charged = self.ship_charge >= self.ship_cap - 1e-4
        feats = [
            self.energy / cap, self.energy / (w.energy_max * 2), self.hp / w.hp_max,
            *[self.upg[..., i] / w.upgrade_max_level for i in range(N_UPGRADE - 1)],
            asleep, st == BOARDED, loner,
            *[self.faction == i for i in range(Fm)],
            rel[..., 0], rel[..., 1], ship_d / S,
            self.seen_ago == 0, self.seen_charge, self.seen_seats,
            np.log1p(self.seen_ago) / np.log1p(NEVER_SEEN),
            (self.seen_ago == 0) & charged[:, None], ship_d <= 1,
            cell_src / w.source_amount_max,
        ]
        vec = [np.stack(feats, -1).astype(np.float32), np.eye(N_MAIN, dtype=np.float32)[self.prev_action]]

        # Сигналы: M ближайших переданных на прошлом такте в радиусе слышимости.
        M = w.signals_heard
        d = (self.sig_pos[:, None, :, :] - self.pos[:, :, None, :]).astype(np.float32)  # (E, Rrecv, Remit, 2)
        dist = np.sqrt((d ** 2).sum(-1))
        emitting = self.sig_sym > 0
        ok = emitting[:, None, :] & (dist <= w.signal_radius) & on_map[:, :, None] & ~np.eye(R, dtype=bool)[None]
        dist = np.where(ok, dist, np.inf)
        idx = np.argsort(dist, axis=-1)[:, :, :M]
        present = np.take_along_axis(ok, idx, -1)
        dxy = np.take_along_axis(d, idx[..., None], 2) / w.signal_radius
        sym = self.sig_sym[ar_e[:, None, None], idx]
        val = self.sig_val[ar_e[:, None, None], idx] / max(self.n_levels - 1, 1)
        # Свой или чужой — понятно, только если отправитель в поле зрения.
        visible = np.take_along_axis(cheb, idx, -1) <= self.sight
        is_ally = np.take_along_axis(ally, idx, -1)
        sig = np.concatenate([
            dxy, np.eye(self.n_symbols, dtype=np.float32)[sym], val[..., None],
            (visible & is_ally)[..., None], (visible & ~is_ally)[..., None], np.ones_like(val)[..., None],
        ], -1) * present[..., None]
        vec.append(sig.reshape(E, R, -1).astype(np.float32))
        vec = np.concatenate(vec, -1)

        # Маски допустимых действий.
        mm = np.zeros((E, R, N_MAIN), bool)
        mm[..., NOOP] = True
        for a in (UP, DOWN, LEFT, RIGHT):
            npos = self.pos + MOVES[a]
            mm[..., a] = ((npos >= 0) & (npos < self.size[:, None, None])).all(-1)
        mm[..., HARVEST] = (cell_src > 0.01) & (self.energy < cap - 0.01)
        near_ship = ship_d <= 1
        mm[..., DEPOSIT] = near_ship & (self.energy > 0) & ~charged[:, None]
        mm[..., BOARD] = near_ship & (self.passengers < self.seats)[:, None]
        mm[..., GIVE] = (adj & ally).any(-1) & (self.energy > self.w.give_amount)
        mm[..., ATTACK] = self._attackable(cheb, adj, ally).any(-1)
        has_free = (st == EMPTY).any(-1)
        mm[..., REPRODUCE] = (self.energy >= w.reproduce_cost + 1) & has_free[:, None]
        mm[..., LEAVE] = ~loner
        mm[~awake] = False
        mm[..., NOOP] = True

        um = np.zeros((E, R, N_UPGRADE), bool)
        um[..., 0] = True
        um[..., 1:] = (self.energy[..., None] >= w.upgrade_cost + 1) & (self.upg < w.upgrade_max_level) & awake[..., None]

        self._main_mask, self._upg_mask = mm, um
        obs = {
            "grid": grid, "vec": vec, "main_mask": mm, "upg_mask": um,
            "active": st != EMPTY, "acting": awake, "new_slot": self.new_slot.copy(),
        }
        self.new_slot[:] = False
        return obs

    # ------------------------------------------------------------------- шаг

    def step(self, main: np.ndarray, upg: np.ndarray, sym: np.ndarray, val: np.ndarray):
        E, R, S, w, rw = self.E, self.R, self.S, self.w, self.rw
        ar_e = np.arange(E)[:, None]
        st = self.status
        awake = st == AWAKE
        asleep_before = st == ASLEEP
        rew = np.zeros((E, R), np.float32)
        done = np.zeros((E, R), bool)
        for ev in self.events:
            ev.clear()

        main = np.where(awake & np.take_along_axis(self._main_mask, main[..., None], -1)[..., 0], main, NOOP)
        upg = np.where(awake & np.take_along_axis(self._upg_mask, upg[..., None], -1)[..., 0], upg, 0)
        sym = np.where(awake, sym, 0)
        on_map, cheb, adj, ally = self._pairwise()

        # Сигналы.
        emit = sym > 0
        self.energy -= emit * w.signal_cost
        self.sig_sym, self.sig_val, self.sig_pos = sym.copy(), val.copy(), self.pos.copy()

        # Улучшения.
        up = upg > 0
        ue, ur = np.nonzero(up)
        self.upg[ue, ur, upg[ue, ur] - 1] += 1
        self.energy -= up * w.upgrade_cost
        rew += up * rw.upgrades

        # Движение и базовый расход.
        moving = (main >= UP) & (main <= RIGHT)
        self.pos += MOVES[main]
        self.energy -= awake * (w.drain_idle + w.upgrade_drain * self.upg.sum(-1)) + moving * w.drain_move

        # Добыча: несколько роботов в одной клетке делят её запас.
        cap = self.energy_cap()
        hv = main == HARVEST
        want = np.minimum(w.harvest_rate + w.harvest_per_level * self.upg[..., 2], cap - self.energy) * hv
        want = np.maximum(want, 0)
        flat = (ar_e * S * S + self.pos[..., 1] * S + self.pos[..., 0])
        total = np.zeros(E * S * S, np.float32)
        np.add.at(total, flat[hv], want[hv])
        src = self.source.reshape(-1)
        frac = np.divide(src, total, out=np.ones_like(src), where=total > 0)
        frac = np.minimum(frac, 1)
        self.energy += want * frac[flat]
        src -= total * frac
        self.source = src.reshape(E, S, S)

        # Передача энергии союзнику: сначала спящему, иначе самому слабому.
        gv = main == GIVE
        cand = adj & ally
        score = np.where(cand, self.energy[:, None, :] - 1000 * asleep_before[:, None, :], np.inf)
        tgt = score.argmin(-1)
        gv &= np.isfinite(score.min(-1))
        received = np.zeros(E * R, np.float32)
        np.add.at(received, (ar_e * R + tgt)[gv], w.give_amount)
        self.energy -= gv * w.give_amount
        self.energy += received.reshape(E, R)
        self.ep_record(gv, tgt, "give")

        # Атака: урон цели и кража части её энергии.
        at = main == ATTACK
        cand = self._attackable(cheb, adj, ally)
        score = np.where(cand, self.hp[:, None, :], np.inf)
        atgt = score.argmin(-1)
        at &= np.isfinite(score.min(-1))
        armor = self.upg[..., 1][ar_e, atgt]
        mult = np.where(asleep_before[ar_e, atgt], w.sleeping_damage_mult, 1.0)
        dmg = w.attack_damage * np.clip(1 - w.armor_per_level * armor, 0.05, 1) * mult * at
        flat_t = (ar_e * R + atgt)[at]
        dmg_total = np.zeros(E * R, np.float32)
        hits = np.zeros(E * R, np.float32)
        np.add.at(dmg_total, flat_t, dmg[at])
        np.add.at(hits, flat_t, 1)
        e_t = np.maximum(self.energy, 0)[ar_e, atgt]
        steal = np.minimum(w.attack_steal, e_t / np.maximum(hits.reshape(E, R)[ar_e, atgt], 1)) * at
        stolen = np.zeros(E * R, np.float32)
        np.add.at(stolen, flat_t, steal[at])
        self.hp -= dmg_total.reshape(E, R)
        self.energy -= stolen.reshape(E, R)
        self.energy += steal
        self.ep_record(at, atgt, "attack")

        # Зарядка корабля.
        dp = main == DEPOSIT
        amt = np.minimum(w.deposit_amount, np.maximum(self.energy, 0)) * dp
        total = amt.sum(-1)
        room = np.maximum(self.ship_cap - self.ship_charge, 0)
        k = np.divide(room, total, out=np.ones_like(room), where=total > 0)
        amt *= np.minimum(k, 1)[:, None]
        self.energy -= amt
        self.ship_charge += amt.sum(-1)
        rew += amt * rw.ship_charge

        # Посадка: места достаются в случайном порядке среди одновременно вошедших.
        bd = main == BOARD
        prio = np.where(bd, self.rng.random((E, R)), np.inf)
        rank = np.argsort(np.argsort(prio, -1), -1)
        bd &= rank < (self.seats - self.passengers)[:, None]
        self.status[bd] = BOARDED
        self.pos[bd] = np.broadcast_to(self.ship_pos[:, None, :], self.pos.shape)[bd]
        self.passengers += bd.sum(-1)
        be, br = np.nonzero(bd & (self.faction >= 0))
        np.add.at(self.passenger_faction, (be, self.faction[be, br]), 1)

        # Уход из фракции.
        lv = main == LEAVE
        self.faction[lv] = LONER

        # Смерть от атак.
        boarded = self.status == BOARDED
        dead = (on_map & ~boarded | boarded & w.passenger_damage) & (self.hp <= 0)
        # Погибший пассажир освобождает место.
        pd = dead & boarded
        self.passengers -= pd.sum(-1)
        pe, pr = np.nonzero(pd & (self.faction >= 0))
        np.subtract.at(self.passenger_faction, (pe, self.faction[pe, pr]), 1)
        rew += dead * rw.destroyed
        killer = at & dead[ar_e, atgt]
        rew += killer * rw.kills
        if rw.dead_wait:
            self.status[dead] = DEAD
            self.hp[dead] = 0
            self.energy[dead] = 0
        else:
            done |= dead
            self.status[dead] = EMPTY

        # Размножение (редкое действие, поэтому цикл).
        births = np.zeros((E, R), bool)
        for e, r in zip(*np.nonzero((main == REPRODUCE) & (self.status == AWAKE) & (self.energy >= w.reproduce_cost))):
            free = np.nonzero(self.status[e] == EMPTY)[0]
            if len(free) == 0:
                continue
            c = int(free[0])
            self.energy[e, r] -= w.reproduce_cost
            self._spawn(e, c, self.pos[e, r].copy(), int(self.faction[e, r]), w.child_energy)
            births[e, r] = True
            self.events[e].append({"type": "birth", "src": int(self.uid[e, r]), "dst": int(self.uid[e, c])})
        rew += births * rw.spawned

        # Сон и пробуждение.
        cap = self.energy_cap()
        self.energy = np.minimum(self.energy, cap)
        fell = (self.status == AWAKE) & (self.energy <= 0)
        self.energy[fell] = 0
        self.status[fell] = ASLEEP
        woke = (self.status == ASLEEP) & (self.energy > 0) & asleep_before
        self.status[woke] = AWAKE
        rescuer = gv & woke[ar_e, tgt]
        rew += rescuer * rw.rescued

        # Промежуточные «жизненные» награды.
        st = self.status
        rew += (st == AWAKE) * rw.awake + ((st == AWAKE) | (st == ASLEEP)) * rw.alive

        # Вся фракция заснула или погибла.
        for f in range(self.Fm):
            members = (self.faction == f) & ((st == AWAKE) | (st == ASLEEP))
            off = (f < self.n_factions) & ~self.deactivated[:, f] & ~((self.faction == f) & (st == AWAKE)).any(-1)
            rew += (members & off[:, None]) * rw.faction_deactivated
            self.deactivated[:, f] |= off

        # Видимость корабля.
        seen = ((st == AWAKE) | (st == ASLEEP)) & (self._ship_dist() <= self.sight)
        self.seen_ago = np.where(seen, 0, np.minimum(self.seen_ago + 1, NEVER_SEEN))
        self.seen_charge = np.where(seen, (self.ship_charge / self.ship_cap)[:, None], self.seen_charge)
        left = (self.seats - self.passengers) / np.maximum(self.seats, 1)
        self.seen_seats = np.where(seen, left[:, None], self.seen_seats)
        self.prev_action = main.copy()
        self.t += 1

        # Статистика и события для реплеев.
        for e in range(E):
            s = self.ep_stats[e]
            s["deposited"] += float(amt[e].sum())
            s["kills"] += int(dead[e].sum())
            s["passenger_kills"] += int(pd[e].sum())
            s["births"] += int(births[e].sum())
            s["upgrades"] += int(up[e].sum())
            s["signals"] += int(emit[e].sum())
            s["gives"] += int(gv[e].sum())
            s["rescues"] += int(woke[e].sum())
            s["leaves"] += int(lv[e].sum())
            s["attacks"] += int(at[e].sum())
            pop = int(np.isin(st[e], (AWAKE, ASLEEP, BOARDED)).sum())
            s["pop_sum"] += pop
            s["pop_min"] = pop if s["pop_min"] is None else min(s["pop_min"], pop)
            s["pop_max"] = max(s["pop_max"], pop)
            by_sym = np.bincount(sym[e][emit[e]], minlength=self.n_symbols)[1:]
            s["signals_by_symbol"] = by_sym if s["signals_by_symbol"] is None else s["signals_by_symbol"] + by_sym
            ev = self.events[e]
            for r in np.nonzero(emit[e])[0]:
                ev.append({"type": "signal", "src": int(self.uid[e, r]), "sym": int(sym[e, r]), "val": int(val[e, r]),
                           "x": int(self.sig_pos[e, r, 0]), "y": int(self.sig_pos[e, r, 1])})
            for name, mask in (("deposit", dp), ("board", bd), ("leave", lv), ("death", dead), ("sleep", fell),
                               ("wake", woke)):
                for r in np.nonzero(mask[e])[0]:
                    ev.append({"type": name, "src": int(self.uid[e, r])})
            for r in np.nonzero(up[e])[0]:
                ev.append({"type": "upgrade", "src": int(self.uid[e, r]), "what": UPGRADE_NAMES[upg[e, r]]})

        # Корабль и конец матча.
        charged = self.ship_charge >= self.ship_cap - 1e-4
        start = charged & (self.launch_timer < 0)
        self.launch_timer[start] = w.launch_delay
        self.launch_timer[charged & ~start] -= 1
        launch = charged & ((self.launch_timer <= 0) | (self.passengers >= self.seats))
        stuck = ~charged & ~(st == AWAKE).any(-1)
        timeout = ~launch & ((self.t >= w.max_steps) | stuck)

        finished = []
        for e in np.nonzero(launch | timeout)[0]:
            in_play = st[e] != EMPTY
            alive = in_play & (st[e] != DEAD)  # погибшие своё наказание уже получили
            if launch[e]:
                share = np.zeros(self.R, np.float32)
                fm = self.faction[e] >= 0
                share[fm] = self.passenger_faction[e, self.faction[e, fm]] / self.seats[e]
                rew[e] += alive * np.where(st[e] == BOARDED, rw.escape, rw.left_behind) + in_play * rw.faction_share * share
            else:
                rew[e] += alive * rw.timeout
            done[e] |= in_play
            info = dict(self.ep_stats[e])
            ticks = max(int(self.t[e]), 1)
            info["pop_mean"] = info.pop("pop_sum") / ticks
            info["pop_min"] = info["pop_min"] or 0
            by_sym = info["signals_by_symbol"]
            info["signals_by_symbol"] = [0] * (self.n_symbols - 1) if by_sym is None else by_sym.tolist()
            info.update({
                "launched": bool(launch[e]), "length": int(self.t[e]), "passengers": int(self.passengers[e]),
                "seats": int(self.seats[e]), "factions": int(self.n_factions[e]),
                "charge_frac": float(self.ship_charge[e] / self.ship_cap[e]),
                "passenger_faction": self.passenger_faction[e, :self.n_factions[e]].tolist(),
            })
            finished.append((e, info))
            self.events[e].append({"type": "launch" if launch[e] else "timeout"})

        info = {"episodes": [i for _, i in finished], "finished_envs": [e for e, _ in finished]}
        return rew, done, info

    def reset_finished(self, envs: list[int]) -> None:
        """Сбрасывает закончившиеся матчи. Вызывается после step, чтобы реплей успел снять последний кадр."""
        for e in envs:
            self._reset_env(e)

    def ep_record(self, mask: np.ndarray, tgt: np.ndarray, kind: str) -> None:
        for e, r in zip(*np.nonzero(mask)):
            self.events[e].append({"type": kind, "src": int(self.uid[e, r]), "dst": int(self.uid[e, tgt[e, r]])})

    # ---------------------------------------------------------------- реплей

    def snapshot(self, e: int) -> dict:
        robots = []
        for r in np.nonzero((self.status[e] != EMPTY) & (self.status[e] != DEAD))[0]:
            robots.append({
                "id": int(self.uid[e, r]), "slot": int(r),
                "x": int(self.pos[e, r, 0]), "y": int(self.pos[e, r, 1]),
                "faction": int(self.faction[e, r]), "status": STATUS_NAMES[int(self.status[e, r])],
                "energy": round(float(self.energy[e, r]), 2), "hp": round(float(self.hp[e, r]), 2),
                "upgrades": self.upg[e, r].tolist(),
            })
        ys, xs = np.nonzero(self.source[e] > 0.01)
        return {
            "t": int(self.t[e]),
            "ship": {"x": int(self.ship_pos[e, 0]), "y": int(self.ship_pos[e, 1]),
                     "charge": round(float(self.ship_charge[e]), 2), "capacity": round(float(self.ship_cap[e]), 2),
                     "seats": int(self.seats[e]), "passengers": int(self.passengers[e]),
                     "passenger_faction": self.passenger_faction[e, :self.n_factions[e]].tolist(),
                     "launch_timer": int(self.launch_timer[e])},
            "sources": [[int(x), int(y), round(float(self.source[e, y, x]), 1)] for y, x in zip(ys, xs)],
            "robots": robots,
            "events": list(self.events[e]),
        }

    def map_info(self, e: int) -> dict:
        return {"size": int(self.size[e]), "factions": int(self.n_factions[e]), "sight": int(self.sight)}
