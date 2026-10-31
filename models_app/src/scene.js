// 3D-сцена модели: свой компонент на каждый тип блока, потоки частиц по рёбрам, выбор и облёт.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Gizmo } from '@extract-moon/sdk/gizmo';

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

export function plural(n, one, few, many) {
  const m = Math.abs(n) % 100, k = m % 10;
  return m >= 11 && m <= 14 ? many : k === 1 ? one : k >= 2 && k <= 4 ? few : many;
}
// Размер тензора простыми словами: «7 слоёв 11×11» или «192 числа».
export function sizeText(s) {
  if (s.length === 3) return `${s[0]} ${plural(s[0], 'слой', 'слоя', 'слоёв')} ${s[1]}×${s[2]}`;
  if (s.length === 1) return `${s[0].toLocaleString('ru-RU')} ${plural(s[0], 'число', 'числа', 'чисел')}`;
  if (s.length === 2) return `${s[0]} ${plural(s[0], 'вектор', 'вектора', 'векторов')} по ${s[1]} ${plural(s[1], 'числу', 'числа', 'чисел')}`;
  return s.join('×');
}

// Детерминированный шум: у каждой клетки своя фаза «активации».
function rand(seed) { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); }

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  // Плотная точка с мягким краем: на белом фоне размытое свечение почти не видно.
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.55, 'rgba(255,255,255,1)');
  grd.addColorStop(0.75, 'rgba(255,255,255,.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const GLOW = glowTexture();

function solid(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 0.18, roughness: 0.35, metalness: 0.1, ...opts,
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

const AXIS_COLORS = { x: '#da1e28', y: '#24a148', z: '#0f62fe' };
// Движение камеры: [вправо, вверх, вперёд].
const MOVE_KEYS = { KeyW: [0, 0, 1], KeyS: [0, 0, -1], KeyA: [-1, 0, 0], KeyD: [1, 0, 0], KeyE: [0, 1, 0], KeyQ: [0, -1, 0] };
const FRAME_MS = 1000 / 30;  // анимация не чаще 30 кадров в секунду
const UP = new THREE.Vector3(0, 1, 0);
const LABEL_BASE = 900;  // при таком меньшем размере кадра подписи ролика равны экранным

// Без видеокарты браузер рисует WebGL на процессоре и занимает все ядра, поэтому там нет теней.
function softwareGL(renderer) {
  const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
  return /swiftshader|llvmpipe|software|basic render/i.test(name);
}

export function createScene(container, { onHover, onSelect, onSelectGroup, onCamera }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  const soft = softwareGL(renderer);
  renderer.shadowMap.enabled = !soft;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;  // тени считаются заново только при смене модели
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

  const persp = new THREE.PerspectiveCamera(42, 1, 0.1, 600);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 1000);
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2);
  let camera = persp, orthoH = 10;
  persp.position.set(10, 22, 40);
  const controls = new OrbitControls(camera, labels.domElement);
  controls.enableDamping = true;
  controls.minDistance = 3; controls.maxDistance = 250;
  let dirty = true;
  controls.addEventListener('change', () => { dirty = true; });

  scene.add(new THREE.HemisphereLight('#ffffff', '#c6c6c6', 0.7));
  const sun = new THREE.DirectionalLight('#ffffff', 1.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.ShadowMaterial({ opacity: 0.12 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
  const grid = new THREE.GridHelper(400, 200, '#e0e0e0', '#efefef');
  grid.position.y = -0.01;
  scene.add(ground, grid);

  const selRing = new THREE.Mesh(new THREE.RingGeometry(1, 1.08, 96),
    new THREE.MeshBasicMaterial({ color: '#161616', transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
  selRing.rotation.x = -Math.PI / 2; selRing.position.y = 0.03; selRing.visible = false;
  scene.add(selRing);

  let root = null, blocks = new Map(), edges = [], pickables = [], animated = [], plates = new Map(), groupInfo = {};
  let selGroup = null, hoverGroup = null;
  let hovered = null, selected = null, animate = false, fly = null, animT = 0, last = 0;
  let labelsOn = true, flight = null, held = false, saved = null, renderSize = null;
  const keys = new Set();

  function clear() {
    if (!root) return;
    root.traverse(o => {
      if (o.isCSS2DObject) o.element.remove();
      o.geometry?.dispose();
      [].concat(o.material || []).forEach(m => m.dispose());
    });
    scene.remove(root);
    root = null; blocks = new Map(); edges = []; pickables = []; animated = []; plates = new Map();
  }

  function label(text, sub, cls = 'lbl') {
    const el = document.createElement('div');
    el.className = cls;
    el.innerHTML = `<b></b>${sub ? '<span></span>' : ''}`;
    el.querySelector('b').textContent = text;
    if (sub) el.querySelector('span').textContent = sub;
    return new CSS2DObject(el);
  }

  function show(inst, groups = {}) {
    clear();
    groupInfo = groups;
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
      const lbl = label(b.short ?? b.title, '');  // в сцене короткое имя, полное в карточке
      lbl.position.set(0, size.y / 2 + (b.component === 'rwkv_layer' ? 0.9 : 0.55), 0);
      lbl.element.dataset.block = b.id;
      lbl.element.addEventListener('pointerenter', () => setHover(b.id));
      lbl.element.addEventListener('pointerleave', () => setHover(null));
      obj.add(lbl);
      root.add(obj);
      blocks.set(b.id, { b, obj, size, color, lbl });
    }
    for (const e of inst.edges) addEdge(e);
    addPlates(groups);
    animated.forEach(f => f(animT));  // начальный кадр, он же остаётся при выключенной анимации
    fitShadows();
    hovered = null; hoverGroup = null; selGroup = null; select(null, false);
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
    const ptsMat = new THREE.PointsMaterial({ size: 0.55, map: GLOW, color: A.color, transparent: true, depthWrite: false, alphaTest: 0.05 });
    const pts = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3)), ptsMat);
    pts.frustumCulled = false;
    pts.visible = animate;
    root.add(tube, pts);
    // Точки кривой считаются один раз: искать точку по длине на каждом кадре дорого.
    const path = curve.getSpacedPoints(240), len = curve.getLength();
    edges.push({
      e, tubeMat, ptsMat, pts,
      animate(t) {
        for (let i = 0; i < n; i++) {
          const p = path[Math.floor((((i / n) + t * 2.2 / len) % 1) * 240)];
          pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
        }
        pts.geometry.attributes.position.needsUpdate = true;
      },
    });
  }

  // Подложки групп, как рамки в нодовых редакторах: охватывают блоки группы, по клику открывают её описание.
  function addPlates(groups) {
    const boxes = new Map();
    for (const { b, obj, size } of blocks.values()) {
      const box = boxes.get(b.group) ?? new THREE.Box3();
      box.expandByPoint(obj.position.clone().sub(size.clone().multiplyScalar(0.5)));
      box.expandByPoint(obj.position.clone().add(size.clone().multiplyScalar(0.5)));
      boxes.set(b.group, box);
    }
    for (const [g, box] of boxes) {
      const color = GROUP_COLORS[g] ?? '#8d8d8d', pad = 0.9;
      const w = box.max.x - box.min.x + pad * 2, dz = box.max.z - box.min.z + pad * 2;
      const geo = new RoundedBoxGeometry(w, 0.08, dz, 2, 0.04);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, depthWrite: false });
      const plate = new THREE.Mesh(geo, mat);
      plate.position.set((box.min.x + box.max.x) / 2, 0.05, (box.min.z + box.max.z) / 2);
      plate.userData.group = g;
      const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, 0.001, dz)),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 }));
      frame.position.y = 0.05;
      plate.add(frame);
      const lbl = label(groups[g]?.title ?? g, '', 'grp');
      lbl.element.dataset.group = g;
      lbl.element.style.setProperty('--c', color);
      lbl.position.set(-w / 2 + 0.2, 0.1, dz / 2);
      lbl.center.set(0, 0);
      plate.add(lbl);
      root.add(plate);
      pickables.push(plate);
      plates.set(g, { plate, mat, frame, w, dz, lbl, color, box: box.clone().expandByVector(new THREE.Vector3(pad, 0, pad)) });
    }
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
    renderer.shadowMap.needsUpdate = true;
  }

  // ------------------------------------------------ камера

  // Расстояние до цели, которому соответствует текущий вид; у ортографической камеры его задаёт масштаб.
  function viewDist() {
    return camera === persp ? camera.position.distanceTo(controls.target) : orthoH / ortho.zoom / tanHalf;
  }

  function flyTo(target, dir, dist, ms = 800) {
    const toP = target.clone().addScaledVector(dir, camera === persp ? dist : 150);
    fly = { t0: performance.now(), ms, fromT: controls.target.clone(), toT: target.clone(),
      fromP: camera.position.clone(), toP, fromZ: ortho.zoom, toZ: orthoH / (dist * tanHalf) };
  }

  function viewDir() { return camera.position.clone().sub(controls.target).normalize(); }

  // Расстояние, при котором все углы рамки попадают в кадр с полями.
  function fitDistance(box, dir, aspect, marginX = 0.92, marginY = 0.8) {
    const c = box.getCenter(new THREE.Vector3()), cam = persp.clone(), p = new THREE.Vector3();
    cam.aspect = aspect; cam.updateProjectionMatrix();
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(i => new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    let lo = 1, hi = 400;
    for (let k = 0; k < 30; k++) {
      const d = (lo + hi) / 2;
      cam.position.copy(c).addScaledVector(dir, d); cam.lookAt(c); cam.updateMatrixWorld();
      const fits = corners.every(q => { p.copy(q).project(cam); return Math.abs(p.x) < marginX && Math.abs(p.y) < marginY; });
      if (fits) hi = d; else lo = d;
    }
    return hi;
  }

  function overview(smooth = true) {
    const box = bounds(), dir = new THREE.Vector3(0.12, 0.72, 0.7).normalize();
    flyTo(box.getCenter(new THREE.Vector3()), dir, fitDistance(box, dir, persp.aspect), smooth ? 800 : 0);
  }

  // Вид вдоль оси: камера смотрит на цель со стороны dir.
  function snap(dir) {
    const d = dir.clone();
    if (Math.abs(d.y) > 0.999) d.z = 0.001;  // строго сверху камере не определить, где верх
    flyTo(controls.target.clone(), d.normalize(), viewDist(), 500);
  }

  function setProjection(orthographic) {
    if ((camera === ortho) === orthographic) return;
    const dist = viewDist(), dir = viewDir();
    if (orthographic) {
      orthoH = dist * tanHalf;
      ortho.zoom = 1;
      ortho.position.copy(controls.target).addScaledVector(dir, 150);
      camera = ortho;
    } else {
      persp.position.copy(controls.target).addScaledVector(dir, dist);
      camera = persp;
    }
    camera.up.copy(UP);
    controls.object = camera;
    resize();
    controls.update();
    onCamera?.(orthographic);
  }

  function selectGroup(g, focus = true) {
    selGroup = g; selected = null; selRing.visible = false;
    const p = g && plates.get(g);
    if (p && focus) {
      // Расстояние, при котором подложка помещается в кадр по ширине и по глубине.
      const fit = Math.max(p.w / (2 * tanHalf * persp.aspect), p.dz / (2 * tanHalf));
      flyTo(p.plate.position.clone().setY(FLOW_Y), viewDir(), Math.max(12, fit * 1.25));
    }
    paint();
  }

  function select(id, focus = true) {
    selected = id;
    if (id) selGroup = null;
    const s = id && blocks.get(id);
    selRing.visible = !!s;
    if (s) {
      const r = Math.max(s.size.x, s.size.z) / 2 + 0.7;
      selRing.scale.setScalar(r);
      selRing.position.set(s.obj.position.x, 0.03, s.obj.position.z);
      selRing.material.color.set(s.color);
      if (focus) flyTo(s.obj.position.clone(), viewDir(), Math.max(9, s.size.length() * 2.6));
    }
    paint();
  }

  function setHover(id) {
    if (hovered === id) return;
    hovered = id;
    renderer.domElement.style.cursor = labels.domElement.style.cursor = id ? 'pointer' : '';
    paint();
    onHover?.(id);
  }

  // Подсветка меняется только при наведении и выборе, а не на каждом кадре.
  function paint() {
    for (const [g, p] of plates) {
      p.mat.opacity = g === selGroup ? 0.2 : g === hoverGroup ? 0.14 : 0.08;
      p.frame.material.opacity = g === selGroup ? 1 : 0.5;
    }
    for (const [id, s] of blocks) {
      const inGroup = s.b.group === selGroup;
      const boost = id === hovered ? 2.2 : id === selected || inGroup ? 1.6 : 1;
      s.obj.traverse(o => [].concat(o.material || []).forEach(m => {
        if (m.emissive) m.emissiveIntensity = m.userData.baseEmissive * boost;
      }));
    }
    for (const { e, tubeMat, ptsMat } of edges) {
      const hot = [hovered, selected].some(id => id && (e.from === id || e.to === id));
      tubeMat.opacity = hot ? 0.75 : 0.35;
      ptsMat.size = hot ? 0.75 : 0.55;
    }
    dirty = true;
  }

  // ------------------------------------------------ мышь и клавиатура

  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down = null;
  function pick(ev) {
    const r = labels.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickables, false)[0]?.object.userData;
    return hit ? { block: hit.block ?? null, group: hit.group ?? null } : { block: null, group: null };
  }
  function hoverAt(ev) {
    const hit = pick(ev);
    setHover(hit.block);
    if (hoverGroup !== hit.group) { hoverGroup = hit.block ? null : hit.group; paint(); }
  }
  const dom = labels.domElement;
  dom.addEventListener('pointermove', ev => { if (!down && ev.target === dom) hoverAt(ev); });
  dom.addEventListener('pointerdown', ev => { down = [ev.clientX, ev.clientY]; });
  // OrbitControls захватывает указатель, поэтому клик по подписи приходит сюда, а не в саму подпись.
  dom.addEventListener('pointerup', ev => {
    if (down && Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) < 5) {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const lbl = el?.closest('.lbl'), grp = el?.closest('.grp');
      const hit = lbl ? { block: lbl.dataset.block } : grp ? { group: grp.dataset.group } : pick(ev);
      if (hit.block) onSelect(hit.block);
      else if (hit.group) onSelectGroup?.(hit.group);
      else onSelect(null);
    }
    down = null;
  });
  dom.addEventListener('pointerleave', () => { setHover(null); hoverGroup = null; paint(); });

  const typing = ev => ['INPUT', 'TEXTAREA'].includes(ev.target.tagName);
  addEventListener('keydown', ev => {
    if (typing(ev) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (MOVE_KEYS[ev.code]) { keys.add(ev.code); ev.preventDefault(); }
    if (ev.key === 'Shift') keys.add('Shift');
  });
  addEventListener('keyup', ev => { keys.delete(ev.code); if (ev.key === 'Shift') keys.delete('Shift'); });
  addEventListener('blur', () => keys.clear());

  const move = new THREE.Vector3(), fwd = new THREE.Vector3(), right = new THREE.Vector3();
  function walk(dt) {
    let x = 0, y = 0, z = 0;
    for (const k of keys) if (MOVE_KEYS[k]) { x += MOVE_KEYS[k][0]; y += MOVE_KEYS[k][1]; z += MOVE_KEYS[k][2]; }
    if (!x && !y && !z) return false;
    // Вперёд значит по направлению взгляда, положенному на пол; при виде сверху это верх экрана.
    fwd.copy(controls.target).sub(camera.position).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 1, 0).applyQuaternion(camera.quaternion).setY(0);
    fwd.normalize();
    right.crossVectors(fwd, UP).normalize();
    const speed = viewDist() * 0.5 * (keys.has('Shift') ? 2.5 : 1) * dt;
    move.set(0, 0, 0).addScaledVector(right, x).addScaledVector(UP, y).addScaledVector(fwd, z).multiplyScalar(speed);
    camera.position.add(move); controls.target.add(move);
    return true;
  }

  // ------------------------------------------------ осевой гизмо

  const gizmoEl = document.createElement('div');
  gizmoEl.className = 'gizmo';
  gizmoEl.title = 'Щелчок по оси задаёт вид, перетаскивание вращает камеру';
  container.appendChild(gizmoEl);
  const spherical = new THREE.Spherical(), offset = new THREE.Vector3();
  const gizmo = new Gizmo(gizmoEl, {
    get camera() { return camera; },
    viewAlong(x, y, z) { snap(new THREE.Vector3(x, y, z)); },
    orbit(dx, dy) {
      if (flight || held) return;
      fly = null;
      spherical.setFromVector3(offset.copy(camera.position).sub(controls.target));
      spherical.theta -= dx * 0.01;
      spherical.phi = THREE.MathUtils.clamp(spherical.phi - dy * 0.01, 0.02, Math.PI - 0.02);
      camera.position.setFromSpherical(spherical).add(controls.target);
      controls.update();
      dirty = true;
    },
  }, { colors: AXIS_COLORS });

  // ------------------------------------------------ пролёты и запись

  function placeCamera({ target, dir, dist }) {
    if (camera === ortho) {
      ortho.position.copy(target).addScaledVector(dir, 150);
      ortho.zoom = orthoH / (dist * tanHalf);
      ortho.updateProjectionMatrix();
    } else {
      persp.position.copy(target).addScaledVector(dir, dist);
    }
    camera.lookAt(target);
    camera.updateMatrixWorld();
    controls.target.copy(target);
  }

  // Анимация идёт от времени ролика, поэтому кадр можно получить в любой момент и в любом порядке.
  function flightFrame(path, t) {
    const at = path.at(t);
    placeCamera(at);
    if (at.group !== selGroup) { selGroup = at.group; paint(); }
    animT = t;
    animated.forEach(f => f(t));
    edges.forEach(e => e.animate(t));
    renderer.render(scene, camera);
    return at;
  }

  function beginFlight(orthographic) {
    saved = { ortho: camera === ortho, position: camera.position.clone(), target: controls.target.clone(), zoom: ortho.zoom,
      orthoH, animate, selGroup, selected };
    fly = null;
    controls.enabled = false;
    setProjection(orthographic);
    selGroup = null; selected = null; selRing.visible = false; paint();
    edges.forEach(e => { e.pts.visible = true; });
  }

  function endFlight() {
    const s = saved;
    saved = null;
    setProjection(s.ortho);
    orthoH = s.orthoH;
    resize();
    camera.position.copy(s.position);
    controls.target.copy(s.target);
    ortho.zoom = s.zoom;
    ortho.updateProjectionMatrix();
    controls.enabled = true;
    controls.update();
    animate = s.animate;
    edges.forEach(e => { e.pts.visible = animate; });
    selGroup = s.selGroup;
    selected = s.selected;
    selRing.visible = !!selected;
    paint();
  }

  // Подписи сцены живут в DOM и на холст не попадают, поэтому в ролике они рисуются отдельно.
  const place = new THREE.Vector3();
  function screenOf(obj, w, h) {
    place.setFromMatrixPosition(obj.matrixWorld).project(camera);
    if (Math.abs(place.z) > 1) return null;
    return [(place.x + 1) / 2 * w, (1 - place.y) / 2 * h];
  }

  function drawLabels(g, w, h) {
    const s = Math.min(w, h) / LABEL_BASE;
    g.save();
    g.lineJoin = 'round';
    g.textBaseline = 'middle';
    g.font = `600 ${12 * s}px "IBM Plex Sans", sans-serif`;
    for (const { lbl, color } of plates.values()) {
      const at = screenOf(lbl, w, h);
      if (!at) continue;
      const text = lbl.element.textContent, boxW = g.measureText(text).width + 19 * s, boxH = 21 * s;
      g.fillStyle = '#ffffffd9';
      g.fillRect(at[0], at[1], boxW, boxH);
      g.fillStyle = color;
      g.fillRect(at[0], at[1], 3 * s, boxH);
      g.fillText(text, at[0] + 11 * s, at[1] + boxH / 2);
    }
    g.textAlign = 'center';
    for (const { lbl } of blocks.values()) {
      const at = screenOf(lbl, w, h);
      if (!at) continue;
      const text = lbl.element.textContent;
      g.strokeStyle = '#ffffff';
      g.lineWidth = 5 * s;
      g.strokeText(text, at[0], at[1]);
      g.fillStyle = '#161616';
      g.fillText(text, at[0], at[1]);
    }
    g.restore();
  }

  function wrap(g, text, width) {
    const lines = [];
    for (const word of text.split(' ')) {
      const joined = lines.length ? `${lines[lines.length - 1]} ${word}` : word;
      if (lines.length && g.measureText(joined).width <= width) lines[lines.length - 1] = joined;
      else lines.push(word);
    }
    return lines;
  }

  // Название группы и её назначение на задержке пролёта.
  function drawCaption(g, { title, text, color }, alpha, w, h) {
    const s = Math.min(w, h) / LABEL_BASE, pad = 22 * s, width = Math.min(620 * s, w - 80 * s);
    g.save();
    g.globalAlpha = alpha;
    g.font = `400 ${17 * s}px "IBM Plex Sans", sans-serif`;
    const lines = wrap(g, text, width - pad * 2), step = 24 * s, boxH = pad * 2 + 44 * s + step * lines.length;
    const x = 40 * s, y = 40 * s;
    g.fillStyle = '#ffffffeb';
    g.fillRect(x, y, width, boxH);
    g.fillStyle = color;
    g.fillRect(x, y, 5 * s, boxH);
    g.textBaseline = 'top';
    g.fillStyle = '#161616';
    g.font = `600 ${30 * s}px "IBM Plex Sans", sans-serif`;
    g.fillText(title, x + pad, y + pad);
    g.font = `400 ${17 * s}px "IBM Plex Sans", sans-serif`;
    g.fillStyle = '#525252';
    lines.forEach((l, i) => g.fillText(l, x + pad, y + pad + 44 * s + step * i));
    g.restore();
  }

  // ------------------------------------------------ кадр

  function resize() {
    const { clientWidth, clientHeight } = container;
    if (!clientWidth || !clientHeight) return;
    const [w, h] = renderSize ?? [clientWidth, clientHeight];
    if (renderSize) renderer.setSize(w, h, false);
    else { renderer.setSize(w, h); labels.setSize(w, h); }
    const aspect = w / h;
    persp.aspect = aspect; persp.updateProjectionMatrix();
    Object.assign(ortho, { left: -orthoH * aspect, right: orthoH * aspect, top: orthoH, bottom: -orthoH });
    ortho.updateProjectionMatrix();
    dirty = true;
  }
  new ResizeObserver(resize).observe(container);
  resize();

  const ease = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  // Кадр рисуется, только когда что-то изменилось; анимация идёт не чаще 30 кадров в секунду.
  renderer.setAnimationLoop(now => {
    if (held) return;  // при записи кадрами управляет рендер ролика
    if (flight) {
      const t = (now - (flight.t0 ??= now)) / 1000;
      const at = flightFrame(flight.path, Math.min(t, flight.path.duration));
      labels.render(scene, camera);
      gizmo.draw();
      flight.onFrame?.(at, t);
      if (t >= flight.path.duration) stopFlight();
      return;
    }
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    let changed = dirty;
    if (fly) {
      const k = fly.ms ? Math.min(1, (now - fly.t0) / fly.ms) : 1, e = ease(k);
      controls.target.lerpVectors(fly.fromT, fly.toT, e);
      camera.position.lerpVectors(fly.fromP, fly.toP, e);
      if (camera === ortho) { ortho.zoom = THREE.MathUtils.lerp(fly.fromZ, fly.toZ, e); ortho.updateProjectionMatrix(); }
      if (k >= 1) fly = null;
      changed = true;
    }
    if (walk(dt)) changed = true;
    if (controls.update()) changed = true;
    const frameDue = animate && now - last >= FRAME_MS;
    if (!changed && !frameDue) return;
    if (animate) {
      animT += dt;
      animated.forEach(f => f(animT));
      edges.forEach(e => e.animate(animT));
      if (selRing.visible) selRing.material.opacity = 0.45 + 0.3 * Math.sin(animT * 3);
    }
    renderer.render(scene, camera);
    labels.render(scene, camera);
    gizmo.draw();
    dirty = false;
    last = now;
  });

  function stopFlight() {
    if (!flight) return;
    const done = flight.onEnd;
    flight = null;
    endFlight();
    done?.();
  }

  return {
    show, select, selectGroup, overview, setProjection, soft,
    snapAxis(name, sign = 1) {
      snap(new THREE.Vector3(name === 'X' ? sign : 0, name === 'Y' ? sign : 0, name === 'Z' ? sign : 0));
    },
    // То, из чего строится маршрут пролёта. aspect — пропорции кадра видео, а не окна.
    flightContext(aspect) {
      return {
        aspect, tanHalf, box: bounds(),
        fit: (box, dir, a) => fitDistance(box, dir, a),
        view: { target: controls.target.clone(), dir: viewDir(), dist: viewDist() },
        groups: Object.keys(groupInfo).filter(g => plates.has(g)).map(g => ({
          id: g, title: groupInfo[g].title ?? g, purpose: groupInfo[g].purpose ?? '', color: plates.get(g).color,
          box: plates.get(g).box,
        })),
      };
    },
    playFlight(path, orthographic, onFrame, onEnd) {
      stopFlight();
      beginFlight(orthographic);
      flight = { path, onFrame, onEnd };
    },
    stopFlight,
    // Запись: renderVideo вызывает эти функции вместо цикла окна.
    recorder: (path, orthographic, { showLabels }) => ({
      prepare(w, h) {
        beginFlight(orthographic);
        held = true;
        renderer.setPixelRatio(1);
        renderSize = [w, h];
        resize();
      },
      draw: t => flightFrame(path, t),
      overlay(g, at, w, h) {
        if (showLabels && labelsOn) drawLabels(g, w, h);
        if (at.caption) drawCaption(g, at.caption, at.alpha, w, h);
      },
      restore() {
        renderSize = null;
        renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
        endFlight();
        held = false;
      },
    }),
    canvas: renderer.domElement,
    isOrtho: () => camera === ortho,
    setAnimate(v) { animate = v; edges.forEach(e => { e.pts.visible = v; }); dirty = true; },
    isAnimating: () => animate,
    setLabels(v) { labelsOn = v; labels.domElement.classList.toggle('hide-labels', !v); dirty = true; },
  };
}

