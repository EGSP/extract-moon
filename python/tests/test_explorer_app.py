import csv
import json
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from extract_moon.explorer_app import Actions, Catalog, Exports, UserError, make_server
from extract_moon.metrics_view import chain_series, ema, lineage


def write_run(path, first, last, parent=None, total=None, episodes=200):
    path.mkdir()
    keys = ["update", "steps", "sps", "episodes", "launch_rate", "entropy"]
    with (path / "metrics.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, keys)
        w.writeheader()
        for u in range(first, last + 1):
            w.writerow({"update": u, "steps": u * 100, "sps": 1000, "episodes": 5 if u == first and parent else episodes,
                        "launch_rate": u / last, "entropy": 2})
    (path / "run.json").write_text(json.dumps({"parent": parent, "rules": 3, "note": "проверка"}), encoding="utf-8")
    (path / "config.json").write_text(json.dumps({"train": {"total_updates": total or last}, "world": {"signal_symbols": 2}}),
                                      encoding="utf-8")
    (path / "checkpoints").mkdir()
    (path / "replays").mkdir()
    for u in range(first - first % 10 + 10, last + 1, 10):
        (path / "checkpoints" / f"model_{u:06d}.pt").write_bytes(b"")
    return path


@pytest.fixture
def family(tmp_path):
    runs = tmp_path / "runs"
    runs.mkdir()
    write_run(runs / "root", 1, 100)
    write_run(runs / "root-u60--a", 61, 90, {"run": "root", "update": 60})
    write_run(runs / "root-u60--a-u80--b", 81, 120, {"run": "root-u60--a", "update": 80}, total=200)
    write_run(runs / "orphan", 11, 20, {"run": "deleted", "update": 10})
    (runs / "root" / "replays" / "u000020_seed1000.jsonl.gz").write_bytes(b"")
    return runs


LEAF = "root-u60--a-u80--b"


def launch_panel(chart):
    return next(p for p in chart["panels"] if p["title"] == "Матчи, где корабль улетел")


def test_tree_order_and_depth(family):
    runs = Catalog(family).runs()
    depth = {r["name"]: r["depth"] for r in runs}
    assert depth == {"root": 0, "root-u60--a": 1, LEAF: 2, "orphan": 0}
    names = [r["name"] for r in runs]
    assert names.index("root") < names.index("root-u60--a") < names.index(LEAF)
    assert next(r for r in runs if r["name"] == "orphan")["parent"] is None


def test_parent_cycle_does_not_lose_runs(tmp_path):
    write_run(tmp_path / "a", 1, 5, {"run": "b", "update": 1})
    write_run(tmp_path / "b", 1, 5, {"run": "a", "update": 1})
    assert {r["name"] for r in Catalog(tmp_path).runs()} == {"a", "b"}


def test_state_of_finished_and_stopped_runs(family):
    runs = {r["name"]: r for r in Catalog(family).runs()}
    assert runs["root"]["state"] == "готов"
    assert runs[LEAF]["state"] == "обучается"  # метрики только что записаны, до конца ещё далеко


def test_best_skips_few_episodes(tmp_path):
    write_run(tmp_path / "few", 1, 5, episodes=10)
    assert Catalog(tmp_path).runs()[0]["best"] is None


def test_chain_chart_matches_metrics_view(family):
    chart = Catalog(family).chart([LEAF])
    assert chart["mode"] == "chain"
    assert [c["name"] for c in chart["chain"]] == ["root", "root-u60--a", LEAF]
    assert [c["label"] for c in chart["chain"]] == ["root", "u60--a", "u80--b"]
    assert chart["branches"] == [{"update": 60, "steps": 6000}, {"update": 80, "steps": 8000}]
    assert (chart["marks"][0], chart["marks"][-1]) == ([1, 100], [120, 12000])
    assert len(chart["panels"]) == 13

    chain = lineage(str(family / LEAF))
    parts = [chain_series(rows, "launch_rate") for _, rows in chain]
    ys = [y for part in parts for y in part[1]]
    line = launch_panel(chart)["lines"][0]
    assert line["xs"] == [x for part in parts for x in part[0]]
    assert line["smooth"] == pytest.approx(ema(ys), rel=1e-5)


def test_values_of_few_episodes_are_dropped_after_branch(family):
    xs = launch_panel(Catalog(family).chart([LEAF]))["lines"][0]["xs"]
    assert 6100 not in xs and 8100 not in xs  # первые строки веток: 5 матчей
    assert 6100 in next(p for p in Catalog(family).chart([LEAF])["panels"] if p["lines"] and p["lines"][0]["key"] == "entropy")["lines"][0]["xs"]


def test_segments_join_without_gaps(family):
    line = launch_panel(Catalog(family).chart([LEAF]))["lines"][0]
    segs = line["segments"]
    assert [s["color"] for s in segs] == [0, 1, 2]
    assert [s["label"] for s in segs] == ["root", "u60--a", "u80--b"]
    assert segs[0]["from"] == 0 and segs[-1]["to"] == len(line["xs"])
    for a, b in zip(segs, segs[1:]):
        assert b["from"] == a["to"] - 1
    assert line["joints"] == [segs[1]["from"], segs[2]["from"]]


def test_root_has_no_branches(family):
    chart = Catalog(family).chart(["root"])
    assert chart["branches"] == [] and len(chart["chain"]) == 1
    assert launch_panel(chart)["lines"][0]["joints"] == []


def test_own_view_is_not_stitched(family):
    chart = Catalog(family).chart([LEAF], own=True)
    assert chart["mode"] == "own" and chart["branches"] == []
    assert launch_panel(chart)["lines"][0]["xs"][0] == 8100


def test_compare_lines(family):
    chart = Catalog(family).chart(["root", "root-u60--a"])
    assert chart["mode"] == "compare" and chart["marks"] == []
    lines = launch_panel(chart)["lines"]
    assert [(line["label"], line["color"]) for line in lines] == [("root", 0), ("root-u60--a", 1)]
    assert "ys" not in lines[0]  # в сравнении только сглаженные линии


def test_compare_shows_whole_branch(family):
    lines = launch_panel(Catalog(family).chart(["root", LEAF]))["lines"]
    leaf = lines[1]["xs"]
    assert leaf[0] == 100 and leaf[-1] == 12000
    assert leaf == sorted(leaf) and len(leaf) == 118  # первые строки двух потомков: мало матчей в окне
    assert len(lines[1]["joints"]) == 2 and lines[0]["joints"] == []


def test_compare_cache_follows_ancestor(family):
    catalog = Catalog(family)
    first = catalog.chart(["root", LEAF])
    with (family / "root-u60--a" / "metrics.csv").open("a", encoding="utf-8", newline="") as f:
        csv.writer(f).writerow([91, 9100, 1000, 200, 1.0, 2])
    assert catalog.chart(["root", LEAF])["stamp"] != first["stamp"]


def test_chart_cache_follows_file(family):
    catalog = Catalog(family)
    first = catalog.chart(["root"])
    assert catalog.chart(["root"]) is first
    with (family / "root" / "metrics.csv").open("a", encoding="utf-8", newline="") as f:
        csv.writer(f).writerow([101, 10100, 1000, 200, 1.0, 2])
    assert catalog.chart(["root"])["stamp"] != first["stamp"]


def test_detail(family):
    d = Catalog(family).detail("root-u60--a")
    assert (d["parent"], d["parent_update"]) == ("root", 60)
    assert [m["update"] for m in d["models"]] == [90, 80, 70]
    model = d["models"][1]
    assert model["children"] == [LEAF] and model["launch"] == pytest.approx(80 / 90)
    assert d["range"] == 90
    assert [b["update"] for b in d["timeline"]["branches"]] == [60]
    assert d["timeline"]["xs"][0] == 1 and d["timeline"]["xs"][-1] == 90


def test_interface_texts_have_no_long_dash(family):
    text = json.dumps(Catalog(family).chart(["root"]), ensure_ascii=False)
    assert "—" not in text and "«" not in text
    assert "короче, корабль заряжают быстрее" in text


def test_summary_keeps_commas(family):
    assert "обновление 100/100, 10 000 робот-тактов, 1000 такт/с" in Catalog(family).detail("root")["summary"]


def test_inherited_model_uses_parent_metrics(family):
    (family / LEAF / "checkpoints" / "model_000080.pt").write_bytes(b"")
    model = next(m for m in Catalog(family).detail(LEAF)["models"] if m["update"] == 80)
    assert model["inherited"] and model["launch"] == pytest.approx(80 / 90)


def test_lost_parent(family):
    d = Catalog(family).detail("orphan")
    assert d["parent"] is None and d["lost_parent"] == "deleted"


@pytest.mark.parametrize("name", ["", "..", "../x", "a/b", ".hidden", "nothing"])
def test_bad_run_names(family, name):
    with pytest.raises(UserError):
        Catalog(family).path(name)


def actions(family):
    calls, opened = [], []
    return Actions(Catalog(family), lambda *a: calls.append(a), opened.append, family / "journal.md", calls.append), calls, opened


def test_action_replays_and_stage(family):
    act, calls, _ = actions(family)
    act.do("replays", "root")
    act.do("stage", "root", 20)
    assert calls == [("view", str(family / "root")), ("view", str(family / "root" / "replays" / "u000020_seed1000.jsonl.gz"))]
    with pytest.raises(UserError):
        act.do("replays", "root-u60--a")
    with pytest.raises(UserError):
        act.do("stage", "root", 30)


def test_action_play_uses_cpu(family):
    act, calls, _ = actions(family)
    act.do("play", "root", 30)
    args = calls[0]
    assert args[:3] == ("record", "--checkpoint", str(family / "root" / "checkpoints" / "model_000030.pt"))
    assert args[-3:] == ("--device", "cpu", "--view")


def test_action_needs_model(family):
    act, _, _ = actions(family)
    for update in (None, 12345, "30"):
        with pytest.raises(UserError):
            act.do("play", "root", update)


def test_action_player(family, monkeypatch, tmp_path):
    exe = tmp_path / "player.exe"
    exe.write_bytes(b"")
    monkeypatch.setattr("extract_moon.explorer_app.PLAYER_EXE", exe)
    act, calls, _ = actions(family)
    act.do("player", "root", 20)
    act.do("player", "root", 30)
    act.do("player", "root")
    assert calls[0] == ("player", str(family / "root" / "replays" / "u000020_seed1000.jsonl.gz"))
    assert calls[1][0] == "record" and calls[1][-1] == "--player"
    assert calls[2] == ("player", str(family / "root"))


def test_action_finetune_and_folders(family):
    act, calls, opened = actions(family)
    command = act.do("finetune", "root", 30)["command"]
    assert calls == [command]  # команда попала в буфер обмена
    assert command == 'uv run extract-moon train --run root-u30--МЕТКА --resume root:30 --set train.total_updates=330 --note "ЗАЧЕМ"'
    act.do("folder", "root")
    act.do("journal")
    assert opened == [family / "root", family / "journal.md"]


def test_visualizer_starts_service_once(family, monkeypatch):
    opened, proc = [], object()
    monkeypatch.setattr("extract_moon.explorer_app.ensure_service", lambda: ("http://127.0.0.1:8765/", proc))
    monkeypatch.setattr("extract_moon.explorer_app.webbrowser.open", opened.append)
    act, _, _ = actions(family)
    assert act.do("visualizer")["url"] == "http://127.0.0.1:8765/"
    assert opened == ["http://127.0.0.1:8765/"] and act.visualizer is proc


@pytest.mark.parametrize("out, speed", [("", 30), ("relative.mp4", 30), ("C:/x.mp4", 0), ("C:/x.mp4", "быстро")])
def test_export_rejects_bad_input(family, out, speed):
    with pytest.raises(UserError):
        Exports(Catalog(family)).start("root", out, speed, None)


def test_export_runs_plot_video(family, tmp_path):
    exports = Exports(Catalog(family))
    out = tmp_path / "video" / "one"
    job = exports.job(exports.start("root-u60--a", str(out), 100, 1))
    deadline = time.monotonic() + 120
    while job["state"] == "running" and time.monotonic() < deadline:
        time.sleep(0.2)
    assert job["state"] == "done", job["error"]
    assert job["out"].endswith("one.mp4") and (tmp_path / "video" / "one.mp4").stat().st_size > 0
    assert job["done"] == job["total"] > 0


@pytest.fixture
def server(family, tmp_path):
    (tmp_path / "dist").mkdir()
    (tmp_path / "dist" / "index.html").write_text("окно", encoding="utf-8")
    calls, opened = [], []
    srv, token, _ = make_server(family, run=lambda *a: calls.append(a), opener=opened.append, dist=tmp_path / "dist")
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}", token, calls
    srv.shutdown()
    srv.server_close()


def get(url, token=None):
    req = Request(url, headers={"X-Token": token} if token else {})
    with urlopen(req, timeout=20) as resp:
        return json.load(resp)


def post(url, token, data):
    req = Request(url, json.dumps(data).encode(), {"X-Token": token, "Content-Type": "application/json"})
    with urlopen(req, timeout=20) as resp:
        return json.load(resp)


def test_http_requires_token(server):
    base, token, _ = server
    for bad in (None, "чужой".encode().hex()):
        with pytest.raises(HTTPError) as e:
            get(f"{base}/api/runs", bad)
        assert e.value.code == 403
    assert len(get(f"{base}/api/runs", token)["runs"]) == 4
    assert len(get(f"{base}/api/runs?token={token}")["runs"]) == 4


def test_http_action_and_errors(server):
    base, token, calls = server
    post(f"{base}/api/action", token, {"action": "replays", "run": "root"})
    assert calls[0][0] == "view"
    with pytest.raises(HTTPError) as e:
        post(f"{base}/api/action", token, {"action": "replays", "run": "../root"})
    assert e.value.code == 400 and "не найден" in json.load(e.value)["error"]


def test_http_chart_and_static(server):
    base, token, _ = server
    assert get(f"{base}/api/chart?run={LEAF}", token)["mode"] == "chain"
    assert get(f"{base}/api/chart?run=root&run=orphan", token)["mode"] == "compare"
    with urlopen(f"{base}/", timeout=20) as resp:
        assert resp.read().decode() == "окно"
    with pytest.raises(HTTPError):
        urlopen(f"{base}/../pyproject.toml", timeout=20)
