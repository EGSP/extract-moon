// Интерфейс проигрывателя: воспроизведение, панель сведений, снимки и экспорт.
import "@fontsource/ibm-plex-sans/cyrillic-400.css";
import "@fontsource/ibm-plex-sans/cyrillic-600.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/greek-400.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/cyrillic-400.css";
import "./style.css";
import { Commands } from "./commands.js";
import { renderVideo } from "./export.js";
import { Gizmo } from "./gizmo.js";
import { factionColor, iconSvg, LEGEND, onColor, preloadIcons } from "./icons.js";
import { loadStage, openFolder, saveOutput, stages } from "./replay.js";
import { LAUNCH_TAIL, World } from "./world.js";

// Скорость воспроизведения, тактов в секунду, как в старом проигрывателе.
const SPEEDS = [0.5, 1, 2, 4, 8, 16, 32];
const FPS = 30;
const ORBIT_RATES = [5, 10, 20, 45, 90]; // градусов за секунду ролика
const ACTIONS = {
  noop: "ждать", up: "вверх", down: "вниз", left: "влево", right: "вправо", harvest: "добыть", deposit: "зарядить",
  board: "сесть", give: "передать", attack: "атаковать", reproduce: "размножиться", leave: "уйти",
};
const UPGRADES = { none: "нет", capacity: "ёмкость", armor: "броня", harvest: "добыча" };
const STATUS = { awake: "бодрствует", asleep: "спит", boarded: "на борту" };

const $ = (id) => document.getElementById(id);
const canvas = $("scene");
const world = new World(canvas);
const commands = new Commands();
const state = { rep: null, list: [], tick: 0, playing: false, speed: 0, smooth: true, exporting: false, shownIdx: -1, arming: null };

const lastFrame = () => state.rep.frames.length - 1;
const maxTick = () => lastFrame() + (state.rep.header.result?.launched ? LAUNCH_TAIL : 0);
const frameIndex = () => Math.min(Math.floor(state.tick), lastFrame());
const shownTick = (tick) => (state.smooth ? tick : Math.floor(tick));

function toast(text, error = false) {
  const t = $("toast");
  t.textContent = text;
  t.classList.toggle("error", error);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, error ? 12000 : 6000);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function speedLabel(v) {
  return v < 1 ? `1 такт / ${1 / v} с` : `${v} такт/с`;
}

// ---------------------------------------------------------------- этапы

async function refreshStages() {
  const fresh = await stages();
  state.list = fresh.stages;
  return fresh.current;
}

async function openStage(name) {
  const rep = await loadStage(name);
  state.rep = rep;
  world.setReplay(rep);
  commands.load(`commands:${rep.header.model.checkpoint ?? name}:${rep.header.seed}`);
  showCommands();
  state.tick = Math.min(state.tick, maxTick());
  state.shownIdx = -1;
  $("seek").max = maxTick();
  const model = rep.header.model;
  $("match").textContent = `карта ${rep.header.seed}, размер ${rep.header.map.size}, модель: обновление ${model.update}`;
  document.title = `Extract Moon — ${name}`;
  showStage();
  draw();
}

function showStage() {
  const i = state.list.findIndex((s) => s.name === state.rep.name);
  const stage = state.list[i];
  $("stage").textContent = stage?.update != null ? `этап ${i + 1}/${state.list.length}, обновление ${stage.update}` : state.rep.name;
  $("stage-prev").disabled = i <= 0;
  $("stage-next").disabled = i < 0 || i >= state.list.length - 1;
}

async function switchStage(delta) {
  await refreshStages(); // во время обучения появляются новые этапы
  const i = state.list.findIndex((s) => s.name === state.rep.name);
  const next = state.list[Math.max(0, Math.min(i + delta, state.list.length - 1))];
  if (next) await openStage(next.name); // тот же такт на другом этапе
}

// -------------------------------------------------------------- панель

function shipPanel(fr) {
  const sh = fr.ship;
  const frac = Math.min(sh.charge / sh.capacity, 1);
  const res = state.rep.header.result ?? {};
  const aboard = fr.robots.filter((r) => r.status === "boarded");
  const seats = Array.from({ length: sh.seats }, (_, i) => {
    const rb = aboard[i];
    if (!rb) return '<span class="seat"></span>';
    const bg = factionColor(rb.faction);
    return `<span class="seat" style="background:${bg};color:${onColor(bg)}">#${rb.id}</span>`;
  }).join("");
  const timer = sh.launch_timer >= 0 ? `Взлёт через ${sh.launch_timer} тактов` : "";
  const end = frameIndex() === lastFrame() ? (res.launched ? "Корабль улетел" : "Корабль не улетел") : "";
  $("ship-info").innerHTML = `<h2>Корабль</h2>
    <div class="row"><span>Заряд</span><span class="num">${sh.charge.toFixed(0)} / ${sh.capacity.toFixed(0)}</span></div>
    <div class="progress"><div style="width:${frac * 100}%"></div></div>
    <div class="row"><span>Места</span><span class="num">${sh.passengers} / ${sh.seats}</span></div>
    <div class="seats">${seats}</div>
    ${timer || end ? `<p class="note">${end || timer}</p>` : ""}`;
}

function factionPanel(fr) {
  const counts = new Map();
  for (const rb of fr.robots) {
    if (!counts.has(rb.faction)) counts.set(rb.faction, { awake: 0, asleep: 0, boarded: 0 });
    counts.get(rb.faction)[rb.status]++;
  }
  const rows = [...counts].sort((a, b) => a[0] - b[0]).map(([f, n]) => `<tr>
    <td><i class="swatch" style="background:${factionColor(f)}"></i>${f < 0 ? "Одиночки" : `Фракция ${f}`}</td>
    <td class="num">${n.awake}</td><td class="num">${n.asleep}</td><td class="num">${n.boarded}</td></tr>`);
  $("factions").innerHTML = `<h2>Фракции</h2><table><thead><tr><th></th><th>бодры</th><th>спят</th><th>в корабле</th></tr></thead>
    <tbody>${rows.join("")}</tbody></table>`;
}

function bars(title, labels, probs, chosen) {
  const rows = probs.map((p, i) => ({ p, i })).filter(({ p, i }) => p >= 0.005 || i === chosen).sort((a, b) => b.p - a.p)
    .map(({ p, i }) => `<div class="bar${i === chosen ? " chosen" : ""}"><span>${esc(labels[i])}</span>
      <div class="track"><div style="width:${p * 100}%"></div></div><span class="num">${p.toFixed(2)}</span></div>`);
  return `<h3>${title}</h3>${rows.join("")}`;
}

function robotPanel(fr) {
  const el = $("robot");
  const rb = fr.robots.find((r) => r.id === world.selected);
  if (!rb) {
    el.innerHTML = '<h2>Робот</h2><p class="note">Нажмите на робота, чтобы увидеть его решения</p>';
    return;
  }
  const names = state.rep.header.names;
  const dec = fr.decisions[rb.id];
  const faction = rb.faction < 0 ? "одиночка" : `фракция ${rb.faction}`;
  const body = dec
    ? `<div class="row"><span>Оценка критика</span><span class="num">${dec.critic >= 0 ? "+" : ""}${dec.critic.toFixed(2)}</span></div>
      ${bars("Действие", names.main.map((n) => ACTIONS[n] ?? n), dec.main, dec.chosen[0])}
      ${bars("Улучшение", names.upgrade.map((n) => UPGRADES[n] ?? n), dec.upgrade, dec.chosen[1])}
      ${bars("Сигнал", names.symbols, dec.symbol, dec.chosen[2])}`
    : '<p class="note">На этом такте робот не принимает решений</p>';
  el.innerHTML = `<h2><i class="swatch" style="background:${factionColor(rb.faction)}"></i>Робот #${rb.id}</h2>
    <p class="note">${faction}, ${STATUS[rb.status]}</p>
    <div class="row"><span>Энергия</span><span class="num">${rb.energy.toFixed(1)}</span></div>
    <div class="row"><span>Прочность</span><span class="num">${rb.hp.toFixed(1)}</span></div>
    <div class="row"><span>Улучшения</span><span class="num">${rb.upgrades.join(" / ")}</span></div>${body}`;
}

function showPanels() {
  const idx = frameIndex();
  const fr = state.rep.frames[idx];
  $("tick").textContent = `такт ${fr.t} / ${state.rep.frames[lastFrame()].t}`;
  if (state.shownIdx === idx) return;
  state.shownIdx = idx;
  shipPanel(fr);
  factionPanel(fr);
  robotPanel(fr);
}

// ------------------------------------------------------- воспроизведение

function followCommands(tick) {
  const pose = commands.pose(tick, SPEEDS[state.speed]);
  if (!pose) return;
  const c = pose.command;
  if (c.type === "follow") world.followRobot(c.camera, c.robot, pose.tick, c.yaw, c.rotate);
  else world.applyCamera(c.camera, pose.angle);
}

function draw() {
  if (!state.rep) return;
  if (commands.follow) followCommands(state.tick);
  world.update(shownTick(state.tick));
  $("seek").value = state.tick;
  showPanels();
}

function setPlaying(on) {
  state.playing = on;
  const b = $("play");
  b.innerHTML = iconSvg(on ? "pauseFilled" : "playFilled", 20);
}

const ACTIONS_BY_NAME = {
  play() {
    if (!state.playing && state.tick >= maxTick()) state.tick = 0;
    setPlaying(!state.playing);
  },
  start() { state.tick = 0; draw(); },
  end() { state.tick = lastFrame(); setPlaying(false); draw(); },
  prev() { state.tick = Math.max(Math.ceil(state.tick) - 1, 0); setPlaying(false); draw(); },
  next() { state.tick = Math.min(Math.floor(state.tick) + 1, lastFrame()); setPlaying(false); draw(); },
  faster() { setSpeed(state.speed + 1); },
  slower() { setSpeed(state.speed - 1); },
  vision() { toggle("vision"); },
  icons() { toggle("icons"); },
  smooth() { state.smooth = !state.smooth; $("smooth").classList.toggle("on", state.smooth); draw(); },
  shot() { saveShot(); },
  video() { exportVideo(); },
  folder() { if (state.rep) openFolder(state.rep.name).catch((e) => toast(String(e), true)); },
  ortho() { setOrtho(!world.camera.isOrthographicCamera); },
  orbit() { showTab("commands"); toggleOrbit(); },
  pin() { showTab("commands"); pinCamera(); },
  followPlain() { showTab("commands"); toggleFollow(false); },
  followTurn() { showTab("commands"); toggleFollow(true); },
};

function setSpeed(i) {
  state.speed = Math.max(0, Math.min(i, SPEEDS.length - 1));
  $("speed").value = state.speed;
}

function setOrtho(on) {
  world.setOrthographic(on);
  showProjection();
}

function showProjection() {
  $("cam-ortho").textContent = world.camera.isOrthographicCamera ? "Ортография" : "Перспектива";
}

function toggle(option) {
  world.options[option] = !world.options[option];
  $(option).classList.toggle("on", world.options[option]);
  world.visionKey = null;
  draw();
}

function loop(prev) {
  requestAnimationFrame((now) => {
    if (!state.exporting) {
      if (state.playing && state.rep) {
        // Метка кадра rAF бывает раньше performance.now() из предыдущего вызова.
        state.tick += (Math.max(now - prev, 0) / 1000) * SPEEDS[state.speed];
        if (state.tick >= maxTick()) {
          state.tick = maxTick();
          setPlaying(false);
        }
        draw();
      }
      if (world.dirty) world.render();
    }
    loop(now);
  });
}

// ---------------------------------------------------------------- вывод

async function saveShot() {
  if (!state.rep) return;
  world.render();
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  const t = state.rep.frames[frameIndex()].t;
  const file = `${state.rep.name}_${String(t).padStart(4, "0")}_3d.png`;
  const path = await saveOutput(state.rep.name, "shot", file, await blob.arrayBuffer());
  toast(`Снимок сохранён: ${path}`);
}

/** Файл рядом с видео: чем и как снят ролик, чтобы повторить кадр позже. */
function exportMeta(file, video, speed, span, camera, settings, list) {
  const { name, header, frames } = state.rep;
  return JSON.stringify({
    createdAt: new Date().toISOString(),
    video: { file, ...video, durationSeconds: video.frames / video.fps },
    replay: { name, seed: header.seed, mapSize: header.map.size, ticks: frames[frames.length - 1].t, model: header.model },
    playback: { ticksPerSecond: speed, fromTick: 0, toTick: span, launchTailTicks: span - lastFrame() },
    settings,
    camera,
    commands: list,
  }, null, 2);
}

async function exportVideo() {
  if (!state.rep || state.exporting) return;
  state.exporting = true;
  setPlaying(false);
  const speed = SPEEDS[state.speed];
  const height = Number($("quality").value);
  const span = maxTick();
  const camera = world.cameraState();
  const animated = commands.enabled.length > 0;
  const list = commands.enabled;
  const settings = { smooth: state.smooth, ...world.options, selectedRobot: world.selected };
  const frames = Math.max(Math.round((span / speed) * FPS), 1) + 1;
  let stop = false;
  $("modal-cancel").onclick = () => { stop = true; };
  $("modal-text").textContent = `${height}p, ${FPS} кадров в секунду, ${speedLabel(speed)}, длительность ${Math.ceil(frames / FPS)} с`;
  $("modal-bar").style.width = "0";
  $("modal").hidden = false;
  try {
    const result = await renderVideo({
      world, canvas, height, fps: FPS, frames,
      tickAt: (j) => {
        const tick = Math.min((j * speed) / FPS, span);
        if (animated) followCommands(tick);
        return shownTick(tick);
      },
      onProgress: (k) => { $("modal-bar").style.width = `${k * 100}%`; },
      cancelled: () => stop,
    });
    if (result) {
      const stem = `${state.rep.name}_3d${animated ? "_anim" : ""}`;
      const file = `${stem}.mp4`;
      const path = await saveOutput(state.rep.name, "video", file, result.bytes);
      const meta = exportMeta(file, result.video, speed, span, camera, settings, list);
      await saveOutput(state.rep.name, "video", `${stem}.json`, new TextEncoder().encode(meta));
      toast(`Видео и параметры сохранены: ${path}`);
    }
  } catch (e) {
    toast(`Видео не сохранено: ${e.message ?? e}`, true);
  }
  $("modal").hidden = true;
  state.exporting = false;
  if (animated) world.applyCamera(camera); // вид до экспорта
  showProjection();
  draw();
}

// --------------------------------------------------------------- команды

function commandTitle(c) {
  if (c.type === "pin") return "Вид камеры";
  if (c.type === "follow") return `За роботом #${c.robot}${c.rotate ? ", с поворотом" : ""}`;
  const sign = c.rate < 0 ? "−" : "";
  return `Вращение ${sign}${Math.abs(c.rate)}°/с`;
}

function showCommands() {
  const active = commands.recording;
  const orbit = $("orbit");
  const orbiting = active?.type === "orbit";
  orbit.classList.toggle("recording", orbiting);
  orbit.innerHTML = orbiting
    ? `${iconSvg("stopFilled", 16)}<span>Остановить вращение</span>`
    : `${iconSvg("rotate", 16)}<span>Начать вращение</span>`;
  $("follow").checked = commands.follow;
  for (const [id, rotate, icon, text] of [["follow-plain", false, "location", "Следовать за роботом"], ["follow-turn", true, "compass", "Следовать с поворотом"]]) {
    const live = active?.type === "follow" && active.rotate === rotate;
    const button = $(id);
    button.classList.toggle("recording", live);
    button.classList.toggle("armed", state.arming === rotate);
    button.innerHTML = `${iconSvg(live ? "stopFilled" : icon, 16)}<span>${live ? "Остановить следование" : text}</span>`;
  }
  $("arm-hint").hidden = state.arming === null;
  $("tab-commands").textContent = commands.list.length ? `Команды (${commands.list.length})` : "Команды";
  const rows = [...commands.list].sort((a, b) => a.start - b.start).map((c) => `
    <tr data-id="${c.id}" class="${c.enabled ? "" : "off"} ${c === active ? "live" : ""}">
      <td><input type="checkbox" data-action="toggle" ${c.enabled ? "checked" : ""} aria-label="Включить действие" /></td>
      <td>${commandTitle(c)}</td>
      <td class="num">${c.start.toFixed(1)}</td>
      <td class="num">${c.end === null ? "—" : c.end.toFixed(1)}</td>
      <td><button data-action="delete" title="Удалить действие">${iconSvg("trash", 16)}</button></td>
    </tr>`);
  $("command-list").innerHTML = rows.length
    ? `<table><thead><tr><th></th><th>Действие</th><th>с такта</th><th>до</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>`
    : '<p class="note">Пока пусто. Начните вращение или запомните вид: команда появится здесь с текущим тактом.</p>';
  const animated = commands.enabled.length > 0;
  const exportButton = $("export");
  exportButton.innerHTML = `${iconSvg(animated ? "starFilled" : "video", 16)}<span>${animated ? "Видео с анимацией" : "Видео"}</span>`;
  exportButton.title = animated ? "Видео MP4 с учётом команд камеры (M)" : "Видео MP4 с текущей камерой и настройками (M)";
  exportButton.classList.toggle("animated", animated);
}

function toggleOrbit() {
  if (!state.rep) return;
  state.arming = null;
  const wasOrbit = commands.recording?.type === "orbit";
  commands.stop(state.tick);
  if (!wasOrbit) {
    commands.add("orbit", state.tick, world.cameraState(), { rate: Number($("orbit-rate").value) });
    if (!state.playing && state.tick < maxTick()) setPlaying(true);
  }
  showCommands();
}

/** Без выбранного робота кнопка ждёт щелчка по нему в сцене. */
function toggleFollow(rotate) {
  if (!state.rep) return;
  const live = commands.recording;
  if (live?.type === "follow" && live.rotate === rotate) {
    commands.stop(state.tick);
  } else {
    const alive = state.rep.frames[frameIndex()].robots.some((r) => r.id === world.selected && r.status !== "boarded");
    if (alive) startFollow(world.selected, rotate);
    else state.arming = state.arming === rotate ? null : rotate;
  }
  showCommands();
}

function startFollow(robot, rotate) {
  state.arming = null;
  commands.stop(state.tick);
  const yaw = world.smoothYaw(robot, state.tick);
  commands.add("follow", state.tick, world.cameraState(), { robot, rotate, yaw });
  if (!state.playing && state.tick < maxTick()) setPlaying(true);
  draw();
}

function pinCamera() {
  if (!state.rep) return;
  state.arming = null;
  commands.stop(state.tick);
  commands.add("pin", state.tick, world.cameraState());
  showCommands();
}

function showTab(name) {
  $("tab-info").classList.toggle("on", name === "info");
  $("tab-commands").classList.toggle("on", name === "commands");
  $("pane-info").hidden = name !== "info";
  $("pane-commands").hidden = name !== "commands";
}

// --------------------------------------------------------------- события

function bindUi() {
  for (const el of document.querySelectorAll("[data-icon]")) el.innerHTML = iconSvg(el.dataset.icon, 20);
  $("play").innerHTML = iconSvg("playFilled", 20);
  const labelled = { icons: ["flashFilled", "Значки"], vision: ["view", "Обзор"], smooth: ["activity", "Плавно"], shot: ["camera", "Снимок"], export: ["video", "Видео"] };
  for (const [id, [icon, text]] of Object.entries(labelled)) $(id).innerHTML = `${iconSvg(icon, 16)}<span>${text}</span>`;
  $("speed").innerHTML = SPEEDS.map((v, i) => `<option value="${i}">${speedLabel(v)}</option>`).join("");
  $("legend").innerHTML = LEGEND.map(([n, text]) => `<li><span class="tile">${iconSvg(n, 16)}</span>${text}</li>`).join("");

  const clicks = {
    play: "play", "to-start": "start", "to-end": "end", "step-back": "prev", "step-next": "next", vision: "vision",
    icons: "icons", smooth: "smooth", shot: "shot", export: "video", folder: "folder", "cam-ortho": "ortho",
  };
  for (const [id, action] of Object.entries(clicks)) $(id).onclick = () => ACTIONS_BY_NAME[action]();
  $("cam-home").onclick = () => world.home();
  $("tab-info").onclick = () => showTab("info");
  $("tab-commands").onclick = () => showTab("commands");
  $("orbit").onclick = toggleOrbit;
  $("pin-camera").onclick = pinCamera;
  $("follow-plain").onclick = () => toggleFollow(false);
  $("follow-turn").onclick = () => toggleFollow(true);
  $("pin-camera").innerHTML = `${iconSvg("pin", 16)}<span>Запомнить вид</span>`;
  $("orbit-rate").innerHTML = ORBIT_RATES.flatMap((v) => [v, -v])
    .map((v) => `<option value="${v}"${v === 10 ? " selected" : ""}>${v > 0 ? "↻" : "↺"} ${Math.abs(v)}°/с</option>`).join("");
  $("follow").onchange = (e) => {
    commands.follow = e.target.checked;
    draw();
  };
  $("command-list").onclick = (e) => {
    const row = e.target.closest("tr[data-id]");
    if (!row) return;
    const id = Number(row.dataset.id);
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "delete") commands.remove(id);
    else if (action === "toggle") commands.toggle(id);
    else {
      state.tick = commands.list.find((c) => c.id === id).start;
      commands.follow = true;
    }
    showCommands();
    draw();
  };
  // Ручное движение камеры важнее команд: иначе следующий кадр вернул бы её обратно.
  world.onUserCamera = () => {
    if (!commands.follow || state.exporting) return;
    commands.follow = false;
    showCommands();
  };
  new Gizmo($("gizmo"), world);
  $("stage-prev").onclick = () => switchStage(-1);
  $("stage-next").onclick = () => switchStage(1);
  $("speed").onchange = (e) => setSpeed(Number(e.target.value));
  $("seek").oninput = (e) => { state.tick = Number(e.target.value); draw(); };

  // Перетаскивание вращает камеру, поэтому выбором считается только щелчок без сдвига.
  let down = null;
  canvas.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 || e.button !== 0 || !state.rep) return;
    const box = canvas.getBoundingClientRect();
    world.selected = world.pick(e.clientX - box.left, e.clientY - box.top);
    if (state.arming !== null && world.selected !== null) {
      startFollow(world.selected, state.arming);
      showCommands();
    }
    state.shownIdx = -1;
    draw();
  });

  const keys = {
    " ": "play", ArrowLeft: "prev", ArrowRight: "next", ArrowUp: "faster", ArrowDown: "slower", v: "vision", h: "icons",
    i: "smooth", s: "shot", m: "video", o: "folder", 5: "ortho", r: "orbit", p: "pin", f: "followPlain", g: "followTurn",
  };
  window.addEventListener("keydown", (e) => {
    if (state.exporting || e.target.tagName === "SELECT") return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === "Tab" && state.rep) {
      e.preventDefault();
      const ids = state.rep.frames[frameIndex()].robots.filter((r) => r.status !== "boarded").map((r) => r.id);
      world.selected = ids[(ids.indexOf(world.selected) + 1) % ids.length] ?? null;
      state.shownIdx = -1;
      draw();
    } else if (key === "0") world.home();
    else if (key === "1") world.viewAlong(0, 0, 1);
    else if (key === "3") world.viewAlong(1, 0, 0);
    else if (key === "7") world.viewAlong(0, 1, 0);
    else if (keys[key]) {
      e.preventDefault();
      ACTIONS_BY_NAME[keys[key]]();
    }
  });
  new ResizeObserver(() => { if (!state.exporting) world.resize(); }).observe($("viewport"));
}

function showEmpty(text) {
  const el = $("empty");
  el.hidden = false;
  el.textContent = text;
}

async function start() {
  bindUi();
  world.resize();
  await Promise.all([preloadIcons(), document.fonts.load('42px "IBM Plex Mono"', "α1"), world.load()]);
  const current = await refreshStages();
  if (!current) {
    showEmpty("Реплей не выбран. Откройте матч кнопкой «Новый плеер» в проводнике запусков.");
  } else {
    await openStage(current);
    setPlaying(true);
  }
  loop(performance.now());
}

start().catch((e) => showEmpty(`Не удалось открыть реплей: ${e.message ?? e}`));
