from __future__ import annotations

import time

import torch
from PIL import Image

from . import ModelOutput
from ._hf import free_cuda, quant_config, snapshot_revision


class QwenBackend:
    structured = True

    def __init__(self, name: str, repo: str, quant: str | None = None,
                 max_new_tokens: int = 600, temperature: float = 0, **_):
        self.name, self.repo, self.quant = name, repo, quant
        self.max_new_tokens, self.temperature = max_new_tokens, temperature
        self.model = self.proc = None

    def load(self) -> None:
        from transformers import AutoModelForImageTextToText, AutoProcessor
        self.proc = AutoProcessor.from_pretrained(self.repo)
        self.model = AutoModelForImageTextToText.from_pretrained(
            self.repo, dtype=torch.bfloat16, device_map="cuda",
            quantization_config=quant_config(self.quant),
        ).eval()

    def revision(self) -> str | None:
        return snapshot_revision(self.repo)

    @torch.inference_mode()
    def run(self, image: Image.Image, prompt: str) -> ModelOutput:
        msgs = [{"role": "user", "content": [{"type": "image", "image": image}, {"type": "text", "text": prompt}]}]
        inp = self.proc.apply_chat_template(
            msgs, tokenize=True, add_generation_prompt=True, return_dict=True,
            return_tensors="pt", enable_thinking=False,
        ).to(self.model.device)
        gen = {"max_new_tokens": self.max_new_tokens}
        if self.temperature and self.temperature > 0:
            gen |= {"do_sample": True, "temperature": self.temperature, "top_p": 0.9}
        else:
            gen |= {"do_sample": False}
        t = time.time()
        out = self.model.generate(**inp, **gen)
        text = self.proc.decode(out[0][inp["input_ids"].shape[1]:], skip_special_tokens=True)
        return ModelOutput(text.strip(), time.time() - t, {"input_tokens": int(inp["input_ids"].shape[1])})

    def unload(self) -> None:
        self.model = self.proc = None
        free_cuda()
