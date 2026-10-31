import socket
import threading

import pytest

from extract_moon import model_viewer
from extract_moon.model_viewer import PORT_SPAN, answers, ensure_service, find_service, make_server, port_free


@pytest.fixture
def base_port():
    """Начало диапазона портов make_server, свободного целиком."""
    for port in range(18800, 19800, PORT_SPAN):
        if all(port_free(p) for p in range(port, port + PORT_SPAN)):
            return port
    pytest.skip("нет свободного диапазона портов")


@pytest.fixture
def server(base_port):
    srv = make_server(base_port)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv
    srv.shutdown()
    srv.server_close()


def test_busy_port_is_skipped(server, base_port):
    second = make_server(base_port)
    try:
        assert server.server_port == base_port
        assert second.server_port == base_port + 1
    finally:
        second.server_close()


def test_running_service_is_reused(server, base_port, monkeypatch):
    def forbidden(*_a, **_k):
        raise AssertionError("второй экземпляр")

    monkeypatch.setattr(model_viewer.subprocess, "Popen", forbidden)
    assert ensure_service(base_port) == (f"http://127.0.0.1:{base_port}/", None)


def test_foreign_listener_is_not_the_service(base_port):
    with socket.socket() as s:
        s.bind(("127.0.0.1", base_port))
        s.listen()
        assert not port_free(base_port)
        assert not answers(base_port, timeout=0.3)


def test_starts_service_and_reports_failure(base_port, tmp_path, monkeypatch):
    url, proc = ensure_service(base_port)
    try:
        assert url == f"http://127.0.0.1:{base_port}/"
        assert proc is not None
        assert find_service(base_port) == base_port
    finally:
        proc.kill()
        proc.wait()

    monkeypatch.setattr(model_viewer.sys, "executable", "python-не-существует")
    with pytest.raises(OSError):
        ensure_service(base_port)

    monkeypatch.undo()
    monkeypatch.setenv("PYTHONHOME", str(tmp_path))  # интерпретатор падает при старте
    with pytest.raises(RuntimeError, match="завершился с кодом"):
        ensure_service(base_port)
