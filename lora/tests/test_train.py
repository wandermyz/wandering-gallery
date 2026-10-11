import json
from pathlib import Path

import pytest
import yaml
from PIL import Image

from wlora import train
from wlora.config import Dataset, default_config_text


@pytest.fixture
def ds(tmp_path: Path) -> Dataset:
    cfg = yaml.safe_load(default_config_text())
    sd = tmp_path / "sd-scripts"
    (sd / ".venv" / "bin").mkdir(parents=True)
    (sd / "sdxl_train_network.py").write_text("")
    (sd / ".venv" / "bin" / "python").write_text("")
    (tmp_path / "base.safetensors").write_text("")
    cfg["train"] |= {"sd_scripts": str(sd), "base_model": str(tmp_path / "base.safetensors"),
                     "comfyui_loras": str(tmp_path / "loras")}
    (tmp_path / "ds").mkdir()
    (tmp_path / "ds" / "dataset.yaml").write_text(yaml.safe_dump(cfg))
    exp = tmp_path / "ds" / "exports" / "v1"
    exp.mkdir(parents=True)
    Image.new("RGB", (4000, 2000)).save(exp / "a.jpg")
    (exp / "a.txt").write_text("siggraph, cat, no humans, sitting\n")
    Image.new("RGB", (64, 64)).save(exp / "b.png")  # no caption: skipped
    return Dataset.load(tmp_path / "ds")


def test_style_tags_after_trigger_and_class():
    assert train.caption_with_style("siggraph, cat, no humans, realistic, sitting", "siggraph", ["cat"],
                                    ["photo (medium)", "realistic"]) == \
        "siggraph, cat, photo (medium), realistic, no humans, sitting"
    assert train.caption_with_style("siggraph, cat, sitting", "siggraph", ["cat"], []) == "siggraph, cat, sitting"


def test_set_parsing(ds):
    p = train.resolve_params(ds, ["learning_rate=5e-5", "shuffle_caption=on", "style_tags=", "network_dim=32"])
    assert p["learning_rate"] == 5e-5 and p["shuffle_caption"] is True
    assert p["style_tags"] == [] and p["network_dim"] == 32
    with pytest.raises(SystemExit):
        train.resolve_params(ds, ["nope=1"])
    with pytest.raises(SystemExit):
        train.resolve_params(ds, ["epochs=many"])


def test_dry_run_prepares_data_and_configs(ds):
    assert train.train(ds, "v1", [], None, dry_run=True) == 0
    run = ds.train_dir / "runs" / "r001"
    params = json.loads((run / "params.json").read_text())
    assert params["images"] == 1
    data = Path(params["data"])
    with Image.open(data / "a.jpg") as im:
        assert im.width * im.height <= params["params"]["max_pixels"]
    assert (data / "a.txt").read_text().startswith("siggraph, cat, photo (medium), realistic, no humans")
    cfg = (run / "config.toml").read_text()
    assert "cache_text_encoder_outputs = true" in cfg and "network_train_unet_only = true" in cfg
    assert "[[datasets]]" in (run / "dataset.toml").read_text()
    assert (Path(ds.cfg["train"]["comfyui_loras"]) / "wlora" / "ds" / "r001").resolve() == run / "output"
    # next run gets the next name and reuses the prepared data
    train.train(ds, "v1", ["shuffle_caption=true"], None, dry_run=True)
    run2 = ds.train_dir / "runs" / "r002"
    assert json.loads((run2 / "params.json").read_text())["data"] == params["data"]
    assert "cache_text_encoder_outputs" not in (run2 / "config.toml").read_text()
    assert "shuffle_caption = true" in (run2 / "dataset.toml").read_text()


def test_eval_plan_and_graph(ds, tmp_path):
    from wlora import evaluate
    train.train(ds, "v1", [], None, dry_run=True)
    run = ds.train_dir / "runs" / "r001"
    for n in ("ds-r001-000002", "ds-r001-000004", "ds-r001"):  # last epoch saved without a number
        (run / "output" / f"{n}.safetensors").write_text("")
    ckpts = evaluate.checkpoints(run)
    assert [e for e, _ in ckpts] == [2, 4, 16]
    jobs = evaluate.plan_jobs(ds, "r001", ckpts, [0.5, 1.0])
    prompts = ds.cfg["train"]["eval"]["prompts"]
    assert len(jobs) == len(prompts) * 2 * len(ds.cfg["train"]["eval"]["seeds"]) * (1 + 3 * 2)
    assert len({j["key"] for j in jobs}) == len(jobs)
    no_trigger = [j for j in jobs if j["variant"] == "n"]
    assert all("siggraph" not in j["text"] and "{" not in j["text"] for j in no_trigger)
    assert no_trigger[0]["text"].startswith("cat,")

    import json
    base = json.loads(evaluate.workflow_path(ds).read_text())
    g = evaluate.build_graph(base, lora="wlora/ds/r001/x.safetensors", strength=0.8, prompt="p", negative="n",
                             seed=7, size=(832, 1216), steps=20, cfg=4.5, prefix="wlora/ds/r001/k")
    assert g["2"]["inputs"]["lora_name"] == "wlora/ds/r001/x.safetensors" and g["6"]["inputs"]["model"] == ["2", 0]
    assert g["6"]["inputs"]["seed"] == 7 and g["5"]["inputs"]["height"] == 1216
    g = evaluate.build_graph(base, lora=None, strength=0, prompt="p", negative="n",
                             seed=7, size=(832, 1216), steps=20, cfg=4.5, prefix="x")
    assert "2" not in g and g["6"]["inputs"]["model"] == ["1", 0]
    assert base["2"]["inputs"]["lora_name"] == ""  # base untouched


def test_eye_tags_only_where_eyes_visible(ds):
    exp = ds.exports_dir / "v1"
    Image.new("RGB", (64, 64)).save(exp / "c.jpg")
    (exp / "c.txt").write_text("siggraph, cat, no humans, closed eyes\n")
    (exp / "manifest.jsonl").write_text(
        json.dumps({"image": "a.jpg", "classification": {"eyes_open": True, "face_visible": True}}) + "\n"
        + json.dumps({"image": "c.jpg", "classification": {"eyes_open": False, "face_visible": True}}) + "\n")
    train.train(ds, "v1", ["eye_tags=orange eyes"], None, dry_run=True)
    data = Path(json.loads((ds.train_dir / "runs" / "r001" / "params.json").read_text())["data"])
    assert (data / "a.txt").read_text().startswith("siggraph, cat, photo (medium), realistic, orange eyes, no humans")
    assert "orange eyes" not in (data / "c.txt").read_text()

    from wlora import evaluate
    (ds.train_dir / "runs" / "r001" / "output" / "ds-r001.safetensors").write_text("")
    jobs = evaluate.plan_jobs(ds, "r001", evaluate.checkpoints(ds.train_dir / "runs" / "r001"), [1.0], ["orange eyes"])
    assert jobs[0]["text"].startswith("siggraph, cat, orange eyes, no humans")
    assert [j for j in jobs if j["variant"] == "n"][0]["text"].startswith("cat, orange eyes,")
