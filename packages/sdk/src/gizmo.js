// Гизмо осей, как в игровых редакторах: показывает поворот камеры,
// щелчок по оси задаёт вид, перетаскивание вращает камеру.
import * as THREE from "three";

const SIZE = 112;
const REACH = 38;
const COLORS = { x: "#fa4d56", y: "#42be65", z: "#4589ff" };
export const AXES = [
  { name: "X", dir: [1, 0, 0], axis: "x" },
  { name: "Y", dir: [0, 1, 0], axis: "y" },
  { name: "Z", dir: [0, 0, 1], axis: "z" },
  { name: "", dir: [-1, 0, 0], axis: "x" },
  { name: "", dir: [0, -1, 0], axis: "y" },
  { name: "", dir: [0, 0, -1], axis: "z" },
];

export class Gizmo {
  /** view даёт camera, orbit(dx, dy) и viewAlong(x, y, z). draw() окно вызывает после каждого кадра. */
  constructor(el, view, { axes = AXES, colors = COLORS } = {}) {
    this.view = view;
    this.axes = axes;
    this.colors = colors;
    el.classList.add("axis-gizmo");
    el.innerHTML = `<svg viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}"></svg>`;
    this.svg = el.firstChild;
    this.key = "";
    let drag = null;
    el.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, moved: false, axis: e.target.closest("[data-axis]")?.dataset.axis };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
      view.orbit(dx, dy);
    });
    el.addEventListener("pointerup", () => {
      if (drag && !drag.moved && drag.axis !== undefined) view.viewAlong(...axes[drag.axis].dir);
      drag = null;
    });
  }

  draw() {
    const q = this.view.camera.quaternion.clone().invert();
    const key = q.toArray().map((v) => v.toFixed(3)).join();
    if (key === this.key) return;
    this.key = key;
    const c = SIZE / 2;
    const items = this.axes.map((a, i) => {
      const v = new THREE.Vector3(...a.dir).applyQuaternion(q);
      return { ...a, i, x: c + v.x * REACH, y: c - v.y * REACH, z: v.z, color: this.colors[a.axis] };
    }).sort((a, b) => a.z - b.z);
    this.svg.innerHTML = items.map(({ name, color, i, x, y }) => {
      const line = name ? `<line x1="${c}" y1="${c}" x2="${x}" y2="${y}" stroke="${color}" stroke-width="2"/>` : "";
      const dot = name
        ? `<circle cx="${x}" cy="${y}" r="10" fill="${color}"/><text x="${x}" y="${y + 4}">${name}</text>`
        : `<circle class="hole" cx="${x}" cy="${y}" r="7" stroke="${color}"/>`;
      return `${line}<g data-axis="${i}">${dot}</g>`;
    }).join("");
  }
}
