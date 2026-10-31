// Графики на canvas. Оси один раз рисуются с конечным масштабом, на кадр анимации меняются только линии:
// так тринадцать панелей проигрываются плавно. Цвет линии закреплён за куском ветки или колонкой.
export const COLORS = ["#0f62fe", "#eb6200", "#198038", "#d02670", "#8a3ffc", "#b28600", "#007d79", "#6f6f6f", "#6929c4", "#1192e8"];
const GRID = "#e0e0e0";
const INK = "#6f6f6f";
const INK_STRONG = "#525252";
const SURFACE = "#f4f4f4";
const CURSOR = "#161616";
const CHOSEN = "#da1e28";
const FONT = '11px "IBM Plex Sans", "Segoe UI", sans-serif';
const RUN_FONT = '600 26px "IBM Plex Sans", "Segoe UI", sans-serif';
const RUN_LINE = 30;
const RUN_ALPHA = 0.22;
const RUN_LEVEL = 0.72; // доля шкалы, если свободной полосы на участке нет
const DASH = { "-": [], "--": [6, 4], ":": [2, 3], "-.": [6, 3, 2, 3] };
export const color = (i) => COLORS[i % COLORS.length];

// Индекс первой точки правее x: столько точек линии видно на этом кадре.
export function visibleCount(xs, x) {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function niceTicks(lo, hi, count = 4) {
  if (lo === hi) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toPrecision(10));
  return out;
}

export function formatValue(v) {
  const a = Math.abs(v);
  if (a < 1e-12) return "0"; // ноль шкалы после сложения шагов
  if (a >= 1e6) return `${+(v / 1e6).toFixed(2)} млн`.replace(".", ",");
  if (a >= 1e3) return `${+(v / 1e3).toFixed(1)} тыс`.replace(".", ",");
  if (a >= 10 || a === 0) return String(+v.toFixed(1)).replace(".", ",");
  return String(+v.toPrecision(3)).replace(".", ",");
}

function fit(canvas) {
  const ratio = devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  const w = Math.max(Math.round(width), 10);
  const h = Math.max(Math.round(height), 10);
  if (canvas.width !== w * ratio || canvas.height !== h * ratio) {
    canvas.width = w * ratio;
    canvas.height = h * ratio;
  }
  return { w, h, ratio };
}

/** Уровень подписи: середина самой широкой свободной полосы над кривой участка или под ней. */
export function freeLevel(values) {
  if (!values.length) return RUN_LEVEL;
  const hi = Math.max(...values);
  const lo = Math.min(...values);
  const above = 1 - hi;
  if (above < 0.25 && lo < 0.25) return RUN_LEVEL;
  return above >= lo ? hi + above / 2 : lo / 2;
}

/** Сокращает строку по центру: начало и конец имени запуска различают его лучше всего. */
export function middleTruncate(g, text, width) {
  if (g.measureText(text).width <= width) return text;
  for (let keep = text.length - 1; keep >= 2; keep--) {
    const head = text.slice(0, Math.ceil(keep / 2));
    const tail = text.slice(text.length - Math.floor(keep / 2));
    if (g.measureText(`${head}…${tail}`).width <= width) return `${head}…${tail}`;
  }
  return null;
}

/** Строки подписи при неизменном размере шрифта: перенос по дефисам и подчёркиваниям, иначе сокращение по центру. */
export function fitLabel(g, label, width, maxLines) {
  const lines = [];
  for (const part of label.match(/[^-_]+[-_]*/g) ?? [label]) {
    const joined = lines.length ? lines[lines.length - 1] + part : part;
    if (lines.length && g.measureText(joined).width <= width) lines[lines.length - 1] = joined;
    else lines.push(part);
  }
  if (lines.length <= maxLines && lines.every((l) => g.measureText(l).width <= width)) return lines;
  if (lines.length <= maxLines) {
    const short = lines.map((l) => middleTruncate(g, l, width));
    if (short.every(Boolean)) return short;
  }
  const one = middleTruncate(g, label, width);
  return one ? [one] : [];
}

function trace(g, xs, ys, from, to, px, py) {
  g.beginPath();
  for (let i = from; i < to; i++) {
    if (i === from) g.moveTo(px(xs[i]), py(ys[i]));
    else g.lineTo(px(xs[i]), py(ys[i]));
  }
  g.stroke();
}

/** Одна панель. draw(x) показывает линии до значения x по горизонтали; без него весь график. */
export class Panel {
  constructor(canvas, panel, chart, tip) {
    Object.assign(this, { canvas, panel, chart, tip });
    this.limit = Infinity;
    this.hover = null;
    this.cursor = null;
    this.peers = [this];
    const all = panel.lines.flatMap((l) => l.xs);
    this.xlo = all.length ? Math.min(...panel.lines.map((l) => l.xs[0])) : 0;
    this.xhi = all.length ? Math.max(...panel.lines.map((l) => l.xs[l.xs.length - 1])) : 1;
    if (this.xlo === this.xhi) this.xhi += 1;
    let lo = Infinity;
    let hi = -Infinity;
    for (const line of panel.lines) {
      for (const v of line.ys ?? line.smooth) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (lo === Infinity) [lo, hi] = [0, 1];
    if (lo === hi) [lo, hi] = [lo - 0.5, hi + 0.5];
    const pad = (hi - lo) * 0.05;
    this.ylo = lo - pad;
    this.yhi = hi + pad;
    canvas.onpointermove = (e) => this.onHover(e);
    canvas.onpointerleave = () => this.onHover(null);
  }

  layout() {
    const { w, h, ratio } = fit(this.canvas);
    this.box = { left: 46, right: w - 10, top: 8, bottom: h - 20, w, h, ratio };
    const { left, right, top, bottom } = this.box;
    this.px = (x) => left + ((x - this.xlo) / (this.xhi - this.xlo)) * (right - left);
    this.py = (y) => bottom - ((y - this.ylo) / (this.yhi - this.ylo)) * (bottom - top);
  }

  background() {
    this.layout();
    const { left, right, top, bottom, w, h, ratio } = this.box;
    const off = (this.back ??= document.createElement("canvas"));
    off.width = w * ratio;
    off.height = h * ratio;
    const g = off.getContext("2d");
    g.scale(ratio, ratio);
    g.font = FONT;
    g.lineWidth = 1;
    g.strokeStyle = GRID;
    g.fillStyle = INK;
    g.textBaseline = "middle";
    g.textAlign = "right";
    for (const v of niceTicks(this.ylo, this.yhi, 5)) {
      const y = Math.round(this.py(v)) + 0.5;
      g.beginPath();
      g.moveTo(left, y);
      g.lineTo(right, y);
      g.stroke();
      g.fillText(formatValue(v), left - 6, y);
    }
    g.textBaseline = "top";
    g.textAlign = "center";
    const ticks = niceTicks(this.xlo, this.xhi, Math.max(Math.floor((right - left) / 80), 2));
    for (const v of ticks) g.fillText(formatValue(v), this.px(v), bottom + 6);
    g.strokeStyle = "#8d8d8d";
    g.beginPath();
    g.moveTo(left, bottom + 0.5);
    g.lineTo(right, bottom + 0.5);
    g.stroke();
    g.textAlign = "left";
    for (const mark of this.chart.branches) {
      const x = Math.round(this.px(mark.steps)) + 0.5;
      if (x < left || x > right) continue;
      g.strokeStyle = INK_STRONG;
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(x, top);
      g.lineTo(x, bottom);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = INK_STRONG;
      g.fillText(`u${mark.update}`, x + 3, top);
    }
  }

  draw(limit = this.limit) {
    this.limit = limit;
    if (!this.back || this.back.width !== Math.round(this.canvas.getBoundingClientRect().width * (devicePixelRatio || 1))) this.background();
    const { ratio, left, right, top, bottom } = this.box;
    const g = this.canvas.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (this.canvas.width !== this.back.width || this.canvas.height !== this.back.height) fit(this.canvas);
    g.setTransform(1, 0, 0, 1, 0, 0);  // fit мог задать масштаб; фон прозрачный, прошлый кадр надо стереть
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.back, 0, 0);
    g.scale(ratio, ratio);
    g.save();
    g.beginPath();
    g.rect(left, top - 2, right - left, bottom - top + 4);
    g.clip();
    g.lineJoin = "round";
    // Длинные линии снизу: при сравнении родитель виден поверх общего участка с потомком.
    const order = [...this.panel.lines].sort((a, b) => b.xs.length - a.xs.length);
    for (const line of order) this.drawLine(g, line, visibleCount(line.xs, limit));
    g.restore();
    if (this.hover !== null) this.drawHover(g);
  }

  drawLine(g, line, n) {
    if (line.ys) {
      g.strokeStyle = "rgba(141,141,141,.35)";
      g.lineWidth = 1;
      trace(g, line.xs, line.ys, 0, n, this.px, this.py);
    }
    g.lineWidth = 2;
    g.setLineDash(DASH[line.dash] ?? []);
    if (line.segments) {
      for (const s of line.segments) {
        if (s.from >= n) continue;
        g.strokeStyle = color(s.color);
        trace(g, line.xs, line.smooth, s.from, Math.min(s.to, n), this.px, this.py);
      }
      for (const i of line.joints) if (i < n) dot(g, this.px(line.xs[i]), this.py(line.smooth[i]), 3.5, CURSOR);
    } else {
      g.strokeStyle = color(line.color);
      trace(g, line.xs, line.smooth, 0, n, this.px, this.py);
      // Стыки ветки при сравнении: где запуск продолжил предка.
      g.setLineDash([]);
      for (const i of line.joints ?? []) if (i < n) dot(g, this.px(line.xs[i]), this.py(line.smooth[i]), 3, color(line.color));
    }
    g.setLineDash([]);
  }

  onHover(e) {
    if (!e || !this.panel.lines.length) {
      this.setCursor(null);
      this.tip.hidden = true;
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const x = this.xlo + ((px - this.box.left) / (this.box.right - this.box.left)) * (this.xhi - this.xlo);
    this.setCursor(Math.min(Math.max(x, this.xlo), Math.min(this.xhi, this.limit)));
    this.hover = this.cursor;
    this.showTip(rect);
  }

  /** Курсор общий для всех панелей: линия стоит на том же опыте. Перерисовка раз в кадр, панелей до тринадцати. */
  setCursor(x) {
    for (const p of this.peers) p.cursor = x;
    if (this.peers.pending) return;
    this.peers.pending = true;
    requestAnimationFrame(() => {
      this.peers.pending = false;
      for (const p of this.peers) {
        p.hover = p.cursor ?? null;
        p.draw();
      }
    });
  }

  drawHover(g) {
    const { top, bottom } = this.box;
    const x = Math.round(this.px(this.hover)) + 0.5;
    if (this.hover < this.xlo || this.hover > this.xhi) return;
    g.strokeStyle = CURSOR;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, top);
    g.lineTo(x, bottom);
    g.stroke();
    for (const line of this.panel.lines) {
      const i = Math.max(visibleCount(line.xs, this.hover) - 1, 0);
      dot(g, this.px(line.xs[i]), this.py(line.smooth[i]), 3, lineColor(line, i));
    }
  }

  showTip(rect) {
    const marks = this.chart.marks;
    const steps = this.hover;
    const update = marks.length ? marks[Math.max(visibleCount(marks.map((m) => m[1]), steps) - 1, 0)][0] : null;
    const rows = this.panel.lines.slice(0, 16).map((line) => {
      const i = Math.max(visibleCount(line.xs, steps) - 1, 0);
      const label = line.label ?? line.segments?.find((s) => i >= s.from && i < s.to)?.label ?? "среднее";
      return `<div><i style="background:${lineColor(line, i)}"></i><span>${label}</span><b>${formatValue(line.smooth[i])}</b></div>`;
    });
    this.tip.innerHTML = `<p>${update !== null ? `обновление ${update}, ` : ""}${formatValue(steps)} робот-тактов</p>${rows.join("")}`;
    this.tip.hidden = false;
    const parent = this.tip.offsetParent.getBoundingClientRect();
    const x = this.px(steps) + rect.left - parent.left;
    const wide = this.tip.offsetWidth;
    this.tip.style.left = `${x + wide + 16 > parent.width ? x - wide - 12 : x + 12}px`;
    this.tip.style.top = `${rect.top - parent.top + 8}px`;
  }
}

function lineColor(line, i) {
  if (!line.segments) return color(line.color);
  return color((line.segments.find((s) => i >= s.from && i < s.to) ?? line.segments[0]).color);
}

function dot(g, x, y, r, fill) {
  g.fillStyle = fill;
  g.strokeStyle = SURFACE;
  g.lineWidth = 2;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.stroke();
}

/** Шкала моделей: кривая взлётов ветки по обновлениям и сами модели. cursor — положение линии курсора в пикселях.
 *  Возвращает зоны для щелчка и подсказки и функцию at, которая по пикселю даёт обновление и значение кривой. */
export function drawTimeline(canvas, run, selected, cursor = null) {
  const { w, h, ratio } = fit(canvas);
  const g = canvas.getContext("2d");
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.clearRect(0, 0, w, h);
  g.font = FONT;
  const left = 44;
  const right = w - 16;
  const top = 34;
  const bottom = h - 28;
  const hi = run.range;
  const x = (u) => left + (u / hi) * (right - left);
  const y = (v) => bottom - v * (bottom - top);

  g.textBaseline = "middle";
  g.textAlign = "right";
  g.lineWidth = 1;
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    const py = Math.round(y(v)) + 0.5;
    g.strokeStyle = GRID;
    g.beginPath();
    g.moveTo(left, py);
    g.lineTo(right, py);
    g.stroke();
    g.fillStyle = INK;
    g.fillText(`${v * 100} %`, left - 6, py);
  }
  g.textBaseline = "top";
  g.textAlign = "center";
  for (const u of niceTicks(0, hi, Math.max(Math.floor((right - left) / 90), 2))) g.fillText(String(u), x(u), bottom + 8);

  if (run.state === "обучается" && run.update < hi) {
    g.fillStyle = "#e8e8e8";
    g.fillRect(x(run.update), top, right - x(run.update), bottom - top);
    g.fillStyle = INK_STRONG;
    g.textBaseline = "middle";
    if (right - x(run.update) > 90) g.fillText("ещё обучается", (x(run.update) + right) / 2, (top + bottom) / 2);
  }

  g.textAlign = "left";
  g.textBaseline = "top";
  for (const mark of run.timeline.branches) {
    const px = Math.round(x(mark.update)) + 0.5;
    g.strokeStyle = INK_STRONG;
    g.setLineDash([4, 3]);
    g.beginPath();
    g.moveTo(px, top);
    g.lineTo(px, bottom);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = INK_STRONG;
    g.fillText(`u${mark.update}`, px + 4, top - 14);
  }

  const { xs, smooth, segments, joints } = run.timeline;
  // Имена прогонов под кривой: по ширине в центре своего участка, по высоте в свободной полосе, шрифт постоянный.
  g.save();
  g.font = RUN_FONT;
  g.globalAlpha = RUN_ALPHA;
  g.textAlign = "center";
  g.textBaseline = "middle";
  segments.forEach((s, i) => {
    const from = i ? x(xs[s.from]) : left;
    const to = i < segments.length - 1 ? x(xs[s.to - 1]) : right;
    const lines = fitLabel(g, s.label, to - from - 12, Math.max(Math.floor((bottom - top) / RUN_LINE), 1));
    const half = (lines.length * RUN_LINE) / 2;
    const level = Math.min(Math.max(y(freeLevel(smooth.slice(s.from, s.to))), top + half), bottom - half);
    g.fillStyle = color(s.color);
    lines.forEach((line, n) => g.fillText(line, (from + to) / 2, level + (n - (lines.length - 1) / 2) * RUN_LINE));
  });
  g.restore();

  g.lineJoin = "round";
  g.lineWidth = 2;
  for (const s of segments) {
    g.strokeStyle = color(s.color);
    trace(g, xs, smooth, s.from, s.to, x, y);
  }
  for (const i of joints) dot(g, x(xs[i]), y(smooth[i]), 3.5, CURSOR);

  const zones = [];
  for (const m of [...run.models].reverse()) {
    const px = x(m.update);
    const chosen = m.update === selected;
    if (chosen) {
      g.strokeStyle = CHOSEN;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(px, top);
      g.lineTo(px, bottom);
      g.stroke();
    }
    const r = chosen ? 6 : 4;
    g.fillStyle = chosen ? CHOSEN : m.stage ? INK_STRONG : SURFACE;
    g.strokeStyle = chosen ? CHOSEN : INK_STRONG;
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(px, bottom, r, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    zones.push({ x: px, model: m });
  }

  const taken = new Map();
  for (const child of run.children) {
    const px = x(child.update);
    const row = taken.get(child.update) ?? 0;
    taken.set(child.update, row + 1);
    const py = 8 + row * 12;
    g.fillStyle = "#eb6200";
    g.beginPath();
    g.moveTo(px, py - 5);
    g.lineTo(px + 5, py);
    g.lineTo(px, py + 5);
    g.lineTo(px - 5, py);
    g.fill();
    const label = child.name.startsWith(`${run.name}-`) ? child.name.slice(run.name.length + 1) : child.name;
    const wide = g.measureText(label).width;
    g.fillStyle = INK_STRONG;
    g.textBaseline = "middle";
    g.textAlign = px + 9 + wide > right ? "right" : "left";
    g.fillText(label, g.textAlign === "right" ? px - 9 : px + 9, py);
  }
  const at = (px) => {
    const u = Math.min(Math.max(((px - left) / (right - left)) * hi, 0), hi);
    const i = visibleCount(xs, u) - 1;
    return { update: Math.round(u), value: i >= 0 ? smooth[i] : null, x: Math.min(Math.max(px, left), right), y: i >= 0 ? y(smooth[i]) : null };
  };
  if (cursor !== null) {
    const point = at(cursor);
    const px = Math.round(point.x) + 0.5;
    g.strokeStyle = CURSOR;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(px, top);
    g.lineTo(px, bottom);
    g.stroke();
    if (point.y !== null) dot(g, point.x, point.y, 3.5, CURSOR);
  }
  return { zones, at };
}
