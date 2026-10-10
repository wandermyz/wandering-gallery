from __future__ import annotations

import csv
import time

import numpy as np
from PIL import Image

from . import ModelOutput
from ._hf import snapshot_revision


class WD14Backend:
    """SmilingWolf WD tagger (ONNX). Not structured: comparison only."""
    structured = False

    def __init__(self, name: str, repo: str, threshold: float = 0.35, **_):
        self.name, self.repo, self.threshold = name, repo, threshold
        self.sess = None

    def load(self) -> None:
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        model = hf_hub_download(self.repo, "model.onnx")
        tags = hf_hub_download(self.repo, "selected_tags.csv")
        with open(tags) as f:
            rows = list(csv.DictReader(f))
        self.names = [r["name"].replace("_", " ") for r in rows]
        self.general = np.array([r["category"] == "0" for r in rows])
        self.sess = ort.InferenceSession(model, providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
        self.size = self.sess.get_inputs()[0].shape[1]

    def revision(self) -> str | None:
        return snapshot_revision(self.repo)

    def run(self, image: Image.Image, prompt: str = "") -> ModelOutput:
        # pad to square on white, resize, RGB->BGR, 0..255 float
        w, h = image.size
        side = max(w, h)
        canvas = Image.new("RGB", (side, side), (255, 255, 255))
        canvas.paste(image, ((side - w) // 2, (side - h) // 2))
        arr = np.asarray(canvas.resize((self.size, self.size), Image.Resampling.BICUBIC), dtype=np.float32)[:, :, ::-1]
        t = time.time()
        probs = self.sess.run(None, {self.sess.get_inputs()[0].name: arr[None].copy()})[0][0]
        idx = [i for i in np.argsort(-probs) if self.general[i] and probs[i] >= self.threshold]
        text = ", ".join(f"{self.names[i]} ({probs[i]:.2f})" for i in idx)
        return ModelOutput(text, time.time() - t)

    def unload(self) -> None:
        self.sess = None
