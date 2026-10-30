// Команды камеры для видео. Каждая запоминает такт начала и исходный вид камеры,
// поэтому положение камеры на любом такте вычисляется заново и не зависит от прошлых кадров.
const DEG = Math.PI / 180;

export class Commands {
  constructor() {
    this.list = [];
    this.follow = true; // камера на экране следует за командами
    this.key = null;
    this.nextId = 1;
  }

  load(key) {
    this.key = key;
    this.follow = true;
    try {
      this.list = JSON.parse(localStorage.getItem(key)) ?? [];
    } catch {
      this.list = [];
    }
    this.nextId = Math.max(0, ...this.list.map((c) => c.id)) + 1;
  }

  save() {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.list));
    } catch {
      // Без хранилища команды живут до закрытия окна.
    }
  }

  get recording() {
    return this.list.find((c) => c.type === "orbit" && c.end === null) ?? null;
  }

  get enabled() {
    return this.list.filter((c) => c.enabled).sort((a, b) => a.start - b.start);
  }

  add(type, tick, camera, rate = 0) {
    this.list.push({ id: this.nextId++, type, enabled: true, start: tick, end: null, rate, camera });
    this.follow = true;
    this.save();
  }

  /** Завершает вращение. Если такты не сдвинулись, команда ничего не делает и удаляется. */
  stop(tick) {
    const c = this.recording;
    if (!c) return;
    if (tick <= c.start) this.remove(c.id);
    else c.end = tick;
    this.save();
  }

  remove(id) {
    this.list = this.list.filter((c) => c.id !== id);
    this.save();
  }

  toggle(id) {
    const c = this.list.find((x) => x.id === id);
    c.enabled = !c.enabled;
    this.save();
  }

  /** speed — тактов в секунду: скорость вращения задана в градусах за секунду ролика. */
  pose(tick, speed) {
    const on = this.enabled;
    if (!on.length) return null;
    const cur = on.filter((c) => c.start <= tick).pop() ?? on[0];
    const t = Math.min(Math.max(tick, cur.start), cur.end ?? Infinity);
    return { camera: cur.camera, angle: ((cur.rate * (t - cur.start)) / speed) * DEG };
  }
}
