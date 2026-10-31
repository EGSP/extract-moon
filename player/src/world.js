// Сцена матча. Всё, что видно на экране и в видео, определяется числом tick и настройками:
// update() не хранит времени, поэтому экспорт повторяет проигрыватель кадр в кадр.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { gaussian, headingCurve, sampleCurve } from "./track.js";
import { ACTION_ICONS, badgeTexture, factionColor, glintTexture, glowTexture, labelTexture, slotTexture } from "./icons.js";

export const LAUNCH_TAIL = 8; // тактов после конца матча: корабль набирает высоту
const BADGE = 0.027; // сторона значка, доля высоты кадра
const SOURCE_BADGE = 0.021;
const ROBOT_SCALE = 1.4;
const TURN = 0.12; // доля такта на разворот в сторону движения
const LIFT = 0.75; // значок выше точки привязки на долю своей стороны: не закрывает модель
const FOV = 36;
const BEAMS = { give: "#42be65", deposit: "#f1c21b" };
const BOLT_HIT = 0.6; // доля такта, за которую снаряд долетает до цели
const IMPACT_LIFE = 0.42; // тактов длится попадание: короткая вспышка, а не мягкое пятно
const SPARKS = 16;
const FX_Y = 0.55; // высота снарядов и лучей
const FX_ORDER = 200000; // эффекты боя рисуются поверх всех значков
const HOME = new THREE.Vector3(0.62, 1, 0.82).normalize();
const UP = new THREE.Vector3(0, 1, 0);
// Сглаживание камеры в тактах: поворот плавнее положения, иначе кадр качается на каждом шаге.
const TRACK_SIGMA = 1;
const YAW_SIGMA = 3.5;

function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function spriteOf(tex = null) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true }));
  s.renderOrder = 10;
  return s;
}

const lerp = (a, b, k) => a + (b - a) * k;

/** Высота корабля через tail тактов после конца матча. */
export const shipLift = (tail) => 0.14 * tail ** 3 + 0.5 * tail;

function lerpAngle(a, b, k) {
  const d = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return a + d * k;
}

export class World {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    // Neutral сохраняет насыщенность цветов фракций, ACES их выбеливает.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.35;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#0b0c10");
    this.perspective = new THREE.PerspectiveCamera(FOV, 1, 0.5, 400);
    this.orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, -300, 500);
    this.camera = this.perspective;
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 120;
    this.controls.zoomToCursor = true;
    this.overlays = [];
    this.robots = new Map();
    this.sources = [];
    this.beams = [];
    this.rings = [];
    this.labels = [];
    this.marks = [];
    this.seats = [];
    this.bolts = [];
    this.glows = [];
    this.sparks = [];
    this.paint = new Map();
    this.options = { vision: true, icons: true };
    this.selected = null;
    this.dirty = true;
    let interacting = false;
    this.controls.addEventListener("start", () => { interacting = true; });
    this.controls.addEventListener("end", () => { interacting = false; });
    // Щелчок по роботу тоже начинает жест, поэтому ручным считается только реальный сдвиг камеры.
    this.controls.addEventListener("change", () => {
      this.dirty = true;
      if (interacting && !this.applying) this.onUserCamera?.();
    });
    this.addLights();
    this.addStars();
  }

  async load() {
    const loader = new GLTFLoader();
    const [robot, ship, source] = await Promise.all(
      ["robot", "ship", "source"].map((n) => loader.loadAsync(`models/${n}.glb`)));
    for (const g of [robot, ship, source]) {
      g.scene.traverse((o) => {
        if (o.isMesh) o.castShadow = o.receiveShadow = true;
      });
    }
    this.robotModel = robot.scene;
    this.sourceModel = source.scene;
    this.ship = ship.scene;
    this.shipFlame = this.ship.getObjectByName("flame");
    this.ship.traverse((o) => {
      if (o.isMesh && o.material.name === "flame") {
        o.castShadow = false;
      }
    });
    this.scene.add(this.ship);
    this.shipBadge = spriteOf(badgeTexture("rocket", "#82cfff"));
    this.shipBadge.userData.top = true;
    this.scene.add(this.shipBadge);

    const flat = (geo, color, opacity) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2;
      this.scene.add(m);
      return m;
    };
    this.zone = flat(new THREE.PlaneGeometry(3, 3), "#82cfff", 0.08);
    this.zone.renderOrder = 2;
    this.chargeBack = flat(new THREE.RingGeometry(1.0, 1.14, 64), "#393939", 0.9);
    this.chargeBack.renderOrder = 3;
    this.chargeRing = flat(new THREE.BufferGeometry(), "#82cfff", 1);
    this.chargeRing.renderOrder = 4;
    this.selectRing = flat(new THREE.RingGeometry(0.3, 0.36, 40), "#ffffff", 1);
    this.selectRing.renderOrder = 4;
    this.selectRing.visible = false;
    this.charge = -1;
  }

  addLights() {
    this.scene.add(new THREE.HemisphereLight("#dfe6ff", "#6a6a70", 1.5));
    this.sun = new THREE.DirectionalLight("#fff1dc", 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);
  }

  addStars() {
    const rnd = random(7);
    const pts = [];
    for (let i = 0; i < 1400; i++) {
      const a = rnd() * Math.PI * 2;
      const y = rnd() * 0.9 + 0.02;
      const r = Math.sqrt(1 - y * y);
      pts.push(Math.cos(a) * r * 180, y * 180, Math.sin(a) * r * 180);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    this.scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: "#c6c6c6", size: 1.3, sizeAttenuation: false })));
  }

  // ---------------------------------------------------------------- матч

  setReplay(rep) {
    const sameMap = this.rep && this.size === rep.header.map.size && this.rep.header.seed === rep.header.seed;
    this.rep = rep;
    this.size = rep.header.map.size;
    this.signalRadius = rep.header.config.world.signal_radius;
    this.sourceMax = rep.header.config.world.source_amount_max;
    this.visionKey = null;
    for (const r of this.robots.values()) this.removeRobot(r);
    this.robots.clear();
    if (sameMap) return;
    this.buildGround();
    this.home();
  }

  buildGround() {
    const S = this.size;
    for (const old of [this.ground, this.visionMesh, this.rocks, this.outer]) {
      if (!old) continue;
      this.scene.remove(old);
      old.geometry.dispose();
      old.material.dispose();
    }
    const rnd = random(this.rep.header.seed + 1);
    const px = 32;
    const c = document.createElement("canvas");
    c.width = c.height = S * px;
    const g = c.getContext("2d");
    g.fillStyle = "#7a7b84";
    g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < S * S * 34; i++) {
      const v = 105 + rnd() * 60;
      g.fillStyle = `rgba(${v},${v},${v + 4},${0.08 + rnd() * 0.12})`;
      const r = 1 + rnd() * rnd() * 16;
      g.beginPath();
      g.ellipse(rnd() * c.width, rnd() * c.height, r, r * (0.6 + rnd() * 0.4), rnd() * 3, 0, 7);
      g.fill();
    }
    g.strokeStyle = "rgba(22,22,22,.42)";
    g.lineWidth = 1.5;
    for (let i = 0; i <= S; i++) {
      g.beginPath(); g.moveTo(i * px, 0); g.lineTo(i * px, c.height); g.stroke();
      g.beginPath(); g.moveTo(0, i * px); g.lineTo(c.width, i * px); g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(S, S), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.set(S / 2, 0, S / 2);
    this.ground.receiveShadow = true;
    this.outer = new THREE.Mesh(new THREE.CircleGeometry(170, 64), new THREE.MeshStandardMaterial({ color: "#47484e", roughness: 1 }));
    this.outer.rotation.x = -Math.PI / 2;
    this.outer.position.set(S / 2, -0.08, S / 2);
    this.outer.receiveShadow = true;
    this.scene.add(this.ground, this.outer);

    // Камни только за границей карты: на поле их можно принять за игровые объекты.
    const count = 90;
    this.rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: "#5a5a60", roughness: 1, flatShading: true }), count);
    const m = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2;
      const d = S * 0.75 + 2 + rnd() * rnd() * 22;
      m.position.set(S / 2 + Math.cos(a) * d, 0, S / 2 + Math.sin(a) * d);
      m.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      m.scale.set(0.12 + rnd() * 0.4, 0.08 + rnd() * 0.25, 0.12 + rnd() * 0.4);
      m.updateMatrix();
      this.rocks.setMatrixAt(i, m.matrix);
    }
    this.rocks.castShadow = this.rocks.receiveShadow = true;
    this.scene.add(this.rocks);

    this.visionCanvas = document.createElement("canvas");
    this.visionCanvas.width = this.visionCanvas.height = S * 16;
    const vt = new THREE.CanvasTexture(this.visionCanvas);
    vt.magFilter = THREE.NearestFilter;
    vt.colorSpace = THREE.SRGBColorSpace;
    this.visionMesh = new THREE.Mesh(new THREE.PlaneGeometry(S, S), new THREE.MeshBasicMaterial({ map: vt, transparent: true, depthWrite: false }));
    this.visionMesh.rotation.x = -Math.PI / 2;
    this.visionMesh.position.set(S / 2, 0.02, S / 2);
    this.visionMesh.renderOrder = 1;
    this.scene.add(this.visionMesh);

    const R = S * 0.9;
    this.sun.position.set(S / 2 + R, R * 1.5, S / 2 - R * 0.7);
    this.sun.target.position.set(S / 2, 0, S / 2);
    Object.assign(this.sun.shadow.camera, { left: -R * 1.2, right: R * 1.2, top: R * 1.2, bottom: -R * 1.2, near: 1, far: R * 5 });
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  paintFor(faction) {
    if (!this.paint.has(faction)) {
      const color = factionColor(faction);
      const m = new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.4, emissive: color, emissiveIntensity: 0.28 });
      this.paint.set(faction, m);
    }
    return this.paint.get(faction);
  }

  addRobot(id) {
    const root = this.robotModel.clone(true);
    const r = { id, root, faction: null, parts: {}, painted: [], glow: [] };
    root.traverse((o) => {
      if (o.name) r.parts[o.name] = o;
      if (o.isMesh && o.material.name === "paint") r.painted.push(o);
    });
    r.badge = spriteOf();
    r.barBack = spriteOf();
    r.barBack.material.color.set("#161616");
    r.energy = spriteOf();
    r.hp = spriteOf();
    r.energy.center.set(0, 0.5);
    r.hp.center.set(0, 0.5);
    r.hp.material.color.set("#ffffff");
    r.badge.userData = { group: r, layer: 0 };
    r.barBack.userData = { group: r, layer: 1 };
    r.energy.userData = { group: r, layer: 2 };
    r.hp.userData = { group: r, layer: 2 };
    this.scene.add(root, r.badge, r.barBack, r.energy, r.hp);
    this.robots.set(id, r);
    return r;
  }

  removeRobot(r) {
    this.scene.remove(r.root, r.badge, r.barBack, r.energy, r.hp);
    for (const s of [r.badge, r.barBack, r.energy, r.hp]) s.material.dispose();
  }

  bodyPosition(id, idx, alpha) {
    const { layout, frames } = this.rep;
    const a = layout[idx].get(id);
    if (!a) return null;
    if (alpha <= 0 || idx + 1 >= frames.length) return a;
    let b = layout[idx + 1].get(id);
    if (!b) {
      const next = frames[idx + 1];
      if (!next.robots.some((rb) => rb.id === id && rb.status === "boarded")) return a;
      b = [next.ship.x + 0.5, next.ship.y + 0.5];
    }
    return [lerp(a[0], b[0], alpha), lerp(a[1], b[1], alpha)];
  }

  iconFor(rb, fr) {
    if (rb.status === "asleep") return "asleep";
    const dec = fr.decisions[rb.id];
    if (!dec) return "bot";
    const name = ACTION_ICONS[this.rep.header.names.main[dec.chosen[0]]];
    if (name) return name;
    return dec.chosen[2] > 0 ? "radio" : "bot";
  }

  updateRobots(fr, idx, alpha, tick) {
    const world = this.rep.header.config.world;
    const seen = new Set();
    const { yaw: yaws } = this.rep;
    for (const rb of fr.robots) {
      const pos = this.bodyPosition(rb.id, idx, alpha);
      if (!pos) continue;
      seen.add(rb.id);
      const r = this.robots.get(rb.id) ?? this.addRobot(rb.id);
      if (r.faction !== rb.faction) {
        r.faction = rb.faction;
        for (const m of r.painted) m.material = this.paintFor(rb.faction);
      }
      const asleep = rb.status === "asleep";
      // yaw[idx] — направление шага от такта idx: тело разворачивается в начале шага, потом едет.
      const heading = yaws[idx].get(rb.id) ?? 0;
      const yaw = lerpAngle(yaws[idx - 1]?.get(rb.id) ?? heading, heading, Math.min(alpha / TURN, 1));
      const moving = alpha > 0 && this.isMoving(rb, idx);
      r.root.position.set(pos[0], 0, pos[1]);
      r.root.scale.setScalar(ROBOT_SCALE);
      r.root.rotation.y = yaw;
      r.root.visible = true;
      const phase = tick * Math.PI * 2 + rb.id;
      r.parts.body.position.y = 0.15 + (asleep ? -0.04 : moving ? Math.sin(phase * 2) * 0.012 : 0);
      r.parts.head.rotation.x = asleep ? 0.6 : 0;
      r.parts.head.rotation.y = asleep ? 0 : Math.sin(phase * 0.17) * 0.3;
      r.parts.antenna.rotation.z = asleep ? 0.8 : Math.sin(phase * 0.9) * 0.08;
      r.parts.upgCapacity.visible = rb.upgrades[0] > 0;
      r.parts.upgArmor.visible = rb.upgrades[1] > 0;
      r.parts.upgHarvest.visible = rb.upgrades[2] > 0;

      const y = 0.95;
      const color = factionColor(rb.faction);
      const show = this.options.icons;
      r.badge.material.map = badgeTexture(this.iconFor(rb, fr), color, asleep);
      r.badge.material.needsUpdate = true;
      r.badge.visible = show;
      this.overlay(r.badge, pos[0], y, pos[1], BADGE, 1, 1, LIFT);
      const e = Math.min(Math.max(rb.energy, 0) / world.energy_max, 1);
      const h = Math.min(Math.max(rb.hp, 0) / world.hp_max, 1);
      r.barBack.visible = r.energy.visible = r.hp.visible = show;
      this.overlay(r.barBack, pos[0], y, pos[1], BADGE, 1, 0.3, LIFT - 0.68);
      this.overlay(r.energy, pos[0], y, pos[1], BADGE, e * 0.92, 0.11, LIFT - 0.61, -0.46);
      this.overlay(r.hp, pos[0], y, pos[1], BADGE, h * 0.92, 0.11, LIFT - 0.75, -0.46);
      r.energy.material.color.set(e < 0.2 ? "#fa4d56" : "#42be65");
    }
    for (const [id, r] of this.robots) {
      if (seen.has(id)) continue;
      r.root.visible = r.badge.visible = r.barBack.visible = r.energy.visible = r.hp.visible = false;
    }
    const sel = this.selected !== null && seen.has(this.selected) ? this.bodyPosition(this.selected, idx, alpha) : null;
    this.selectRing.visible = !!sel;
    if (sel) this.selectRing.position.set(sel[0], 0.05, sel[1]);
  }

  isMoving(rb, idx) {
    const to = this.rep.frames[idx + 1]?.robots.find((o) => o.id === rb.id);
    return !!to && (to.x !== rb.x || to.y !== rb.y);
  }

  updateShip(fr, tick) {
    const sh = fr.ship;
    const last = this.rep.frames.length - 1;
    const tail = Math.max(tick - last, 0);
    const launched = !!this.rep.header.result?.launched;
    const lift = launched ? shipLift(tail) : 0;
    const x = sh.x + 0.5;
    const z = sh.y + 0.5;
    this.ship.position.set(x, lift, z);
    this.shipFlame.visible = launched && tail > 0;
    this.shipFlame.scale.setScalar(1 + Math.sin(tick * 37) * 0.12);
    this.zone.position.set(x, 0.03, z);
    this.chargeBack.position.set(x, 0.04, z);
    this.chargeRing.position.set(x, 0.045, z);
    const frac = Math.round(Math.min(sh.charge / sh.capacity, 1) * 100);
    if (frac !== this.charge) {
      this.charge = frac;
      this.chargeRing.geometry.dispose();
      this.chargeRing.geometry = new THREE.RingGeometry(1.0, 1.14, 64, 1, Math.PI / 2, -(frac / 100) * Math.PI * 2);
    }
    const ready = sh.launch_timer >= 0;
    this.chargeRing.material.color.set(ready ? "#42be65" : "#82cfff");
    this.shipBadge.visible = this.options.icons;
    this.overlay(this.shipBadge, x, lift + 1.9, z, BADGE * 1.3, 1, 1, 1.78);
    this.updateSeats(fr, x, lift + 1.9, z);
  }

  /** Ряд мест над кораблём: пассажиры в порядке посадки, затем пустые рамки. */
  updateSeats(fr, x, y, z) {
    const aboard = fr.robots.filter((rb) => rb.status === "boarded");
    const n = fr.ship.seats;
    for (let i = 0; i < n; i++) {
      const s = this.pooled(this.seats, i);
      s.userData.top = true;
      const rb = aboard[i];
      s.visible = this.options.icons;
      s.material.map = rb ? badgeTexture("bot", factionColor(rb.faction)) : slotTexture();
      s.material.needsUpdate = true;
      this.overlay(s, x, y, z, BADGE * 1.05, 1, 1, LIFT, (i - (n - 1) / 2) * 1.1);
    }
    for (let i = n; i < this.seats.length; i++) this.seats[i].visible = false;
  }

  updateSources(fr) {
    fr.sources.forEach(([x, y, amount], i) => {
      let s = this.sources[i];
      if (!s) {
        const root = this.sourceModel.clone(true);
        s = { root, crystals: root.getObjectByName("crystals"), badge: spriteOf(badgeTexture("flashFilled", "#42be65")) };
        this.scene.add(root, s.badge);
        this.sources.push(s);
      }
      const k = Math.min(amount / this.sourceMax, 1);
      s.root.visible = true;
      s.root.position.set(x + 0.5, 0, y + 0.5);
      s.crystals.scale.setScalar(0.45 + k * 0.75);
      s.badge.visible = this.options.icons;
      this.overlay(s.badge, x + 0.5, 0.6, y + 0.5, SOURCE_BADGE, 1, 1, LIFT);
    });
    for (let i = fr.sources.length; i < this.sources.length; i++) {
      this.sources[i].root.visible = this.sources[i].badge.visible = false;
    }
  }

  /** Светящееся пятно поверх моделей: основа вспышек, снарядов и искр. */
  glow(x, y, z, size, color, opacity, map = glowTexture()) {
    let g = this.glows[this.glowCount];
    if (!g) {
      g = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true, toneMapped: false,
      }));
      g.renderOrder = FX_ORDER + 2;
      this.scene.add(g);
      this.glows[this.glowCount] = g;
    }
    this.glowCount++;
    g.visible = true;
    g.position.set(x, y, z);
    g.scale.set(size, size, 1);
    g.material.map = map;
    g.material.color.set(color);
    g.material.opacity = opacity;
  }

  /** Снаряд бластера: белая сердцевина, ореол цвета фракции стрелка и след за ним. */
  bolt(i, from, to, k, color) {
    let b = this.bolts[i];
    if (!b) {
      const geo = new THREE.SphereGeometry(1, 16, 10);
      const core = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false, depthTest: false, transparent: true }));
      const halo = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true, opacity: 0.75, toneMapped: false,
      }));
      core.renderOrder = FX_ORDER + 1;
      halo.renderOrder = FX_ORDER;
      b = { core, halo };
      this.scene.add(core, halo);
      this.bolts[i] = b;
    }
    const start = new THREE.Vector3(from[0], FX_Y, from[1]);
    const dir = new THREE.Vector3(to[0], FX_Y, to[1]).sub(start);
    const dist = dir.length();
    if (dist > 1e-4) dir.divideScalar(dist);
    else dir.set(1, 0, 0);
    const head = start.clone().addScaledVector(dir, dist * k);
    const length = Math.min(1.1, Math.max(dist * k, 0.45));
    const mid = head.clone().addScaledVector(dir, -length / 2);
    const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    for (const [m, r] of [[b.core, 0.09], [b.halo, 0.22]]) {
      m.visible = true;
      m.position.copy(mid);
      m.quaternion.copy(turn);
      m.scale.set(r, length / 2 + r, r);
    }
    b.halo.material.color.set(color);
    this.glow(head.x, FX_Y, head.z, 1.6, color, 1);
    this.glow(head.x, FX_Y, head.z, 0.55, "#ffffff", 1);
  }

  /** Игла искры: ромб, вытянутый вдоль направления полёта. */
  spark(x, y, z, dir, length, width, color, opacity) {
    let m = this.sparks[this.sparkCount];
    if (!m) {
      m = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true, toneMapped: false,
      }));
      m.renderOrder = FX_ORDER + 3;
      this.scene.add(m);
      this.sparks[this.sparkCount] = m;
    }
    this.sparkCount++;
    m.visible = true;
    m.position.set(x, y, z);
    m.quaternion.setFromUnitVectors(UP, dir);
    m.scale.set(width, length / 2, width);
    m.material.color.set(color);
    m.material.opacity = opacity;
  }

  /** Попадание: острый четырёхлучевой блик и веер игл, разлетающихся и гаснущих. age — тактов после попадания. */
  impact(x, z, age, color, seed) {
    const k = age / IMPACT_LIFE;
    if (k < 0 || k >= 1) return;
    const fade = 1 - k;
    const flash = Math.max(1 - k * 3, 0);
    if (flash > 0) {
      this.glow(x, FX_Y, z, 2.2 * flash + 0.4, "#ffffff", flash, glintTexture());
      this.glow(x, FX_Y, z, 0.5 * flash, color, flash);
    }
    const rnd = random(seed);
    const fly = 1 - (1 - k) * (1 - k); // искры резко вылетают и тормозят
    const dir = new THREE.Vector3();
    for (let i = 0; i < SPARKS; i++) {
      const a = rnd() * Math.PI * 2;
      const up = rnd() * 0.9 - 0.15;
      const speed = 0.7 + rnd() * 1.3;
      dir.set(Math.cos(a), up, Math.sin(a)).normalize();
      const d = speed * fly;
      const length = (0.2 + speed * 0.4) * (1 - k * 0.7);
      this.spark(x + dir.x * d, Math.max(FX_Y + dir.y * d - k * k * 0.3, 0.02), z + dir.z * d, dir, length, 0.022, i % 3 ? color : "#ffffff", fade);
    }
  }

  /** Луч передачи энергии: толстый ореол, светлая сердцевина и импульсы, бегущие к получателю. */
  beam(i, a, b, color, opacity, flow) {
    let m = this.beams[i];
    if (!m) {
      const geo = new THREE.CylinderGeometry(1, 1, 1, 12);
      const core = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false, depthTest: false, depthWrite: false, transparent: true }));
      const halo = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true, toneMapped: false,
      }));
      core.renderOrder = FX_ORDER + 1;
      halo.renderOrder = FX_ORDER;
      m = { core, halo };
      this.scene.add(core, halo);
      this.beams[i] = m;
    }
    const from = new THREE.Vector3(a[0], FX_Y, a[1]);
    const dir = new THREE.Vector3(b[0], FX_Y, b[1]).sub(from);
    const dist = dir.length();
    if (dist < 1e-4) {
      m.core.visible = m.halo.visible = false;
      return;
    }
    dir.divideScalar(dist);
    const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    for (const [mesh, r, o] of [[m.core, 0.045, 0.9], [m.halo, 0.13, 0.6]]) {
      mesh.visible = true;
      mesh.position.copy(from).addScaledVector(dir, dist / 2);
      mesh.quaternion.copy(turn);
      mesh.scale.set(r, dist, r);
      mesh.material.opacity = o * opacity;
    }
    m.halo.material.color.set(color);
    this.glow(from.x, FX_Y, from.z, 0.7, color, opacity);
    this.glow(b[0], FX_Y, b[1], 0.8, color, opacity);
    for (let p = 0; p < 3; p++) {
      const t = (flow + p / 3) % 1;
      this.glow(from.x + dir.x * dist * t, FX_Y, from.z + dir.z * dist * t, 0.5, color, opacity * Math.sin(t * Math.PI));
    }
  }

  ring(i, x, z, radius, color, opacity) {
    let m = this.rings[i];
    if (!m) {
      m = new THREE.Mesh(new THREE.RingGeometry(0.965, 1, 72), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 3;
      this.scene.add(m);
      this.rings[i] = m;
    }
    m.visible = true;
    m.position.set(x, 0.05, z);
    m.scale.setScalar(radius);
    m.material.color.set(color);
    m.material.opacity = opacity;
  }

  /** Спрайт из общего запаса: подписи сигналов и кресты погибших живут один такт. */
  pooled(pool, i) {
    if (!pool[i]) {
      pool[i] = spriteOf();
      this.scene.add(pool[i]);
    }
    pool[i].visible = true;
    return pool[i];
  }

  updateEvents(fr, idx, alpha) {
    const { frames, header } = this.rep;
    const ship = [fr.ship.x + 0.5, fr.ship.y + 0.5];
    const center = (id) => this.bodyPosition(id, idx, alpha);
    let nb = 0;
    let nr = 0;
    let nl = 0;
    let nm = 0;
    const fade = 1 - alpha * 0.75;
    let nbolt = 0;
    this.glowCount = 0;
    this.sparkCount = 0;
    const shooter = (ev) => factionColor(fr.robots.find((rb) => rb.id === ev.src)?.faction ?? -1);
    // Событие атаки лежит в кадре, к которому она привела: снаряд летит весь шаг до этого кадра.
    if (alpha > 0) {
      for (const ev of frames[idx + 1]?.events ?? []) {
        if (ev.type !== "attack") continue;
        const from = center(ev.src);
        if (!from) continue;
        const to = center(ev.dst) ?? ship;
        const k = Math.min(alpha / BOLT_HIT, 1);
        if (k < 1) this.bolt(nbolt++, from, to, k, shooter(ev));
        else this.impact(to[0], to[1], alpha - BOLT_HIT, shooter(ev), ev.src * 31 + ev.dst + idx);
      }
    }
    for (const ev of fr.events) {
      const a = ev.src !== undefined ? center(ev.src) : null;
      if (ev.type === "attack") {
        // Цель могла погибнуть от этого выстрела: тогда её место берём из прошлого кадра.
        const to = center(ev.dst) ?? this.rep.layout[idx - 1]?.get(ev.dst) ?? ship;
        const color = factionColor(frames[idx - 1]?.robots.find((rb) => rb.id === ev.src)?.faction ?? -1);
        this.impact(to[0], to[1], 1 - BOLT_HIT + alpha, color, ev.src * 31 + ev.dst + idx - 1);
      }
      if (!a) continue;
      if (ev.type === "give") {
        this.beam(nb++, a, center(ev.dst) ?? ship, BEAMS.give, fade, alpha);
      } else if (ev.type === "deposit") {
        this.beam(nb++, a, ship, BEAMS.deposit, fade, alpha);
      } else if (ev.type === "birth" && center(ev.dst)) {
        const d = center(ev.dst);
        this.ring(nr++, d[0], d[1], 0.5 + alpha * 0.3, "#ffffff", fade);
      }
    }
    // Сигнал ярче всего на своём такте: проявляется на пути к нему и затухает после.
    const signals = fr.events.filter((e) => e.type === "signal").map((e) => [e, 1 - alpha, false]);
    if (alpha > 0 && idx + 1 < frames.length) {
      for (const e of frames[idx + 1].events) if (e.type === "signal") signals.push([e, alpha, true]);
    }
    for (const [ev, k, growing] of signals) {
      if (k <= 0.02) continue;
      const x = ev.x + 0.5;
      const z = ev.y + 0.5;
      this.ring(nr++, x, z, this.signalRadius * (growing ? 0.4 + 0.6 * k : 1), "#a6c8ff", 0.42 * k);
      if (!this.options.icons) continue;
      const s = this.pooled(this.labels, nl++);
      s.material.map = labelTexture(header.names.symbols[ev.sym] + ev.val);
      s.material.needsUpdate = true;
      s.material.opacity = k;
      this.overlay(s, x, 1.45, z, BADGE, 1.6, 0.8);
    }
    // Погибший в этом такте уже не в списке роботов: крест ставится по событию.
    const prev = new Map((frames[idx - 1]?.robots ?? []).map((rb) => [rb.id, rb]));
    for (const ev of fr.events) {
      if (ev.type !== "death" || !prev.has(ev.src)) continue;
      const rb = prev.get(ev.src);
      const s = this.pooled(this.marks, nm++);
      s.material.map = badgeTexture("closeLarge", "#da1e28");
      s.material.needsUpdate = true;
      this.overlay(s, rb.x + 0.5, 0.7, rb.y + 0.5, BADGE);
    }
    for (let i = nb; i < this.beams.length; i++) this.beams[i].core.visible = this.beams[i].halo.visible = false;
    for (let i = nbolt; i < this.bolts.length; i++) this.bolts[i].core.visible = this.bolts[i].halo.visible = false;
    for (let i = this.glowCount; i < this.glows.length; i++) this.glows[i].visible = false;
    for (let i = this.sparkCount; i < this.sparks.length; i++) this.sparks[i].visible = false;
    for (let i = nr; i < this.rings.length; i++) this.rings[i].visible = false;
    for (let i = nl; i < this.labels.length; i++) this.labels[i].visible = false;
    for (let i = nm; i < this.marks.length; i++) this.marks[i].visible = false;
  }

  updateVision(fr, idx) {
    const on = this.options.vision;
    this.visionMesh.visible = on;
    const key = `${this.rep.name}|${idx}`;
    if (!on || this.visionKey === key) return;
    this.visionKey = key;
    const S = this.size;
    const s = this.rep.sight;
    const seen = new Map();
    for (const rb of fr.robots) {
      if (rb.faction < 0 || (rb.status !== "awake" && rb.status !== "asleep")) continue;
      for (let y = Math.max(rb.y - s, 0); y <= Math.min(rb.y + s, S - 1); y++) {
        for (let x = Math.max(rb.x - s, 0); x <= Math.min(rb.x + s, S - 1); x++) {
          const k = x + y * S;
          if (!seen.has(k)) seen.set(k, new Set());
          seen.get(k).add(rb.faction);
        }
      }
    }
    const g = this.visionCanvas.getContext("2d");
    const c = 16;
    g.clearRect(0, 0, S * c, S * c);
    for (const [k, facs] of seen) {
      const x = k % S;
      const y = (k - x) / S;
      const cols = [...facs].sort().map(factionColor);
      if (cols.length === 1) {
        g.globalAlpha = 0.32;
        g.fillStyle = cols[0];
        g.fillRect(x * c, y * c, c, c);
        continue;
      }
      // Пересечение зон: штриховка цветами всех видящих фракций.
      g.globalAlpha = 0.3;
      for (let d = 0; d < c * 2; d++) {
        g.fillStyle = cols[Math.floor(d / 3) % cols.length];
        for (let i = Math.max(0, d - c + 1); i <= Math.min(d, c - 1); i++) g.fillRect(x * c + i, y * c + d - i, 1, 1);
      }
    }
    g.globalAlpha = 1;
    this.visionMesh.material.map.needsUpdate = true;
  }

  /** tick — дробный такт; при выключенной плавности вызывающий передаёт целое число. */
  update(tick) {
    const last = this.rep.frames.length - 1;
    const idx = Math.min(Math.floor(tick), last);
    const alpha = idx < last ? tick - idx : 0;
    const fr = this.rep.frames[idx];
    this.pending = [];
    this.updateVision(fr, idx);
    this.updateRobots(fr, idx, alpha, tick);
    this.updateShip(fr, tick);
    this.updateSources(fr);
    this.updateEvents(fr, idx, alpha);
    this.dirty = true;
  }

  // ---------------------------------------------------------- значки поверх

  overlay(sprite, x, y, z, size, w = 1, h = 1, dy = 0, dx = 0) {
    sprite.position.set(x, y, z);
    this.pending.push({ sprite, x, y, z, size, w, h, dy, dx });
  }

  /** Постоянный размер на экране: масштаб считается от текущей камеры, поэтому работает в обеих проекциях. */
  layoutOverlays() {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const forward = new THREE.Vector3();
    cam.getWorldDirection(forward);
    const p = new THREE.Vector3();
    const camPos = cam.position;
    for (const o of this.pending ?? []) {
      p.set(o.x, o.y, o.z);
      const worldH = cam.isOrthographicCamera
        ? (cam.top - cam.bottom) / cam.zoom
        : 2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * Math.max(p.clone().sub(camPos).dot(forward), 0.1);
      const unit = o.size * worldH;
      o.sprite.scale.set(unit * o.w, unit * o.h, 1);
      o.sprite.position.copy(p).addScaledVector(up, unit * o.dy).addScaledVector(right, unit * o.dx);
    }
    this.orderOverlays(forward);
  }

  /** Значки рисуются без проверки глубины, поэтому порядок задан явно: дальние раньше ближних,
   *  значок робота и его полоски идут подряд, а корабль и его места всегда сверху. */
  orderOverlays(forward) {
    const groups = new Map();
    const p = new THREE.Vector3();
    for (const o of this.pending ?? []) {
      const key = o.sprite.userData.group ?? o.sprite;
      const depth = p.set(o.x, o.y, o.z).dot(forward);
      if (!groups.has(key)) groups.set(key, { depth, items: [] });
      groups.get(key).items.push(o.sprite);
    }
    const sorted = [...groups.values()].sort((a, b) => b.depth - a.depth);
    sorted.forEach(({ items }, rank) => {
      for (const s of items) {
        s.renderOrder = s.userData.top ? 100000 : 10 + rank + (s.userData.layer ?? 0) * 0.1;
      }
    });
  }

  render() {
    this.layoutOverlays();
    this.renderer.render(this.scene, this.camera);
    this.onRender?.();
    this.dirty = false;
  }

  // -------------------------------------------------------------- камера

  /** Текущий вид, сдвинутый так, что камера смотрит в центр карты: расстояние и наклон те же. */
  centeredCameraState() {
    const state = this.cameraState();
    const shift = this.center.sub(new THREE.Vector3(...state.target));
    state.position = this.camera.position.clone().add(shift).toArray();
    state.target = this.center.toArray();
    return state;
  }

  /** Всё, что нужно, чтобы восстановить вид; записывается рядом с видео. */
  cameraState() {
    const cam = this.camera;
    const vec = (v) => v.toArray();
    const common = {
      position: vec(cam.position), target: vec(this.controls.target), up: vec(cam.up), quaternion: vec(cam.quaternion),
      near: cam.near, far: cam.far, zoom: cam.zoom,
    };
    return cam.isOrthographicCamera
      ? { projection: "orthographic", ...common, viewHeight: (cam.top - cam.bottom) / cam.zoom }
      : { projection: "perspective", ...common, fov: cam.fov };
  }

  get center() {
    return new THREE.Vector3(this.size / 2, 0, this.size / 2);
  }

  fitDistance() {
    const aspect = this.aspect ?? 1.6;
    const radius = this.size * 0.62;
    const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    return Math.max(radius / tan, radius / (tan * aspect));
  }

  setView(dir) {
    const dist = this.fitDistance();
    this.controls.target.copy(this.center);
    this.camera.position.copy(this.center).addScaledVector(dir, dist);
    if (this.camera.isOrthographicCamera) this.setOrthoHeight(dist);
    this.controls.update();
    this.dirty = true;
  }

  home() {
    this.onUserCamera?.();
    this.setView(HOME);
  }

  /** Ставит камеру в сохранённый вид, повёрнутый на angle вокруг вертикали через точку from.
   *  Точка from переносится в to. Цель движется вместе с камерой, поэтому расстояние и наклон не меняются. */
  applyCamera(state, angle = 0, from = this.center, to = from) {
    this.applying = true;
    this.setOrthographic(state.projection === "orthographic");
    const turn = (v) => new THREE.Vector3(...v).sub(from).applyAxisAngle(UP, angle).add(to);
    this.camera.position.copy(turn(state.position));
    this.controls.target.copy(turn(state.target));
    if (this.camera.isOrthographicCamera) this.setOrthoView(state.viewHeight);
    this.controls.update();
    this.applying = false;
    this.dirty = true;
  }

  /** Кадр кинокамеры. Камера может стоять ниже цели, поэтому запрет взгляда снизу на время кадра снят. */
  applyPose({ position, target }) {
    this.applying = true;
    this.setOrthographic(false);
    const { maxPolarAngle, minDistance } = this.controls;
    this.controls.maxPolarAngle = Math.PI;
    this.controls.minDistance = 0;
    this.camera.position.set(...position);
    this.controls.target.set(...target);
    this.controls.update();
    Object.assign(this.controls, { maxPolarAngle, minDistance });
    this.applying = false;
    this.dirty = true;
  }

  /** Камера над роботом: цель сохранённого вида переносится на робота, поворот считается от такта начала. */
  followRobot(state, id, tick, startTick, rotate) {
    const point = this.smoothPoint(id, tick);
    const to = new THREE.Vector3(point[0], state.target[1], point[1]);
    const angle = rotate ? this.smoothYaw(id, tick) - this.smoothYaw(id, startTick) : 0;
    this.applyCamera(state, angle, new THREE.Vector3(...state.target), to);
  }

  /** Сглаженный путь робота по тактам. Вне своей жизни робот стоит в ближайшей известной точке. */
  robotTrack(id) {
    this.rep.tracks ??= new Map();
    if (this.rep.tracks.has(id)) return this.rep.tracks.get(id);
    const { layout, yaw } = this.rep;
    const hold = (values) => {
      const first = values.find((v) => v !== undefined);
      let cur = first;
      return values.map((v) => (cur = v ?? cur));
    };
    const cells = hold(layout.map((m) => m.get(id)));
    const xs = cells.map((p) => p[0]);
    const zs = cells.map((p) => p[1]);
    const track = {
      x: gaussian(xs, TRACK_SIGMA),
      z: gaussian(zs, TRACK_SIGMA),
      yaw: gaussian(headingCurve(xs, zs, yaw[0]?.get(id) ?? 0), YAW_SIGMA),
    };
    this.rep.tracks.set(id, track);
    return track;
  }

  smoothPoint(id, tick) {
    const t = this.robotTrack(id);
    return [sampleCurve(t.x, tick), sampleCurve(t.z, tick)];
  }

  smoothYaw(id, tick) {
    return sampleCurve(this.robotTrack(id).yaw, tick);
  }

  /** Вид вдоль оси гизмо. Горизонтальный вид чуть приподнят: камера не опускается под грунт. */
  viewAlong(x, y, z) {
    this.onUserCamera?.();
    const dir = y > 0 ? new THREE.Vector3(0, 1, 0.001) : new THREE.Vector3(x, 0.05, z);
    this.setView(dir.normalize());
  }

  /** Вращение перетаскиванием по гизмо, в пикселях. */
  orbit(dx, dy) {
    this.onUserCamera?.();
    const target = this.controls.target;
    const s = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(target));
    s.theta -= dx * 0.01;
    s.phi = Math.min(Math.max(s.phi - dy * 0.01, 0.02), this.controls.maxPolarAngle);
    this.camera.position.setFromSpherical(s).add(target);
    this.controls.update();
    this.dirty = true;
  }

  setOrthoHeight(dist) {
    this.setOrthoView(2 * dist * Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
  }

  setOrthoView(h) {
    const o = this.orthographic;
    o.top = h / 2;
    o.bottom = -h / 2;
    o.left = (-h / 2) * this.aspect;
    o.right = (h / 2) * this.aspect;
    o.zoom = 1;
    o.updateProjectionMatrix();
  }

  /** Видимый размер у точки вращения сохраняется, поэтому смена проекции не сдвигает кадр. */
  setOrthographic(on) {
    if (on === this.camera.isOrthographicCamera) return;
    const target = this.controls.target;
    const old = this.camera;
    const offset = old.position.clone().sub(target);
    let dist = offset.length();
    if (on) {
      this.setOrthoHeight(dist);
    } else {
      dist = (old.top - old.bottom) / old.zoom / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
    }
    const cam = on ? this.orthographic : this.perspective;
    cam.position.copy(target).addScaledVector(offset.normalize(), dist);
    cam.up.copy(old.up);
    this.camera = cam;
    this.controls.object = cam;
    this.controls.update();
    this.dirty = true;
  }

  resize() {
    const box = this.canvas.parentElement.getBoundingClientRect();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.setRenderSize(Math.max(box.width, 1), Math.max(box.height, 1), true);
  }

  setRenderSize(w, h, style) {
    this.renderer.setSize(w, h, style);
    const aspect = w / h;
    this.aspect = aspect;
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
    const o = this.orthographic;
    const half = (o.top - o.bottom) / 2;
    o.left = -half * aspect;
    o.right = half * aspect;
    o.updateProjectionMatrix();
    this.dirty = true;
  }

  /** id робота под курсором; координаты в пикселях холста. */
  pick(px, py) {
    const box = this.canvas.getBoundingClientRect();
    let best = null;
    let bestD = 30 ** 2;
    const p = new THREE.Vector3();
    for (const [id, r] of this.robots) {
      if (!r.root.visible) continue;
      for (const h of [0.45, 1.1]) {
        p.copy(r.root.position).setY(h).project(this.camera);
        const dx = ((p.x + 1) / 2) * box.width - px;
        const dy = ((1 - p.y) / 2) * box.height - py;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          best = id;
          bestD = d;
        }
      }
    }
    return best;
  }
}
