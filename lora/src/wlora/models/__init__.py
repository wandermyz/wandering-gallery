"""Vision model backends.

Every backend loads lazily, processes one PIL image at a time and returns
`ModelOutput`. `structured` backends return JSON (description, classification,
tags by category); the others only produce raw text and are used by `wlora compare`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from PIL import Image


@dataclass
class ModelOutput:
    text: str
    seconds: float
    extra: dict = field(default_factory=dict)


class Backend(Protocol):
    name: str
    repo: str
    structured: bool

    def load(self) -> None: ...
    def revision(self) -> str | None: ...
    def run(self, image: Image.Image, prompt: str) -> ModelOutput: ...
    def unload(self) -> None: ...


REGISTRY = {
    "qwen3.5-4b": ("qwen", {"repo": "Qwen/Qwen3.5-4B"}),
    "qwen3.5-9b": ("qwen", {"repo": "Qwen/Qwen3.5-9B", "quant": "nf4"}),
    "qwen3.5-9b-8bit": ("qwen", {"repo": "Qwen/Qwen3.5-9B", "quant": "int8"}),
    "joycaption": ("joycaption", {"repo": "fancyfeast/llama-joycaption-beta-one-hf-llava", "quant": "nf4"}),
    "joycaption-8bit": ("joycaption", {"repo": "fancyfeast/llama-joycaption-beta-one-hf-llava", "quant": "int8"}),
    "wd14": ("wd14", {"repo": "SmilingWolf/wd-eva02-large-tagger-v3"}),
}


def get_backend(name: str, **settings) -> Backend:
    if name not in REGISTRY:
        raise SystemExit(f"unknown model {name!r}; available: {', '.join(REGISTRY)}")
    kind, kw = REGISTRY[name]
    kw = {**kw, **settings}
    if kind == "qwen":
        from .qwen import QwenBackend
        return QwenBackend(name, **kw)
    if kind == "joycaption":
        from .joycaption import JoyCaptionBackend
        return JoyCaptionBackend(name, **kw)
    from .wd14 import WD14Backend
    return WD14Backend(name, **kw)
