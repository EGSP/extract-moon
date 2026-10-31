import json
import threading
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

import pytest

from extract_moon import model_viewer
from extract_moon.model_viewer import make_server

TOKEN = "проверка".encode().hex()


@pytest.fixture
def address(tmp_path):
    (tmp_path / "index.html").write_text("окно", encoding="utf-8")
    srv, _ = make_server(token=TOKEN, dist=tmp_path)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()
    srv.server_close()


def get(url, token=TOKEN, method="GET"):
    request = Request(url, method=method, headers={"X-Token": token})
    with build_opener(ProxyHandler({})).open(request, timeout=30) as resp:  # системный прокси не должен перехватывать localhost
        return resp.status, resp.headers, resp.read()


def test_api_needs_token(address):
    with pytest.raises(HTTPError) as e:
        get(f"{address}/api/schemas", token="чужой".encode().hex())
    assert e.value.code == 403


def test_token_opens_schemas_and_allows_window_origin(address):
    status, headers, body = get(f"{address}/api/schemas")
    assert status == 200 and isinstance(json.loads(body), (list, dict))
    assert headers["Access-Control-Allow-Origin"] == "*"
    assert get(f"{address}/?token=", token="", method="OPTIONS")[0] == 204


def test_token_in_address_works_for_browser(address):
    assert get(f"{address}/api/schemas?token={TOKEN}", token="")[0] == 200


@pytest.mark.parametrize("name", ["", "..", "a/b", "a%5Cb"])
def test_memory_rejects_bad_run(address, name):
    with pytest.raises(HTTPError) as e:
        get(f"{address}/api/memory?run={name}")
    assert e.value.code == 400


def test_static_stays_inside_dist(address):
    assert get(f"{address}/")[2].decode() == "окно"
    with pytest.raises(HTTPError) as e:
        get(f"{address}/../test_model_viewer_service.py")
    assert e.value.code == 404


def test_missing_window_is_reported(monkeypatch, tmp_path):
    monkeypatch.setattr(model_viewer, "MODELS_EXE", tmp_path / "нет.exe")
    with pytest.raises(FileNotFoundError, match="не собран"):
        model_viewer.run_app()
