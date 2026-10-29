import pytest

from extract_moon.config import Config
from extract_moon.env import ExtractMoonEnv
from extract_moon.model import Policy
from extract_moon.model_viewer.schema import catalog, instantiate, load_schemas, torch_shapes


@pytest.mark.parametrize("layers,d,mult", [(2, 192, 4), (3, 192, 4), (4, 192, 4), (3, 64, 2)])
def test_schema_matches_model(layers, d, mult):
    """Схема описывает ровно те тензоры параметров, что есть у модели, с теми же формами."""
    cfg = Config().override([f"model.n_layers={layers}", f"model.d_model={d}", f"model.ffn_mult={mult}"])
    model = Policy(cfg, ExtractMoonEnv(cfg, 1).vec_dim)
    inst = instantiate(load_schemas()["rwkv-grid-v1"], cfg.to_dict())
    real = {k: list(v.shape) for k, v in model.state_dict().items()}
    assert torch_shapes(inst) == real
    assert inst["total_params"] == sum(p.numel() for p in model.parameters())
    assert inst["vars"]["vec"] == ExtractMoonEnv(cfg, 1).vec_dim


def test_catalog_builds():
    cat = catalog()
    assert cat["archs"] and cat["archs"][0]["default"]
    for arch in cat["archs"]:
        assert arch["instance"]["total_params"] > 0
        assert all(run["arch"] == arch["id"] for run in arch["runs"])
