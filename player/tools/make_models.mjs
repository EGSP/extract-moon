// Собирает модели в public/models/*.glb. Единица длины — клетка карты, ось Y вверх.
// GLB можно заменить файлом из Blender: проигрыватель ищет узлы по именам ниже,
// а материал paint перекрашивает в цвет фракции.
import { mkdirSync, writeFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

// GLTFExporter читает Blob через FileReader, которого в Node нет.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => { this.result = buf; this.onloadend?.(); });
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = `data:${blob.type};base64,${Buffer.from(buf).toString("base64")}`;
      this.onloadend?.();
    });
  }
};

const mat = (name, color, metalness = 0.2, roughness = 0.6, emissive = 0x000000, emissiveIntensity = 1) =>
  new THREE.MeshStandardMaterial({ name, color, metalness, roughness, emissive, emissiveIntensity });

const paint = mat("paint", 0xffffff, 0.25, 0.45);
const steel = mat("steel", 0x8d8d8d, 0.7, 0.4);
const dark = mat("dark", 0x262626, 0.4, 0.7);
const hull = mat("hull", 0xe0e0e0, 0.35, 0.4);
const glow = mat("glow", 0x82cfff, 0, 0.3, 0x82cfff, 2.2);
const crystal = mat("crystal", 0x42be65, 0.1, 0.2, 0x42be65, 1.1);

function part(parent, geo, material, x = 0, y = 0, z = 0, name = "") {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.name = name;
  parent.add(m);
  return m;
}

function node(parent, name, x = 0, y = 0, z = 0) {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

const box = (w, h, d, r = 0.02) => new RoundedBoxGeometry(w, h, d, 3, r);

// Робот смотрит вдоль +Z. Узлы: treadL, treadR, body, head, antenna,
// upgCapacity, upgArmor, upgHarvest (скрыты, пока нет улучшения).
function robot() {
  const root = new THREE.Group();
  root.name = "robot";
  for (const [name, x] of [["treadL", -0.15], ["treadR", 0.15]]) {
    const tread = node(root, name, x, 0.07, 0);
    part(tread, box(0.1, 0.14, 0.36, 0.05), dark);
    for (const z of [-0.12, 0, 0.12]) {
      const wheel = part(tread, new THREE.CylinderGeometry(0.05, 0.05, 0.115, 12), steel, 0, 0, z);
      wheel.rotation.z = Math.PI / 2;
    }
  }
  const body = node(root, "body", 0, 0.15, 0);
  part(body, box(0.3, 0.2, 0.3, 0.05), paint, 0, 0.11, 0);
  part(body, box(0.2, 0.05, 0.02, 0.01), glow, 0, 0.13, 0.15);
  part(body, new THREE.CylinderGeometry(0.05, 0.07, 0.05, 12), steel, 0, 0.23, 0);
  const head = node(body, "head", 0, 0.27, 0);
  part(head, box(0.22, 0.15, 0.2, 0.05), hull, 0, 0.06, 0);
  part(head, box(0.17, 0.05, 0.02, 0.01), glow, 0, 0.07, 0.1);
  const antenna = node(head, "antenna", 0.07, 0.13, -0.03);
  part(antenna, new THREE.CylinderGeometry(0.008, 0.008, 0.12, 6), steel, 0, 0.06, 0);
  part(antenna, new THREE.SphereGeometry(0.02, 10, 8), paint, 0, 0.13, 0);
  for (const x of [-0.19, 0.19]) {
    const arm = part(body, box(0.05, 0.16, 0.06), steel, x, 0.1, 0.02);
    arm.rotation.x = -0.25;
  }

  const capacity = node(body, "upgCapacity", 0, 0.12, -0.2);
  part(capacity, box(0.24, 0.2, 0.1, 0.03), hull);
  part(capacity, box(0.2, 0.04, 0.11, 0.01), paint, 0, 0.03, 0);
  const armor = node(body, "upgArmor", 0, 0.12, 0);
  for (const x of [-0.17, 0.17]) part(armor, box(0.035, 0.24, 0.34, 0.015), steel, x, 0, 0);
  const harvest = node(body, "upgHarvest", 0.24, 0.1, 0.14);
  const drill = part(harvest, new THREE.ConeGeometry(0.05, 0.2, 12), crystal, 0, 0, 0);
  drill.rotation.x = Math.PI / 2;
  return root;
}

// Корабль стоит в начале координат. Узлы: flame (видно при взлёте), lights.
function ship() {
  const root = new THREE.Group();
  root.name = "ship";
  const profile = [[0, 0.32], [0.2, 0.32], [0.3, 0.5], [0.34, 0.8], [0.32, 1.15], [0.23, 1.5], [0.1, 1.75], [0, 1.85]]
    .map(([x, y]) => new THREE.Vector2(x, y));
  part(root, new THREE.LatheGeometry(profile, 32), hull);
  part(root, new THREE.CylinderGeometry(0.24, 0.3, 0.14, 32), dark, 0, 0.28, 0);
  part(root, new THREE.CylinderGeometry(0.335, 0.345, 0.07, 32), dark, 0, 0.95, 0);
  const lights = node(root, "lights", 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
    const window = part(lights, new THREE.SphereGeometry(0.075, 16, 12), glow, Math.sin(a) * 0.29, 1.25, Math.cos(a) * 0.29);
    window.scale.set(1, 1, 0.5);
    window.lookAt(Math.sin(a), 1.25, Math.cos(a));
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const leg = node(root, `leg${i}`, 0, 0, 0);
    leg.rotation.y = a;
    const fin = part(leg, box(0.03, 0.42, 0.3, 0.012), dark, 0, 0.42, 0.42);
    fin.rotation.x = 0.42;
    part(leg, new THREE.CylinderGeometry(0.065, 0.08, 0.04, 16), steel, 0, 0.02, 0.6);
  }
  const flame = node(root, "flame", 0, 0.22, 0);
  const cone = part(flame, new THREE.ConeGeometry(0.2, 0.9, 20), mat("flame", 0xffb784, 0, 0.5, 0xff832b, 3), 0, -0.45, 0);
  cone.rotation.x = Math.PI;
  return root;
}

// Источник энергии: узел crystals масштабируется по запасу.
function source() {
  const root = new THREE.Group();
  root.name = "source";
  part(root, new THREE.CylinderGeometry(0.3, 0.36, 0.05, 8), dark, 0, 0.025, 0);
  const crystals = node(root, "crystals", 0, 0.03, 0);
  const shards = [[0, 0, 0.36, 0.13, 0], [0.15, 0.06, 0.24, 0.09, 0.3], [-0.14, 0.09, 0.28, 0.1, -0.25], [0.02, -0.16, 0.2, 0.08, -0.2]];
  for (const [x, z, h, r, tilt] of shards) {
    const geo = new THREE.OctahedronGeometry(1, 0);
    const m = part(crystals, geo, crystal, x, h, z);
    m.scale.set(r, h, r);
    m.rotation.z = tilt;
  }
  return root;
}

async function save(object, file) {
  const buf = await new GLTFExporter().parseAsync(object, { binary: true });
  writeFileSync(new URL(`../public/models/${file}`, import.meta.url), Buffer.from(buf));
  console.log(file, buf.byteLength);
}

mkdirSync(new URL("../public/models/", import.meta.url), { recursive: true });
await save(robot(), "robot.glb");
await save(ship(), "ship.glb");
await save(source(), "source.glb");
