// Запросы к сервису на Python.
import { invoke } from "@tauri-apps/api/core";
import { createBackend, inWindow } from "@extract-moon/sdk/backend";

const { connect, request } = createBackend("extract-moon explorer-app");

export { connect, inWindow };

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
