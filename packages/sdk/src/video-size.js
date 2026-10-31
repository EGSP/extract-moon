// Размер кадра видео. Варианты от окна не зависят, по умолчанию 1920 × 1080.

const SIZES = [
  [1920, 1080], [2560, 1440], [3840, 2160], [1600, 900], [1280, 720], [1200, 900], [1200, 676], [1080, 1080], [1080, 1920],
];
const clamp = (v, max) => Math.min(Math.max(Math.round(v) || 64, 64), max);

/** Строит список в el. onChange вызывается при смене размера, size() даёт [ширина, высота]. */
export function mountVideoSize(el, onChange = () => {}) {
  el.classList.add("video-size");
  el.innerHTML = `<label class="field">Размер видео
      <select class="video-size-list">
        ${SIZES.map(([w, h]) => `<option value="${w}x${h}">${w} × ${h}</option>`).join("")}
        <option value="custom">Свой размер</option>
      </select>
    </label>
    <span class="video-size-custom" hidden>
      <input type="number" min="64" max="3840" step="2" value="1200" aria-label="Ширина видео" />
      <span>×</span>
      <input type="number" min="64" max="2160" step="2" value="800" aria-label="Высота видео" />
    </span>`;
  const list = el.querySelector("select");
  const custom = el.querySelector(".video-size-custom");
  const [width, height] = custom.querySelectorAll("input");
  list.onchange = () => {
    custom.hidden = list.value !== "custom";
    onChange();
  };
  width.oninput = height.oninput = onChange;
  return {
    size: () => (list.value === "custom"
      ? [clamp(Number(width.value), 3840), clamp(Number(height.value), 2160)]
      : list.value.split("x").map(Number)),
  };
}

/** Рамка на сцене показывает кадр видео, если он уже окна; более широкий кадр захватит сцену по бокам. */
export function placeFrameGuide(guide, box, [w, h]) {
  const width = box.height * (w / h);
  guide.hidden = width >= box.width - 1;
  guide.style.width = `${width}px`;
}
