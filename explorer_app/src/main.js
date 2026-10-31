// Экран проводника: дерево запусков, страница запуска, графики и их анимация.
import "@fontsource/ibm-plex-sans/cyrillic-400.css";
import "@fontsource/ibm-plex-sans/cyrillic-600.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/greek-400.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/cyrillic-400.css";
import "./style.css";
import { action, connect, exportState, fetchChart, fetchRun, fetchRuns, inWindow, openExport, pickVideo, startExport } from "./api.js";
import { color, drawTimeline, Panel } from "./charts.js";
import { iconSvg } from "./icons.js";

const REFRESH_MS = 10_000;
const DEFAULT_SPEED = 30;
const LAUNCH_PANEL = 1; // номер графика взлётов в metrics_view.PANELS
const LAG_NOTE = "значение отстаёт: среднее по 200 матчам";

const $ = (id) => document.getElementById(id);
const state = {
  runs: [], collapsed: new Set(), selected: null, run: null, model: null, tab: "overview", zones: [], at: null, cursor: null,
  view: "chain", compare: [], chart: null, panels: [], panel: null, pos: 0, playing: false, last: 0, showRuns: true,
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

const percent = (v) => (v === null || v === undefined ? "нет" : `${(v * 100).toFixed(0)} %`);
const count = (v) => (v === null || v === undefined ? "нет" : Math.round(v).toLocaleString("ru-RU"));

let toastTimer;
function toast(text, error = false) {
  const el = $("toast");
  el.textContent = text;
  el.classList.toggle("error", error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), error ? 8000 : 4000);
}

async function act(name, run = state.selected, update) {
  try {
    return await action(name, run, update);
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

// ---------------------------------------------------------------- дерево

function hiddenByParent(run, byName) {
  for (let p = run.parent; p; p = byName.get(p)?.parent) if (state.collapsed.has(p)) return true;
  return false;
}

function tagClass(s) {
  return { "обучается": "live", "готов": "done" }[s] ?? "";
}

function renderTree() {
  const byName = new Map(state.runs.map((r) => [r.name, r]));
  const rows = state.runs.filter((r) => !hiddenByParent(r, byName)).map((r) => {
    const open = !state.collapsed.has(r.name);
    const chevron = r.branches
      ? `<button class="twist ${open ? "open" : ""}" data-twist="${escapeHtml(r.name)}" title="Свернуть или развернуть ветку">${iconSvg("chevronRight")}</button>`
      : `<span class="twist-gap"></span>`;
    return `<tr data-run="${escapeHtml(r.name)}" tabindex="0" class="${r.name === state.selected ? "on" : ""}">
      <td class="name" style="padding-left:${8 + r.depth * 16}px" title="${escapeHtml(r.name)}">${chevron}<span>${escapeHtml(r.name)}</span></td>
      <td><span class="tag ${tagClass(r.state)}">${r.state}</span></td>
      <td>${r.rules === null ? "?" : `r${r.rules}`}</td>
      <td class="n">${r.update}/${r.total ?? "?"}</td>
      <td class="n">${r.launch === null ? "нет" : r.launch.toFixed(2)}</td>
      <td class="n">${r.best === null ? "нет" : r.best.toFixed(2)}</td>
    </tr>`;
  });
  $("tree-body").innerHTML = rows.join("");
}

async function select(name, keepModel = false) {
  if (name !== state.selected) {
    stop();
    state.selected = name;
    state.compare = [];
    if (state.view === "compare") state.view = "chain";
    if (!keepModel) state.model = null;
    state.panel = null;
    state.chart = null;
  }
  renderTree();
  await refreshRun();
}

async function refreshRuns() {
  try {
    state.runs = (await fetchRuns()).runs;
    if (!state.runs.some((r) => r.name === state.selected)) state.selected = state.runs.at(-1)?.name ?? null;
    renderTree();
    $("refreshed").textContent = `обновлено ${new Date().toLocaleTimeString("ru-RU")}`;
    await refreshRun();
    renderComparePicker();
  } catch (e) {
    $("refreshed").textContent = "сервис не отвечает";
    toast(e.message, true);
  }
}

// ---------------------------------------------------------------- страница запуска

async function refreshRun() {
  const name = state.selected;
  $("empty").hidden = Boolean(name);
  $("run").hidden = !name;
  if (!name) {
    $("empty").textContent = "Запусков пока нет. Обучение запускается командой extract-moon train.";
    return;
  }
  const run = await fetchRun(name);
  if (name !== state.selected) return; // пока шёл запрос, выбрали другой запуск
  state.run = run;
  if (!run.models.some((m) => m.update === state.model)) state.model = null;
  renderRun();
  if (state.tab === "charts") await refreshChart();
}

function renderRun() {
  const r = state.run;
  $("run-name").textContent = r.name;
  const tag = $("run-state");
  tag.textContent = r.state;
  tag.className = `tag ${tagClass(r.state)}`;
  const chain = r.timeline.chain;
  $("crumbs").innerHTML = chain.slice(0, -1)
    .map((c) => `<button class="crumb" data-run="${escapeHtml(c.name)}">${escapeHtml(c.label)}</button><span class="muted">/</span>`).join("");
  $("compare-parent").disabled = !r.parent;
  $("compare-parent").title = r.parent ? `Открыть графики рядом с ${r.parent}` : "Этот запуск обучен с нуля, сравнивать не с чем";
  renderPassport();
  renderModels();
  renderTimeline();
}

function latestMatches({ last }) {
  return `взлёты ${percent(last.launch_rate)}, заряд ${percent(last.charge_frac)}, пассажиров ${last.passengers ?? "нет"}, ` +
    `длина ${last.ep_length ?? "нет"} тактов, убийств ${last.kills ?? "нет"}`;
}

function renderPassport() {
  const r = state.run;
  const origin = r.parent ? `${r.parent}, обновление ${r.parent_update}`
    : r.lost_parent ? `${r.lost_parent}, обновление ${r.parent_update} (папка удалена)` : "обучен с нуля";
  const rows = [
    ["Сейчас", r.summary],
    ["Последние 200 матчей", latestMatches(r)],
    ...(r.note ? [["Зачем", r.note]] : []),
    ["От модели", origin],
    ["Правила", r.rules === null ? "неизвестны" : `r${r.rules}`],
    ...(r.commit ? [["Код", `коммит ${r.commit}${r.dirty ? " и незакоммиченные правки" : ""}`]] : []),
    ...(r.started ? [["Начат", r.started + (r.finished ? `, закончен ${r.finished}` : "")]] : []),
    ["Матчей-этапов", r.replays],
  ];
  $("passport").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join("");
}

function renderModels() {
  const models = state.run.models;
  $("models-body").innerHTML = models.map((m) => `<tr data-model="${m.update}" tabindex="0" class="${m.update === state.model ? "on" : ""}">
    <td class="num">${m.update}${m.inherited ? " <span class='muted'>родительская</span>" : ""}</td>
    <td class="n">${count(m.steps)}</td>
    <td class="n">${percent(m.launch)}</td>
    <td>${m.stage ? "есть" : "нет"}</td>
    <td>${m.children.map(escapeHtml).join(", ") || "нет"}</td>
  </tr>`).join("") || `<tr><td colspan="5" class="muted">Сохранённых моделей нет</td></tr>`;
  const none = state.model === null;
  for (const b of $("model-actions").querySelectorAll("[data-action], #finetune")) b.disabled = none;
  const chosen = models.find((m) => m.update === state.model);
  $("model-actions").querySelector('[data-action="stage"]').disabled = !chosen?.stage;
  $("launch-animation").disabled = !state.run.timeline.xs.length;
}

function renderTimeline() {
  if ($("pane-overview").hidden || !state.run) return;
  drawLine();
  const chain = state.run.timeline.chain;
  $("timeline-legend").innerHTML = (chain.length > 1 ? chain.map(swatch).join("") : "") +
    `<span><i class="mark stage"></i>модель с записанным матчем</span><span><i class="mark"></i>модель</span>
     <span><i class="mark child"></i>дообучение от модели</span><span class="muted">щелчок выбирает модель</span>`;
}

function drawLine() {
  ({ zones: state.zones, at: state.at } = drawTimeline($("timeline"), state.run, state.model, state.cursor));
}

function chartSize() {
  try {
    return localStorage.getItem("chart-size") ?? "compact";
  } catch {
    return "compact";
  }
}

function setChartSize(size) {
  try {
    localStorage.setItem("chart-size", size);
  } catch {
    // Без хранилища выбор живёт до закрытия окна.
  }
  $("timeline-box").classList.toggle("full", size === "full");
  for (const b of $("chart-size").children) b.classList.toggle("on", b.dataset.size === size);
  renderTimeline();
}

function swatch(c) {
  return `<span title="${escapeHtml(c.name)}"><i style="background:${color(c.color)}"></i>${escapeHtml(c.label)}</span>`;
}

function nearestZone(event, reach = Infinity) {
  const x = event.clientX - $("timeline").getBoundingClientRect().left;
  let best = null;
  for (const zone of state.zones) if (!best || Math.abs(zone.x - x) < Math.abs(best.x - x)) best = zone;
  return best && Math.abs(best.x - x) <= reach ? best : null;
}

function selectModel(update) {
  state.model = update;
  renderModels();
  renderTimeline();
  // Прокручивается только таблица: шкала, по которой щёлкнули, остаётся на месте.
  const row = $("models-body").querySelector("tr.on");
  const box = row?.closest(".table-scroll");
  if (row) box.scrollTop = row.offsetTop - box.clientHeight / 2;
}

// ---------------------------------------------------------------- графики

const chartNames = () => (state.view === "compare" && state.compare.length ? state.compare : [state.selected]);

async function refreshChart() {
  const names = chartNames();
  const own = state.view === "own";
  const chart = await fetchChart(names, own);
  if (names.join() !== chartNames().join() || own !== (state.view === "own")) return;
  const same = state.chart?.stamp === chart.stamp && state.chart?.mode === chart.mode && state.chart?.names === names.join();
  chart.names = names.join();
  if (same) return;
  const atEnd = state.pos >= state.last;
  const wasChain = state.chart?.mode === "chain" && state.chart.names === chart.names;
  state.chart = chart;
  state.last = Math.max(chart.marks.length - 1, 0);
  if (atEnd || !wasChain) state.pos = state.last;
  state.pos = Math.min(state.pos, state.last);
  renderChart();
}

function panelTitles() {
  return [`<option value="all">Все графики</option>`,
    ...state.chart.panels.map((p, i) => `<option value="${i}">${escapeHtml(p.title)}</option>`)].join("");
}

function renderChart() {
  const chart = state.chart;
  for (const b of document.querySelectorAll("#view-mode button")) b.classList.toggle("on", b.dataset.view === state.view);
  $("compare-picker").hidden = state.view !== "compare";
  $("chart-summary").textContent = chart.summary.join("; ");
  const chain = chart.chain.length > 1 ? chart.chain.map(swatch) : [];
  $("chain-legend").innerHTML = chain.join("");
  $("transport").hidden = chart.mode !== "chain";
  const choice = $("panel-choice");
  choice.innerHTML = panelTitles();
  choice.value = state.panel === null ? "all" : String(state.panel);

  const shown = state.panel === null ? chart.panels.map((p, i) => [p, i]) : [[chart.panels[state.panel], state.panel]];
  const host = $("panels");
  host.classList.toggle("single", state.panel !== null);
  host.innerHTML = shown.map(([p, i]) => {
    const launch = p.lines.some((l) => l.key === "launch_rate");
    const legend = p.legend ? p.lines.filter((l) => l.label).map((l) =>
      `<span><i style="background:${color(l.color)}"></i>${escapeHtml(l.label)}</span>`).join("") : "";
    return `<article class="panel" data-panel="${i}">
      <h3 title="Открыть этот график">${escapeHtml(p.title)}</h3>
      <p class="note">${escapeHtml(p.note)}</p>
      ${launch ? `<p class="lag">${LAG_NOTE}</p>` : ""}
      ${p.lines.length ? "<canvas></canvas>" : `<p class="no-data">Этой метрики в запуске нет</p>`}
      ${legend ? `<div class="legend">${legend}</div>` : ""}
    </article>`;
  }).join("") + `<div id="chart-tip" class="tip" hidden></div>`;
  const tip = $("chart-tip");
  state.panels = [...host.querySelectorAll("canvas")].map((canvas) => {
    const index = Number(canvas.closest(".panel").dataset.panel);
    return new Panel(canvas, chart.panels[index], chart, tip);
  });
  for (const p of state.panels) p.peers = state.panels;
  updateFrame();
}

function currentSteps() {
  return state.chart.marks.length ? state.chart.marks[Math.round(state.pos)][1] : Infinity;
}

function updateFrame() {
  if (!state.chart) return;
  const steps = state.pos >= state.last ? Infinity : currentSteps();
  for (const p of state.panels) p.draw(steps);
  const seek = $("seek");
  seek.max = state.last;
  seek.value = state.pos;
  const mark = state.chart.marks[Math.round(state.pos)];
  $("frame").textContent = mark ? `обновление ${mark[0]}` : "";
}

function speed() {
  const v = Number($("speed").value.replace(",", "."));
  return v > 0 ? v : DEFAULT_SPEED;
}

let stamp = 0;
function step(now) {
  if (!state.playing) return;
  // По реальному времени: если кадр рисовался долго, скорость всё равно та, что выбрана.
  // now у requestAnimationFrame может быть раньше performance.now() из play().
  state.pos = Math.min(state.pos + (speed() * Math.max(now - stamp, 0)) / 1000, state.last);
  stamp = now;
  updateFrame();
  if (state.pos < state.last) requestAnimationFrame(step);
  else stop();
}

function play() {
  if (!state.chart || state.chart.mode !== "chain" || !state.last) return;
  if (state.pos >= state.last) state.pos = 0;
  state.playing = true;
  stamp = performance.now();
  $("play").innerHTML = iconSvg("pauseFilled");
  requestAnimationFrame(step);
}

function stop() {
  state.playing = false;
  $("play").innerHTML = iconSvg("playFilled");
}

const toggle = () => (state.playing ? stop() : play());

function choosePanel(panel) {
  state.panel = panel;
  renderChart();
}

function applyLayout() {
  const hide = !state.showRuns;
  $("layout").classList.toggle("wide", hide);
  renderTimeline();
  resizeCharts();
}

function resizeCharts() {
  for (const p of state.panels) p.back = null;
  updateFrame();
}

async function setTab(tab) {
  stop();
  state.tab = tab;
  $("tab-overview").classList.toggle("on", tab === "overview");
  $("tab-charts").classList.toggle("on", tab === "charts");
  $("pane-overview").hidden = tab !== "overview";
  $("pane-charts").hidden = tab !== "charts";
  state.showRuns = tab === "overview"; // сетке из 13 графиков нужна вся ширина окна
  applyLayout();
  if (tab === "charts") await refreshChart();
}

async function setView(view) {
  stop();
  state.view = view;
  if (view === "compare" && !state.compare.length) state.compare = [state.selected];
  state.chart = null;
  state.panel = view === "chain" ? state.panel : null;
  renderComparePicker();
  await refreshChart();
}

function renderComparePicker() {
  const menu = $("compare-menu");
  const open = !menu.hidden;
  menu.innerHTML = state.runs.map((r) => `<label style="padding-left:${12 + r.depth * 12}px">
    <input type="checkbox" value="${escapeHtml(r.name)}" ${state.compare.includes(r.name) ? "checked" : ""} /> ${escapeHtml(r.name)}</label>`).join("");
  menu.hidden = !open;
  const text = $("compare-open").querySelector("span");
  if (text) text.textContent = `Запуски: ${state.compare.length}`;
}

// ---------------------------------------------------------------- экспорт

const exportJob = { id: null, timer: null, name: "" };

function exportPanel() {
  return state.panel;
}

function showDuration() {
  const v = Number($("export-speed").value.replace(",", "."));
  const updates = state.chart.marks.length;
  $("export-duration").textContent = v > 0 ? `Видео на ${((updates - 1) / v).toFixed(1).replace(".", ",")} с, обновлений ${updates}`
    : "Скорость должна быть больше нуля";
}

function openExportDialog() {
  stop();
  if (!state.chart || state.chart.mode !== "chain") return;
  const panel = exportPanel();
  $("export-what").textContent = `${state.selected}: ${panel === null ? "все графики" : state.chart.panels[panel].title}. Вид задаёт plot-video: графики matplotlib, склеенные с предками.`;
  $("export-speed").value = $("speed").value;
  const dir = state.run.folder;
  $("export-path").value = `${dir}\\${panel === null ? "metrics.mp4" : `metrics_${panel + 1}.mp4`}`;
  $("export-browse").hidden = !inWindow;
  $("export-bar").style.width = "0";
  $("export-status").textContent = "";
  $("export-open").disabled = true;
  $("export-save").disabled = exportJob.timer !== null;
  $("export-dialog").hidden = false;
  showDuration();
}

async function saveExport() {
  const run = state.selected;
  try {
    const { id } = await startExport({ run, out: $("export-path").value, speed: Number($("export-speed").value.replace(",", ".")), panel: exportPanel() });
    exportJob.id = id;
    exportJob.name = run;
    $("export-save").disabled = true;
    $("export-open").disabled = true;
    $("export-status").textContent = "Подготовка графиков...";
    exportJob.timer = setInterval(pollExport, 300);
  } catch (e) {
    $("export-status").textContent = e.message;
  }
}

async function pollExport() {
  const job = await exportState(exportJob.id);
  const visible = !$("export-dialog").hidden;
  if (job.state === "running") {
    if (visible && job.total) {
      $("export-bar").style.width = `${(job.done / job.total) * 100}%`;
      $("export-status").textContent = `Кадр ${job.done} из ${job.total}`;
    }
    return;
  }
  clearInterval(exportJob.timer);
  exportJob.timer = null;
  $("export-save").disabled = false;
  const ok = job.state === "done";
  const text = ok ? `Готово: ${job.out}` : `Экспорт не удался: ${job.error}`;
  if (visible) {
    $("export-status").textContent = text;
    if (ok) $("export-bar").style.width = "100%";
    $("export-open").disabled = !ok;
  } else {
    toast(text, !ok); // окно закрыли во время экспорта: итог всё равно нужно показать
  }
}

async function copyCommand() {
  const res = await act("finetune", state.selected, state.model);
  if (!res) return;
  const area = $("command-text");
  $("command-dialog").hidden = false;
  area.value = res.command;
  area.select();
  $("command-status").textContent = `${res.copied ? "Команда скопирована." : "Скопируйте команду вручную."} Запускать из папки python, МЕТКУ и ЗАЧЕМ заменить.`;
}

// ---------------------------------------------------------------- события

function bind() {
  for (const el of document.querySelectorAll("[data-icon]")) {
    const text = el.dataset.text;
    el.innerHTML = iconSvg(el.dataset.icon) + (text ? `<span>${text}</span>` : "");
  }

  $("tree-body").addEventListener("click", (e) => {
    const twist = e.target.closest("[data-twist]");
    if (twist) {
      const name = twist.dataset.twist;
      if (state.collapsed.has(name)) state.collapsed.delete(name);
      else state.collapsed.add(name);
      renderTree();
      return;
    }
    const row = e.target.closest("tr[data-run]");
    if (row) select(row.dataset.run);
  });
  $("tree-body").addEventListener("dblclick", (e) => {
    const row = e.target.closest("tr[data-run]");
    if (row && !e.target.closest("[data-twist]")) act("replays", row.dataset.run);
  });
  $("tree-body").addEventListener("keydown", (e) => {
    const row = e.target.closest("tr[data-run]");
    if (!row) return;
    const next = e.key === "ArrowDown" ? row.nextElementSibling : e.key === "ArrowUp" ? row.previousElementSibling : null;
    if (e.key === "Enter") select(row.dataset.run);
    if (next) {
      e.preventDefault();
      const name = next.dataset.run;
      select(name).then(() => $("tree-body").querySelector("tr.on")?.focus());
    }
  });
  $("crumbs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-run]");
    if (b) select(b.dataset.run);
  });

  for (const b of document.querySelectorAll("[data-action]")) {
    b.addEventListener("click", async () => {
      const name = b.dataset.action;
      const res = await act(name, state.selected, name === "folder" || name === "replays" ? undefined : state.model ?? undefined);
      if (res && name !== "folder") toast({ replays: "Открываю матчи", player: "Открываю плеер", play: "Записываю матч, окно откроется само", stage: "Открываю матч этапа" }[name]);
    });
  }
  $("journal").addEventListener("click", () => act("journal", null));
  $("visualizer").addEventListener("click", async () => {
    const b = $("visualizer");
    b.disabled = true;
    toast("Запускаю визуализатор");
    const res = await act("visualizer", null);
    b.disabled = false;
    if (res) toast(`Визуализатор: ${res.url}`);
  });
  $("refresh").addEventListener("click", refreshRuns);
  $("toggle-runs").addEventListener("click", () => {
    state.showRuns = !state.showRuns;
    applyLayout();
  });
  $("compare-parent").addEventListener("click", async () => {
    state.compare = [state.run.parent, state.selected];
    state.view = "compare";
    state.chart = null;
    renderComparePicker();
    await setTab("charts");
  });
  $("finetune").addEventListener("click", copyCommand);
  $("launch-animation").addEventListener("click", async () => {
    state.view = "chain";
    state.panel = LAUNCH_PANEL;
    state.chart = null;
    await setTab("charts");
    state.pos = 0;
    play();
  });

  for (const b of $("chart-size").children) b.addEventListener("click", () => setChartSize(b.dataset.size));
  setChartSize(chartSize());
  $("tab-overview").addEventListener("click", () => setTab("overview"));
  $("tab-charts").addEventListener("click", () => setTab("charts"));

  $("models-body").addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-model]");
    if (row) selectModel(Number(row.dataset.model));
  });
  $("models-body").addEventListener("dblclick", (e) => {
    const row = e.target.closest("tr[data-model]");
    if (row) act("play", state.selected, Number(row.dataset.model));
  });

  const line = $("timeline");
  line.addEventListener("click", (e) => {
    const zone = nearestZone(e);
    if (zone) selectModel(zone.model.update);
  });
  line.addEventListener("pointermove", (e) => {
    state.cursor = e.clientX - line.getBoundingClientRect().left;
    drawLine();
    const point = state.at(state.cursor);
    const zone = nearestZone(e, 16);
    const tip = $("timeline-tip");
    const value = zone ? zone.model.launch : point.value;
    tip.innerHTML = `<p>${zone ? `модель ${zone.model.update}` : `обновление ${point.update}`}</p><div><span>взлёты, среднее по 200 матчам</span><b>${percent(value)}</b></div>`;
    tip.hidden = false;
    const wide = tip.offsetWidth;
    tip.style.left = `${point.x + wide + 16 > line.clientWidth ? point.x - wide - 12 : point.x + 12}px`;
    tip.style.top = "36px";
  });
  line.addEventListener("pointerleave", () => {
    $("timeline-tip").hidden = true;
    state.cursor = null;
    drawLine();
  });

  for (const b of document.querySelectorAll("#view-mode button")) b.addEventListener("click", () => setView(b.dataset.view));
  $("compare-open").addEventListener("click", () => ($("compare-menu").hidden = !$("compare-menu").hidden));
  $("compare-menu").addEventListener("change", async () => {
    state.compare = [...$("compare-menu").querySelectorAll("input:checked")].map((i) => i.value);
    state.chart = null;
    renderComparePicker();
    if (state.compare.length) await refreshChart();
  });
  $("panels").addEventListener("click", (e) => {
    const title = e.target.closest("h3");
    if (title && state.panel === null) choosePanel(Number(title.closest(".panel").dataset.panel));
  });

  $("play").addEventListener("click", toggle);
  $("seek").addEventListener("input", (e) => {
    stop();
    state.pos = Math.min(Number(e.target.value), state.last);
    updateFrame();
  });
  $("panel-choice").addEventListener("change", (e) => {
    stop();
    state.pos = state.last; // другой график показывается целиком, как при открытии
    choosePanel(e.target.value === "all" ? null : Number(e.target.value));
  });
  $("export").addEventListener("click", openExportDialog);
  $("export-speed").addEventListener("input", showDuration);
  $("export-save").addEventListener("click", saveExport);
  $("export-close").addEventListener("click", () => ($("export-dialog").hidden = true));
  $("export-open").addEventListener("click", async () => {
    try {
      await openExport(exportJob.id);
    } catch (e) {
      toast(e.message, true);
    }
  });
  $("export-browse").addEventListener("click", async () => {
    const path = await pickVideo($("export-path").value);
    if (path) $("export-path").value = path;
  });
  $("command-close").addEventListener("click", () => ($("command-dialog").hidden = true));

  addEventListener("keydown", (e) => {
    if (e.code !== "Space" || state.tab !== "charts" || e.target.matches("input, select, textarea, button")) return;
    e.preventDefault();
    toggle();
  });
  new ResizeObserver(() => {
    renderTimeline();
    resizeCharts();
  }).observe($("page"));
}

async function start() {
  bind();
  await document.fonts.ready;
  try {
    await connect();
  } catch (e) {
    $("empty").hidden = false;
    $("empty").textContent = e.message;
    return;
  }
  await refreshRuns();
  setInterval(() => {
    if (!state.playing) refreshRuns();
  }, REFRESH_MS);
}

start();
