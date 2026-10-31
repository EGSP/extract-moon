"""Просмотр архитектур: локальный HTTP-сервер с 3D-приложением и каталогом схем и запусков.

GET /api/catalog — все схемы и все запуски с готовыми экземплярами моделей;
GET /api/memory?run=имя — полупериоды памяти слоёв RWKV по последнему чекпойнту;
GET /api/schemas — исходные JSON схем. Остальное — статика из web/.
"""

from __future__ import annotations

import json
import mimetypes
import os
import socket
import subprocess
import sys
import tempfile
import time
import webbrowser
from http.client import HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import ProxyHandler, build_opener

WEB_DIR = Path(__file__).parent / "web"
DEFAULT_PORT = 8765
PORT_SPAN = 20


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        from urllib.parse import parse_qs, urlparse

        from .schema import catalog, load_schemas, run_memory

        path = self.path.split("?")[0]
        try:
            if path == "/api/catalog":
                return self._send(json.dumps(catalog(), ensure_ascii=False).encode(), "application/json")
            if path == "/api/memory":
                name = parse_qs(urlparse(self.path).query).get("run", [""])[0]
                if not name or "/" in name or "\\" in name or name.startswith("."):
                    return self._send(b'{"error": "bad run"}', "application/json", 400)
                return self._send(json.dumps(run_memory(name)).encode(), "application/json")
            if path == "/api/schemas":
                return self._send(json.dumps(load_schemas(), ensure_ascii=False).encode(), "application/json")
        except Exception as e:  # ошибка схемы не должна ронять сервер
            return self._send(json.dumps({"error": repr(e)}, ensure_ascii=False).encode(), "application/json", 500)
        file = (WEB_DIR / (path.lstrip("/") or "index.html")).resolve()
        if WEB_DIR.resolve() not in file.parents or not file.is_file():
            return self._send(b"not found", "text/plain", 404)
        kind = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        self._send(file.read_bytes(), kind + ("; charset=utf-8" if kind.startswith(("text/", "application/javascript")) else ""))

    def _send(self, body: bytes, kind: str, code: int = 200):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # тихо: в консоль только адрес
        pass


class Server(ThreadingHTTPServer):
    # На Windows SO_REUSEADDR пускает второй сервер на занятый порт без ошибки, и запросы
    # попадают к любому из двух. Перебор портов в make_server работает только без этого флага.
    allow_reuse_address = os.name != "nt"


def make_server(port: int = DEFAULT_PORT) -> ThreadingHTTPServer:
    mimetypes.add_type("application/javascript", ".js")
    for p in range(port, port + PORT_SPAN):  # порт занят — берём следующий
        try:
            return Server(("127.0.0.1", p), Handler)
        except OSError:
            continue
    raise OSError(f"свободного порта нет в {port}–{port + PORT_SPAN - 1}")


def port_free(port: int) -> bool:
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def answers(port: int, timeout: float = 2.0) -> bool:
    """На порту работает этот сервис, а не чужая программа."""
    opener = build_opener(ProxyHandler({}))  # системный прокси не должен перехватывать localhost
    try:
        with opener.open(f"http://127.0.0.1:{port}/api/schemas", timeout=timeout) as resp:
            return resp.status == 200 and resp.headers.get_content_type() == "application/json"
    except (OSError, HTTPException):
        return False


def find_service(port: int = DEFAULT_PORT) -> int | None:
    """Порт работающего сервиса. Он мог занять не первый порт, поэтому смотрим весь диапазон make_server."""
    for p in range(port, port + PORT_SPAN):
        if not port_free(p) and answers(p):  # соединение со свободным портом на Windows ждёт отказа 2 с
            return p
    return None


def ensure_service(port: int = DEFAULT_PORT, timeout: float = 30.0) -> tuple[str, subprocess.Popen | None]:
    """Адрес работающего сервиса; если его нет, поднимает его отдельным процессом и ждёт готовности.

    Возвращает ещё и запущенный процесс, а если сервис уже работал, вместо него None.
    Сервис читает чекпойнты только на CPU, видеопамять не занимает.
    """
    found = find_service(port)
    if found is not None:
        return f"http://127.0.0.1:{found}/", None
    with tempfile.TemporaryFile() as log:
        proc = subprocess.Popen([sys.executable, "-m", "extract_moon.cli", "models", "--no-browser", "--port", str(port)],
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            found = find_service(port)
            if found is not None:
                return f"http://127.0.0.1:{found}/", proc
            if proc.poll() is not None:
                log.seek(0)
                text = log.read().decode(errors="replace").strip()
                raise RuntimeError(f"сервис завершился с кодом {proc.returncode}: {text[-500:]}")
            time.sleep(0.2)
        proc.kill()
    raise TimeoutError(f"сервис не ответил за {timeout:.0f} с")


def serve(port: int = DEFAULT_PORT, open_browser: bool = True) -> None:
    server = make_server(port)
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"архитектуры моделей: {url} (Ctrl+C — остановить)")
    if open_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
