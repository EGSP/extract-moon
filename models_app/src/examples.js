// Примеры данных в карточках блоков: как выглядят входы, выходы и промежуточные шаги на конкретных числах.
import { icon } from './icons.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const dec = (v, digits = 2) => (Math.round(v * 10 ** digits) / 10 ** digits).toString().replace('.', ',');
const CHANNEL_COLORS = ['#6f6f6f', '#b28600', '#0f62fe', '#198038', '#6fdc8c', '#da1e28', '#ff8389'];
const KIND_COLORS = { body: '#009d9a', world: '#0f62fe', meta: '#8a3ffc', past: '#b28600', message: '#ee538b' };

const note = ex => ex.note ? `<p class="hint">${esc(ex.note)}</p>` : '';

// Окно обзора: по маленькой карте на каждый слой; клетки в тумане заштрихованы.
function gridView(b, ex) {
  const [C, K] = [b.outputs[0].shape[0], b.outputs[0].shape[1]], [rx, ry] = ex.robot, cell = 9;
  const val = Array.from({ length: C }, () => Array.from({ length: K }, () => new Array(K).fill(0)));
  for (let y = 0; y < K; y++) for (let x = ex.edge_x; x < K; x++) val[0][y][x] = 1;
  for (const [c, x, y, v] of ex.cells) val[c][y][x] = v;
  const fogged = (x, y) => Math.max(Math.abs(x - rx), Math.abs(y - ry)) > ex.sight;
  const maps = val.map((layer, c) => {
    let rects = '';
    for (let y = 0; y < K; y++) for (let x = 0; x < K; x++) {
      const v = fogged(x, y) ? 0 : layer[y][x];
      const fill = fogged(x, y) ? 'url(#fog)' : v ? CHANNEL_COLORS[c] : '#f4f4f4';
      rects += `<rect x="${x * cell}" y="${y * cell}" width="${cell - 1}" height="${cell - 1}" fill="${fill}"${v ? ` fill-opacity="${0.25 + 0.75 * v}"` : ''}><title>${dec(v)}</title></rect>`;
    }
    rects += `<rect x="${rx * cell - 0.5}" y="${ry * cell - 0.5}" width="${cell}" height="${cell}" fill="none" stroke="#161616" stroke-width="1.5"/>`;
    return `<figure><svg width="${K * cell}" height="${K * cell}">${rects}</svg><figcaption>${esc(b.labels?.[c] ?? c)}</figcaption></figure>`;
  }).join('');
  const defs = `<svg width="0" height="0" style="position:absolute"><defs><pattern id="fog" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="#f4f4f4"/><line x1="0" y1="0" x2="0" y2="4" stroke="#c6c6c6" stroke-width="1.5"/></pattern></defs></svg>`;
  return `${defs}<div class="maps">${maps}</div><p class="hint">Рамка в центре это сам робот, штриховка это туман. Чем темнее клетка, тем больше число.</p>${note(ex)}`;
}

// Вектор о роботе: полоса из всех чисел по частям, ниже каждая часть со смыслом и примером значений.
function segmentsView(ex) {
  const total = ex.segments.reduce((a, s) => a + s.size, 0);
  const strip = ex.segments.map(s =>
    `<div style="flex:${s.size};background:${KIND_COLORS[s.kind]}" title="${esc(s.title)}, ${s.size}"></div>`).join('');
  const kinds = Object.entries(ex.kinds).map(([k, t]) => `<span><i style="background:${KIND_COLORS[k]}"></i>${esc(t)}</span>`).join('');
  const rows = ex.segments.map(s => {
    const vals = s.onehot !== undefined ? Array.from({ length: s.size }, (_, i) => i === s.onehot ? 1 : 0)
      : [...(s.values ?? []), ...new Array(Math.max(0, s.size - (s.values?.length ?? 0))).fill(0)];
    const shown = vals.slice(0, 15);
    const cells = shown.map(v => `<i style="background:${KIND_COLORS[s.kind]};opacity:${0.12 + 0.88 * Math.min(1, Math.abs(v))}" title="${dec(v)}"></i>`).join('');
    const nums = s.size <= 6 && s.onehot === undefined ? `<span class="nums">${vals.map(v => dec(v)).join('; ')}</span>` : '';
    const more = s.size > shown.length ? `<span class="hint">и ещё ${s.size - shown.length}</span>` : '';
    return `<div class="seg"><div class="st"><i style="background:${KIND_COLORS[s.kind]}"></i><b>${esc(s.title)}</b><span>${s.size}</span></div>
      <p>${esc(s.desc)}</p><div class="cells">${cells}${more}</div>${nums}</div>`;
  }).join('');
  return `<div class="strip">${strip}</div><div class="kinds">${kinds}</div><p class="hint">Всего ${total} чисел.</p>${rows}${note(ex)}`;
}

// Слияние: две половины встают в один ряд, затем сжимаются вдвое.
function mergeView(b, color) {
  const d = b.outputs[0].shape[0];
  const bar = (label, w, c) => `<div class="mbar" style="width:${w}%;--c:${c}">${esc(label)}</div>`;
  return `<div class="merge">
    <div class="mrow">${bar(`окружение, ${d}`, 48, '#0f62fe')}${bar(`робот, ${d}`, 48, '#009d9a')}</div>
    <div class="mstep">${icon('to', 16)}встают в один ряд</div>
    <div class="mrow">${bar(`${2 * d} чисел подряд`, 100, '#6f6f6f')}</div>
    <div class="mstep">${icon('to', 16)}каждое выходное число это взвешенная сумма всех ${2 * d}</div>
    <div class="mrow">${bar(`описание ситуации, ${d}`, 50, color)}</div></div>`;
}

function normView(ex, color) {
  const row = vs => `<div class="chips">${vs.map(v => `<span class="chip" style="--c:${color}">${dec(v)}</span>`).join('')}</div>`;
  return `<div class="flow"><div><span class="hint">До</span>${row(ex.before)}</div>${icon('to', 20)}<div><span class="hint">После</span>${row(ex.after)}</div></div>${note(ex)}`;
}

// Вероятности вариантов: полоса на каждый вариант, недоступные отмечены.
function probsView(b, ex, color) {
  const masked = new Set(ex.masked ?? []), max = Math.max(...ex.values);
  const rows = ex.values.map((v, i) => {
    const label = b.labels?.[i] ?? String(i);
    return `<div class="prob${masked.has(i) ? ' off' : ''}"><span>${esc(label)}</span>
      <div class="pbar"><div style="width:${100 * v / max}%;background:${color}"></div></div>
      <b>${masked.has(i) ? 'нельзя' : Math.round(v * 100) + ' %'}</b></div>`;
  }).join('');
  return `<div class="probs">${rows}</div>${note(ex)}`;
}

export function exampleView(b, color) {
  const ex = b.example;
  if (ex.kind === 'grid') return gridView(b, ex);
  if (ex.kind === 'segments') return segmentsView(ex);
  if (ex.kind === 'merge') return mergeView(b, color);
  if (ex.kind === 'norm') return normView(ex, color);
  if (ex.kind === 'probs') return probsView(b, ex, color);
  return '';
}

// ---------------------------------------------------------------- память RWKV

const BINS = [[0, 2, 'до 2'], [2, 4, '2-4'], [4, 8, '4-8'], [8, 16, '8-16'], [16, 32, '16-32'],
  [32, 64, '32-64'], [64, 128, '64-128'], [128, 256, '128-256'], [256, Infinity, '256+']];
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// Гистограмма полупериодов каналов слоя: сколько каналов помнят на каждом масштабе.
export function memoryView(m, layer, fromLatest) {
  const L = m.layers[layer];
  if (!L) return '<p class="hint">В весах модели нет такого слоя.</p>';
  const counts = BINS.map(([lo, hi]) => L.half_life.filter(h => h >= lo && h < hi).length);
  const top = Math.max(...counts);
  const bars = counts.map((n, i) => `<div class="hb"><b>${n || ''}</b><div style="height:${Math.round(70 * n / top)}px"></div><span>${BINS[i][2]}</span></div>`).join('');
  const med = median(L.half_life), keep = Math.pow(0.5, 1 / med);
  const layers = m.layers.map((l, i) => `<span class="chip${i === layer ? ' on' : ''}" style="--c:#8a3ffc">слой ${i + 1}: ${dec(median(l.half_life), 0)}</span>`).join('');
  return `<p>Каналы слоя по полупериоду памяти, в тактах. Половина каналов слоя помнит не дольше ${dec(med, 0)} тактов: за такт такой канал сохраняет ${dec(keep * 100, 0)} % накопленного.</p>
    <div class="hist">${bars}</div>
    <p class="hint">Медианный полупериод по слоям</p><div class="chips">${layers}</div>
    <p class="hint">По весам модели ${esc(m.run)}, обновление ${m.update}${fromLatest ? ', последней обученной на этой архитектуре' : ''}.</p>`;
}
