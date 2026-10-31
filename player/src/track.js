// Плавные кривые для камеры. Робот меняет клетку и направление скачком, поэтому камера
// идёт не за ним напрямую, а по значениям тактов, сглаженным заранее и интерполированным между тактами.

const HEADING_REACH = 5; // тактов в каждую сторону: курс считается по смещению за это окно
const HEADING_MIN_MOVE = 1.2; // клеток: меньшее смещение за окно считается топтанием на месте
const HEADING_MAX_TURN = 0.25; // радиан за такт
const REVERSAL = 2.6; // радиан: разворот почти на 180°, у которого нет короткого направления

const shortest = (d) => ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

/** Курс по пути робота, неразрывный по тактам. Шаги влево-вправо и стоянка курс не меняют.
 *  Разворот возвращает курс к исходному, поэтому движение туда-обратно не накапливает обороты. */
export function headingCurve(xs, zs, fallback = 0) {
  const last = xs.length - 1;
  const target = xs.map((_, i) => {
    const a = Math.max(i - HEADING_REACH, 0);
    const b = Math.min(i + HEADING_REACH, last);
    const dx = xs[b] - xs[a];
    const dz = zs[b] - zs[a];
    return Math.hypot(dx, dz) >= HEADING_MIN_MOVE ? Math.atan2(dx, dz) : null;
  });
  const home = target.find((v) => v !== null) ?? fallback;
  let cur = home;
  return target.map((aim) => {
    if (aim === null) return cur;
    let d = shortest(aim - cur);
    if (Math.abs(d) > REVERSAL && Math.abs(cur + d - home) > Math.abs(cur + d - Math.sign(d) * 2 * Math.PI - home)) {
      d -= Math.sign(d) * 2 * Math.PI;
    }
    cur += Math.min(Math.max(d, -HEADING_MAX_TURN), HEADING_MAX_TURN);
    return cur;
  });
}

/** Гауссово сглаживание; за краями повторяются крайние значения. */
export function gaussian(values, sigma) {
  const reach = Math.ceil(sigma * 3);
  const weights = [];
  for (let d = -reach; d <= reach; d++) weights.push(Math.exp(-(d * d) / (2 * sigma * sigma)));
  const total = weights.reduce((a, b) => a + b, 0);
  const last = values.length - 1;
  return values.map((_, i) => {
    let sum = 0;
    weights.forEach((w, k) => {
      sum += w * values[Math.min(Math.max(i + k - reach, 0), last)];
    });
    return sum / total;
  });
}

/** Значение на дробном такте по сплайну Катмулла — Рома: скорость не скачет на границе тактов. */
export function sampleCurve(curve, t) {
  const last = curve.length - 1;
  const clamped = Math.min(Math.max(t, 0), last);
  const i = Math.min(Math.floor(clamped), last - 1);
  if (i < 0) return curve[0];
  const k = clamped - i;
  const at = (n) => curve[Math.min(Math.max(n, 0), last)];
  const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
  return 0.5 * (2 * p1 + (p2 - p0) * k + (2 * p0 - 5 * p1 + 4 * p2 - p3) * k * k + (3 * p1 - p0 - 3 * p2 + p3) * k * k * k);
}
