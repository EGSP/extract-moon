"""Схемы архитектур: загрузка, подстановка конфига запуска и сверка с git.

Схема — JSON в папке schemas/, написанный вручную по model.py. Размеры в ней — выражения
от ключей конфига (`model.d_model`, `2 * world.view_radius + 1`) и от переменных схемы.
Блок с `repeat` объявлен один раз и разворачивается в столько копий, сколько даёт выражение;
внутри него доступен номер копии `i`.
"""

from __future__ import annotations

import ast
import hashlib
import json
import re
import math
import operator
import subprocess
from pathlib import Path

from ..config import Config
from ..paths import PROJECT_ROOT, RUNS_DIR

SCHEMAS_DIR = Path(__file__).parent / "schemas"
# Схема для запусков без model.arch в конфиге.
DEFAULT_SCHEMA = "rwkv-grid-v1"

_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
        ast.FloorDiv: operator.floordiv, ast.Div: operator.truediv, ast.Mod: operator.mod}
_FUNCS = {"max": max, "min": min, "ceil": math.ceil, "floor": math.floor}


class Scope:
    """Значения для выражений: секции конфига и переменные схемы. Запоминает, какие ключи конфига прочитаны."""

    def __init__(self, cfg: dict):
        self.cfg, self.vars, self.var_keys = cfg, {}, {}
        self.used: set[str] = set()

    def eval(self, expr) -> int | float:
        if isinstance(expr, (int, float)):
            return expr
        return self._node(ast.parse(str(expr), mode="eval").body)

    def _node(self, n):
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)):
            return n.value
        if isinstance(n, ast.BinOp) and type(n.op) in _OPS:
            return _OPS[type(n.op)](self._node(n.left), self._node(n.right))
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.USub):
            return -self._node(n.operand)
        if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name):
            key = f"{n.value.id}.{n.attr}"
            self.used.add(key)
            return self.cfg[n.value.id][n.attr]
        if isinstance(n, ast.Name):
            self.used |= self.var_keys.get(n.id, set())
            return self.vars[n.id]
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in _FUNCS:
            return _FUNCS[n.func.id](*(self._node(a) for a in n.args))
        raise ValueError(f"недопустимое выражение: {ast.unparse(n)}")

    def shape(self, dims) -> list[int]:
        return [int(self.eval(x)) for x in dims]

    def tracked(self, fn):
        """Выполняет fn и возвращает (результат, прочитанные ключи конфига)."""
        saved, self.used = self.used, set()
        try:
            return fn(), self.used
        finally:
            self.used = saved | self.used


def plural(n: int, one: str, few: str, many: str) -> str:
    n = abs(n) % 100
    if 11 <= n <= 14:
        return many
    return one if n % 10 == 1 else few if 2 <= n % 10 <= 4 else many


def fmt(text: str, values: dict) -> str:
    """Подставляет в текст переменные схемы: {d} — число, {L|слой|слоя|слоёв} — слово в нужной форме."""
    def sub(m):
        name, *forms = m.group(1).split("|")
        v = values[name]
        if isinstance(v, float) and v.is_integer():
            v = int(v)
        return plural(int(v), *forms) if forms else f"{v:,}".replace(",", " ").replace(".", ",")
    return re.sub(r"\{([^{}]+)\}", sub, text or "")


def load_schemas() -> dict[str, dict]:
    return {s["id"]: s for s in (json.loads(p.read_text(encoding="utf-8")) for p in sorted(SCHEMAS_DIR.glob("*.json")))}


def instantiate(schema: dict, cfg: dict) -> dict:
    """Схема + конфиг → конкретные блоки с формами тензоров, числом параметров и рёбрами."""
    sc = Scope(cfg)
    for v in schema["vars"]:
        sc.vars[v["name"]], keys = sc.tracked(lambda: sc.eval(v["expr"]))
        sc.var_keys[v["name"]] = keys
    tensors = lambda items: [{"name": t["name"], "shape": sc.shape(t["shape"]), "dtype": schema["dtype"],
                              "label": t.get("label", "")} for t in items or []]

    def example(ex):
        """Пример данных блока: тексты с подстановкой, размеры частей вектора — по конфигу."""
        if not ex:
            return None
        out = dict(ex)
        if "segments" in ex:
            out["segments"] = [{**seg, "size": int(sc.eval(seg["size"]))} for seg in ex["segments"]]
        if "note" in ex:
            out["note"] = fmt(ex["note"], sc.vars)
        return out

    def params(items, i):
        out = []
        for p in items or []:
            shape = sc.shape(p["shape"])
            out.append({"name": p["name"], "torch": p.get("torch", "").replace("{i}", str(i)),
                        "shape": shape, "count": math.prod(shape)})
        return out

    blocks, first, last = [], {}, {}
    for b in schema["blocks"]:
        n, rep_keys = sc.tracked(lambda: int(sc.eval(b.get("repeat", 1))))
        for i in range(n):
            sc.vars["i"] = i

            def build():
                parts = [{"id": p["id"], "title": p["title"], "desc": p.get("desc", ""),
                          "purpose": fmt(p.get("purpose", ""), sc.vars), "params": params(p["params"], i)}
                         for p in b.get("parts", [])]
                for p in parts:
                    p["count"] = sum(q["count"] for q in p["params"])
                own = params(b.get("params"), i)
                return {
                    "id": b["id"] if "repeat" not in b else f"{b['id']}.{i}",
                    "base": b["id"], "index": i, "repeat": n if "repeat" in b else None,
                    "title": b["title"] + (f" {i + 1}" if "repeat" in b else ""),
                    "short": b.get("short", b["title"]) + (f" {i + 1}" if "repeat" in b else ""),
                    "group": b["group"], "component": b["component"], "desc": b.get("desc", ""),
                    "purpose": fmt(b.get("purpose", ""), sc.vars),
                    "how": [fmt(x, sc.vars) for x in b.get("how", [])], "example": example(b.get("example")),
                    "inputs": tensors(b.get("inputs")), "outputs": tensors(b.get("outputs")),
                    "params": own, "parts": parts, "labels": b.get("labels"),
                    "state": b.get("state") and {"shape": sc.shape(b["state"]["shape"]), "slots": b["state"]["slots"]},
                    "memory": bool(b.get("memory")),
                    "param_count": sum(p["count"] for p in own) + sum(p["count"] for p in parts),
                }

            blk, used = sc.tracked(build)
            blk["config"] = {k: cfg[k.split(".")[0]][k.split(".")[1]] for k in sorted(used | rep_keys)}
            blk["layout"] = {"stage": sc.eval(b["layout"]["stage"]), "row": b["layout"].get("row", 0)}
            blocks.append(blk)
            first.setdefault(b["id"], blk)
            last[b["id"]] = blk
    sc.vars.pop("i", None)

    edges = []
    for prev, cur in zip(blocks, blocks[1:]):  # цепочка копий повторяемого блока
        if cur["repeat"] and cur["index"] > 0:
            edges.append({"from": prev["id"], "to": cur["id"], "shape": prev["outputs"][0]["shape"], "label": ""})
    for e in schema["edges"]:
        src, dst = last[e["from"]], first[e["to"]]
        shape = sc.shape(e["shape"]) if "shape" in e else src["outputs"][0]["shape"]
        edges.append({"from": src["id"], "to": dst["id"], "shape": shape, "label": e.get("label", "")})
    groups = {}
    for b in blocks:
        groups[b["group"]] = groups.get(b["group"], 0) + b["param_count"]
    values = {v["name"]: sc.vars[v["name"]] for v in schema["vars"]}
    return {
        "schema": schema["id"], "blocks": blocks, "edges": edges,
        "title": fmt(schema.get("arch_title", schema["title"]), values),
        "vars": {v["name"]: sc.vars[v["name"]] for v in schema["vars"]},
        "total_params": sum(b["param_count"] for b in blocks), "group_params": groups,
        "config": {k: cfg[k.split(".")[0]][k.split(".")[1]] for k in sorted(sc.used)},
    }


def torch_shapes(inst: dict) -> dict[str, list[int]]:
    """Имена и формы всех тензоров параметров экземпляра — для сверки со state_dict модели."""
    out = {}
    for b in inst["blocks"]:
        for p in b["params"] + [q for part in b["parts"] for q in part["params"]]:
            out[p["torch"]] = p["shape"]
    return out


# ------------------------------------------------------------------ git

def _git(*args: str) -> str | None:
    try:
        r = subprocess.run(["git", *args], cwd=PROJECT_ROOT, capture_output=True, text=True, encoding="utf-8")
    except OSError:
        return None
    return r.stdout.strip() if r.returncode == 0 else None


_blobs: dict[str, str | None] = {}


def _blob(commit: str, path: str) -> str | None:
    key = f"{commit}:{path}"
    if key not in _blobs:
        _blobs[key] = _git("rev-parse", key)
    return _blobs[key]


def schema_status(schema: dict) -> dict:
    """Изменился ли model.py с коммита, по которому написана схема (коммиты и правки рабочей копии)."""
    path, commit = schema["model_file"], schema["model_commit"]
    base = _blob(commit, path)
    if base is None:
        return {"stale": True, "reason": f"коммит {commit[:7]} не найден в git", "commits": [], "dirty": False}
    log = _git("log", "--format=%h %ad %s", "--date=short", f"{commit}..HEAD", "--", path) or ""
    commits = [line for line in log.splitlines() if line]
    current = _git("hash-object", path)
    head = _blob("HEAD", path)
    dirty = current is not None and current != head
    stale = current != base
    return {"stale": stale, "commits": commits, "dirty": dirty,
            "reason": "" if not stale else "model.py изменился после коммита схемы"}


# ------------------------------------------------------------------ каталог

def run_entry(run_dir: Path, schemas: dict) -> dict:
    from ..provenance import load

    raw = json.loads((run_dir / "config.json").read_text(encoding="utf-8"))
    cfg = Config.from_dict(raw).to_dict()
    info = load(run_dir)
    sessions = info.get("sessions") or [{}]
    code = sessions[-1].get("code", {})
    sid = raw.get("model", {}).get("arch") or DEFAULT_SCHEMA
    entry = {
        "name": run_dir.name, "note": info.get("note", ""), "rules": info.get("rules"),
        "parent": info.get("parent"), "started": sessions[0].get("started", ""),
        "commit": code.get("commit", ""), "dirty": bool(code.get("dirty")),
        "result": info.get("result"), "schema": sid, "model": cfg["model"], "error": "",
    }
    schema = schemas.get(sid)
    if schema is None:
        entry["error"] = f"нет схемы {sid}"
        return entry
    try:
        entry["instance"] = instantiate(schema, cfg)
    except (KeyError, ValueError) as e:
        entry["error"] = f"схема не подходит к конфигу: {e}"
        return entry
    # Отличался ли model.py у запуска от версии схемы.
    path = schema["model_file"]
    run_blob = _blob(entry["commit"], path) if entry["commit"] else None
    edited = entry["dirty"] and "model.py" in _read(run_dir / "code.diff")
    entry["model_differs"] = run_blob != _blob(schema["model_commit"], path) or edited
    return entry


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8", errors="replace") if p.exists() else ""


def arch_key(schema_id: str, inst: dict) -> str:
    """Модели с одинаковыми тензорами весов — одна архитектура, как бы их ни обучали."""
    sig = json.dumps([schema_id, sorted(torch_shapes(inst).items())])
    return hashlib.sha1(sig.encode()).hexdigest()[:8]


def catalog() -> dict:
    """Архитектуры, у каждой список моделей-запусков на ней."""
    schemas = load_schemas()
    archs: dict[str, dict] = {}

    def arch_for(s: dict, inst: dict) -> dict:
        key = arch_key(s["id"], inst)
        if key not in archs:
            archs[key] = {"id": key, "schema": s["id"], "title": inst["title"], "default": False,
                          "instance": inst, "runs": []}
        return archs[key]

    for s in schemas.values():  # архитектура конфига по умолчанию есть всегда, даже без запусков
        arch_for(s, instantiate(s, Config().to_dict()))["default"] = s["id"] == DEFAULT_SCHEMA
    orphans = []
    if RUNS_DIR.exists():
        for d in sorted(RUNS_DIR.iterdir()):
            if not (d.is_dir() and (d / "config.json").exists()):
                continue
            run = run_entry(d, schemas)
            inst = run.pop("instance", None)
            if inst is None:
                orphans.append(run)
            else:
                run["arch"] = arch_for(schemas[run["schema"]], inst)["id"]
                archs[run["arch"]]["runs"].append(run)
    meta = [{"id": s["id"], "title": s["title"], "description": s["description"], "summary": s.get("summary", ""),
             "batch": s.get("batch", ""), "model_commit": s["model_commit"], "groups": s.get("groups", {}),
             "vars": s["vars"], "status": schema_status(s)} for s in schemas.values()]
    order = sorted(archs.values(), key=lambda a: (not a["default"], a["instance"]["total_params"]))
    return {"schemas": meta, "archs": order, "orphans": orphans}


# ------------------------------------------------------------------ память RWKV по весам

_memory_cache: dict[tuple, dict] = {}


def run_memory(name: str) -> dict:
    """Полупериоды памяти каналов каждого слоя RWKV по последнему чекпойнту запуска.

    За такт канал умножает накопленное на exp(-exp(time_decay)); половина старого
    значения остаётся через ln 2 / exp(time_decay) тактов.
    """
    ck_dir = RUNS_DIR / name / "checkpoints"
    files = sorted(ck_dir.glob("model_*.pt"))
    if not files:
        return {"error": "у запуска нет чекпойнтов"}
    ck = files[-1]
    key = (str(ck), ck.stat().st_mtime)
    if key not in _memory_cache:
        import torch  # тяжёлый импорт, нужен только здесь

        state = torch.load(ck, map_location="cpu", weights_only=False)["model"]
        layers = []
        for i in range(len([k for k in state if k.endswith("att.time_decay")])):
            td = state[f"blocks.{i}.att.time_decay"].float()
            decay = torch.exp(-torch.exp(td))
            half = (math.log(2) / torch.exp(td)).tolist()
            layers.append({"half_life": half, "decay": decay.tolist()})
        _memory_cache[key] = {"run": name, "checkpoint": ck.name, "update": int(ck.stem.split("_")[1]), "layers": layers}
    return _memory_cache[key]
