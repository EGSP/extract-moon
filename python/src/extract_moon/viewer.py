"""Проигрыватель реплеев на pygame — временная замена представлению на Godot.

Управление — кнопками внизу окна. Дублирующие клавиши: пробел — пауза, ←/→ — такт
назад/вперёд, ↑/↓ — скорость, V — зоны обзора фракций, клик или Tab — выбрать
робота, S — снимок экрана, G — экспорт GIF. Клик по полосе времени — перейти к такту.
"""

from __future__ import annotations

import os
from pathlib import Path

from .replay import load_replay

FACTION_COLORS = [(232, 92, 80), (82, 152, 240), (240, 200, 64), (172, 112, 232)]
LONER_COLOR = (170, 170, 170)
BG, CELL_BG, GRID_LINE = (16, 18, 24), (32, 36, 46), (40, 44, 56)
TEXT, DIM = (225, 228, 235), (130, 136, 150)
BUTTON, BUTTON_HOVER, BUTTON_OFF = (48, 54, 70), (70, 78, 100), (34, 38, 48)
EVENT_COLORS = {"attack": (255, 70, 70), "give": (90, 230, 120), "deposit": (250, 210, 80)}
PANEL_W = 420
TOOLBAR_H = 74
TOOLBAR_W = 1250  # ширина, при которой помещаются все кнопки
# Скорость воспроизведения, тактов в секунду. По умолчанию — такт в 2 секунды.
SPEEDS = [0.5, 1, 2, 4, 8, 16, 32]


def faction_color(f: int):
    return LONER_COLOR if f < 0 else FACTION_COLORS[f % len(FACTION_COLORS)]


def speed_label(speed: float) -> str:
    return f"1 такт / {1 / speed:.0f} с" if speed < 1 else f"{speed:g} такт/с"


class Renderer:
    def __init__(self, header: dict, frames: list[dict], cell: int = 28, controls: bool = True):
        import pygame

        self.pg = pygame
        pygame.font.init()
        self.h, self.frames, self.cell = header, frames, cell
        self.size = header["map"]["size"]
        self.names = header["names"]
        world = header["config"]["world"]
        self.signal_radius = world["signal_radius"]
        # Старые реплеи (правила r1) не знают о тумане: видно всё окно обзора.
        self.sight = header["map"].get("sight", world.get("sight") or world["view_radius"])
        self.controls = controls
        self.map_h = max(self.size * cell, 700)
        self.width = max(self.size * cell + PANEL_W, TOOLBAR_W if controls else 0)
        self.height = self.map_h + (TOOLBAR_H if controls else 0)
        self.font = pygame.font.SysFont("segoeui,arial,dejavusans", 15)
        self.small = pygame.font.SysFont("segoeui,arial,dejavusans", 12)
        self.big = pygame.font.SysFont("segoeui,arial,dejavusans", 20, bold=True)
        self.buttons: list[tuple] = []  # (прямоугольник, действие), заполняются при отрисовке

    def robot_centers(self, frame: dict) -> dict:
        """Несколько роботов в одной клетке раскладываются по её углам."""
        c, by_cell, out = self.cell, {}, {}
        for rb in frame["robots"]:
            if rb["status"] == "boarded":
                continue
            by_cell.setdefault((rb["x"], rb["y"]), []).append(rb)
        offsets = [(0, 0)], [(-0.2, 0), (0.2, 0)], [(-0.2, -0.2), (0.2, -0.2), (0, 0.2)]
        for (x, y), rbs in by_cell.items():
            n = len(rbs)
            offs = offsets[n - 1] if n <= 3 else [(-0.22 + 0.44 * (i % 2), -0.22 + 0.44 * ((i // 2) % 2)) for i in range(n)]
            for rb, (ox, oy) in zip(rbs, offs):
                out[rb["id"]] = (int((x + 0.5 + ox) * c), int((y + 0.5 + oy) * c))
        return out

    def moving_centers(self, idx: int, alpha: float) -> dict:
        """Позиции роботов на доле alpha пути от такта idx к следующему."""
        centers = self.robot_centers(self.frames[idx])
        if alpha <= 0 or idx + 1 >= len(self.frames):
            return centers
        nxt_frame = self.frames[idx + 1]
        nxt = self.robot_centers(nxt_frame)
        sh, c = nxt_frame["ship"], self.cell
        # Севший в корабль в следующем такте летит к кораблю.
        boarding = {rb["id"] for rb in nxt_frame["robots"] if rb["status"] == "boarded"}
        for rid, (x0, y0) in centers.items():
            if rid in nxt:
                x1, y1 = nxt[rid]
            elif rid in boarding:
                x1, y1 = (sh["x"] + 0.5) * c, (sh["y"] + 0.5) * c
            else:
                continue
            centers[rid] = (int(x0 + (x1 - x0) * alpha), int(y0 + (y1 - y0) * alpha))
        return centers

    def vision(self, frame: dict) -> dict:
        """Клетки, которые видит хотя бы один робот фракции: {клетка: множество фракций}."""
        S, s, seen = self.size, self.sight, {}
        for rb in frame["robots"]:
            if rb["status"] not in ("awake", "asleep") or rb["faction"] < 0:
                continue
            for y in range(max(rb["y"] - s, 0), min(rb["y"] + s, S - 1) + 1):
                for x in range(max(rb["x"] - s, 0), min(rb["x"] + s, S - 1) + 1):
                    seen.setdefault((x, y), set()).add(rb["faction"])
        return seen

    def draw_vision(self, surf, frame: dict):
        pg, c = self.pg, self.cell
        layer = pg.Surface((self.size * c, self.size * c), pg.SRCALPHA)
        for (x, y), facs in self.vision(frame).items():
            rect = (x * c, y * c, c, c)
            if len(facs) == 1:
                layer.fill((*faction_color(next(iter(facs))), 46), rect)
                continue
            # Пересечение зон: штриховка цветами всех видящих фракций.
            cols = [faction_color(f) for f in sorted(facs)]
            layer.fill((255, 255, 255, 18), rect)
            step = max(c // 4, 3)
            for i, k in enumerate(range(-c, c, step)):
                col = (*cols[i % len(cols)], 95)
                pg.draw.line(layer, col, (x * c + max(k, 0), y * c + max(-k, 0)),
                             (x * c + min(c + k, c) - 1, y * c + min(c - k, c) - 1), 1)
        surf.blit(layer, (0, 0))

    def draw(self, surf, idx: int, selected: int | None = None, playing: bool = False, speed: float = 1,
             vision: bool = True, stage: tuple[int, int] = (0, 1), mouse=None, alpha: float = 0.0,
             smooth: bool = True):
        """alpha — доля пути к следующему такту: роботы рисуются между клетками, остальное — по такту idx."""
        pg, c = self.pg, self.cell
        fr = self.frames[idx]
        surf.fill(BG)
        S = self.size
        pg.draw.rect(surf, CELL_BG, (0, 0, S * c, S * c))
        if vision:
            self.draw_vision(surf, fr)
        for i in range(S + 1):
            pg.draw.line(surf, GRID_LINE, (i * c, 0), (i * c, S * c))
            pg.draw.line(surf, GRID_LINE, (0, i * c), (S * c, i * c))

        src_max = self.h["config"]["world"]["source_amount_max"]
        for x, y, a in fr["sources"]:
            k = min(a / src_max, 1)
            col = (int(30 + 40 * k), int(80 + 150 * k), int(50 + 40 * k))
            m = int(c * (0.5 - 0.35 * k))
            pg.draw.rect(surf, col, (x * c + m, y * c + m, c - 2 * m, c - 2 * m), border_radius=4)

        sh = fr["ship"]
        zone = pg.Surface((3 * c, 3 * c), pg.SRCALPHA)
        zone.fill((120, 200, 255, 28))
        surf.blit(zone, ((sh["x"] - 1) * c, (sh["y"] - 1) * c))
        pg.draw.rect(surf, (150, 210, 255), (sh["x"] * c + 2, sh["y"] * c + 2, c - 4, c - 4), border_radius=6)
        frac = sh["charge"] / sh["capacity"]
        pg.draw.rect(surf, (60, 60, 70), (sh["x"] * c - c // 2, sh["y"] * c + c + 2, 2 * c, 5))
        pg.draw.rect(surf, (120, 230, 255), (sh["x"] * c - c // 2, sh["y"] * c + c + 2, int(2 * c * frac), 5))

        centers = self.centers = self.moving_centers(idx, alpha)
        ship_c = ((sh["x"] + 0.5) * c, (sh["y"] + 0.5) * c)

        # События такта.
        overlay = pg.Surface((S * c, S * c), pg.SRCALPHA)
        for ev in fr["events"]:
            a = centers.get(ev.get("src"))
            if ev["type"] in ("attack", "give") and a and ev.get("dst") in centers:
                pg.draw.line(surf, EVENT_COLORS[ev["type"]], a, centers[ev["dst"]], 3)
            elif ev["type"] == "deposit" and a:
                pg.draw.line(surf, EVENT_COLORS["deposit"], a, ship_c, 2)
            elif ev["type"] == "signal":
                p = ((ev["x"] + 0.5) * c, (ev["y"] + 0.5) * c)
                pg.draw.circle(overlay, (200, 200, 255, 40), p, int(self.signal_radius * c), 2)
                label = self.names["symbols"][ev["sym"]] + str(ev["val"])
                surf.blit(self.small.render(label, True, (210, 210, 255)), (p[0] + 6, p[1] - c * 0.75))
            elif ev["type"] == "birth" and ev.get("dst") in centers:
                pg.draw.circle(surf, (255, 255, 255), centers[ev["dst"]], int(c * 0.45), 2)
        surf.blit(overlay, (0, 0))

        r = max(int(c * 0.26), 4)
        for rb in fr["robots"]:
            if rb["id"] not in centers:
                continue
            p, col = centers[rb["id"]], faction_color(rb["faction"])
            if rb["status"] == "asleep":
                pg.draw.circle(surf, (50, 52, 60), p, r)
                pg.draw.circle(surf, col, p, r, 2)
                surf.blit(self.small.render("z", True, DIM), (p[0] - 3, p[1] - r - 12))
            else:
                pg.draw.circle(surf, col, p, r)
                e = max(rb["energy"], 0) / 20
                pg.draw.rect(surf, (90, 255, 140), (p[0] - r, p[1] - r - 4, int(2 * r * min(e, 1.5)), 3))
            if sum(rb["upgrades"]):
                pg.draw.circle(surf, (255, 255, 255), p, max(r // 3, 2))
            if rb["id"] == selected:
                pg.draw.circle(surf, (255, 255, 255), p, r + 4, 2)
        # Погибший в этом такте уже не в списке роботов — крест ставим по событию.
        prev = {rb["id"]: rb for rb in self.frames[idx - 1]["robots"]} if idx > 0 else {}
        for ev in fr["events"]:
            if ev["type"] == "death" and ev["src"] in prev:
                rb = prev[ev["src"]]
                x, y = int((rb["x"] + 0.5) * c), int((rb["y"] + 0.5) * c)
                pg.draw.line(surf, (255, 60, 60), (x - r, y - r), (x + r, y + r), 3)
                pg.draw.line(surf, (255, 60, 60), (x - r, y + r), (x + r, y - r), 3)

        self.draw_panel(surf, fr, idx, selected)
        if self.controls:
            self.draw_toolbar(surf, idx, playing, speed, vision, stage, mouse, smooth)

    def draw_panel(self, surf, fr, idx, selected):
        pg = self.pg
        x0, y = self.size * self.cell + 16, 12

        def text(s, col=TEXT, font=None, dx=0):
            nonlocal y
            surf.blit((font or self.font).render(s, True, col), (x0 + dx, y))
            y += (font or self.font).get_linesize()

        sh = fr["ship"]
        res = self.h.get("result") or {}
        text("Extract Moon", font=self.big)
        text(f"такт {fr['t']} / {self.frames[-1]['t']}   карта {self.h['seed']}   модель: обновление {self.h['model']['update']}",
             DIM, self.small)
        y += 6
        timer = f", взлёт через {sh['launch_timer']}" if sh["launch_timer"] >= 0 else ""
        text(f"Корабль: заряд {sh['charge']:.0f}/{sh['capacity']:.0f}{timer}")
        y = self.draw_seats(surf, x0, y + 2, fr)
        counts = {}
        for rb in fr["robots"]:
            counts.setdefault(rb["faction"], {"awake": 0, "asleep": 0, "boarded": 0})[rb["status"]] += 1
        for f in sorted(counts):
            n = counts[f]
            name = "одиночки" if f < 0 else f"фракция {f}"
            pg.draw.circle(surf, faction_color(f), (x0 + 6, y + 10), 6)
            text(f"{name}: бодрых {n['awake']}, спят {n['asleep']}, на борту {n['boarded']}", dx=18)
        if res and idx == len(self.frames) - 1:
            text("Корабль улетел" if res.get("launched") else "Корабль не улетел", (255, 220, 120))
        y += 8

        rb = next((r for r in fr["robots"] if r["id"] == selected), None)
        if rb:
            fname = "одиночка" if rb["faction"] < 0 else f"фракция {rb['faction']}"
            text(f"Робот #{rb['id']} ({fname}, {rb['status']})", faction_color(rb["faction"]))
            text(f"энергия {rb['energy']:.1f}  прочность {rb['hp']:.1f}  улучшения {rb['upgrades']}", DIM, self.small)
            dec = fr["decisions"].get(str(rb["id"]))
            if dec:
                text(f"оценка критика: {dec['critic']:+.2f}", DIM, self.small)
                self.bars(surf, x0, y, self.names["main"], dec["main"], dec["chosen"][0])
                y += 12 * 15 + 6
                self.bars(surf, x0, y, self.names["upgrade"], dec["upgrade"], dec["chosen"][1])
                y += 4 * 15 + 6
                top = sorted(range(len(dec["symbol"])), key=lambda i: -dec["symbol"][i])[:4]
                self.bars(surf, x0, y, [self.names["symbols"][i] for i in top], [dec["symbol"][i] for i in top],
                          top.index(dec["chosen"][2]) if dec["chosen"][2] in top else -1)
        else:
            text("Кликните по роботу, чтобы увидеть его решения", DIM, self.small)

    def draw_seats(self, surf, x0, y, fr) -> int:
        """Места в корабле: занятые окрашены в цвет фракции пассажира."""
        pg, sh = self.pg, fr["ship"]
        aboard = [rb for rb in fr["robots"] if rb["status"] == "boarded"]
        surf.blit(self.small.render(f"Места в корабле: {sh['passengers']}/{sh['seats']}", True, DIM), (x0, y))
        y += self.small.get_linesize() + 2
        w, h, gap = 56, 30, 6
        for i in range(sh["seats"]):
            rect = pg.Rect(x0 + i * (w + gap), y, w, h)
            if i < len(aboard):
                pg.draw.rect(surf, faction_color(aboard[i]["faction"]), rect, border_radius=6)
                label = self.small.render(f"#{aboard[i]['id']}", True, (20, 20, 24))
                surf.blit(label, label.get_rect(center=rect.center))
            else:
                pg.draw.rect(surf, (70, 76, 92), rect, 2, border_radius=6)
        return y + h + 8

    def draw_toolbar(self, surf, idx, playing, speed, vision, stage, mouse, smooth=True):
        pg = self.pg
        y0 = self.map_h
        pg.draw.rect(surf, (24, 27, 35), (0, y0, self.width, TOOLBAR_H))
        # Полоса времени: клик переходит к такту.
        bar = pg.Rect(12, y0 + 8, self.width - 24, 10)
        pg.draw.rect(surf, (50, 54, 66), bar, border_radius=4)
        frac = idx / max(len(self.frames) - 1, 1)
        pg.draw.rect(surf, (120, 180, 255), (bar.x, bar.y, int(bar.w * frac), bar.h), border_radius=4)
        self.buttons = [(bar.inflate(0, 10), "seek")]

        x, y = 12, y0 + 28

        def button(label, action, w=None, enabled=True):
            nonlocal x
            img = self.font.render(label, True, TEXT if enabled else DIM)
            rect = pg.Rect(x, y, w or img.get_width() + 22, 34)
            hover = enabled and mouse is not None and rect.collidepoint(mouse)
            pg.draw.rect(surf, BUTTON_HOVER if hover else (BUTTON if enabled else BUTTON_OFF), rect, border_radius=6)
            surf.blit(img, img.get_rect(center=rect.center))
            if enabled:
                self.buttons.append((rect, action))
            x += rect.w + 6

        def label(s, w):
            nonlocal x
            img = self.small.render(s, True, DIM)
            surf.blit(img, img.get_rect(center=(x + w // 2, y + 17)))
            x += w + 6

        button("|<", "start", 40)
        button("<", "prev", 40)
        button("Пауза" if playing else "Пуск", "play", 86)
        button(">", "next", 40)
        button(">|", "end", 40)
        x += 14
        button("−", "slower", 34, speed > SPEEDS[0])
        label(speed_label(speed), 92)
        button("+", "faster", 34, speed < SPEEDS[-1])
        x += 14
        n_stage, i_stage = stage[1], stage[0]
        button("< этап", "stage-", enabled=i_stage > 0)
        label(f"этап {i_stage + 1}/{n_stage}, обновление {self.h['model']['update']}", 190)
        button("этап >", "stage+", enabled=i_stage < n_stage - 1)
        x += 14
        button(f"Обзор: {'вкл' if vision else 'выкл'}", "vision")
        button(f"Плавно: {'вкл' if smooth else 'выкл'}", "smooth")
        button("Снимок", "shot")
        button("GIF", "gif")

    def action_at(self, pos):
        for rect, action in self.buttons:
            if rect.collidepoint(pos):
                return action
        return None

    def seek_index(self, pos) -> int:
        rect = self.buttons[0][0]
        frac = (pos[0] - rect.x) / max(rect.w, 1)
        return round(min(max(frac, 0), 1) * (len(self.frames) - 1))

    def bars(self, surf, x0, y, names, probs, chosen):
        pg = self.pg
        for i, (n, p) in enumerate(zip(names, probs)):
            yy = y + i * 15
            col = (255, 220, 120) if i == chosen else TEXT
            surf.blit(self.small.render(n, True, col), (x0, yy))
            pg.draw.rect(surf, (50, 54, 66), (x0 + 80, yy + 3, 220, 9))
            pg.draw.rect(surf, (120, 180, 255) if i != chosen else (255, 200, 90), (x0 + 80, yy + 3, int(220 * p), 9))
            surf.blit(self.small.render(f"{p:.2f}", True, DIM), (x0 + 306, yy))

    def pick(self, frame, pos) -> int | None:
        best, bd = None, (self.cell * 0.6) ** 2
        # Во время движения кликают по тому месту, где робот нарисован.
        for rid, (x, y) in (getattr(self, "centers", None) or self.robot_centers(frame)).items():
            d = (x - pos[0]) ** 2 + (y - pos[1]) ** 2
            if d < bd:
                best, bd = rid, d
        return best


def export_gif(path: Path, out: Path, cell: int = 20, fps: int = 8, selected: int | None = None,
               vision: bool = True) -> Path:
    os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
    import pygame
    from PIL import Image

    header, frames = load_replay(path)
    rd = Renderer(header, frames, cell, controls=False)
    surf = pygame.Surface((rd.width, rd.height))
    images = []
    for i in range(len(frames)):
        rd.draw(surf, i, selected, vision=vision)
        images.append(Image.frombytes("RGB", surf.get_size(), pygame.image.tobytes(surf, "RGB")).quantize(128))
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    images[0].save(out, save_all=True, append_images=images[1:], duration=int(1000 / fps), loop=0, optimize=True)
    return out


def replay_name(path: Path) -> str:
    return Path(path).name.removesuffix(".gz").removesuffix(".jsonl")


def find_replays(target: Path) -> list[Path]:
    """Файл реплея, папка с реплеями или папка запуска (тогда берётся её replays/)."""
    target = Path(target)
    if target.is_file():
        return [target]
    if (target / "replays").is_dir():
        target = target / "replays"
    return sorted(target.glob("*.jsonl.gz"))


def fit_cell(size: int, max_cell: int = 28) -> int:
    """Размер клетки, при котором окно помещается на экран."""
    import pygame

    info = pygame.display.Info()
    by_h = (info.current_h - 120 - TOOLBAR_H) // size
    by_w = (info.current_w - PANEL_W - 40) // size
    return max(10, min(max_cell, by_h, by_w))


def run_viewer(target: Path, cell: int | None = None) -> None:
    """Этапы обучения (реплеи в папке) переключаются кнопками; список обновляется на лету."""
    import pygame

    paths = find_replays(target)
    if not paths:
        raise FileNotFoundError(f"реплеи не найдены: {target}")
    pygame.init()
    stage = len(paths) - 1
    screen = rd = path = frames = None

    def open_stage(i: int):
        nonlocal screen, rd, path, frames
        path = paths[i]
        header, frames = load_replay(path)
        rd = Renderer(header, frames, cell or fit_cell(header["map"]["size"]))
        if screen is None or screen.get_size() != (rd.width, rd.height):
            screen = pygame.display.set_mode((rd.width, rd.height))
        pygame.display.set_caption(f"Extract Moon — {replay_name(path)}")

    def switch_stage(delta: int):
        nonlocal paths, stage, idx
        # Пересканируем папку: во время обучения появляются новые этапы.
        fresh = find_replays(target) or paths
        cur = paths[stage]
        paths = fresh
        stage = paths.index(cur) if cur in paths else len(paths) - 1
        stage = max(0, min(stage + delta, len(paths) - 1))
        open_stage(stage)
        idx = min(idx, len(frames) - 1)  # тот же такт на другом этапе

    def save_shot():
        shots = Path(path).parent / "screens"
        shots.mkdir(parents=True, exist_ok=True)
        pygame.image.save(screen, shots / f"{replay_name(path)}_{frames[idx]['t']:04d}.png")
        pygame.display.set_caption(f"Extract Moon — снимок сохранён в {shots}")

    def save_gif():
        out = Path(path).parent / f"{replay_name(path)}.gif"
        pygame.display.set_caption("Экспорт GIF…")
        export_gif(path, out, selected=selected, vision=vision)
        pygame.display.set_caption(f"Extract Moon — сохранено {out}")

    open_stage(stage)
    clock = pygame.time.Clock()
    idx, playing, speed_i, selected, acc, vision, smooth = 0, True, 0, None, 0.0, True, True
    dragging = False

    def do(action: str, pos=None):
        nonlocal idx, playing, speed_i, vision, acc, smooth
        if action == "seek":
            idx, acc = rd.seek_index(pos), 0.0
        elif action == "start":
            idx = 0
        elif action == "end":
            idx, playing = len(frames) - 1, False
        elif action == "prev":
            idx, playing = max(idx - 1, 0), False
        elif action == "next":
            idx, playing = min(idx + 1, len(frames) - 1), False
        elif action == "play":
            if not playing and idx == len(frames) - 1:
                idx = 0
            playing, acc = not playing, 0.0
        elif action == "slower":
            speed_i = max(speed_i - 1, 0)
        elif action == "faster":
            speed_i = min(speed_i + 1, len(SPEEDS) - 1)
        elif action in ("stage-", "stage+"):
            switch_stage(-1 if action == "stage-" else 1)
        elif action == "vision":
            vision = not vision
        elif action == "smooth":
            smooth = not smooth
        elif action == "shot":
            save_shot()
        elif action == "gif":
            save_gif()

    keys = {pygame.K_SPACE: "play", pygame.K_LEFT: "prev", pygame.K_RIGHT: "next", pygame.K_UP: "faster",
            pygame.K_DOWN: "slower", pygame.K_v: "vision", pygame.K_s: "shot", pygame.K_g: "gif",
            pygame.K_i: "smooth"}
    while True:
        dt = clock.tick(60) / 1000
        for ev in pygame.event.get():
            if ev.type == pygame.QUIT or (ev.type == pygame.KEYDOWN and ev.key == pygame.K_ESCAPE):
                pygame.quit()
                return
            if ev.type == pygame.KEYDOWN:
                if ev.key in keys:
                    do(keys[ev.key])
                elif ev.key == pygame.K_TAB:
                    ids = [r["id"] for r in frames[idx]["robots"] if r["status"] != "boarded"]
                    if ids:
                        selected = ids[(ids.index(selected) + 1) % len(ids)] if selected in ids else ids[0]
            if ev.type == pygame.MOUSEBUTTONDOWN and ev.button == 1:
                action = rd.action_at(ev.pos)
                if action:
                    dragging = action == "seek"
                    do(action, ev.pos)
                elif ev.pos[1] < rd.size * rd.cell and ev.pos[0] < rd.size * rd.cell:
                    selected = rd.pick(frames[idx], ev.pos)
            if ev.type == pygame.MOUSEBUTTONUP and ev.button == 1:
                dragging = False
            if ev.type == pygame.MOUSEMOTION and dragging:
                do("seek", ev.pos)
        if playing:
            acc += dt * SPEEDS[speed_i]
            while acc >= 1:
                acc -= 1
                if idx < len(frames) - 1:
                    idx += 1
                else:
                    playing = False
        alpha = acc if playing and smooth else 0.0
        rd.draw(screen, idx, selected, playing, SPEEDS[speed_i], vision, (stage, len(paths)), pygame.mouse.get_pos(),
                alpha, smooth)
        pygame.display.flip()
