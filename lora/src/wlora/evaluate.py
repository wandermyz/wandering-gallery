"""Render a fixed eval set for every checkpoint × LoRA strength of a run through ComfyUI.

Images go to ComfyUI's output folder (wlora/<dataset>/<run>/), so they are gallery
assets. One contact sheet per prompt (rows: epochs, columns: strengths, first row:
no LoRA) goes next to them. See docs/plans/lora-tuning.md.
"""
from __future__ import annotations

import copy
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

from .config import Dataset
from .sidecar import atomic_write

WORKFLOW = "wai-illustrious-lora.api.json"
CKPT_RE = re.compile(r"-(\d{6})\.safetensors$")


def workflow_path(ds: Dataset) -> Path:
    wf = ds.cfg["train"]["eval"].get("workflow")
    if wf:
        return Path(wf).expanduser()
    # lora/src/wlora/evaluate.py -> <repo>/comfyui/workflows
    return Path(__file__).resolve().parents[3] / "comfyui" / "workflows" / WORKFLOW


def checkpoints(run_dir: Path) -> list[tuple[int, Path]]:
    """(epoch, file) for every saved checkpoint; the final one (no number) counts as the last epoch."""
    out = []
    params = json.loads((run_dir / "params.json").read_text())["params"]
    for p in sorted((run_dir / "output").glob("*.safetensors")):
        m = CKPT_RE.search(p.name)
        out.append((int(m.group(1)) if m else params["epochs"], p))
    # sd-scripts saves the last epoch twice when epochs % save_every == 0; keep one.
    seen: dict[int, Path] = {}
    for epoch, p in out:
        if epoch not in seen or CKPT_RE.search(p.name):
            seen[epoch] = p
    return sorted(seen.items())


def build_graph(base: dict, *, lora: str | None, strength: float, prompt: str, negative: str,
                seed: int, size: tuple[int, int], steps: int, cfg: float, prefix: str) -> dict:
    g = copy.deepcopy(base)
    if lora is None:
        g["6"]["inputs"]["model"] = ["1", 0]
        del g["2"]
    else:
        g["2"]["inputs"] |= {"lora_name": lora, "strength_model": strength}
    g["3"]["inputs"]["text"] = prompt
    g["4"]["inputs"]["text"] = negative
    g["5"]["inputs"] |= {"width": size[0], "height": size[1]}
    g["6"]["inputs"] |= {"seed": seed, "steps": steps, "cfg": cfg}
    g["8"]["inputs"]["filename_prefix"] = prefix
    return g


class Comfy:
    def __init__(self, url: str):
        self.url = url.rstrip("/")

    def _req(self, path: str, body: dict | None = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            raise SystemExit(f"ComfyUI {path}: HTTP {e.code} {e.read().decode(errors='replace')[:500]}") from None
        except OSError as e:
            raise SystemExit(f"ComfyUI not reachable at {self.url} ({e})") from None

    def submit(self, graph: dict, pnginfo: dict) -> str:
        return self._req("/prompt", {"prompt": graph, "extra_data": {"extra_pnginfo": pnginfo}})["prompt_id"]

    def wait(self, prompt_id: str, poll: float = 1.0) -> list[dict]:
        while True:
            h = self._req(f"/history/{prompt_id}").get(prompt_id)
            if h and h.get("status", {}).get("completed") is not None:
                st = h["status"]
                if st.get("status_str") != "success":
                    msgs = [m for m in st.get("messages", []) if m[0] == "execution_error"]
                    raise SystemExit(f"ComfyUI job {prompt_id} failed: {msgs[-1][1].get('exception_message') if msgs else st}")
                return [img for out in h["outputs"].values() for img in out.get("images", [])]
            time.sleep(poll)


def _fmt_strength(s: float) -> str:
    return f"{s:.2f}".rstrip("0").rstrip(".")


def with_tags_after_class(prompt: str, ds: Dataset, extra: list[str]) -> str:
    """Insert the run's eye_tags after the trigger and class tags, like in its training captions."""
    if not extra:
        return prompt
    tags = [t.strip() for t in prompt.split(",") if t.strip()]
    head = 1 if tags and tags[0] == "{trigger}" else 0
    while head < len(tags) and tags[head] in ds.subject.get("class_tags", []):
        head += 1
    return ", ".join(tags[:head] + [t for t in extra if t not in tags] + tags[head:])


def plan_jobs(ds: Dataset, run: str, ckpts: list[tuple[int, Path]], strengths: list[float],
              eye_tags: list[str] = (), seeds: list[int] | None = None) -> list[dict]:
    ev = ds.cfg["train"]["eval"]
    seeds = seeds or ev["seeds"]
    jobs = []
    for p in ev["prompts"]:
        prompt = with_tags_after_class(p["prompt"], ds, list(eye_tags))
        texts = {"t": prompt.replace("{trigger}", ds.trigger)}
        if p.get("without_trigger", True):
            # Same scene without the trigger word: measures leakage into normal prompts.
            texts["n"] = re.sub(r"\s*\{trigger\}\s*,?\s*", "", prompt).strip(", ")
        for variant, text in texts.items():
            for seed in seeds:
                base = {"prompt_id": p["id"], "variant": variant, "seed": seed, "text": text}
                jobs.append(base | {"epoch": 0, "strength": 0.0, "lora": None,
                                    "key": f"{p['id']}-{variant}-{seed}-base"})
                for epoch, ck in ckpts:
                    for s in strengths:
                        jobs.append(base | {"epoch": epoch, "strength": s, "lora": ck,
                                            "key": f"{p['id']}-{variant}-{seed}-e{epoch:03d}-s{_fmt_strength(s)}"})
    return jobs


def evaluate(ds: Dataset, run: str, epochs: list[int] | None, strengths: list[float] | None,
             dry_run: bool, seeds: list[int] | None = None) -> int:
    tcfg, ev = ds.cfg["train"], ds.cfg["train"]["eval"]
    run_dir = ds.train_dir / "runs" / run
    if not (run_dir / "params.json").exists():
        raise SystemExit(f"{run_dir} is not a run")
    ckpts = checkpoints(run_dir)
    if epochs:
        ckpts = [c for c in ckpts if c[0] in epochs]
    if not ckpts:
        raise SystemExit(f"no checkpoints in {run_dir / 'output'}")
    strengths = strengths or ev["strengths"]
    loras_root = Path(tcfg["comfyui_loras"]).expanduser()
    link = loras_root / "wlora" / ds.root.name / run

    params = json.loads((run_dir / "params.json").read_text())["params"]
    jobs = plan_jobs(ds, run, ckpts, strengths, params.get("eye_tags") or [], seeds)
    eval_dir = run_dir / "eval"
    manifest_path = eval_dir / "manifest.json"
    done: dict[str, dict] = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    out_root = Path(ev["comfyui_output"]).expanduser()
    # Re-render when the image is missing or the prompt text changed since.
    todo = [j for j in jobs if j["key"] not in done or done[j["key"]].get("text") != j["text"]
            or not (out_root / done[j["key"]]["file"]).exists()]
    print(f"eval {run}: {len(ckpts)} checkpoint(s) × {len(strengths)} strength(s), "
          f"{len(jobs)} images, {len(todo)} to render")
    if dry_run:
        for j in todo[:10]:
            print(f"  {j['key']}: {j['text']}")
        return 0

    comfy = Comfy(tcfg["comfyui"])
    base = json.loads(workflow_path(ds).read_text())
    base["1"]["inputs"]["ckpt_name"] = Path(tcfg["base_model"]).name
    negative, quality = ev["negative_prompt"], ev["quality_tags"]
    size = tuple(ev["size"])
    eval_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    # Group by checkpoint so ComfyUI loads each LoRA once.
    todo.sort(key=lambda j: (j["epoch"], j["strength"], j["key"]))
    for i, j in enumerate(todo, 1):
        lora = None if j["lora"] is None else str((link / j["lora"].name).relative_to(loras_root))
        sub = f"wlora/{ds.root.name}/{'baseline' if lora is None else run}"
        prompt = f"{j['text']}, {quality}" if quality else j["text"]
        g = build_graph(base, lora=lora, strength=j["strength"], prompt=prompt, negative=negative,
                        seed=j["seed"], size=size, steps=ev["steps"], cfg=ev["cfg"], prefix=f"{sub}/{j['key']}")
        meta = {k: j[k] for k in ("prompt_id", "variant", "seed", "epoch", "strength", "text")} | {
            "dataset": ds.root.name, "run": run if lora else None, "lora": lora}
        pid = comfy.submit(g, {"wlora": meta, "source_prompt": prompt})
        imgs = comfy.wait(pid)
        if not imgs:
            raise SystemExit(f"job {pid} produced no image")
        img = imgs[0]
        rel = str(Path(img["subfolder"]) / img["filename"])
        done[j["key"]] = meta | {"file": rel}
        atomic_write(manifest_path, json.dumps(done, indent=1) + "\n")
        el = time.time() - t0
        print(f"  [{i}/{len(todo)}] {j['key']}  ({el / i:.1f}s/img, ~{el / i * (len(todo) - i) / 60:.0f} min left)",
              flush=True)

    if epochs or seeds or strengths != ev["strengths"]:
        # A subset: don't replace the run's full contact sheets with partial ones.
        print(f"done: {len(jobs)} images (subset; contact sheets not rewritten)")
        return 0
    sheets = contact_sheets(ds, run, jobs, done, out_root, [e for e, _ in ckpts], strengths)
    print(f"done: {len(jobs)} images; contact sheets in {out_root / f'wlora/{ds.root.name}/{run}/sheets'}")
    for s in sheets:
        print(f"  {s.name}")
    return 0


def contact_sheets(ds: Dataset, run: str, jobs: list[dict], done: dict, out_root: Path,
                   epochs: list[int], strengths: list[float], cell: int = 320) -> list[Path]:
    """One PNG per (prompt, variant, seed): rows = epochs (first row: no LoRA), columns = strengths."""
    dest = out_root / "wlora" / ds.root.name / run / "sheets"
    dest.mkdir(parents=True, exist_ok=True)
    groups: dict[tuple, dict] = {}
    for j in jobs:
        groups.setdefault((j["prompt_id"], j["variant"], j["seed"]), {})[(j["epoch"], j["strength"])] = done.get(j["key"])
    label_w, head_h = 90, 28
    written = []
    for (pid, variant, seed), cells in groups.items():
        w0, h0 = ds.cfg["train"]["eval"]["size"]
        ch = round(cell * h0 / w0)
        rows = [0] + epochs
        sheet = Image.new("RGB", (label_w + cell * len(strengths), head_h + ch * len(rows)), "white")
        d = ImageDraw.Draw(sheet)
        for c, s in enumerate(strengths):
            d.text((label_w + c * cell + 8, 8), f"strength {_fmt_strength(s)}", fill="black")
        for r, epoch in enumerate(rows):
            y = head_h + r * ch
            d.text((8, y + 8), "no LoRA" if epoch == 0 else f"epoch {epoch}", fill="black")
            for c, s in enumerate(strengths):
                entry = cells.get((0, 0.0)) if epoch == 0 else cells.get((epoch, s))
                if epoch == 0 and c > 0:
                    continue
                if entry and (out_root / entry["file"]).exists():
                    with Image.open(out_root / entry["file"]) as im:
                        sheet.paste(im.convert("RGB").resize((cell, ch), Image.Resampling.LANCZOS),
                                    (label_w + c * cell, y))
        name = f"{pid}-{'trigger' if variant == 't' else 'no-trigger'}-{seed}.png"
        tmp = dest / f".{name}.tmp"
        sheet.save(tmp, "PNG")
        tmp.replace(dest / name)
        written.append(dest / name)
    return written
