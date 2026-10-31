// Связь окна с сервисом на Python. В окне Tauri адрес и токен дают переменные окружения, в браузере адресная строка.
import { invoke, isTauri } from "@tauri-apps/api/core";

export const inWindow = isTauri();

/** command — команда запуска, её называет ошибка, если окно открыто без сервиса. */
export function createBackend(command) {
  let base = "";
  let token = "";

  async function connect() {
    if (inWindow) ({ api: base, token } = await invoke("backend"));
    else token = new URLSearchParams(location.search).get("token") ?? "";
    if (inWindow && !base) throw new Error(`Окно открыто без сервиса. Запустите его командой ${command}.`);
  }

  async function request(path, options = {}) {
    const resp = await fetch(base + path, { ...options, headers: { "X-Token": token, ...options.headers } });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error ?? `ошибка ${resp.status}`);
    return data;
  }

  return { connect, request };
}
