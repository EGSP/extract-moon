import os

from extract_moon.config import Config
from extract_moon.replay import load_replay, record_episode


def test_record_and_render(tmp_path):
    cfg = Config()
    cfg.world.max_steps = 25
    out = tmp_path / "r.jsonl.gz"
    result = record_episode(out, None, seed=5, cfg=cfg, device="cpu")
    header, frames = load_replay(out)
    assert header["result"] == result
    assert len(frames) == result["length"] + 1
    assert any(fr["decisions"] for fr in frames)

    os.environ["SDL_VIDEODRIVER"] = "dummy"
    from extract_moon.viewer import export_gif

    gif = export_gif(out, tmp_path / "r.gif", cell=10)
    assert gif.stat().st_size > 0
