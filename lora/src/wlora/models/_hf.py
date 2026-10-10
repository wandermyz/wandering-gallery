from __future__ import annotations

import gc

import torch


def quant_config(quant: str | None):
    if not quant:
        return None
    from transformers import BitsAndBytesConfig
    if quant == "nf4":
        return BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                                  bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    if quant == "int8":
        return BitsAndBytesConfig(load_in_8bit=True)
    raise ValueError(f"unknown quant {quant}")


def snapshot_revision(repo: str) -> str | None:
    try:
        from huggingface_hub import scan_cache_dir
        for r in scan_cache_dir().repos:
            if r.repo_id == repo:
                revs = sorted(r.revisions, key=lambda x: x.last_modified, reverse=True)
                return revs[0].commit_hash if revs else None
    except Exception:
        return None
    return None


def free_cuda() -> None:
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
