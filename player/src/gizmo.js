// Гизмо осей, как в игровых редакторах: показывает поворот камеры,
// щелчок по оси задаёт вид, перетаскивание вращает камеру.
import * as THREE from "three";

const SIZE = 112;
const REACH = 38;
const AXES = [
  { name: "X", dir: [1, 0, 0], color: "#fa4d56" },
  { name: "Y", dir: [0, 1, 0], color: "#42be65" },
  { name: "Z", dir: [0, 0, 1], color: "#4589ff" },
  { name: "", dir: [-1, 0, 0], color: "#fa4d56" },
  { name: "", dir: [0, 0, -1], color: "#4589ff" },
];

export class Gizmo {
  constructor(el, world) {
    this.world = world;
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
      world.orbit(dx, dy);
    });
    el.addEventListener("pointerup", () => {
      if (drag && !drag.moved && drag.axis !== undefined) world.viewAlong(...AXES[drag.axis].dir);
      drag = null;
    });
    world.onRender = () => this.draw();
  }

  draw() {
    const q = this.world.camera.quaternion.clone().invert();
    const key = q.toArray().map((v) => v.toFixed(3)).join();
    if (key === this.key) return;
    this.key = key;
    const c = SIZE / 2;
    const items = AXES.map((a, i) => {
      const v = new THREE.Vector3(...a.dir).applyQuaternion(q);
      return { ...a, i, x: c + v.x * REACH, y: c - v.y * REACH, z: v.z };
    }).sort((a, b) => a.z - b.z);
    this.svg.innerHTML = items.map(({ name, color, i, x, y }) => {
      const line = name ? `<line x1="${c}" y1="${c}" x2="${x}" y2="${y}" stroke="${color}" stroke-width="2"/>` : "";
      const dot = name
        ? `<circle cx="${x}" cy="${y}" r="10" fill="${color}"/><text x="${x}" y="${y + 4}">${name}</text>`
        : `<circle cx="${x}" cy="${y}" r="7" fill="#161616" stroke="${color}" stroke-width="2"/>`;
      return `${line}<g data-axis="${i}">${dot}</g>`;
    }).join("");
  }
}
