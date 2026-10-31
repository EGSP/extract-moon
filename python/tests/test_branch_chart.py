import csv
import json

from matplotlib.backends.backend_agg import FigureCanvasAgg
from matplotlib.figure import Figure

from extract_moon.metrics_view import MetricsAnimation, chain_series, draw_branch, draw_view, lineage


def write_run(path, first, last, parent=None):
    path.mkdir()
    keys = ["update", "steps", "sps", "episodes", "launch_rate"]
    with (path / "metrics.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, keys)
        w.writeheader()
        for u in range(first, last + 1):
            w.writerow({"update": u, "steps": u * 100, "sps": 1000, "episodes": 200, "launch_rate": u / last})
    (path / "run.json").write_text(json.dumps({"parent": parent}), encoding="utf-8")
    return path


def family(tmp_path):
    write_run(tmp_path / "root", 1, 100)
    write_run(tmp_path / "root-u60--a", 61, 90, {"run": "root", "update": 60})
    return write_run(tmp_path / "root-u60--a-u80--b", 81, 120, {"run": "root-u60--a", "update": 80})


def figure():
    fig = Figure(figsize=(12, 7), dpi=50)
    FigureCanvasAgg(fig)
    return fig


def test_lineage_cuts_each_parent_at_branch(tmp_path):
    chain = lineage(str(family(tmp_path)))
    assert [name for name, _ in chain] == ["root", "root-u60--a", "root-u60--a-u80--b"]
    assert [(int(rows[0]["update"]), int(rows[-1]["update"])) for _, rows in chain] == [(1, 60), (61, 80), (81, 120)]


def test_lineage_without_parent_folder(tmp_path):
    run = write_run(tmp_path / "child", 11, 20, {"run": "deleted", "update": 10})
    assert [name for name, _ in lineage(str(run))] == ["child"]


def test_few_episodes_are_skipped_after_branch():
    rows = [{"update": "1", "steps": "10", "episodes": "5", "launch_rate": "0.0", "entropy": "2"},
            {"update": "2", "steps": "20", "episodes": "60", "launch_rate": "0.5", "entropy": "2"}]
    assert chain_series(rows, "launch_rate") == ([20], [0.5])
    assert chain_series(rows, "entropy")[0] == [10, 20]


def branch_marks(ax):
    return [line.get_xdata()[0] for line in ax.get_lines() if line.get_linestyle() == "--"]


def test_single_run_is_stitched_by_default(tmp_path):
    fig = figure()
    draw_view(fig, [str(family(tmp_path))], own=False)
    assert branch_marks(fig.axes[1]) == [6000, 8000]


def test_own_view_shows_only_the_run(tmp_path):
    fig = figure()
    draw_view(fig, [str(family(tmp_path))], own=True)
    assert branch_marks(fig.axes[1]) == []


def test_animation_covers_whole_branch(tmp_path):
    fig = figure()
    anim = MetricsAnimation(fig, str(family(tmp_path)))
    assert (anim.marks[0][0], anim.marks[-1][0]) == (1, 120)


def test_animation_of_one_panel(tmp_path):
    fig = figure()
    anim = MetricsAnimation(fig, str(family(tmp_path)), panel=1)
    assert [ax.get_title().split("\n")[0] for ax in fig.axes] == ["Матчи, где корабль улетел"]
    anim.show(10)
    anim.close()


def test_branch_figure_marks_each_branch_point(tmp_path):
    fig = figure()
    draw_branch(fig, str(family(tmp_path)))
    launch = fig.axes[1]
    assert branch_marks(launch) == [6000, 8000]
    assert [t.get_text().strip() for t in launch.texts] == ["u60", "u80"]
    assert len([line for line in launch.get_lines() if line.get_marker() == "o"]) == 2
