// Запросы к сервису и файлы результата. В окне ролик ложится в data/videos, в браузере скачивается.
import { invoke } from "@tauri-apps/api/core";
import { createBackend, inWindow } from "@extract-moon/sdk/backend";

const { connect, request } = createBackend("extract-moon models");

export { connect };
export const fetchCatalog = () => request("/api/catalog");
export const fetchMemory = (name) => request(`/api/memory?run=${encodeURIComponent(name)}`);
export const renderJob = () => (inWindow ? invoke("render_job") : Promise.resolve(null));
export const finishJob = () => invoke("finish_job");

export async function saveOutput(file, bytes) {
  if (inWindow) return invoke("save_output", bytes, { headers: { "x-file": file } });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([bytes]));
  link.download = file;
  link.click();
  return file;
}
