from __future__ import annotations

import time

import torch
from PIL import Image

from . import ModelOutput
from ._hf import free_cuda, quant_config, snapshot_revision

PROMPTS = {
    "descriptive": "Write a medium-length descriptive caption for this image in a casual tone.",
    "danbooru": ("Generate only comma-separated Danbooru tags (lowercase_underscores). Strict order: "
                 "`artist:`, `copyright:`, `character:`, `meta:`, then general tags. Include counts (1girl), "
                 "appearance, clothing, accessories, pose, expression, actions, background. Use precise "
                 "Danbooru syntax. No extra text."),
    "booru": "Write a list of Booru-like tags for this image.",
}


class JoyCaptionBackend:
    """JoyCaption Beta One. Not structured: used for comparison only."""
    structured = False

    def __init__(self, name: str, repo: str, quant: str | None = "nf4", max_new_tokens: int = 300, **_):
        self.name, self.repo, self.quant, self.max_new_tokens = name, repo, quant, max_new_tokens
        self.model = self.proc = None

    def load(self) -> None:
        from transformers import AutoProcessor, LlavaForConditionalGeneration
        self.proc = AutoProcessor.from_pretrained(self.repo)
        self.model = LlavaForConditionalGeneration.from_pretrained(
            self.repo, dtype=torch.bfloat16, device_map="cuda",
            quantization_config=quant_config(self.quant),
        ).eval()

    def revision(self) -> str | None:
        return snapshot_revision(self.repo)

    @torch.inference_mode()
    def run(self, image: Image.Image, prompt: str) -> ModelOutput:
        prompt = PROMPTS.get(prompt, prompt)
        convo = [{"role": "system", "content": "You are a helpful image captioner."},
                 {"role": "user", "content": prompt}]
        s = self.proc.apply_chat_template(convo, tokenize=False, add_generation_prompt=True)
        inp = self.proc(text=[s], images=[image], return_tensors="pt").to(self.model.device)
        inp["pixel_values"] = inp["pixel_values"].to(torch.bfloat16)
        t = time.time()
        out = self.model.generate(**inp, max_new_tokens=self.max_new_tokens, do_sample=False,
                                  suppress_tokens=None, use_cache=True)
        text = self.proc.tokenizer.decode(out[0][inp["input_ids"].shape[1]:], skip_special_tokens=True,
                                          clean_up_tokenization_spaces=False)
        return ModelOutput(text.strip(), time.time() - t)

    def unload(self) -> None:
        self.model = self.proc = None
        free_cuda()
