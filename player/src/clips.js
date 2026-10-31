// Полоса действий над шкалой матча. Края клипа растягивают действие, сам клип двигает его целиком.
// Пересекающиеся действия лежат на разных дорожках; работает то, что началось последним.

const ROW = 21;
const MIN_LENGTH = 1; // тактов
const CLICK = 3; // пикселей: меньший сдвиг считается щелчком

const snap = (v) => Math.round(v * 10) / 10; // шаг 0,1 такта

/** Конец клипа на экране: у вида он тянется до следующего действия, у идущей записи — до конца матча. */
function shownEnd(c, list, span) {
  if (c.end !== null) return c.end;
  if (c.type !== "pin") return span;
  return list.find((o) => o.start > c.start)?.start ?? span;
}

function lanes(list, span) {
  const ends = [];
  return list.map((c) => {
    const to = shownEnd(c, list, span);
    let lane = ends.findIndex((e) => e <= c.start);
    if (lane < 0) lane = ends.length;
    ends[lane] = to;
    return { c, to, lane };
  });
}

export class ClipTrack {
  /** marks(c) — такты внутри клипа, где меняется план; onDrag — на каждом сдвиге, onDrop — в конце, onPick — по щелчку. */
  constructor(host, { commands, span, title, marks, onDrag, onDrop, onPick }) {
    Object.assign(this, { host, commands, span, title, marks, onDrag, onDrop, onPick });
    host.addEventListener("pointerdown", (e) => this.grab(e));
  }

  sorted() {
    return [...this.commands.list].sort((a, b) => a.start - b.start);
  }

  render() {
    const span = this.span();
    const rows = lanes(this.sorted(), span);
    const count = Math.max(...rows.map((r) => r.lane + 1), 0);
    this.host.hidden = !count;
    this.host.style.height = `${count * ROW}px`;
    this.host.innerHTML = '<div id="clips-head"></div>' + rows.map(({ c, to, lane }) => {
      const open = c.end === null && c.type !== "pin";
      const inner = this.marks(c).map((t) => `<b style="left:${((t - c.start) / (to - c.start)) * 100}%"></b>`).join("");
      return `<div class="clip ${c.type} ${c.enabled ? "" : "off"} ${open ? "open" : ""}" data-id="${c.id}" title="${this.title(c)}"
        style="left:${(c.start / span) * 100}%;width:${((to - c.start) / span) * 100}%;top:${lane * ROW}px">
        ${inner}<i class="from"></i><span>${this.title(c)}</span>${c.end === null ? "" : '<i class="to"></i>'}</div>`;
    }).join("");
    this.head = this.host.firstChild;
  }

  /** Метка текущего такта на полосе. */
  seek(tick) {
    if (this.head) this.head.style.left = `${(tick / this.span()) * 100}%`;
  }

  /** Новые границы клипа: края не заходят друг за друга, клип не выходит за матч. */
  bounds(edge, start, end, delta, span) {
    if (edge === "from") return [Math.max(Math.min(snap(start + delta), (end ?? span) - MIN_LENGTH), 0), end];
    if (edge === "to") return [start, Math.min(Math.max(snap(end + delta), start + MIN_LENGTH), span)];
    const length = (end ?? start) - start;
    const from = Math.max(Math.min(snap(start + delta), span - length), 0);
    return [from, end === null ? null : from + length];
  }

  grab(down) {
    const el = down.target.closest(".clip");
    if (!el || down.button !== 0) return;
    down.preventDefault();
    const id = Number(el.dataset.id);
    const c = this.commands.list.find((o) => o.id === id);
    const span = this.span();
    const classes = down.target.classList;
    const edge = classes.contains("from") ? "from" : classes.contains("to") ? "to" : "body";
    const { start, end } = c;
    const perTick = span / this.host.clientWidth;
    let moved = false;
    const move = (e) => {
      if (Math.abs(e.clientX - down.clientX) >= CLICK) moved = true;
      if (!moved) return;
      const [from, to] = this.bounds(edge, start, end, (e.clientX - down.clientX) * perTick, span);
      this.commands.resize(id, from, to);
      el.style.left = `${(from / span) * 100}%`;
      el.style.width = `${((shownEnd(c, this.sorted(), span) - from) / span) * 100}%`;
      this.onDrag();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) this.onDrop();
      else this.onPick(c);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
}
