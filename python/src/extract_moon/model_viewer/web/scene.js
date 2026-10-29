// 3D-сцена модели: свой компонент на каждый тип блока, потоки частиц по рёбрам, выбор и облёт.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { RoundedBoxGeometry } from 'three/addons/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/RoomEnvironment.js';

// Категориальная палитра Carbon для светлой темы.
export const GROUP_COLORS = { input: '#009d9a', encoder: '#0f62fe', core: '#8a3ffc', heads: '#b28600' };
const TM = '#1192e8', CM = '#ee538b', VALUE = '#198038', BG = '#ffffff';
const FLOW_Y = 2.2;          // высота оси потока данных
const STAGE_X = 6.4, ROW_Z = 3.8;
const CELL = 0.22;
const WHITE = new THREE.Color('#ffffff');

const lg = n => Math.log2(n + 1);
const prod = s => s.reduce((a, b) => a * b, 1);
export const shapeText = s => ['B', ...s].join('×');

// Детерминированный шум: у каждой клетки своя фаза «активации».
function rand(seed) { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); }

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.25, 'rgba(255,255,255,.7)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const GLOW = glowTexture();

function solid(color, opts = {}) {
  return new THREE.MeshPhysicalMaterial({
    color, emissive: color, emissiveIntensity: 0.18, roughness: 0.35, metalness: 0.1, clearcoat: 0.6, ...opts,
  });
}
function glass(color, opacity = 0.35) {
  // На белом фоне прозрачные блоки бледнеют, поэтому непрозрачность выше заданной.
  return solid(color, { transparent: true, opacity: Math.min(0.85, opacity * 1.6 + 0.2), depthWrite: false, roughness: 0.3, emissiveIntensity: 0.3 });
}
function edgesOf(geo, color, opacity = 0.7) {
  return new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}

// Решётка «нейронов»: экземпляры с мерцающей яркостью. cells — массив позиций.
function cellGrid(cells, geo, color, phaseSeed) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true });
  const mesh = new THREE.InstancedMesh(geo, mat, cells.length);
  const m = new THREE.Matrix4(), base = new THREE.Color(color), c = new THREE.Color();
  cells.forEach((p, i) => { m.makeTranslation(p.x, p.y, p.z); mesh.setMatrixAt(i, m); mesh.setColorAt(i, base); });
  const phases = cells.map((_, i) => rand(i + phaseSeed) * 6.28);
  const speeds = cells.map((_, i) => 0.6 + rand(i * 7 + phaseSeed) * 1.6);
  mesh.userData.animate = t => {
    for (let i = 0; i < cells.length; i++) {
      const v = Math.max(0, Math.sin(t * speeds[i] + phases[i]));
      c.copy(base).lerp(WHITE, 0.5 - 0.5 * v * v);
      mesh.setColorAt(i, c);
    }
    mesh.instanceColor.needsUpdate = true;
  };
  return mesh;
}

// Почти квадратная раскладка n клеток в плоскости YZ.
function squareLayout(n, step, cap = 400) {
  const k = Math.min(n, cap), cols = Math.ceil(Math.sqrt(k)), rows = Math.ceil(k / cols), out = [];
  for (let i = 0; i < k; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    out.push(new THREE.Vector3(0, (rows - 1) / 2 * step - r * step, c * step - (cols - 1) / 2 * step));
  }
  return { cells: out, h: rows * step, w: cols * step, shown: k };
}

// ---------------------------------------------------------------- компоненты блоков
// Каждый возвращает { obj, size: Vector3, accent } — объект с началом на оси потока.

const COMPONENTS = {
  tensor(b, color) {
    const obj = new THREE.Group(), shape = b.outputs[0].shape;
    const geo = new THREE.BoxGeometry(CELL * 0.82, CELL * 0.82, CELL * 0.82);
    if (shape.length === 3) {
      const [C, H, W] = shape, gap = 0.34, cells = [], hues = [];
      for (let ch = 0; ch < C; ch++) {
        const x = (ch - (C - 1) / 2) * gap;
        const sheet = squareLayout(H * W, CELL, H * W);
        for (const p of sheet.cells) cells.push(new THREE.Vector3(x, p.y, p.z));
        const frame = new THREE.Mesh(new THREE.PlaneGeometry(W * CELL + 0.08, H * CELL + 0.08),
          new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(ch / C, 0.6, 0.5), transparent: true,
            opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }));
        frame.rotation.y = Math.PI / 2; frame.position.x = x; obj.add(frame);
        hues.push(ch);
      }
      obj.add(cellGrid(cells, geo, color, 3));
      return { obj, size: new THREE.Vector3(C * gap, H * CELL, W * CELL) };
    }
    const lay = squareLayout(prod(shape), CELL);
    obj.add(cellGrid(lay.cells, geo, color, 11));
    const box = new THREE.BoxGeometry(CELL * 1.6, lay.h + 0.16, lay.w + 0.16);
    obj.add(new THREE.Mesh(box, glass(color, 0.08)), edgesOf(box, color, 0.5));
    return { obj, size: new THREE.Vector3(CELL * 1.6, lay.h, lay.w) };
  },

  conv(b, color) {
    const obj = new THREE.Group(), [ch, h, w] = b.outputs[0].shape;
    const plates = Math.min(ch, 14), gap = 0.13, cs = CELL * Math.max(1, 6 / Math.max(h, w));
    const ph = h * cs, pw = w * cs;
    for (let i = 0; i < plates; i++) {
      const geo = new THREE.BoxGeometry(0.04, ph, pw);
      const mesh = new THREE.Mesh(geo, glass(color, 0.12 + 0.3 * (i / plates)));
      mesh.position.x = (i - (plates - 1) / 2) * gap;
      mesh.castShadow = true;
      obj.add(mesh);
    }
    const front = squareLayout(h * w, cs, h * w);
    const grid = cellGrid(front.cells, new THREE.BoxGeometry(0.05, cs * 0.8, cs * 0.8), color, 21);
    grid.position.x = (plates - 1) / 2 * gap + 0.05;
    obj.add(grid);
    // Ядро 3×3: рамка, «скользящая» по входу.
    const kernel = new THREE.Mesh(new THREE.BoxGeometry(0.06, cs * 3, cs * 3),
      new THREE.MeshBasicMaterial({ color: '#161616', transparent: true, opacity: 0.3 }));
    kernel.position.x = -(plates - 1) / 2 * gap - 0.12;
    kernel.userData.animate = t => {
      const k = Math.floor(t * 2.5) % (h * w), r = Math.floor(k / w), c = k % w;
      kernel.position.y = (h - 1) / 2 * cs - r * cs; kernel.position.z = c * cs - (w - 1) / 2 * cs;
    };
    obj.add(kernel);
    return { obj, size: new THREE.Vector3(plates * gap + 0.2, ph, pw) };
  },

  dense(b, color) {
    const obj = new THREE.Group(), nIn = prod(b.inputs[0].shape), nOut = prod(b.outputs[0].shape);
    const sIn = Math.min(3.4, 0.4 + 0.3 * lg(nIn)), sOut = Math.min(3.4, 0.4 + 0.3 * lg(nOut)), len = 1.8;
    const geo = new THREE.CylinderGeometry(sOut / Math.SQRT2, sIn / Math.SQRT2, len, 4, 1, false, Math.PI / 4);
    geo.rotateZ(-Math.PI / 2);
    const body = new THREE.Mesh(geo, glass(color, 0.28));
    body.castShadow = true;
    obj.add(body, edgesOf(geo, color, 0.8));
    const lay = squareLayout(nOut, Math.min(0.18, (sOut - 0.2) / Math.ceil(Math.sqrt(Math.min(nOut, 400)))));
    const neurons = cellGrid(lay.cells, new THREE.IcosahedronGeometry(0.055, 1), color, 31);
    neurons.position.x = len / 2 + 0.08;
    obj.add(neurons);
    return { obj, size: new THREE.Vector3(len + 0.2, Math.max(sIn, sOut), Math.max(sIn, sOut)) };
  },

  merge(b, color) {
    const obj = new THREE.Group();
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.75, 1), solid(color, { flatShading: true, emissiveIntensity: 0.5 }));
    core.castShadow = true;
    core.userData.animate = t => { core.rotation.y = t * 0.4; core.rotation.x = t * 0.25; };
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.05, 12, 64), solid(color, { emissiveIntensity: 0.5 }));
    ring.rotation.y = Math.PI / 2;
    obj.add(core, ring);
    return { obj, size: new THREE.Vector3(1.6, 2.4, 2.4) };
  },

  norm(b, color) {
    const obj = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.07, 12, 64), solid(color, { emissiveIntensity: 0.5 }));
    ring.rotation.y = Math.PI / 2;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.98, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
    disc.rotation.y = Math.PI / 2;
    obj.add(ring, disc);
    return { obj, size: new THREE.Vector3(0.5, 2.1, 2.1) };
  },

  rwkv_layer(b, color, inst) {
    const obj = new THREE.Group(), F = inst.vars.F ?? 4;
    const plinth = new THREE.Mesh(new RoundedBoxGeometry(4.6, 0.28, 3.8, 3, 0.08),
      new THREE.MeshStandardMaterial({ color: '#e0e0e0', metalness: 0.1, roughness: 0.8 }));
    plinth.position.y = -1.6; plinth.castShadow = plinth.receiveShadow = true;
    // Остаточный поток проходит сквозь слой.
    const stream = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 4.8, 12), solid(color, { emissiveIntensity: 0.6 }));
    stream.rotation.z = Math.PI / 2;
    const tmGeo = new RoundedBoxGeometry(1.5, 2.3, 2.6, 4, 0.14);
    const tm = new THREE.Mesh(tmGeo, glass(TM, 0.42)); tm.position.x = -1.05; tm.castShadow = true;
    const cmGeo = new RoundedBoxGeometry(1.5, 2.3, 1.7 + 0.32 * F, 4, 0.14);
    const cm = new THREE.Mesh(cmGeo, glass(CM, 0.42)); cm.position.x = 1.05; cm.castShadow = true;
    obj.add(plinth, stream, tm, cm);
    // Внутри time-mix — четыре проекции key/value/receptance/output.
    for (let i = 0; i < 4; i++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.6, 2.0), solid(TM, { emissiveIntensity: 0.7 }));
      bar.position.set(-1.5 + i * 0.3, 0, 0); obj.add(bar);
    }
    // Внутри channel-mix — расширение до F·d и обратно.
    const wide = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.5, 0.9 + 0.3 * F), solid(CM, { emissiveIntensity: 0.7 }));
    wide.position.x = 1.05; obj.add(wide);
    // Кольцо памяти: по дуге на каждый вектор состояния.
    const slots = b.state?.slots ?? [], ring = new THREE.Group();
    ring.position.y = 2.15;
    slots.forEach((s, i) => {
      const arc = (Math.PI * 2) / slots.length;
      const seg = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.09, 10, 40, arc - 0.12),
        solid(new THREE.Color().setHSL(0.5 + i / slots.length * 0.45, 0.85, 0.6), { emissiveIntensity: 0.5 }));
      seg.rotation.z = i * arc; ring.add(seg);
    });
    ring.rotation.x = Math.PI / 2;
    ring.userData.animate = t => { ring.rotation.z = t * 0.35; };
    obj.add(ring);
    const beamMat = new THREE.MeshBasicMaterial({ color: '#8a3ffc', transparent: true, opacity: 0.18,
      depthWrite: false });
    for (const x of [-1.05, 1.05]) {
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.12, 1.0, 10, 1, true), beamMat);
      beam.position.set(x * 0.85, 1.65, 0); beam.rotation.z = x * 0.25; obj.add(beam);
    }
    // Частицы, бегущие по кольцу памяти.
    const n = 40, pos = new Float32Array(n * 3);
    const pts = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3)),
      new THREE.PointsMaterial({ size: 0.22, map: GLOW, color: '#8a3ffc', transparent: true, depthWrite: false }));
    pts.position.y = 2.15;
    pts.userData.animate = t => {
      for (let i = 0; i < n; i++) {
        const a = i / n * Math.PI * 2 - t * 0.9;
        pos[i * 3] = Math.cos(a) * 1.25; pos[i * 3 + 1] = Math.sin(t * 2 + i) * 0.05; pos[i * 3 + 2] = Math.sin(a) * 1.25;
      }
      pts.geometry.attributes.position.needsUpdate = true;
    };
    obj.add(pts);
    return { obj, size: new THREE.Vector3(4.6, 3.6, 3.8) };
  },

  head(b, color) {
    const obj = new THREE.Group(), n = prod(b.outputs[0].shape), c = b.id === 'value_head' ? VALUE : color;
    const geo = new THREE.CylinderGeometry(0.42, 0.8, 1.0, 4, 1, false, Math.PI / 4);
    geo.rotateZ(-Math.PI / 2);
    const body = new THREE.Mesh(geo, glass(c, 0.35)); body.castShadow = true;
    body.position.x = -0.6;
    const outline = edgesOf(geo, c, 0.8);
    outline.position.copy(body.position);
    obj.add(body, outline);
    // Веер выходов: по лучу на каждый логит, длина «дышит» как распределение.
    const span = n === 1 ? 0 : Math.min(Math.PI * 0.85, 0.16 * n), r0 = 0.25;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff }), n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(),
      z = new THREE.Vector3(0, 0, 1), col = new THREE.Color();
    const w = Math.min(0.12, 1.6 / n);
    mesh.userData.animate = t => {
      const logits = Array.from({ length: n }, (_, i) => Math.sin(t * 0.5 + i * 1.7) * 1.4 + Math.sin(t * 0.23 + i * 0.6));
      const mx = Math.max(...logits), ex = logits.map(v => Math.exp(v - mx)), sum = ex.reduce((a, v) => a + v, 0);
      for (let i = 0; i < n; i++) {
        const a = n === 1 ? 0 : -span / 2 + span * i / (n - 1), prob = ex[i] / sum;
        const len = n === 1 ? 1.2 + 0.4 * Math.sin(t) : 0.25 + 1.6 * prob;
        q.setFromAxisAngle(z, a); p.set(Math.cos(a) * (r0 + len / 2), Math.sin(a) * (r0 + len / 2), 0);
        s.set(len, w, w);
        mesh.setMatrixAt(i, m.compose(p, q, s));
        mesh.setColorAt(i, col.set(c).lerp(WHITE, n === 1 ? 0.2 : Math.max(0, 0.7 - 2.5 * prob)));
      }
      mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
    };
    mesh.userData.animate(0);
    obj.add(mesh);
    return { obj, size: new THREE.Vector3(2.4, 2.4, 1.6) };
  },
};

// ---------------------------------------------------------------- сцена

export function createScene(container, { onHover, onSelect }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;
  container.appendChild(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.domElement.className = 'labels';
  container.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 150, 320);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
  camera.position.set(10, 22, 40);
  const controls = new OrbitControls(camera, labels.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.minDistance = 3; controls.maxDistance = 160;

  scene.add(new THREE.HemisphereLight('#ffffff', '#c6c6c6', 0.7));
  const sun = new THREE.DirectionalLight('#ffffff', 1.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 6;
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.ShadowMaterial({ opacity: 0.12 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
  const grid = new THREE.GridHelper(400, 200, '#e0e0e0', '#efefef');
  grid.position.y = -0.01;
  scene.add(ground, grid);


  const selRing = new THREE.Mesh(new THREE.RingGeometry(1, 1.08, 96),
    new THREE.MeshBasicMaterial({ color: '#f8fafc', transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
  selRing.rotation.x = -Math.PI / 2; selRing.position.y = 0.03; selRing.visible = false;
  scene.add(selRing);

  let root = null, blocks = new Map(), edges = [], pickables = [], animated = [];
  let hovered = null, selected = null, flow = true, fly = null;
  const clock = new THREE.Clock();

  function clear() {
    if (!root) return;
    root.traverse(o => {
      if (o.isCSS2DObject) o.element.remove();
      o.geometry?.dispose();
      [].concat(o.material || []).forEach(m => m.dispose());
    });
    scene.remove(root);
    root = null; blocks = new Map(); edges = []; pickables = []; animated = [];
  }

  function label(text, sub, cls = 'lbl') {
    const el = document.createElement('div');
    el.className = cls;
    el.innerHTML = `<b></b>${sub ? '<span></span>' : ''}`;
    el.querySelector('b').textContent = text;
    if (sub) el.querySelector('span').textContent = sub;
    return new CSS2DObject(el);
  }

  function show(inst) {
    clear();
    root = new THREE.Group();
    scene.add(root);
    for (const b of inst.blocks) {
      const color = GROUP_COLORS[b.group] ?? '#8d8d8d';
      const make = COMPONENTS[b.component] ?? COMPONENTS.norm;
      const { obj, size } = make(b, color, inst);
      obj.position.set(b.layout.stage * STAGE_X, FLOW_Y, b.layout.row * ROW_Z);
      obj.traverse(o => {
        if (o.isMesh) { pickables.push(o); o.userData.block = b.id; }
        if (o.userData.animate) animated.push(o.userData.animate);
        [].concat(o.material || []).forEach(m => { m.userData.baseEmissive = m.emissiveIntensity; });
      });
      const out = b.outputs[0]?.shape;
      const lbl = label(b.title, out ? shapeText(out) : '');
      lbl.position.set(0, size.y / 2 + (b.component === 'rwkv_layer' ? 0.9 : 0.55), 0);
      lbl.element.addEventListener('click', () => onSelect(b.id));
      lbl.element.addEventListener('pointerenter', () => setHover(b.id));
      lbl.element.addEventListener('pointerleave', () => setHover(null));
      obj.add(lbl);
      root.add(obj);
      blocks.set(b.id, { b, obj, size, color, scale: 1 });
    }
    for (const e of inst.edges) addEdge(e);
    fitShadows();
    setHover(null); select(null, false);
    overview(false);
  }

  function addEdge(e) {
    const A = blocks.get(e.from), B = blocks.get(e.to);
    const a = A.obj.position.clone().add(new THREE.Vector3(A.size.x / 2 + 0.1, 0, 0));
    const b = B.obj.position.clone().add(new THREE.Vector3(-B.size.x / 2 - 0.1, 0, 0));
    const dx = Math.max(1.2, (b.x - a.x) * 0.5);
    const curve = new THREE.CubicBezierCurve3(a, a.clone().add(new THREE.Vector3(dx, 0, 0)),
      b.clone().add(new THREE.Vector3(-dx, 0, 0)), b);
    const width = 0.025 + 0.012 * lg(prod(e.shape));
    const tubeMat = new THREE.MeshBasicMaterial({ color: A.color, transparent: true, opacity: 0.35, depthWrite: false });
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, width, 8), tubeMat);
    const n = Math.round(10 + 2 * lg(prod(e.shape))), pos = new Float32Array(n * 3);
    const ptsMat = new THREE.PointsMaterial({ size: 0.28, map: GLOW, color: A.color, transparent: true,
      depthWrite: false });
    const pts = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3)), ptsMat);
    pts.frustumCulled = false;
    root.add(tube, pts);
    if (e.label) {
      const l = label(e.label, shapeText(e.shape), 'lbl edge');
      l.position.copy(curve.getPointAt(0.5)).add(new THREE.Vector3(0, 0.45, 0));
      root.add(l);
    }
    const len = curve.getLength(), p = new THREE.Vector3();
    edges.push({
      e, tubeMat, ptsMat,
      animate(t) {
        pts.visible = flow;
        if (!flow) return;
        for (let i = 0; i < n; i++) {
          curve.getPointAt(((i / n) + t * 2.2 / len) % 1, p);
          pos.set([p.x, p.y, p.z], i * 3);
        }
        pts.geometry.attributes.position.needsUpdate = true;
      },
    });
  }

  function bounds() {
    const box = new THREE.Box3();
    for (const { obj, size } of blocks.values()) {
      box.expandByPoint(obj.position.clone().sub(size.clone().multiplyScalar(0.5)));
      box.expandByPoint(obj.position.clone().add(size.clone().multiplyScalar(0.5)));
    }
    return box;
  }

  function fitShadows() {
    const box = bounds(), c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2 + 4;
    sun.position.set(c.x - r * 0.4, r * 1.6, c.z + r * 0.8);
    sun.target.position.copy(c);
    Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 0.5, far: r * 4 });
    sun.shadow.camera.updateProjectionMatrix();
  }

  function flyTo(target, position, ms = 900) {
    fly = { t0: performance.now(), ms, fromT: controls.target.clone(), toT: target,
      fromP: camera.position.clone(), toP: position };
  }

  function overview(animate = true) {
    const box = bounds(), c = box.getCenter(new THREE.Vector3());
    // Подбираем расстояние, при котором все углы рамки модели попадают в кадр с полями.
    const dir = new THREE.Vector3(0.12, 0.72, 0.7).normalize(), cam = camera.clone(), p = new THREE.Vector3();
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(i => new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    let lo = 1, hi = 400;
    for (let k = 0; k < 30; k++) {
      const d = (lo + hi) / 2;
      cam.position.copy(c).addScaledVector(dir, d); cam.lookAt(c); cam.updateMatrixWorld();
      const fits = corners.every(q => { p.copy(q).project(cam); return Math.abs(p.x) < 0.92 && Math.abs(p.y) < 0.8; });
      if (fits) hi = d; else lo = d;
    }
    const pos = c.clone().addScaledVector(dir, hi);
    if (animate) flyTo(c, pos);
    else { controls.target.copy(c); camera.position.copy(pos); }
  }

  function select(id, focus = true) {
    selected = id;
    const s = id && blocks.get(id);
    selRing.visible = !!s;
    if (s) {
      const r = Math.max(s.size.x, s.size.z) / 2 + 0.7;
      selRing.scale.setScalar(r);
      selRing.position.set(s.obj.position.x, 0.03, s.obj.position.z);
      selRing.material.color.set(s.color);
      if (focus) {
        const target = s.obj.position.clone();
        const dir = camera.position.clone().sub(controls.target).normalize();
        const dist = Math.max(9, s.size.length() * 2.6);
        flyTo(target, target.clone().add(dir.multiplyScalar(dist)));
      }
    }
    refreshEdges();
  }

  function setHover(id) {
    if (hovered === id) return;
    hovered = id;
    renderer.domElement.style.cursor = labels.domElement.style.cursor = id ? 'pointer' : '';
    refreshEdges();
    onHover?.(id);
  }

  function refreshEdges() {
    for (const { e, tubeMat, ptsMat } of edges) {
      const hot = [hovered, selected].some(id => id && (e.from === id || e.to === id));
      tubeMat.opacity = hot ? 0.75 : 0.35;
      ptsMat.size = hot ? 0.42 : 0.26;
    }
  }

  // Выбор мышью: клик без перетаскивания.
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down = null;
  function pick(ev) {
    const r = labels.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(pickables, false)[0]?.object.userData.block ?? null;
  }
  const dom = labels.domElement;
  dom.addEventListener('pointermove', ev => { if (!down && ev.target === dom) setHover(pick(ev)); });
  dom.addEventListener('pointerdown', ev => { down = [ev.clientX, ev.clientY]; });
  dom.addEventListener('pointerup', ev => {
    if (down && Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) < 5 && ev.target === dom) onSelect(pick(ev));
    down = null;
  });
  dom.addEventListener('pointerleave', () => setHover(null));

  function resize() {
    const { clientWidth: w, clientHeight: h } = container;
    renderer.setSize(w, h); labels.setSize(w, h);
    camera.aspect = w / Math.max(h, 1); camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  const ease = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  renderer.setAnimationLoop(() => {
    const t = clock.getElapsedTime();
    animated.forEach(f => f(t));
    edges.forEach(e => e.animate(t));
    for (const [id, s] of blocks) {
      const goal = id === hovered ? 1.05 : 1;
      s.scale += (goal - s.scale) * 0.15;
      s.obj.scale.setScalar(s.scale);
      const boost = id === hovered ? 2.2 : id === selected ? 1.6 : 1;
      s.obj.traverse(o => [].concat(o.material || []).forEach(m => {
        if (m.emissive) m.emissiveIntensity = m.userData.baseEmissive * boost;
      }));
    }
    if (selRing.visible) selRing.material.opacity = 0.55 + 0.3 * Math.sin(t * 3);
    if (fly) {
      const k = Math.min(1, (performance.now() - fly.t0) / fly.ms), e = ease(k);
      controls.target.lerpVectors(fly.fromT, fly.toT, e);
      camera.position.lerpVectors(fly.fromP, fly.toP, e);
      if (k >= 1) fly = null;
    }
    controls.update();
    renderer.render(scene, camera);
    labels.render(scene, camera);
  });

  return {
    show, select, overview,
    setFlow(v) { flow = v; },
    setLabels(v) { labels.domElement.classList.toggle('hide-labels', !v); },
  };
}
