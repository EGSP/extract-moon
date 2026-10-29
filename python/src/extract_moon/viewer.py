"""Проигрыватель реплеев на pygame — временная замена представлению на Godot.

Управление: пробел — пауза, ←/→ — кадр назад/вперёд, ↑/↓ — скорость,
Home — в начало, PageUp/PageDown — предыдущий/следующий этап обучения,
клик или Tab — выбрать робота, S — снимок экрана, G — экспорт GIF.
"""

from __future__ import annotations

import os
from pathlib import Path

from .replay import load_replay

FACTION_COLORS = [(232, 92, 80), (82, 152, 240), (240, 200, 64), (172, 112, 232)]
LONER_COLOR = (170, 170, 170)
BG, CELL_BG, GRID_LINE = (16, 18, 24), (32, 36, 46), (40, 44, 56)
TEXT, DIM = (225, 228, 235), (130, 136, 150)
EVENT_COLORS = {"attack": (255, 70, 70), "give": (90, 230, 120), "deposit": (250, 210, 80)}
PANEL_W = 400


def faction_color(f: int):
    return LONER_COLOR if f < 0 else FACTION_COLORS[f % len(FACTION_COLORS)]


class Renderer:
    def __init__(self, header: dict, frames: list[dict], cell: int = 28):
        import pygame

        self.pg = pygame
        pygame.font.init()
        self.h, self.frames, self.cell = header, frames, cell
        self.size = header["map"]["size"]
        self.names = header["names"]
        self.signal_radius = header["config"]["world"]["signal_radius"]
        self.width = self.size * cell + PANEL_W
        self.height = max(self.size * cell, 640)
        self.font = pygame.font.SysFont("segoeui,arial,dejavusans", 15)
        self.small = pygame.font.SysFont("segoeui,arial,dejavusans", 12)
        self.big = pygame.font.SysFont("segoeui,arial,dejavusans", 20, bold=True)

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

    def draw(self, surf, idx: int, selected: int | None = None, playing: bool = False, speed: int = 0,
             controls: bool = True):
        pg, c = self.pg, self.cell
        fr = self.frames[idx]
        surf.fill(BG)
        S = self.size
        pg.draw.rect(surf, CELL_BG, (0, 0, S * c, S * c))
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

        centers = self.robot_centers(fr)
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
        for ev in fr["events"]:
            if ev["type"] == "death" and ev["src"] in centers:
                x, y = centers[ev["src"]]
                pg.draw.line(surf, (255, 60, 60), (x - r, y - r), (x + r, y + r), 3)
                pg.draw.line(surf, (255, 60, 60), (x - r, y + r), (x + r, y - r), 3)

        self.draw_panel(surf, fr, idx, selected, playing, speed, controls)

    def draw_panel(self, surf, fr, idx, selected, playing, speed, controls):
        pg = self.pg
        x0, y = self.size * self.cell + 16, 12

        def text(s, col=TEXT, font=None, dx=0):
            nonlocal y
            surf.blit((font or self.font).render(s, True, col), (x0 + dx, y))
            y += (font or self.font).get_linesize()

        sh = fr["ship"]
        res = self.h.get("result") or {}
        text("Extract Moon", font=self.big)
        text(f"такт {fr['t']} / {self.frames[-1]['t']}   seed {self.h['seed']}   модель: update {self.h['model']['update']}", DIM, self.small)
        y += 6
        timer = f", взлёт через {sh['launch_timer']}" if sh["launch_timer"] >= 0 else ""
        text(f"Корабль: заряд {sh['charge']:.0f}/{sh['capacity']:.0f}{timer}")
        text(f"Места: {sh['passengers']}/{sh['seats']}  по фракциям: {sh['passenger_faction']}")
        counts = {}
        for rb in fr["robots"]:
            counts.setdefault(rb["faction"], {"awake": 0, "asleep": 0, "boarded": 0})[rb["status"]] += 1
        for f in sorted(counts):
            n = counts[f]
            name = "одиночки" if f < 0 else f"фракция {f}"
            surf.blit(self.font.render("●", True, faction_color(f)), (x0, y))
            text(f"{name}: бодрых {n['awake']}, спят {n['asleep']}, на борту {n['boarded']}", dx=16)
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
                y += 4 * 15 + 6
        else:
            text("Кликните по роботу, чтобы увидеть его решения", DIM, self.small)

        if not controls:
            return
        y = self.height - 3 * self.small.get_linesize() - 8
        text(f"{'воспроизведение' if playing else 'пауза'}, скорость {speed} кадр/с", DIM, self.small)
        text("пробел пауза · ←/→ кадр · ↑/↓ скорость · Home начало · PgUp/PgDn этап", DIM, self.small)
        text("клик/Tab выбор · S снимок · G экспорт GIF", DIM, self.small)

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
        for rid, (x, y) in self.robot_centers(frame).items():
            d = (x - pos[0]) ** 2 + (y - pos[1]) ** 2
            if d < bd:
                best, bd = rid, d
        return best


def export_gif(path: Path, out: Path, cell: int = 20, fps: int = 8, selected: int | None = None) -> Path:
    os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
    import pygame
    from PIL import Image

    header, frames = load_replay(path)
    rd = Renderer(header, frames, cell)
    surf = pygame.Surface((rd.width, rd.height))
    images = []
    for i in range(len(frames)):
        rd.draw(surf, i, selected, controls=False)
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


def run_viewer(target: Path, cell: int = 28) -> None:
    """Несколько реплеев (этапы обучения) переключаются PageUp/PageDown; список обновляется на лету."""
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
        rd = Renderer(header, frames, cell)
        if screen is None or screen.get_size() != (rd.width, rd.height):
            screen = pygame.display.set_mode((rd.width, rd.height))
        title = f"Extract Moon — {replay_name(path)}"
        if len(paths) > 1:
            title += f"  (этап {i + 1}/{len(paths)}, PageUp/PageDown)"
        pygame.display.set_caption(title)

    open_stage(stage)
    clock = pygame.time.Clock()
    idx, playing, speed, selected, acc = 0, True, 8, None, 0.0
    while True:
        dt = clock.tick(60) / 1000
        for ev in pygame.event.get():
            if ev.type == pygame.QUIT or (ev.type == pygame.KEYDOWN and ev.key == pygame.K_ESCAPE):
                pygame.quit()
                return
            if ev.type == pygame.KEYDOWN:
                if ev.key == pygame.K_SPACE:
                    playing = not playing
                elif ev.key == pygame.K_RIGHT:
                    idx, playing = min(idx + 1, len(frames) - 1), False
                elif ev.key == pygame.K_LEFT:
                    idx, playing = max(idx - 1, 0), False
                elif ev.key == pygame.K_UP:
                    speed = min(speed * 2, 64)
                elif ev.key == pygame.K_DOWN:
                    speed = max(speed // 2, 1)
                elif ev.key == pygame.K_HOME:
                    idx = 0
                elif ev.key in (pygame.K_PAGEUP, pygame.K_PAGEDOWN):
                    # Пересканируем папку: во время обучения появляются новые этапы.
                    fresh = find_replays(target)
                    if fresh:
                        cur = paths[stage]
                        paths = fresh
                        stage = paths.index(cur) if cur in paths else len(paths) - 1
                        stage = max(0, min(stage + (1 if ev.key == pygame.K_PAGEDOWN else -1), len(paths) - 1))
                        open_stage(stage)
                        idx = min(idx, len(frames) - 1)  # тот же такт на другом этапе
                elif ev.key == pygame.K_TAB:
                    ids = [r["id"] for r in frames[idx]["robots"] if r["status"] != "boarded"]
                    if ids:
                        selected = ids[(ids.index(selected) + 1) % len(ids)] if selected in ids else ids[0]
                elif ev.key == pygame.K_s:
                    shots = Path(path).parent / "screens"
                    shots.mkdir(parents=True, exist_ok=True)
                    pygame.image.save(screen, shots / f"{replay_name(path)}_{frames[idx]['t']:04d}.png")
                elif ev.key == pygame.K_g:
                    out = Path(path).parent / f"{replay_name(path)}.gif"
                    pygame.display.set_caption("Экспорт GIF…")
                    export_gif(path, out, selected=selected)
                    pygame.display.set_caption(f"Extract Moon — сохранено {out.name}")
            if ev.type == pygame.MOUSEBUTTONDOWN and ev.button == 1:
                selected = rd.pick(frames[idx], ev.pos)
        if playing:
            acc += dt * speed
            while acc >= 1:
                acc -= 1
                if idx < len(frames) - 1:
                    idx += 1
                else:
                    playing = False
        rd.draw(screen, idx, selected, playing, speed)
        pygame.display.flip()
