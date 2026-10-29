"""Просмотр архитектур: локальный HTTP-сервер с 3D-приложением и каталогом схем и запусков.

GET /api/catalog — все схемы и все запуски с готовыми экземплярами моделей;
GET /api/schemas — исходные JSON схем. Остальное — статика из web/.
"""

from __future__ import annotations

import json
import mimetypes
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB_DIR = Path(__file__).parent / "web"
DEFAULT_PORT = 8765


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        from .schema import catalog, load_schemas

        path = self.path.split("?")[0]
        try:
            if path == "/api/catalog":
                return self._send(json.dumps(catalog(), ensure_ascii=False).encode(), "application/json")
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


def serve(port: int = DEFAULT_PORT, open_browser: bool = True) -> None:
    mimetypes.add_type("application/javascript", ".js")
    for p in range(port, port + 20):  # порт занят — берём следующий
        try:
            server = ThreadingHTTPServer(("127.0.0.1", p), Handler)
            break
        except OSError:
            continue
    else:
        raise OSError(f"свободного порта нет в {port}–{port + 19}")
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
