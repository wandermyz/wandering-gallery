"""LoRA training with kohya sd-scripts: data preparation, config generation, runs.

See docs/plans/lora-tuning.md in the repo.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

from .config import Dataset
from .imageio import is_image
from .sidecar import atomic_write

# Parameter types for `--set key=value`.
PARAM_TYPES: dict[str, type] = {
    "resolution": int, "network_dim": int, "network_alpha": float, "learning_rate": float,
    "lr_scheduler": str, "lr_warmup_ratio": float, "optimizer": str, "batch_size": int,
    "epochs": int, "save_every_n_epochs": int, "min_snr_gamma": float, "noise_offset": float,
    "style_tags": list, "shuffle_caption": bool, "caption_dropout_rate": float,
    "keep_tokens": int, "max_pixels": int, "eye_tags": list, "num_repeats": int, "seed": int, "flip_aug": bool,
}


def parse_value(key: str, raw: str) -> Any:
    kind = PARAM_TYPES.get(key)
    if kind is None:
        raise SystemExit(f"unknown training parameter {key!r} (known: {', '.join(sorted(PARAM_TYPES))})")
    if kind is bool:
        if raw.lower() not in ("true", "false", "1", "0", "yes", "no", "on", "off"):
            raise SystemExit(f"{key}: expected a boolean, got {raw!r}")
        return raw.lower() in ("true", "1", "yes", "on")
    if kind is list:
        return [t.strip() for t in raw.split(",") if t.strip()]
    try:
        return kind(raw)
    except ValueError:
        raise SystemExit(f"{key}: expected {kind.__name__}, got {raw!r}") from None


def resolve_params(ds: Dataset, overrides: list[str]) -> dict[str, Any]:
    params = dict(ds.cfg["train"]["params"])
    for item in overrides:
        key, sep, raw = item.partition("=")
        if not sep:
            raise SystemExit(f"--set expects key=value, got {item!r}")
        params[key.strip()] = parse_value(key.strip(), raw.strip())
    return params


# ---------------------------------------------------------------- data

def prepared_dir(ds: Dataset, export: str, params: dict) -> Path:
    key = json.dumps({"export": export, "max_pixels": params["max_pixels"],
                      "style_tags": params["style_tags"], "class_tags": ds.subject.get("class_tags", []),
                      "eye_tags": params.get("eye_tags", [])},
                     sort_keys=True)
    return ds.train_dir / "data" / f"{export}-{hashlib.sha256(key.encode()).hexdigest()[:8]}"


def caption_with_style(caption: str, trigger: str, class_tags: list[str], style: list[str],
                       extra: list[str] = ()) -> str:
    """Insert style tags after the trigger and class tags (the kept-in-front part), `extra` after those."""
    tags = [t.strip() for t in caption.split(",") if t.strip()]
    head = 1 if tags and tags[0] == trigger else 0
    while head < len(tags) and tags[head] in class_tags:
        head += 1
    added = list(style) + [t for t in extra if t not in style]
    rest = [t for t in tags[head:] if t not in added]
    return ", ".join(tags[:head] + added + rest)


def eyes_visible(classification: dict | None) -> bool:
    c = classification or {}
    return bool(c.get("eyes_open")) and c.get("face_visible") is not False


def prepare_data(ds: Dataset, export: str, params: dict) -> tuple[Path, int]:
    """Copy an export into a training folder: oriented, ≤ max_pixels, style tags added."""
    src = ds.exports_dir / export
    if not src.is_dir():
        raise SystemExit(f"{src} not found (run `wlora export {ds.root} --name {export}`)")
    dest = prepared_dir(ds, export, params)
    images = sorted(p for p in src.iterdir() if is_image(p) and p.with_suffix(".txt").exists())
    if not images:
        raise SystemExit(f"{src} has no images with captions")
    if (dest / ".complete").exists():
        return dest, len(images)
    dest.mkdir(parents=True, exist_ok=True)
    classes = {}
    if (src / "manifest.jsonl").exists():
        for line in (src / "manifest.jsonl").read_text().splitlines():
            row = json.loads(line)
            classes[Path(row["image"]).stem] = row.get("classification")
    eye_tags = params.get("eye_tags") or []
    max_px = params["max_pixels"]
    for img in images:
        out = dest / f"{img.stem}.png" if img.suffix.lower() == ".png" else dest / f"{img.stem}.jpg"
        with Image.open(img) as im:
            im.draft("RGB", (4096, 4096))
            # sd-scripts ignores EXIF orientation, so bake it in.
            im = ImageOps.exif_transpose(im).convert("RGB")
        w, h = im.size
        if w * h > max_px:
            s = math.sqrt(max_px / (w * h))
            im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.Resampling.LANCZOS)
        if out.suffix == ".png":
            im.save(out)
        else:
            im.save(out, "JPEG", quality=95, subsampling=0)
        caption = img.with_suffix(".txt").read_text(encoding="utf-8").strip()
        caption = caption_with_style(caption, ds.trigger, ds.subject.get("class_tags", []),
                                     params["style_tags"],
                                     eye_tags if eyes_visible(classes.get(img.stem)) else [])
        (dest / f"{img.stem}.txt").write_text(caption + "\n", encoding="utf-8")
    (dest / ".complete").write_text(f"{len(images)}\n")
    return dest, len(images)


# ---------------------------------------------------------------- configs

def _toml_value(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(_toml_value(x) for x in v) + "]"
    return json.dumps(str(v), ensure_ascii=False)


def to_toml(d: dict, prefix: str = "") -> str:
    """Minimal TOML writer: scalars, lists, tables and arrays of tables."""
    lines = [f"{k} = {_toml_value(v)}" for k, v in d.items()
             if not isinstance(v, dict) and not (isinstance(v, list) and v and isinstance(v[0], dict))]
    for k, v in d.items():
        name = f"{prefix}{k}"
        if isinstance(v, dict):
            lines += ["", f"[{name}]", to_toml(v, name + ".")]
        elif isinstance(v, list) and v and isinstance(v[0], dict):
            for item in v:
                lines += ["", f"[[{name}]]", to_toml(item, name + ".")]
    return "\n".join(lines).strip() + "\n"


def caches_text_encoder(params: dict) -> bool:
    return not params["shuffle_caption"] and not params["caption_dropout_rate"]


def dataset_toml(data_dir: Path, params: dict) -> dict:
    subset = {"image_dir": str(data_dir), "caption_extension": ".txt",
              "num_repeats": params["num_repeats"], "flip_aug": params["flip_aug"]}
    if params["shuffle_caption"]:
        subset |= {"shuffle_caption": True, "keep_tokens": params["keep_tokens"]}
    if params["caption_dropout_rate"]:
        subset["caption_dropout_rate"] = params["caption_dropout_rate"]
    return {
        "general": {"enable_bucket": True, "bucket_no_upscale": True},
        "datasets": [{
            "resolution": params["resolution"], "batch_size": params["batch_size"],
            "min_bucket_reso": params["resolution"] // 2, "max_bucket_reso": params["resolution"] * 2,
            "bucket_reso_steps": 64, "subsets": [subset],
        }],
    }


def train_toml(ds: Dataset, run_dir: Path, run: str, params: dict, n_images: int) -> dict:
    tcfg = ds.cfg["train"]
    steps = math.ceil(n_images * params["num_repeats"] / params["batch_size"]) * params["epochs"]
    cfg: dict[str, Any] = {
        "pretrained_model_name_or_path": str(Path(tcfg["base_model"]).expanduser()),
        "dataset_config": str(run_dir / "dataset.toml"),
        "output_dir": str(run_dir / "output"),
        "output_name": f"{ds.trigger}-{run}",
        "save_model_as": "safetensors",
        "save_precision": "fp16",
        "save_every_n_epochs": params["save_every_n_epochs"],
        "max_train_epochs": params["epochs"],
        "network_module": "networks.lora",
        "network_dim": params["network_dim"],
        "network_alpha": params["network_alpha"],
        "network_train_unet_only": True,
        "learning_rate": params["learning_rate"],
        "unet_lr": params["learning_rate"],
        "optimizer_type": params["optimizer"],
        "lr_scheduler": params["lr_scheduler"],
        "lr_warmup_steps": max(0, round(steps * params["lr_warmup_ratio"])),
        "mixed_precision": "bf16",
        "gradient_checkpointing": True,
        "sdpa": True,
        "cache_latents": True,
        "cache_latents_to_disk": True,
        "max_data_loader_n_workers": 2,
        "persistent_data_loader_workers": True,
        "seed": params["seed"],
        "logging_dir": str(run_dir / "logs"),
        "log_with": "tensorboard",
        "metadata_title": f"{ds.subject.get('name', ds.trigger)} {run}",
    }
    if caches_text_encoder(params):
        cfg |= {"cache_text_encoder_outputs": True, "cache_text_encoder_outputs_to_disk": True}
    if params["min_snr_gamma"]:
        cfg["min_snr_gamma"] = params["min_snr_gamma"]
    if params["noise_offset"]:
        cfg["noise_offset"] = params["noise_offset"]
    return cfg


# ---------------------------------------------------------------- runs

def next_run_name(runs_dir: Path) -> str:
    nums = [int(p.name[1:]) for p in runs_dir.glob("r[0-9]*") if p.name[1:].isdigit()] if runs_dir.exists() else []
    return f"r{max(nums, default=0) + 1:03d}"


def free_comfyui(url: str) -> None:
    """Ask ComfyUI to unload models so training has the VRAM. Never fatal."""
    req = urllib.request.Request(url.rstrip("/") + "/free", method="POST",
                                 data=json.dumps({"unload_models": True, "free_memory": True}).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=5).close()
        print(f"asked ComfyUI ({url}) to unload its models")
    except OSError as e:
        print(f"ComfyUI not reachable at {url} ({e}); continuing")


def link_into_comfyui(ds: Dataset, run_dir: Path, run: str) -> Path | None:
    loras = ds.cfg["train"].get("comfyui_loras")
    if not loras:
        return None
    link = Path(loras).expanduser() / "wlora" / ds.root.name / run
    link.parent.mkdir(parents=True, exist_ok=True)
    if not link.exists() and not link.is_symlink():
        link.symlink_to(run_dir / "output", target_is_directory=True)
    return link


def train(ds: Dataset, export: str, overrides: list[str], name: str | None, dry_run: bool) -> int:
    tcfg = ds.cfg["train"]
    sd_scripts = Path(tcfg["sd_scripts"]).expanduser()
    script = sd_scripts / "sdxl_train_network.py"
    python = sd_scripts / ".venv" / "bin" / "python"
    base = Path(tcfg["base_model"]).expanduser()
    for p, what in ((script, "train.sd_scripts"), (python, "sd-scripts venv"), (base, "train.base_model")):
        if not p.exists():
            raise SystemExit(f"{p} not found ({what})")

    params = resolve_params(ds, overrides)
    runs_dir = ds.train_dir / "runs"
    run = name or next_run_name(runs_dir)
    run_dir = runs_dir / run
    if (run_dir / "params.json").exists():
        raise SystemExit(f"{run_dir} already exists")

    data_dir, n = prepare_data(ds, export, params)
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "output").mkdir(exist_ok=True)
    atomic_write(run_dir / "params.json", json.dumps(
        {"run": run, "export": export, "data": str(data_dir), "images": n, "params": params,
         "overrides": overrides, "created": time.strftime("%Y-%m-%dT%H:%M:%S%z")}, indent=2) + "\n")
    atomic_write(run_dir / "dataset.toml", to_toml(dataset_toml(data_dir, params)))
    cfg = train_toml(ds, run_dir, run, params, n)
    atomic_write(run_dir / "config.toml", to_toml(cfg))
    link = link_into_comfyui(ds, run_dir, run)

    cmd = [str(python), str(script), "--config_file", str(run_dir / "config.toml")]
    print(f"run {run}: {n} images, {params['epochs']} epochs, dim {params['network_dim']}, "
          f"lr {params['learning_rate']}, text encoder {'cached' if caches_text_encoder(params) else 'live'}")
    print(f"  folder:  {run_dir}")
    if link:
        print(f"  ComfyUI: loras/{link.relative_to(Path(tcfg['comfyui_loras']).expanduser())}")
    if dry_run:
        print("  " + " ".join(cmd))
        return 0

    free_comfyui(tcfg["comfyui"])
    env = dict(os.environ, PYTHONUNBUFFERED="1")
    with open(run_dir / "train.log", "ab") as log:
        proc = subprocess.Popen(cmd, cwd=sd_scripts, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        assert proc.stdout
        for line in proc.stdout:
            log.write(line)
            log.flush()
            sys.stdout.buffer.write(line)
            sys.stdout.flush()
        rc = proc.wait()
    status = {"exit_code": rc, "finished": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
              "checkpoints": sorted(p.name for p in (run_dir / "output").glob("*.safetensors"))}
    atomic_write(run_dir / "status.json", json.dumps(status, indent=2) + "\n")
    print(f"run {run} {'finished' if rc == 0 else f'failed (exit {rc})'}: {len(status['checkpoints'])} checkpoint(s)")
    return rc
