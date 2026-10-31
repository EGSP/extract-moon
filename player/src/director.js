// Кинокамера. План съёмки строится заранее по всему реплею и зависит только от такта:
// камера на любом кадре вычисляется заново, поэтому экран и видео совпадают кадр в кадр.
//
// Точка интереса — событие матча с весом и местом. Для каждого плана ищется место,
// где взвешенная плотность событий выше всего, а недавно показанные места штрафуются.

const FOV = 36;
const DEG = Math.PI / 180;
const CAMERA_FLOOR = 0.35;
const SHIP_CLEARANCE = 8; // ближе к кораблю камера не подходит: он высокий и закрыл бы кадр
const CANDIDATES = 260;
const SPATIAL = 2.2; // клеток: разброс места
const LAUNCH_LEAD = 3.5; // секунд ролика перед концом матча на взлёт
const SHIP_MIDDLE = 1.6; // высота цели на корабле
const CHASE_TURN = 150; // градусов облёта за время взлёта
const CHASE_LOW = -28; // корабль отрывается, камера смотрит на него снизу
const CHASE_HIGH = 38; // камера догоняет корабль и смотрит сверху на уходящую карту
const CHASE_LAG = 0.4; // доля взлёта, на которой камера отстаёт

const WEIGHTS = {
  death: 10, birth: 7, board: 6, leave: 5, attack: 5, wake: 3, give: 3, upgrade: 1.5, deposit: 1.5, sleep: 1, signal: 0.3,
};

export const MODES = {
  observer: {
    title: "Наблюдатель", shot: [8, 13], blend: 0.4, cutChance: 0, turn: [20, 55],
    kinds: { wide: 4, orbit: 4, top: 1, push: 2 }, distance: [0.55, 1], closest: 5, elevation: [30, 55], snap: false,
  },
  reporter: {
    title: "Репортаж", shot: [2.5, 4.5], blend: 0, cutChance: 1, turn: [50, 130], still: true,
    kinds: { still: 3, stillWide: 2 }, distance: [0.33, 0.55], closest: 5, elevation: [20, 42], snap: true,
  },
  closeup: {
    title: "Крупный план", shot: [3, 5.5], blend: 0.15, cutChance: 0.7, turn: [35, 100], follow: true,
    kinds: { track: 5, orbit: 3, push: 3, low: 2 }, distance: [0.1, 0.18], closest: 3.5, elevation: [10, 28], snap: true,
  },
  action: {
    title: "Боевик", shot: [1.6, 3.2], blend: 0, cutChance: 1, turn: [45, 130],
    kinds: { track: 4, push: 3, low: 4, orbit: 2 }, distance: [0.22, 0.42], closest: 5, elevation: [8, 30], snap: true,
  },
};

function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a, b, k) => a + (b - a) * k;
const ease = (k) => k * k * (3 - 2 * k);
const unit = (v) => Math.min(Math.max(v, 0), 1);
const shortest = (d) => ((d + 180) % 360 + 360) % 360 - 180;
const between = (rnd, [a, b]) => lerp(a, b, rnd());

function pick(rnd, weights, skip) {
  const items = Object.entries(weights).filter(([k]) => k !== skip);
  let left = rnd() * items.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of items) {
    left -= w;
    if (left <= 0) return k;
  }
  return items[0][0];
}

/** События матча: {t, x, z, w, ids}. Позиция берётся из кадра события или, для погибших, из прошлого. */
export function interestPoints(rep) {
  const { frames, layout } = rep;
  const pts = [];
  const at = (id, i) => layout[i]?.get(id) ?? layout[i - 1]?.get(id) ?? null;
  const quarter = (sh) => Math.floor(Math.min(sh.charge / sh.capacity, 1) * 4);
  frames.forEach((fr, i) => {
    const ship = [fr.ship.x + 0.5, fr.ship.y + 0.5];
    for (const ev of fr.events) {
      const w = WEIGHTS[ev.type];
      if (!w) continue;
      const place = ev.type === "signal" ? [ev.x + 0.5, ev.y + 0.5]
        : ev.type === "deposit" || ev.type === "board" ? ship
        : at(ev.dst, i) ?? at(ev.src, i) ?? ship;
      pts.push({ t: i, x: place[0], z: place[1], w, ids: [ev.src, ev.dst].filter((v) => v !== undefined) });
    }
    const prev = frames[i - 1]?.ship;
    if (prev && quarter(fr.ship) > quarter(prev)) pts.push({ t: i, x: ship[0], z: ship[1], w: 8, ids: [] });
    if (fr.ship.launch_timer >= 0) pts.push({ t: i, x: ship[0], z: ship[1], w: 3, ids: [] });
    // Встречи: рядом стоят чужие фракции или идёт группа своих.
    const awake = fr.robots.filter((rb) => rb.status === "awake");
    for (const a of awake) {
      const near = awake.filter((b) => b !== a && Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 2);
      const foes = near.filter((b) => b.faction !== a.faction).length;
      const w = foes * 0.5 + (near.length - foes) * 0.15;
      const place = at(a.id, i);
      if (w > 0 && place) pts.push({ t: i, x: place[0], z: place[1], w, ids: [a.id] });
    }
  });
  return pts;
}

/** Лучшее место на отрезке тактов. Без событий камера показывает бодрствующего робота. */
function focusOf(rep, pts, from, to, recent, rnd) {
  const inside = pts.filter((p) => p.t >= from && p.t < to).sort((a, b) => b.w - a.w).slice(0, CANDIDATES);
  let best = null;
  let bestScore = 0;
  for (const c of inside) {
    let score = 0;
    for (const p of inside) {
      const d2 = (p.x - c.x) ** 2 + (p.z - c.z) ** 2;
      if (d2 < 36) score += p.w * Math.exp(-d2 / (2 * SPATIAL ** 2));
    }
    for (const [x, z, age] of recent) {
      const d2 = (x - c.x) ** 2 + (z - c.z) ** 2;
      score *= 1 - 0.75 * Math.exp(-d2 / 18) * Math.exp(-age / 3);
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (best) {
    const near = inside.filter((p) => (p.x - best.x) ** 2 + (p.z - best.z) ** 2 < 16);
    const votes = new Map();
    for (const p of near) for (const id of p.ids) votes.set(id, (votes.get(id) ?? 0) + p.w);
    const actor = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const w = near.reduce((s, p) => s + p.w, 0);
    return { x: near.reduce((s, p) => s + p.x * p.w, 0) / w, z: near.reduce((s, p) => s + p.z * p.w, 0) / w, actor };
  }
  const i = Math.min(Math.floor(lerp(from, to, 0.5)), rep.frames.length - 1);
  const awake = rep.frames[i].robots.filter((rb) => rb.status === "awake");
  const rb = awake[Math.floor(rnd() * awake.length)];
  if (rb) return { x: rb.x + 0.5, z: rb.y + 0.5, actor: rb.id };
  return { x: rep.header.map.size / 2, z: rep.header.map.size / 2, actor: null };
}

export class Director {
  /** world нужен для сглаженного пути робота, shipLift — для высоты корабля на взлёте. */
  constructor(rep, world, { mode, seed, from, to, speed, shipLift }) {
    Object.assign(this, { rep, world, mode: MODES[mode], seed, from, to, speed, shipLift });
    this.pts = interestPoints(rep);
    this.plan(random(seed * 7919 + 13));
  }

  plan(rnd) {
    const { rep, mode, from, to, speed, pts } = this;
    const last = rep.frames.length - 1;
    const launched = !!rep.header.result?.launched;
    const finale = launched && to > last ? Math.max(last - LAUNCH_LEAD * speed, from) : Infinity;
    const end = Math.min(to, finale);
    const span = (rep.header.map.size * 0.62 / Math.tan((FOV / 2) * DEG)) * 1.08;
    const recent = [];
    this.shots = [];
    let t = from;
    let az = rnd() * 360;
    let kind = null;
    let cut = true;
    while (t < end) {
      let length = between(rnd, mode.shot) * speed;
      if (mode.snap) length = this.snapCut(t, length, end);
      let stop = t + length;
      if (end - stop < mode.shot[0] * speed * 0.6) stop = end;
      const focus = focusOf(rep, pts, Math.floor(t), Math.ceil(stop), recent, rnd);
      recent.forEach((r) => r[2]++);
      recent.push([focus.x, focus.z, 0]);
      kind = pick(rnd, mode.kinds, kind);
      if (kind === "track" && focus.actor === null) kind = "orbit";
      az += (rnd() < 0.5 ? -1 : 1) * between(rnd, mode.turn);
      this.shots.push({ ...this.frame(kind, focus, az, span, rnd), kind, from: t, to: stop, cut });
      cut = rnd() < mode.cutChance;
      t = stop;
    }
    if (finale < to) {
      const ship = rep.frames[last].ship;
      this.shots.push({
        kind: "launch", from: finale, to, cut: true, focus: { x: ship.x + 0.5, z: ship.y + 0.5, actor: null },
        az: [az, mode.still ? az : az + 25], dist: [SHIP_CLEARANCE + 3, SHIP_CLEARANCE + 3], el: [14, 6],
      });
    }
  }

  /** Склейка за мгновение до сильного события: зритель успевает увидеть само действие. */
  snapCut(t, length, end) {
    const margin = 0.4 * this.speed;
    const peak = this.pts
      .filter((p) => p.w >= 5 && p.t < end && p.t - margin > t + length * 0.7 && p.t - margin < t + length * 1.3)
      .sort((a, b) => b.w - a.w)[0];
    return peak ? peak.t - margin - t : length;
  }

  frame(kind, focus, az, span, rnd) {
    const { mode } = this;
    const dist = between(rnd, mode.distance) * span;
    const el = between(rnd, mode.elevation);
    const sweep = (rnd() < 0.5 ? -1 : 1) * lerp(10, 30, rnd());
    const near = Math.max(dist, mode.closest);
    const low = Math.min(el, 12);
    const shape = {
      wide: { az: [az, az + sweep], dist: [span, span * 0.92], el: [el + 8, el + 4] },
      top: { az: [az, az + sweep * 0.6], dist: [span * 0.85, span * 0.75], el: [78, 72] },
      orbit: { az: [az, az + sweep * 1.6], dist: [near, near], el: [el, el + 4] },
      push: { az: [az, az + sweep * 0.3], dist: [near * 1.35, near * 0.85], el: [el + 4, el] },
      track: { az: [az, az + sweep * 0.5], dist: [near, near * 0.92], el: [el, el] },
      low: { az: [az, az + sweep], dist: [near * 0.9, near * 0.75], el: [low, low + 3] },
      still: { az: [az, az], dist: [near, near], el: [el, el] },
      stillWide: { az: [az, az], dist: [near * 1.5, near * 1.5], el: [el + 8, el + 8] },
    }[kind];
    return { focus, ...shape };
  }

  /** Взлёт: цель держится точно на корабле, камера отстаёт, затем догоняет его по спирали. */
  launchParams(s, tick) {
    const last = this.rep.frames.length - 1;
    const tail = Math.max(tick - last, 0);
    const rise = unit(tail / Math.max(s.to - last, 1e-3));
    const k = ease(unit((tick - s.from) / Math.max(last - s.from, 1e-3)));
    const el = rise < CHASE_LAG
      ? lerp(lerp(s.el[0], s.el[1], k), CHASE_LOW, ease(rise / CHASE_LAG))
      : lerp(CHASE_LOW, CHASE_HIGH, ease((rise - CHASE_LAG) / (1 - CHASE_LAG)));
    return {
      x: s.focus.x, y: SHIP_MIDDLE + this.shipLift(tail), z: s.focus.z, dist: s.dist[0],
      az: lerp(s.az[0], s.az[1], k) + (this.mode.still ? 0 : CHASE_TURN * ease(rise)), el,
    };
  }

  /** Параметры плана на такте: цель, расстояние и углы. */
  params(s, tick) {
    if (s.kind === "launch") return this.launchParams(s, tick);
    const k = ease(unit((tick - s.from) / Math.max(s.to - s.from, 1e-3)));
    let [x, z] = [s.focus.x, s.focus.z];
    const follows = s.kind === "track" || (this.mode.follow && s.focus.actor !== null);
    if (follows) [x, z] = this.world.smoothPoint(s.focus.actor, tick);
    const ship = this.rep.frames[this.rep.frames.length - 1].ship;
    const fromShip = Math.hypot(x - ship.x - 0.5, z - ship.y - 0.5);
    const clearance = SHIP_CLEARANCE * (1 - ease(unit((fromShip - 3) / 4)));
    const dist = Math.max(lerp(s.dist[0], s.dist[1], k), clearance);
    return { x, y: 0.6, z, dist, az: lerp(s.az[0], s.az[1], k), el: lerp(s.el[0], s.el[1], k) };
  }

  /** Такты смены планов: метки на клипе. */
  get cuts() {
    return this.shots.slice(1).map((s) => s.from);
  }

  /** Положение камеры и цель на дробном такте. */
  pose(tick) {
    const { mode, shots } = this;
    let i = 0;
    while (i + 1 < shots.length && shots[i + 1].from <= tick) i++;
    const s = shots[i];
    let p = this.params(s, tick);
    const next = shots[i + 1];
    if (next && !next.cut && mode.blend > 0) {
      const start = s.to - (s.to - s.from) * mode.blend;
      if (tick > start) {
        const k = ease((tick - start) / (s.to - start));
        const q = this.params(next, next.from);
        p = {
          x: lerp(p.x, q.x, k), y: lerp(p.y, q.y, k), z: lerp(p.z, q.z, k), dist: lerp(p.dist, q.dist, k),
          az: p.az + shortest(q.az - p.az) * k, el: lerp(p.el, q.el, k),
        };
      }
    }
    const target = [p.x, p.y, p.z];
    const az = p.az * DEG;
    const el = p.el * DEG;
    const position = [
      target[0] + Math.sin(az) * Math.cos(el) * p.dist,
      Math.max(target[1] + Math.sin(el) * p.dist, CAMERA_FLOOR),
      target[2] + Math.cos(az) * Math.cos(el) * p.dist,
    ];
    return { position, target };
  }
}
