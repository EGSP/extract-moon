import csv

import pytest
from matplotlib.backends.backend_agg import FigureCanvasAgg
from matplotlib.figure import Figure

from extract_moon.metrics_view import MetricsAnimation, export_animation, frame_count


def write_run(path, updates=40, first=1):
    path.mkdir()
    keys = ["update", "steps", "sps", "launch_rate", "pop_min", "pop_mean", "pop_max"]
    with (path / "metrics.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, keys)
        w.writeheader()
        for i in range(updates):
            w.writerow({"update": first + i, "steps": (first + i) * 100, "sps": 1000, "launch_rate": i / updates,
                        "pop_min": 1, "pop_mean": 2 + i / updates, "pop_max": 3})
    return path


def animation(path):
    fig = Figure(figsize=(9, 5), dpi=50)
    FigureCanvasAgg(fig)
    return MetricsAnimation(fig, str(path))


def test_frame_count():
    assert frame_count(601, 30, 30) == 601
    assert frame_count(601, 60, 30) == 301
    assert frame_count(1, 30, 30) == 2


def test_lines_grow_with_updates(tmp_path):
    anim = animation(write_run(tmp_path / "run", first=601))
    assert anim.marks[0] == (601, 60100)
    line = anim.lines[0][0]
    lengths = []
    for frame in (0, 19, 39):
        anim.show(frame)
        lengths.append(len(line.get_xdata()))
    assert lengths == [1, 20, 40]
    assert anim.label.get_text() == "обновление 640"


def test_frames_differ(tmp_path):
    anim = animation(write_run(tmp_path / "run"))
    anim.show(0)
    first = anim.rgb()
    anim.show(39)
    assert anim.rgb() != first
    anim.show(0)
    assert anim.rgb() == first  # фон восстанавливается, линии не копятся


def test_no_metrics(tmp_path):
    (tmp_path / "run").mkdir()
    with pytest.raises(ValueError):
        animation(tmp_path / "run")


def test_export_video(tmp_path):
    out = tmp_path / "sub" / "m.mp4"
    calls = []
    export_animation(str(write_run(tmp_path / "run")), out, speed=20, fps=10, progress=lambda j, n: calls.append((j, n)))
    assert out.stat().st_size > 0
    assert calls[-1] == (21, 21)
