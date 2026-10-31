// Связь с сервисом на Python. В окне Tauri адрес и токен дают переменные окружения, в браузере адресная строка.
import { invoke, isTauri } from "@tauri-apps/api/core";

let base = "";
let token = "";

export const inWindow = isTauri();

export async function connect() {
  if (inWindow) ({ api: base, token } = await invoke("backend"));
  else token = new URLSearchParams(location.search).get("token") ?? "";
  if (inWindow && !base) throw new Error("Окно открыто без сервиса. Запустите проводник командой extract-moon explorer-app.");
}

async function request(path, options = {}) {
  const resp = await fetch(base + path, { ...options, headers: { "X-Token": token, ...options.headers } });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error ?? `ошибка ${resp.status}`);
  return data;
}

const post = (path, body) =>
  request(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

export const fetchRuns = () => request("/api/runs");
export const fetchRun = (name) => request(`/api/run/${encodeURIComponent(name)}`);
export const fetchChart = (names, own) =>
  request(`/api/chart?${names.map((n) => `run=${encodeURIComponent(n)}`).join("&")}${own ? "&own=1" : ""}`);
export const action = (name, run, update) => post("/api/action", { action: name, run, update });
export const startExport = (body) => post("/api/export", body);
export const exportState = (id) => request(`/api/export/${id}`);
export const openExport = (id) => post(`/api/export/${id}/open`, {});
export const pickVideo = (current) => invoke("pick_video", { current });
