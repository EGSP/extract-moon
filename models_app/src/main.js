// Справочник архитектур и карточки: весь каталог загружается одним запросом, сцена показывает выбранную архитектуру.
import "@fontsource/ibm-plex-sans/cyrillic-300.css";
import "@fontsource/ibm-plex-sans/cyrillic-400.css";
import "@fontsource/ibm-plex-sans/cyrillic-600.css";
import "@fontsource/ibm-plex-sans/latin-300.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/greek-400.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/cyrillic-400.css";
import './style.css';
import { connect, fetchCatalog, fetchMemory } from './api.js';
import { createScene, GROUP_COLORS, shapeText, sizeText, plural } from './scene.js';
import { icon } from './icons.js';
import { exampleView, memoryView } from './examples.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const num = n => n.toLocaleString('ru-RU');
const short = n => n >= 1e6 ? (n / 1e6).toFixed(2).replace('.', ',') + ' млн' : n >= 1e3 ? Math.round(n / 1e3) + ' тыс.' : String(n);
const pct = (n, total) => (100 * n / total).toFixed(1).replace('.', ',') + ' %';
const HINT = 'Анимация по умолчанию выключена, чтобы не нагружать процессор. Клик выбирает блок или группу. WASD двигает камеру, Q и E опускают и поднимают, Shift ускоряет. Цифры 1, 3 и 7 на цифровом блоке дают вид спереди, сбоку и сверху, 5 переключает проекцию.';

let cat = null, current = null, selectedBlock = null, selectedGroup = null;
const memory = new Map();  // имя запуска -> полупериоды памяти или обещание их загрузки
const scene = createScene($('#stage'), {
  onHover: id => { $('#status').textContent = id ? blockById(id)?.title ?? '' : ''; },
  onSelect: id => selectBlock(id),
  onSelectGroup: g => selectGroup(g),
  onCamera: ortho => setOn('#btn-proj', ortho),
});

const blockById = id => current?.arch.instance.blocks.find(b => b.id === id);
const schemaOf = id => cat.schemas.find(s => s.id === id);
const archOf = id => cat.archs.find(a => a.id === id);
const runOf = name => cat.archs.flatMap(a => a.runs).find(r => r.name === name);
const groupTitle = (schema, g) => schema.groups[g]?.title ?? g;
const runsText = n => `${n} ${plural(n, 'модель', 'модели', 'моделей')}`;

// ---------------------------------------------------------------- справочник

function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const match = (...xs) => !q || xs.some(x => String(x ?? '').toLowerCase().includes(q));
  let html = '';
  for (const a of cat.archs) {
    const runs = a.runs.filter(r => match(r.name, r.note));
    if (!runs.length && !match(a.title)) continue;
    const sel = current?.arch === a && current.kind === 'arch';
    html += `<div class="item arch${sel ? ' sel' : ''}" data-kind="arch" data-id="${a.id}">
      ${icon('arch', 20)}<div><div class="name">${esc(a.title)}${a.default ? '<span class="tag">основная</span>' : ''}</div>
      <div class="meta">${short(a.instance.total_params)} весов, ${runsText(a.runs.length)}</div></div></div>`;
    for (const r of [...runs].sort((x, y) => (x.started || '').localeCompare(y.started || ''))) {
      const sel = current?.kind === 'run' && current.run === r;
      const from = r.parent ? `<div class="meta">${icon('branch', 14)} от ${esc(r.parent.run)}, шаг ${r.parent.update}</div>` : '';
      html += `<div class="item run${sel ? ' sel' : ''}" data-kind="run" data-id="${esc(r.name)}" title="${esc(r.note)}">
        <div class="name">${esc(r.name)}</div>${from}</div>`;
    }
  }
  for (const r of cat.orphans)
    html += `<div class="item run"><div class="name">${esc(r.name)}</div><div class="meta err">${icon('warn', 14)} ${esc(r.error)}</div></div>`;
  $('#list').innerHTML = html || '<p class="hint pad">Ничего не найдено.</p>';
}

$('#list').addEventListener('click', ev => {
  const el = ev.target.closest('.item[data-kind]');
  if (el) open(el.dataset.kind, el.dataset.id);
});
$('#search').addEventListener('input', renderList);

// ---------------------------------------------------------------- выбор

function open(kind, id) {
  const run = kind === 'run' ? runOf(id) : null;
  const arch = run ? archOf(run.arch) : archOf(id);
  if (!arch) return;
  const same = current?.arch === arch;
  current = { kind, arch, run, schema: schemaOf(arch.schema) };
  history.replaceState(null, '', `#${kind}=${encodeURIComponent(id)}`);
  selectedBlock = selectedGroup = null;
  if (same) scene.select(null, false); else scene.show(arch.instance, current.schema.groups);
  renderList();
  renderHeader();
  renderCard();
}

function renderHeader() {
  const { kind, arch, run, schema } = current;
  $('#title').innerHTML = kind === 'run'
    ? `<div class="main">${esc(run.name)}</div><div class="sub">модель, архитектура ${esc(arch.title)}</div>`
    : `<div class="main">${esc(arch.title)}</div><div class="sub">архитектура, ${num(arch.instance.total_params)} весов</div>`;
  const warns = [];
  if (schema.status.stale) warns.push('Код модели менялся после того, как написана схема. Схема может не совпадать с моделью.');
  if (kind === 'run' && run.model_differs) warns.push('Эта модель обучена на другой версии кода, чем та, по которой написана схема.');
  $('#warning').hidden = !warns.length;
  $('#warning').innerHTML = warns.map(w => `<div>${icon('warn', 16)}<span>${esc(w)}</span></div>`).join('');
  $('#legend').innerHTML = Object.keys(schema.groups).map(g =>
    `<span><i style="background:${GROUP_COLORS[g] ?? '#8d8d8d'}"></i>${esc(groupTitle(schema, g))}</span>`).join('');
}

function selectBlock(id) {
  selectedBlock = id || null;
  selectedGroup = null;
  scene.select(selectedBlock);
  renderCard();
}

function selectGroup(g) {
  selectedGroup = g;
  selectedBlock = null;
  scene.selectGroup(g);
  renderCard();
}

// Модель, по весам которой показывается память: выбранный запуск или последний запуск на архитектуре.
function memoryRun() {
  if (current.run) return current.run;
  return [...current.arch.runs].sort((a, b) => (a.started || '').localeCompare(b.started || '')).at(-1) ?? null;
}

function loadMemory(name) {
  if (!memory.has(name)) {
    memory.set(name, fetchMemory(name)
      .then(m => { memory.set(name, m); renderCard(); })
      .catch(e => { memory.set(name, { error: e.message }); renderCard(); }));
  }
  const m = memory.get(name);
  return m instanceof Promise ? null : m;
}

// ---------------------------------------------------------------- карточки

function renderCard() {
  const el = $('#card');
  if (!current) { el.innerHTML = ''; return; }
  const b = selectedBlock && blockById(selectedBlock);
  el.innerHTML = b ? blockCard(b) : selectedGroup ? groupCard(selectedGroup)
    : current.kind === 'run' ? runCard() : archCard();
  el.querySelectorAll('[data-block]').forEach(a => a.addEventListener('click', () => selectBlock(a.dataset.block)));
  el.querySelectorAll('[data-group]').forEach(a => a.addEventListener('click', () => selectGroup(a.dataset.group)));
  el.querySelectorAll('[data-open]').forEach(a => a.addEventListener('click', () => open(...a.dataset.open.split(':'))));
}

const chips = (items, color) => `<div class="chips">${items.map(t =>
  `<span class="chip" style="--c:${color}">${esc(t)}</span>`).join('')}</div>`;

const share = (n, total, color) => `<div class="bar"><div style="width:${100 * n / total}%;background:${color}"></div></div>`;

function archCard() {
  const { arch, schema } = current, inst = arch.instance, total = inst.total_params;
  let html = `<h2>${esc(arch.title)}</h2><p>${esc(schema.summary)}</p><h3>Из чего состоит</h3><div class="groups">`;
  for (const g of Object.keys(schema.groups)) {
    const n = inst.group_params[g] ?? 0;
    html += `<a class="group" data-group="${g}">
      <div class="gt"><i style="background:${GROUP_COLORS[g]}"></i>${esc(groupTitle(schema, g))}<span>${n ? pct(n, total) : ''}</span></div>
      <p>${esc(schema.groups[g].purpose)}</p>${n ? share(n, total, GROUP_COLORS[g]) : ''}</a>`;
  }
  html += '</div><h3>Модели на этой архитектуре</h3>';
  html += arch.runs.length
    ? `<div class="links">${arch.runs.map(r => `<a data-open="run:${esc(r.name)}">${icon('run', 16)}${esc(r.name)}</a>`).join('')}</div>`
    : '<p class="hint">Пока ни одной.</p>';
  html += `<details><summary>Для разработчика</summary><p>${esc(schema.description)}</p>
    <table><tr><td>Всего весов</td><td>${num(total)}</td></tr>
    ${schema.vars.map(v => `<tr><td><code>${esc(v.name)}</code> ${esc(v.desc)}</td><td>${num(inst.vars[v.name])}</td></tr>`).join('')}
    <tr><td>Схема</td><td>${esc(schema.id)}</td></tr><tr><td>Коммит схемы</td><td>${esc(schema.model_commit.slice(0, 7))}</td></tr></table></details>`;
  return html + '<p class="hint gap">Клик по блоку или подложке группы в сцене расскажет, зачем они нужны.</p>';
}

function groupCard(g) {
  const { arch, schema } = current, inst = arch.instance, total = inst.total_params, color = GROUP_COLORS[g];
  const blocks = inst.blocks.filter(b => b.group === g), n = inst.group_params[g] ?? 0;
  let html = `<a class="back" data-block="">${icon('back', 16)}Вся модель</a>`;
  html += `<p class="kind" style="color:${color}">Группа</p><h2>${esc(groupTitle(schema, g))}</h2>`;
  html += `<p class="lead">${esc(schema.groups[g].purpose)}</p>`;
  if (n) html += `<div class="hint">${num(n)} весов, ${pct(n, total)} модели</div>${share(n, total, color)}`;
  html += `<h3>Блоки группы</h3><div class="groups">${blocks.map(b =>
    `<a class="group" data-block="${b.id}"><div class="gt"><i style="background:${color}"></i>${esc(b.title)}</div><p>${esc(b.purpose)}</p></a>`).join('')}</div>`;
  return html;
}

function runCard() {
  const { arch, run } = current;
  let html = `<h2>${esc(run.name)}</h2>`;
  if (run.note) html += `<p>${esc(run.note)}</p>`;
  html += '<table>';
  html += `<tr><td>Архитектура</td><td><a data-open="arch:${arch.id}">${esc(arch.title)}</a></td></tr>`;
  html += `<tr><td>Обучение</td><td>${esc(run.parent ? `дообучена от ${run.parent.run}, шаг ${run.parent.update}` : 'с нуля')}</td></tr>`;
  html += `<tr><td>Запущена</td><td>${esc(run.started.replace('T', ' ').slice(0, 16))}</td></tr></table>`;
  html += `<details><summary>Для разработчика</summary><table>
    <tr><td>Коммит</td><td>${esc(run.commit.slice(0, 7))}${run.dirty ? ', с правками' : ''}</td></tr>
    <tr><td>Правила мира</td><td>r${esc(run.rules ?? '')}</td></tr></table></details>`;
  return html + '<p class="hint gap">Схема одна на архитектуру: обучение меняет веса, но не устройство сети. Память слоёв RWKV у каждой модели своя, она видна в карточке слоя.</p>';
}

const paramRows = params => params.map(p =>
  `<tr><td class="mono">${esc(p.name)}</td><td>${p.shape.join('×')}</td><td>${num(p.count)}</td></tr>`).join('');

function memorySection(b) {
  const run = memoryRun();
  let html = '<h3>Как долго помнит этот слой</h3>';
  if (!run) return html + '<p class="hint">На этой архитектуре ещё нет обученных моделей.</p>';
  const m = loadMemory(run.name);
  if (!m) return html + '<p class="hint">Загружаю веса модели.</p>';
  if (m.error) return html + `<p class="hint">${esc(m.error)}</p>`;
  return html + memoryView(m, b.index, current.kind === 'arch');
}

function blockCard(b) {
  const { arch, schema } = current, total = arch.instance.total_params, color = GROUP_COLORS[b.group];
  let html = `<a class="back" data-block="">${icon('back', 16)}Вся модель</a>`;
  html += `<p class="kind"><a data-group="${b.group}" style="color:${color}">${esc(groupTitle(schema, b.group))}</a></p><h2>${esc(b.title)}</h2>`;
  html += `<p class="lead">${esc(b.purpose)}</p>`;
  const io = ts => ts.map(t => `<span class="chip" style="--c:${color}">${t.label ? esc(t.label) + ', ' : ''}${esc(sizeText(t.shape))}</span>`).join('');
  html += '<div class="flow">';
  if (b.inputs.length) html += `<div><span class="hint">Получает</span>${io(b.inputs)}</div>${icon('to', 20)}`;
  html += `<div><span class="hint">Отдаёт</span>${io(b.outputs)}</div></div>`;
  if (b.labels && b.example?.kind !== 'probs') html += `<h3>${b.group === 'input' ? 'Слои' : 'Варианты'}</h3>${chips(b.labels, color)}`;
  if (b.how.length) html += `<h3>Как это работает</h3>${b.how.map(p => `<p>${esc(p)}</p>`).join('')}`;
  if (b.example) html += `<h3>Пример</h3>${exampleView(b, color)}`;
  if (b.state) html += `<h3>Что хранит память</h3>${chips(b.state.slots.map(s => s.title), color)}`;
  if (b.memory) html += memorySection(b);
  if (b.parts.length) html += `<h3>Внутри</h3><div class="parts">${b.parts.map(p =>
    `<div><b>${esc(p.title)}</b><p>${esc(p.purpose)}</p></div>`).join('')}</div>`;
  if (b.param_count) html += `<h3>Весов</h3><div class="big">${num(b.param_count)}</div>
    <div class="hint">${pct(b.param_count, total)} всей модели</div>${share(b.param_count, total, color)}`;
  html += `<details><summary>Для разработчика</summary><p>${esc(b.desc)}</p>`;
  const tensors = (title, ts) => ts.length ? `<h4>${title}</h4><table>${ts.map(t =>
    `<tr><td class="mono">${esc(t.name)}</td><td>${shapeText(t.shape)}, ${esc(t.dtype)}</td></tr>`).join('')}</table>` : '';
  html += tensors('Вход', b.inputs) + tensors('Выход', b.outputs);
  if (b.params.length) html += `<h4>Параметры</h4><table>${paramRows(b.params)}</table>`;
  for (const p of b.parts) html += `<h4>${esc(p.title)}, ${num(p.count)}</h4><p>${esc(p.desc)}</p><table>${paramRows(p.params)}</table>`;
  if (b.state) html += `<h4>Состояние слоя, ${b.state.shape.join('×')} на робота</h4><table>${b.state.slots.map(s =>
    `<tr><td class="mono">${esc(s.name)}</td><td>${esc(s.desc)}</td></tr>`).join('')}</table>`;
  const keys = Object.entries(b.config);
  if (keys.length) html += `<h4>Из конфига</h4><table>${keys.map(([k, v]) =>
    `<tr><td class="mono">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;
  return html + '</details>';
}

// ---------------------------------------------------------------- кнопки и клавиши

function setOn(sel, v) { $(sel).classList.toggle('on', v); }

$('#btn-overview').innerHTML = `${icon('fit')}Обзор`;
$('#btn-labels').innerHTML = `${icon('label')}Подписи`;
$('#btn-proj').innerHTML = `${icon('cube')}Ортография`;
function syncAnim() {
  const on = scene.isAnimating();
  $('#btn-anim').innerHTML = `${icon(on ? 'pause' : 'play')}Анимация`;
  setOn('#btn-anim', on);
}
syncAnim();

$('#btn-anim').addEventListener('click', () => { scene.setAnimate(!scene.isAnimating()); syncAnim(); });
$('#btn-labels').addEventListener('click', () => {
  const on = !$('#btn-labels').classList.contains('on');
  setOn('#btn-labels', on); scene.setLabels(on);
});
$('#btn-proj').addEventListener('click', () => scene.setProjection(!scene.isOrtho()));
$('#btn-overview').addEventListener('click', () => { selectBlock(null); scene.overview(); });

addEventListener('keydown', ev => {
  if (ev.target.tagName === 'INPUT' || ev.altKey || ev.metaKey) return;
  const sign = ev.ctrlKey ? -1 : 1;
  const views = { Numpad1: 'Z', Numpad3: 'X', Numpad7: 'Y' };
  if (views[ev.code]) { scene.snapAxis(views[ev.code], sign); ev.preventDefault(); return; }
  if (ev.ctrlKey) return;
  if (ev.code === 'Numpad5') scene.setProjection(!scene.isOrtho());
  else if (ev.code === 'KeyL') $('#btn-labels').click();
  else if (ev.code === 'KeyP') $('#btn-anim').click();
  else if (ev.code === 'Home' || ev.code === 'Escape') $('#btn-overview').click();
});

async function load() {
  await connect();
  cat = await fetchCatalog();
  const [kind, id] = decodeURIComponent(location.hash.slice(1)).split('=');
  const ok = kind === 'arch' ? archOf(id) : kind === 'run' ? runOf(id) : null;
  if (ok) open(kind, id); else open('arch', cat.archs[0].id);
  $('#hint').textContent = HINT;
  $('#status').textContent = '';
}
load().catch(e => { $('#status').textContent = 'Ошибка загрузки: ' + e.message; });
