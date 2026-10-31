// Загрузка реплея через бэкенд и то, что вычисляется по кадрам заранее.
import { invoke } from "@tauri-apps/api/core";

export const stages = () => invoke("stages");
export const openFolder = (name) => invoke("open_folder", { name });
export const renderJob = () => invoke("render_job");
export const finishJob = () => invoke("finish_job");

export function saveOutput(replay, kind, file, bytes) {
  return invoke("save_output", bytes, { headers: { "x-replay": replay, "x-kind": kind, "x-file": file } });
}

export async function loadStage(name) {
  const bytes = await invoke("load_stage", { name });
  const lines = new TextDecoder().decode(bytes).split("\n").filter((l) => l.trim());
  const header = JSON.parse(lines[0]);
  if (header.format !== "extract_moon_replay") throw new Error(`${name}: не реплей Extract Moon`);
  const frames = lines.slice(1).map((l) => JSON.parse(l));
  return { name, header, frames, sight: sightOf(header), layout: frames.map(cellLayout), yaw: facing(frames) };
}

// Старые реплеи (правила r1) не знают о тумане: видно всё окно обзора.
function sightOf(header) {
  const world = header.config.world;
  return header.map.sight ?? world.sight ?? world.view_radius;
}

// Несколько роботов в одной клетке расходятся внутри неё, как в старом проигрывателе.
function cellLayout(frame) {
  const byCell = new Map();
  for (const rb of frame.robots) {
    if (rb.status === "boarded") continue;
    const key = rb.x + rb.y * 1000;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(rb);
  }
  const out = new Map();
  const small = [[[0, 0]], [[-0.2, 0], [0.2, 0]], [[-0.2, -0.2], [0.2, -0.2], [0, 0.2]]];
  for (const rbs of byCell.values()) {
    const n = rbs.length;
    rbs.forEach((rb, i) => {
      const [ox, oz] = n <= 3 ? small[n - 1][i] : [-0.22 + 0.44 * (i % 2), -0.22 + 0.44 * ((i >> 1) % 2)];
      out.set(rb.id, [rb.x + 0.5 + ox, rb.y + 0.5 + oz]);
    });
  }
  return out;
}

// Поворот робота в каждом кадре: куда он шёл к следующему такту, а стоя — куда шёл раньше.
function facing(frames) {
  const yaw = [];
  const last = new Map();
  for (let i = 0; i < frames.length; i++) {
    const next = new Map((frames[i + 1]?.robots ?? []).map((rb) => [rb.id, rb]));
    for (const rb of frames[i].robots) {
      const to = next.get(rb.id);
      if (to && (to.x !== rb.x || to.y !== rb.y)) last.set(rb.id, Math.atan2(to.x - rb.x, to.y - rb.y));
    }
    yaw.push(new Map(last));
  }
  return yaw;
}
