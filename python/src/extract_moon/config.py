"""Все параметры мира, наград, модели и обучения в одном месте.

Конфиг сериализуется в JSON вместе с чекпойнтом, поэтому любую версию модели
можно воспроизвести с теми же правилами.
"""

from __future__ import annotations

import dataclasses
import json
from dataclasses import dataclass, field
from pathlib import Path

# Версия правил симуляции и наград. Меняется, когда меняется смысл правил, а не просто значения
# параметров; история версий — в EXPERIMENTS.md.
RULES_VERSION = 3

# Значения новых параметров, при которых правила работают как до их появления. Применяются к
# сохранённым конфигам, где параметра ещё нет, — так старые чекпойнты воспроизводятся по своим правилам.
LEGACY: dict[str, dict] = {
    "world": {"sight": None},  # r1: видно всё окно обзора
    "reward": {"dead_wait": False},  # r1: погибший сразу выбывает и не получает долю за союзников
    "model": {},
    "train": {},
}


@dataclass
class WorldConfig:
    # Размер буфера карты. Активная область каждого матча случайна в пределах [map_min, map_max].
    map_max: int = 18
    map_min: int = 14
    factions_min: int = 2
    factions_max: int = 3
    robots_per_faction_min: int = 3
    robots_per_faction_max: int = 4
    max_robots: int = 24  # число слотов на матч (с учётом потомства)
    seats_min: int = 3  # N — мест в корабле
    seats_max: int = 5
    max_steps: int = 300  # тайм-аут: корабль так и не зарядили — проиграли все

    # Корабль: ёмкость (сколько энергии нужно доставить) и зарядка.
    ship_capacity_min: float = 80.0
    ship_capacity_max: float = 120.0
    deposit_amount: float = 4.0  # сколько робот отдаёт за одно действие
    # После полной зарядки корабль ждёт столько тактов (время T на посадку) и улетает.
    launch_delay: int = 12

    # Источники энергии: «горячие точки», общие для фракций.
    # Капсулы на расстоянии такой доли карты от центра. Дальше 0,4 случайные блуждания почти
    # не доводят роботов до корабля, и сеть с нуля учится просто стоять на месте.
    capsule_distance: float = 0.35

    hotspots_min: int = 3
    hotspots_max: int = 5
    sources_per_hotspot: int = 3
    source_amount_min: float = 15.0
    source_amount_max: float = 30.0
    source_regen: float = 0.08  # восстановление за такт
    harvest_rate: float = 2.0

    # Робот.
    energy_start: float = 12.0
    energy_max: float = 20.0
    hp_max: float = 10.0
    drain_idle: float = 0.05
    drain_move: float = 0.15
    signal_cost: float = 0.3
    give_amount: float = 3.0
    attack_damage: float = 2.5
    attack_steal: float = 1.5  # атака отбирает часть энергии цели
    sleeping_damage_mult: float = 2.0

    # Улучшения тела: ёмкость, броня, скорость добычи. Каждый уровень увеличивает расход.
    upgrade_cost: float = 5.0
    upgrade_max_level: int = 3
    upgrade_drain: float = 0.02  # добавочный расход за такт на каждый уровень
    capacity_per_level: float = 8.0
    armor_per_level: float = 0.35  # доля поглощённого урона
    harvest_per_level: float = 1.0

    # Размножение.
    reproduce_cost: float = 10.0
    child_energy: float = 6.0

    # Зрение и сигналы.
    view_radius: int = 5  # окно (2r+1)^2 вокруг робота — вход сети; его изменение несовместимо со старыми моделями
    # Дальность зрения: клетки окна дальше неё закрыты туманом. None — видно всё окно.
    sight: int | None = 4
    signal_symbols: int = 8  # α, β, γ, … — смысла не несут
    signal_levels: int = 16
    signal_radius: float = 7.0
    signals_heard: int = 4  # робот слышит не больше стольких ближайших сигналов за такт


@dataclass
class RewardConfig:
    # Главная.
    escape: float = 10.0
    faction_share: float = 4.0  # знак и вес задают «характер общества»
    left_behind: float = -5.0
    destroyed: float = -5.0
    faction_deactivated: float = -2.0
    timeout: float = -5.0  # корабль не улетел — проиграли все, включая пассажиров; погибшим не начисляется повторно
    # Погибший робот ждёт конца матча и получает свою долю faction_share, если союзники улетели.
    dead_wait: bool = True

    # Промежуточные.
    alive: float = 0.0
    awake: float = 0.002
    spawned: float = 0.0
    ship_charge: float = 0.2  # за единицу энергии, отданной кораблю
    upgrades: float = 0.0
    rescued: float = 0.3
    kills: float = 0.0


@dataclass
class ModelConfig:
    d_model: int = 192
    n_layers: int = 3
    ffn_mult: int = 4
    head_hidden: int = 128


@dataclass
class TrainConfig:
    num_envs: int = 16
    rollout_len: int = 64
    total_updates: int = 2000
    lr: float = 3e-4
    gamma: float = 0.99
    gae_lambda: float = 0.95
    clip: float = 0.2
    epochs: int = 3
    minibatch_streams: int = 96  # робот-потоков в минибатче: ~0,6 ГБ видеопамяти, больше на GTX 1050 не помещается
    value_coef: float = 0.5
    entropy_coef: float = 0.01
    max_grad_norm: float = 0.5
    save_every: int = 50
    log_every: int = 5
    # Реплей на одной и той же карте по ходу обучения: видно, как меняется поведение. 0 — отключить.
    replay_every: int = 100
    replay_seed: int = 1000
    seed: int = 0
    device: str = "auto"


@dataclass
class Config:
    world: WorldConfig = field(default_factory=WorldConfig)
    reward: RewardConfig = field(default_factory=RewardConfig)
    model: ModelConfig = field(default_factory=ModelConfig)
    train: TrainConfig = field(default_factory=TrainConfig)

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Config":
        def build(section, dc, values):
            names = {f.name for f in dataclasses.fields(dc)}
            values = values or {}
            legacy = {k: v for k, v in LEGACY[section].items() if k not in values} if values else {}
            return dc(**{k: v for k, v in {**values, **legacy}.items() if k in names})

        return cls(
            world=build("world", WorldConfig, d.get("world")),
            reward=build("reward", RewardConfig, d.get("reward")),
            model=build("model", ModelConfig, d.get("model")),
            train=build("train", TrainConfig, d.get("train")),
        )

    def save(self, path: Path) -> None:
        Path(path).write_text(json.dumps(self.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> "Config":
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))

    def override(self, pairs: list[str]) -> "Config":
        """Применяет переопределения вида `train.lr=1e-4` из командной строки."""
        d = self.to_dict()
        for pair in pairs:
            key, _, raw = pair.partition("=")
            section, _, name = key.partition(".")
            if section not in d or name not in d[section]:
                raise KeyError(f"неизвестный параметр: {key}")
            old = d[section][name]
            value = json.loads(raw) if not isinstance(old, str) else raw
            d[section][name] = value if old is None or value is None else type(old)(value)
        return Config.from_dict(d)
