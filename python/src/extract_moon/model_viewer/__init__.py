"""Просмотр архитектур: сервис на 127.0.0.1 для окна models_app/ на Tauri.

Запросы требуют токен в заголовке X-Token или параметре token:
GET /api/catalog — все схемы и все запуски с готовыми экземплярами моделей;
GET /api/memory?run=имя — полупериоды памяти слоёв RWKV по последнему чекпойнту;
GET /api/schemas — исходные JSON схем. Остальное — собранный интерфейс из models_app/dist.
"""

from __future__ import annotations

import json
import mimetypes
import os
import secrets
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from ..paths import MODELS_DIST, MODELS_EXE


class Server(ThreadingHTTPServer):
    # На Windows SO_REUSEADDR пускает второй сервер на занятый порт без ошибки, и запросы
    # попадают к любому из двух.
    allow_reuse_address = os.name != "nt"


def make_handler(token: str, dist: Path) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_OPTIONS(self):
            self._send(b"", "text/plain", 204)

        def do_GET(self):
            from .schema import catalog, load_schemas, run_memory

            url = urlparse(self.path)
            query = parse_qs(url.query)
            if not url.path.startswith("/api/"):
                return self._static(url.path)
            if not secrets.compare_digest((self.headers.get("X-Token") or query.get("token", [""])[0]).encode(), token.encode()):
                return self._reply({"error": "нет доступа"}, 403)
            try:
                if url.path == "/api/catalog":
                    return self._reply(catalog())
                if url.path == "/api/memory":
                    name = query.get("run", [""])[0]
                    if not name or "/" in name or "\\" in name or name.startswith("."):
                        return self._reply({"error": "bad run"}, 400)
                    return self._reply(run_memory(name))
                if url.path == "/api/schemas":
                    return self._reply(load_schemas())
                return self._reply({"error": "неизвестный запрос"}, 404)
            except Exception as e:  # ошибка схемы не должна ронять сервис
                return self._reply({"error": repr(e)}, 500)

        def _reply(self, data, code: int = 200):
            self._send(json.dumps(data, ensure_ascii=False).encode(), "application/json", code)

        def _send(self, body: bytes, kind: str, code: int = 200):
            self.send_response(code)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "X-Token")
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _static(self, path: str):
            """Собранный интерфейс: окно Tauri носит его в себе, а это для проверки в браузере."""
            file = (dist / (path.lstrip("/") or "index.html")).resolve()
            if dist.resolve() not in file.parents or not file.is_file():
                return self._send(b"not found", "text/plain", 404)
            kind = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
            self._send(file.read_bytes(), kind + ("; charset=utf-8" if kind.startswith(("text/", "application/javascript")) else ""))

        def log_message(self, *args):  # тихо: у окна нет консоли
            pass

    return Handler


def make_server(port: int = 0, token: str | None = None, dist: Path = MODELS_DIST) -> tuple[Server, str]:
    """Сервер на 127.0.0.1. Порт 0 значит свободный. Возвращает сервер и токен."""
    mimetypes.add_type("application/javascript", ".js")
    token = token or secrets.token_urlsafe(24)
    return Server(("127.0.0.1", port), make_handler(token, dist)), token


def open_window() -> None:
    """Запускает окно отдельным процессом: оно живёт независимо от проводника. Открытое окно само выйдет на передний план."""
    subprocess.Popen([sys.executable, "-m", "extract_moon.cli", "models"],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def run_app(port: int = 0, window: bool = True) -> None:
    """Открывает окно и держит сервис, пока окно не закрыто. Без окна сервис работает до Ctrl+C.

    Сервис читает чекпойнты только на CPU, видеопамять не занимает.
    """
    if window and not MODELS_EXE.exists():
        raise FileNotFoundError(f"справочник не собран: {MODELS_EXE}. Сборка описана в models_app/README.md")
    server, token = make_server(port)
    address = f"http://127.0.0.1:{server.server_port}"
    try:
        if window:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            env = {**os.environ, "EXTRACT_MOON_API": address, "EXTRACT_MOON_TOKEN": token}
            subprocess.run([str(MODELS_EXE)], env=env, stdin=subprocess.DEVNULL, check=False)
            server.shutdown()
        else:
            print(f"архитектуры моделей: {address}/?token={token} (Ctrl+C: остановить)", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
