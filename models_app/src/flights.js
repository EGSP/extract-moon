// Пролёты камеры. Маршрут строится заранее и зависит только от времени,
// поэтому просмотр в окне и ролик совпадают кадр в кадр.
import * as THREE from 'three';

const TOP = new THREE.Vector3(0, 1, 0.01).normalize();  // строго сверху камере не определить, где верх
const ISO = new THREE.Vector3(-1, 1, 1).normalize();
const SWEEP_SPEED = 4;     // единиц сцены в секунду при скорости ×1
const TRAVEL_SPEED = 7;    // переход между группами
const TRAVEL_MIN = 1.4;    // секунд
const LEAD = 1;            // секунд неподвижности в начале и в конце
const ORBIT_SECONDS = 24;
const SWEEP_FILL = 0.75;   // доля половины кадра от края модели до точки старта
const CAPTION_FADE = 0.4;

export const KINDS = {
  top: { title: 'Сверху, от начала до конца' },
  iso: { title: 'Изометрия, от начала до конца' },
  groups: { title: 'По группам' },
  orbit: { title: 'Облёт вокруг модели' },
  still: { title: 'Текущий вид' },
};
export const SPEEDS = [0.5, 0.75, 1, 1.5, 2, 3];

const ease = x => x * x * x * (x * (6 * x - 15) + 10);
const pose = (target, dir, dist) => ({ target, dir, dist });

function hold(at, seconds, extra = {}) {
  return { seconds, from: at, to: at, ...extra };
}

/** Проход вдоль потока данных: кадр по высоте вмещает модель, камера идёт от первого блока к последнему. */
function sweep(ctx, dir, speed) {
  const { box, aspect, fit, tanHalf } = ctx;
  const center = box.getCenter(new THREE.Vector3());
  const slice = box.clone();
  slice.min.x = slice.max.x = center.x;
  const dist = fit(slice, dir, aspect);
  const half = dist * tanHalf * aspect * SWEEP_FILL;
  const first = box.min.x + half, last = box.max.x - half;
  const at = x => pose(center.clone().setX(x), dir, dist);
  const [a, b] = first < last ? [at(first), at(last)] : [at(center.x), at(center.x)];
  return [
    hold(a, LEAD),
    { seconds: Math.max(a.target.distanceTo(b.target) / SWEEP_SPEED / speed, 2), from: a, to: b },
    hold(b, LEAD),
  ];
}

/** Камера задерживается на каждой группе: зритель успевает прочитать название. */
function groupTour(ctx, { from, to, pause, speed }) {
  const { groups, aspect, fit } = ctx;
  const a = groups.findIndex(g => g.id === from), b = groups.findIndex(g => g.id === to);
  const route = a <= b ? groups.slice(a, b + 1) : groups.slice(b, a + 1).reverse();
  const steps = [];
  route.forEach((g, i) => {
    const center = g.box.getCenter(new THREE.Vector3());
    const at = pose(center, ISO, fit(g.box, ISO, aspect));
    if (i) {
      const prev = steps[steps.length - 1].to;
      steps.push({ seconds: Math.max(center.distanceTo(prev.target) / TRAVEL_SPEED, TRAVEL_MIN) / speed, from: prev, to: at });
    }
    steps.push(hold(at, pause, { group: g.id, caption: { title: g.title, text: g.purpose, color: g.color } }));
  });
  return steps;
}

function orbit(ctx, speed) {
  const { box, aspect, fit } = ctx, center = box.getCenter(new THREE.Vector3());
  const dist = fit(box, ISO, aspect) * 1.08;
  const spin = k => {
    const dir = ISO.clone().applyAxisAngle(THREE.Object3D.DEFAULT_UP, k * Math.PI * 2);
    return pose(center, dir, dist);
  };
  return [{ seconds: ORBIT_SECONDS / speed, spin, linear: true }];
}

/** spec: kind, speed, pause (задержка на группе), seconds (длина ролика на текущем виде), from и to (группы). */
export function buildFlight(spec, ctx) {
  const steps = spec.kind === 'top' ? sweep(ctx, TOP, spec.speed)
    : spec.kind === 'iso' ? sweep(ctx, ISO, spec.speed)
    : spec.kind === 'groups' ? groupTour(ctx, spec)
    : spec.kind === 'orbit' ? orbit(ctx, spec.speed)
    : [hold(ctx.view, spec.seconds)];
  let start = 0;
  for (const s of steps) { s.start = start; start += s.seconds; }
  const duration = start;

  function at(t) {
    const s = steps.find(x => t < x.start + x.seconds) ?? steps[steps.length - 1];
    const k = THREE.MathUtils.clamp((t - s.start) / s.seconds, 0, 1);
    const fade = Math.min(1, (t - s.start) / CAPTION_FADE, (s.start + s.seconds - t) / CAPTION_FADE);
    const extra = { group: s.group ?? null, caption: s.caption ?? null, alpha: Math.max(fade, 0) };
    if (s.spin) return { ...s.spin(k), ...extra };
    const e = s.linear ? k : ease(k);
    return {
      target: s.from.target.clone().lerp(s.to.target, e),
      dir: s.from.dir.clone().lerp(s.to.dir, e).normalize(),
      dist: THREE.MathUtils.lerp(s.from.dist, s.to.dist, e),
      ...extra,
    };
  }
  return { duration, at };
}
