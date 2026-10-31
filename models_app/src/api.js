// Связь с сервисом на Python. В окне Tauri адрес и токен дают переменные окружения, в браузере адресная строка.
import { invoke, isTauri } from "@tauri-apps/api/core";

let base = "";
let token = "";

export async function connect() {
  if (isTauri()) ({ api: base, token } = await invoke("backend"));
  else token = new URLSearchParams(location.search).get("token") ?? "";
  if (isTauri() && !base) throw new Error("Окно открыто без сервиса. Запустите справочник командой extract-moon models.");
}

async function request(path) {
  const resp = await fetch(base + path, { headers: { "X-Token": token } });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error ?? `ошибка ${resp.status}`);
  return data;
}

export const fetchCatalog = () => request("/api/catalog");
export const fetchMemory = (name) => request(`/api/memory?run=${encodeURIComponent(name)}`);
