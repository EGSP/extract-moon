// Подтверждение рендера: какие части матча войдут в ролик.
// Части команд входят целиком, промежутки между ними можно вырезать.
// Без команд с длительностью выбирается один диапазон тактов.

const $ = (id) => document.getElementById(id);
const MIN_PART = 1e-3;

/** Режет матч на части: команды (пересекающиеся сливаются) и промежутки между ними. */
export function splitTimeline(commands, span, titleOf) {
  const parts = [];
  const timed = commands
    .map((c) => ({ from: c.start, to: Math.min(c.end ?? (c.type === "pin" ? c.start : span), span), titles: [titleOf(c)] }))
    .filter((c) => c.to - c.from > MIN_PART)
    .sort((a, b) => a.from - b.from);
  for (const c of timed) {
    const last = parts[parts.length - 1];
    if (last && c.from <= last.to) {
      last.to = Math.max(last.to, c.to);
      last.titles.push(...c.titles);
    } else {
      parts.push({ ...c, kind: "command", keep: true });
    }
  }
  const gaps = [];
  let cursor = 0;
  for (const p of parts) {
    if (p.from - cursor > MIN_PART) gaps.push({ from: cursor, to: p.from, kind: "gap", titles: ["Промежуток"], keep: true });
    cursor = p.to;
  }
  if (span - cursor > MIN_PART) gaps.push({ from: cursor, to: span, kind: "gap", titles: ["Промежуток"], keep: true });
  return [...parts, ...gaps].sort((a, b) => a.from - b.from);
}

/** Соседние оставленные части склеиваются: на их границе нет монтажного скачка. */
function keptRanges(parts) {
  const out = [];
  for (const p of parts) {
    if (!p.keep) continue;
    const last = out[out.length - 1];
    if (last && p.from - last[1] <= MIN_PART) last[1] = p.to;
    else out.push([p.from, p.to]);
  }
  return out;
}

export const rangesLength = (ranges) => ranges.reduce((sum, [a, b]) => sum + b - a, 0);

/** Такт по доле ролика, выраженной в тактах: диапазоны идут встык. */
export function tickInRanges(ranges, elapsed) {
  let left = elapsed;
  for (const [from, to] of ranges) {
    if (left < to - from) return from + left;
    left -= to - from;
  }
  return ranges[ranges.length - 1][1];
}

function drawBar(items, span) {
  $("tl-bar").innerHTML = items.map((p, i) => {
    const left = (p.from / span) * 100;
    const width = ((p.to - p.from) / span) * 100;
    const state = p.keep ? "keep" : "cut";
    return `<button class="tl-part ${p.kind} ${state}" data-part="${i}" style="left:${left}%;width:${width}%"
      title="${p.titles.join(", ")}: такты ${p.from.toFixed(1)}–${p.to.toFixed(1)}" ${p.kind === "gap" ? "" : "disabled"}></button>`;
  }).join("");
}

function drawRows(parts, speed) {
  const rows = parts.map((p, i) => `<tr class="${p.keep ? "" : "off"}">
    <td><input type="checkbox" data-part="${i}" ${p.keep ? "checked" : ""} ${p.kind === "gap" ? "" : "disabled"} aria-label="Включить часть" /></td>
    <td>${p.titles.join(", ")}</td>
    <td class="num">${p.from.toFixed(1)}–${p.to.toFixed(1)}</td>
    <td class="num">${((p.to - p.from) / speed).toFixed(1)} с</td></tr>`);
  $("tl-rows").innerHTML = `<table><thead><tr><th></th><th>Часть</th><th>такты</th><th>в ролике</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

/** Обещание: диапазоны тактов или null, если рендер отменён. */
export function chooseRanges({ parts, span, speed, sizeText }) {
  const hasCommands = parts.some((p) => p.kind === "command");
  const range = { from: 0, to: span, kind: "gap", keep: true, titles: ["Выбранный диапазон"] };
  const ranges = () => (hasCommands ? keptRanges(parts) : [[range.from, range.to]]);

  const redraw = () => {
    drawBar(hasCommands ? parts : [range], span);
    if (hasCommands) drawRows(parts, speed);
    const chosen = ranges();
    const length = rangesLength(chosen);
    const cuts = chosen.length > 1 ? `, склеек ${chosen.length - 1}` : "";
    $("tl-summary").textContent = `В ролик войдёт ${length.toFixed(1)} из ${span.toFixed(1)} тактов, ${(length / speed).toFixed(1)} с${cuts}`;
    $("tl-confirm").disabled = length <= MIN_PART;
  };

  $("tl-size").textContent = sizeText;
  $("tl-rows").hidden = !hasCommands;
  $("tl-cut-gaps").hidden = !hasCommands || !parts.some((p) => p.kind === "gap");
  $("tl-range").hidden = hasCommands;
  for (const id of ["tl-from", "tl-to", "tl-from-num", "tl-to-num"]) {
    $(id).max = span;
  }
  const setRange = (from, to) => {
    range.from = Math.min(Math.max(from, 0), span);
    range.to = Math.min(Math.max(to, range.from), span);
    $("tl-from").value = $("tl-from-num").value = range.from;
    $("tl-to").value = $("tl-to-num").value = range.to;
    redraw();
  };
  $("tl-from").oninput = $("tl-from-num").oninput = (e) => setRange(Math.min(Number(e.target.value), range.to), range.to);
  $("tl-to").oninput = $("tl-to-num").oninput = (e) => setRange(range.from, Math.max(Number(e.target.value), range.from));
  setRange(0, span);

  const toggle = (e) => {
    const el = e.target.closest("[data-part]");
    if (!el || el.disabled || !hasCommands) return;
    const p = parts[Number(el.dataset.part)];
    p.keep = !p.keep;
    redraw();
  };
  $("tl-bar").onclick = toggle;
  $("tl-rows").onclick = toggle;
  $("tl-cut-gaps").onclick = () => {
    const anyKept = parts.some((p) => p.kind === "gap" && p.keep);
    for (const p of parts) if (p.kind === "gap") p.keep = !anyKept;
    redraw();
  };

  const dialog = $("timeline-dialog");
  dialog.hidden = false;
  return new Promise((resolve) => {
    const close = (value) => {
      dialog.hidden = true;
      window.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(null);
    };
    window.addEventListener("keydown", onKey);
    $("tl-confirm").onclick = () => close(ranges());
    $("tl-cancel").onclick = () => close(null);
  });
}
