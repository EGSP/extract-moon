// Справочник моделей и карточки: весь каталог загружается одним запросом, сцена показывает выбранную модель.
import { createScene, GROUP_COLORS, shapeText } from './scene.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const num = n => n.toLocaleString('ru-RU');
const short = n => n >= 1e6 ? (n / 1e6).toFixed(2).replace('.', ',') + ' M' : n >= 1e3 ? Math.round(n / 1e3) + ' k' : String(n);
const COMPONENT_NAMES = {
  tensor: 'тензор входа', conv: 'свёртка', dense: 'полносвязный слой', merge: 'слияние',
  rwkv_layer: 'слой RWKV', norm: 'нормировка', head: 'голова',
};

let cat = null, current = null, selectedBlock = null;
const scene = createScene($('#stage'), {
  onHover: id => { $('#status').textContent = id ? blockById(id)?.title ?? '' : hint(); },
  onSelect: id => selectBlock(id),
});
const hint = () => 'Клик выбирает блок, перетаскивание поворачивает, колесо меняет масштаб';

function blockById(id) { return current?.instance.blocks.find(b => b.id === id); }
function schemaOf(id) { return cat.schemas.find(s => s.id === id); }

// ---------------------------------------------------------------- справочник

function runTree() {
  // Дочерние запуски — под родителем, остальные по дате начала.
  const byName = new Map(cat.runs.map(r => [r.name, r])), kids = new Map(), roots = [];
  for (const r of cat.runs) {
    const p = r.parent?.run;
    if (p && byName.has(p)) (kids.get(p) ?? kids.set(p, []).get(p)).push(r); else roots.push(r);
  }
  const order = (a, b) => (a.started || '').localeCompare(b.started || '') || a.name.localeCompare(b.name);
  const out = [];
  const walk = (r, depth) => { out.push([r, depth]); (kids.get(r.name) ?? []).sort(order).forEach(k => walk(k, depth + 1)); };
  roots.sort(order).forEach(r => walk(r, 0));
  return out;
}

function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const match = (...xs) => !q || xs.some(x => String(x ?? '').toLowerCase().includes(q));
  let html = '<div class="section">Схемы архитектур</div>';
  for (const s of cat.schemas) {
    if (!match(s.id, s.title, s.description)) continue;
    const warn = s.status.stale ? '<span class="badge warn">model.py изменился</span>' : '';
    html += `<div class="item${isCurrent('schema', s.id) ? ' sel' : ''}" data-kind="schema" data-id="${esc(s.id)}">
      <div class="name">${esc(s.title)}</div>
      <div class="meta"><span class="badge">${esc(s.id)}</span>${warn}</div>
      <div class="meta">по умолчанию ${short(s.instance.total_params)} параметров</div></div>`;
  }
  html += '<div class="section">Запуски</div>';
  for (const [r, depth] of runTree()) {
    if (!match(r.name, r.note, r.schema)) continue;
    const m = r.model ?? {};
    const meta = r.error ? `<span class="err">${esc(r.error)}</span>`
      : `${m.n_layers} сл. × ${m.d_model} · ${short(r.instance.total_params)}`;
    const from = r.parent ? ` · от ${esc(r.parent.run)}:${r.parent.update}` : '';
    html += `<div class="item${depth ? ' child' : ''}${isCurrent('run', r.name) ? ' sel' : ''}" style="padding-left:${14 + depth * 14}px"
      data-kind="run" data-id="${esc(r.name)}" title="${esc(r.note)}">
      <div class="name">${esc(r.name)}</div>
      <div class="meta">${r.rules ? `<span class="badge">r${esc(r.rules)}</span>` : ''}${meta}${from}</div></div>`;
  }
  $('#list').innerHTML = html;
}

const isCurrent = (kind, id) => current?.kind === kind && current.id === id;

$('#list').addEventListener('click', ev => {
  const el = ev.target.closest('.item');
  if (el) open(el.dataset.kind, el.dataset.id);
});
$('#search').addEventListener('input', renderList);

// ---------------------------------------------------------------- выбор модели

function open(kind, id) {
  const src = kind === 'schema' ? schemaOf(id) : cat.runs.find(r => r.name === id);
  if (!src) return;
  if (!src.instance) {
    $('#status').textContent = src.error;
    return;
  }
  current = { kind, id, src, instance: src.instance, schema: schemaOf(kind === 'schema' ? id : src.schema) };
  history.replaceState(null, '', `#${kind}=${encodeURIComponent(id)}`);
  selectedBlock = null;
  scene.show(current.instance);
  renderList();
  renderHeader();
  renderCard();
}

function renderHeader() {
  const { kind, src, instance, schema } = current;
  const sub = kind === 'schema'
    ? `схема ${esc(schema.id)} с параметрами по умолчанию`
    : `запуск · схема ${esc(src.schema)}${src.rules ? ` · правила r${esc(src.rules)}` : ''}`;
  $('#title').innerHTML = `<div class="main">${esc(kind === 'schema' ? schema.title : src.name)}
    <span class="sub">· ${num(instance.total_params)} параметров</span></div><div class="sub">${sub}</div>`;
  const warns = [];
  if (schema.status.stale) {
    const list = schema.status.commits.length ? ' в коммитах ' + schema.status.commits.map(esc).join('; ') : '';
    warns.push(`Схема написана по коммиту ${esc(schema.model_commit.slice(0, 7))}, после него model.py менялся${list}.${schema.status.dirty ? ' Есть незакоммиченные правки.' : ''} Схему нужно сверить с кодом.`);
  }
  if (kind === 'run' && src.model_differs)
    warns.push('Запуск обучен на другой версии model.py, чем та, по которой написана схема. Схема может не совпадать с моделью.');
  $('#warning').hidden = !warns.length;
  $('#warning').innerHTML = warns.join('<br>');
  $('#legend').innerHTML = Object.entries(schema.groups).map(([g, name]) =>
    `<span><i style="background:${GROUP_COLORS[g] ?? '#8d8d8d'}"></i>${esc(name)} · ${short(instance.group_params[g] ?? 0)}</span>`).join('');
}

// ---------------------------------------------------------------- карточка

function selectBlock(id) {
  selectedBlock = id;
  scene.select(id);
  renderCard();
}

function paramRows(params) {
  return params.map(p => `<tr><td class="mono">${esc(p.name)}</td><td>${p.shape.join('×')}</td><td>${num(p.count)}</td></tr>`).join('');
}

function renderCard() {
  const el = $('#card');
  if (!current) { el.innerHTML = '<p class="hint">Выберите схему или запуск в справочнике.</p>'; return; }
  const b = selectedBlock && blockById(selectedBlock);
  el.innerHTML = b ? blockCard(b) : modelCard();
  el.querySelectorAll('[data-block]').forEach(a => a.addEventListener('click', () => selectBlock(a.dataset.block)));
}

function modelCard() {
  const { kind, src, instance, schema } = current, total = instance.total_params;
  let html = `<h2>${esc(kind === 'schema' ? schema.title : src.name)}</h2>`;
  if (kind === 'run' && src.note) html += `<p>${esc(src.note)}</p>`;
  html += `<p>${esc(schema.description)}</p><p class="hint">B в формах тензоров означает ${esc(schema.batch)}</p>`;
  html += `<h3>Параметры</h3><div class="big">${num(total)}</div><table>`;
  for (const [g, name] of Object.entries(schema.groups)) {
    const n = instance.group_params[g] ?? 0;
    html += `<tr><td>${esc(name)}<div class="bar"><div style="width:${100 * n / total}%;background:${GROUP_COLORS[g]}"></div></div></td><td>${num(n)}</td></tr>`;
  }
  html += '</table><h3>Блоки</h3><table>';
  for (const b of instance.blocks)
    html += `<tr><td><a href="javascript:void 0" data-block="${esc(b.id)}" style="color:${GROUP_COLORS[b.group]}">${esc(b.title)}</a></td><td>${b.param_count ? short(b.param_count) : '—'}</td></tr>`;
  html += '</table><h3>Размеры схемы</h3><table>';
  for (const v of schema.vars)
    html += `<tr><td><code>${esc(v.name)}</code> ${esc(v.desc)}</td><td>${num(instance.vars[v.name])}</td></tr>`;
  html += '</table>';
  if (kind === 'run') {
    html += '<h3>Происхождение</h3><table>';
    html += `<tr><td>родитель</td><td>${src.parent ? esc(`${src.parent.run}:${src.parent.update}`) : '—'}</td></tr>`;
    html += `<tr><td>коммит</td><td>${esc(src.commit.slice(0, 7))}${src.dirty ? ' + правки' : ''}</td></tr>`;
    html += `<tr><td>начат</td><td>${esc(src.started.replace('T', ' ').slice(0, 16))}</td></tr></table>`;
  }
  return html + '<p class="hint" style="margin-top:14px">Клик по блоку в сцене открывает его описание.</p>';
}

function blockCard(b) {
  const total = current.instance.total_params, group = current.schema.groups[b.group] ?? b.group;
  let html = `<p class="kind"><a href="javascript:void 0" data-block="">← модель</a> · ${esc(group)} · ${esc(COMPONENT_NAMES[b.component] ?? b.component)}</p>`;
  html += `<h2 style="color:${GROUP_COLORS[b.group]}">${esc(b.title)}</h2><p>${esc(b.desc)}</p>`;
  const io = (title, ts) => ts.length ? `<h3>${title}</h3><table>${ts.map(t =>
    `<tr><td class="mono">${esc(t.name)}</td><td>${shapeText(t.shape)} · ${esc(t.dtype)}</td></tr>`).join('')}</table>` : '';
  html += io('Вход', b.inputs) + io('Выход', b.outputs);
  if (b.labels) html += `<h3>${b.group === 'input' ? 'Каналы' : 'Выходы'}</h3><p>${b.labels.map(esc).join(' · ')}</p>`;
  if (b.param_count) {
    html += `<h3>Параметры</h3><div class="big">${num(b.param_count)}</div>
      <div class="hint">${(100 * b.param_count / total).toFixed(1).replace('.', ',')} % модели</div>
      <div class="bar"><div style="width:${100 * b.param_count / total}%;background:${GROUP_COLORS[b.group]}"></div></div>`;
    if (b.params.length) html += `<table style="margin-top:8px">${paramRows(b.params)}</table>`;
  }
  for (const p of b.parts)
    html += `<h3>${esc(p.title)} · ${short(p.count)}</h3><p>${esc(p.desc)}</p><table>${paramRows(p.params)}</table>`;
  if (b.state) {
    html += `<h3>Состояние слоя · ${b.state.shape.join('×')} на робота</h3><div class="slots">`;
    html += b.state.slots.map(s => `<div><code>${esc(s.name)}</code><span>${esc(s.desc)}</span></div>`).join('') + '</div>';
  }
  const keys = Object.entries(b.config);
  if (keys.length) html += `<h3>Из конфига</h3><table>${keys.map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;
  return html;
}

// ---------------------------------------------------------------- кнопки и запуск

function toggle(btn, fn) {
  btn.addEventListener('click', () => { btn.classList.toggle('on'); fn(btn.classList.contains('on')); });
}
toggle($('#btn-flow'), v => scene.setFlow(v));
toggle($('#btn-labels'), v => scene.setLabels(v));
$('#btn-overview').addEventListener('click', () => { selectBlock(null); scene.overview(); });
addEventListener('keydown', ev => {
  if (ev.target.tagName === 'INPUT') return;
  if (ev.key === 'f' || ev.key === 'а') $('#btn-flow').click();
  else if (ev.key === 'l' || ev.key === 'д') $('#btn-labels').click();
  else if (ev.key === 'Home' || ev.key === 'Escape') $('#btn-overview').click();
});

async function load() {
  const res = await fetch('/api/catalog');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  cat = data;
  renderList();
  const [kind, id] = decodeURIComponent(location.hash.slice(1)).split('=');
  const last = runTree().at(-1)?.[0];
  if (kind && id && (kind === 'schema' ? schemaOf(id) : cat.runs.some(r => r.name === id))) open(kind, id);
  else if (last?.instance) open('run', last.name);
  else open('schema', cat.default_schema);
  $('#status').textContent = hint();
}
load().catch(e => { $('#status').textContent = 'Ошибка загрузки: ' + e.message; });
