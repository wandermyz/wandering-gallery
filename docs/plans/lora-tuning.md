# Plan: LoRA training and semi-automatic tuning

Status: in progress · 2026-10-11 (phases 1–2 implemented; Siggraph tuned by hand to r003 e14; phases 3–4 not built)

## Goal

Train an anime-style LoRA of a subject (first: Siggraph the cat) for
WAI-Illustrious SDXL v17.0 from a photo dataset made with `wlora`, and find good
training settings by hill-climbing: the machine trains, renders and scores
candidates; the user picks between the best ones in the gallery.

## Decisions

- **Trainer: kohya sd-scripts** (`sdxl_train_network.py`), checked out at
  `~/Codebase/sd-scripts` with its own uv venv (torch cu130). Not vendored; its
  path is `train.sd_scripts` in `dataset.yaml`. Its output loads as is in
  ComfyUI's `LoraLoaderModelOnly`.
- **Base model = the generation model** (`waiIllustriousSDXL_v170.safetensors`).
  The LoRA only has to work with WAI.
- **UNet only.** The text encoders stay frozen; when captions aren't shuffled or
  dropped, their outputs are cached (sd-scripts can't cache them otherwise).
- **Photos on an anime model.** Training captions get style tags
  (`photo (medium), realistic`) after the class tags, so the photo look goes to
  those tags instead of the trigger word. At generation they're left out (or put
  in the negative prompt). The tags are a tunable parameter.
- **CLIP skip: nothing to do.** SDXL already uses the penultimate layer in both
  sd-scripts and ComfyUI.
- **ComfyUI is always running; there's no run window.** Before training, wlora
  asks ComfyUI to unload its models (`POST /free`); it never stops or starts it.
  While training runs, generating in ComfyUI can run out of VRAM (16 GB).
- **Training data is prepared from an export**, never from `images/` directly:
  images are downscaled to ≤ 2 MP (originals go up to 8192 px) and the style
  tags are added. Cached per (export, max pixels, style tags).
- **Everything for one run lives in one folder**, `<dataset>/train/runs/<run>/`:
  `params.json` (the full parameter set), the generated `config.toml` and
  `dataset.toml`, `train.log`, and `output/` with one `.safetensors` every
  `save_every_n_epochs`. `output/` is symlinked into ComfyUI as
  `models/loras/wlora/<dataset>/<run>/`, so every epoch is selectable there.

## Phase 1: train by hand (done)

```sh
wlora train ~/Datasets/siggraph --export v1                  # baseline, name r001, r002, ...
wlora train ~/Datasets/siggraph --export v1 --set learning_rate=5e-5 --set network_dim=32
wlora train ~/Datasets/siggraph --export v1 -n               # write configs only
```

Defaults (`train.params` in `dataset.yaml`):

| Parameter | Default | |
| --- | --- | --- |
| `resolution` | 1024 | bucketing 512–2048, step 64 |
| `network_dim` / `network_alpha` | 16 / 8 | |
| `learning_rate` | 1e-4 | AdamW8bit, cosine, 5% warmup |
| `batch_size` × `epochs` | 2 × 16 | ≈ 780 steps for 97 images |
| `save_every_n_epochs` | 2 | 8 checkpoints per run |
| `min_snr_gamma` | 5 | |
| `style_tags` | `photo (medium), realistic` | |
| `eye_tags` | none | added to open-eye images (from the classification) and eval prompts |
| `shuffle_caption`, `caption_dropout_rate` | off, 0 | either one turns off text-encoder caching |

Expected: ~25–35 min per run on the RTX 5070 Ti.

## Phase 2: evaluation (done)

`wlora eval <dataset> <run>` renders a fixed eval set for every checkpoint ×
LoRA strength (0.6 / 0.8 / 1.0) through ComfyUI, then scores it.

- **Eval set** (fixed seeds, same for every candidate, in `train.eval`):
  a training-like scene, out-of-distribution scenes (fantasy forest, scarf,
  chibi), a close-up, and the same prompts **without** the trigger word.
- **Graph**: `comfyui/workflows/wai-illustrious-lora.api.json`
  (CheckpointLoader → LoraLoaderModelOnly → KSampler), posted to `/prompt`
  with `extra_pnginfo` like the Generate flow, so the run, epoch and strength
  are in each PNG.
- **Outputs** go to `ComfyUI/output/wlora/<dataset>/<run>/`, so they're gallery
  assets in the `comfyui` library.
- **Implemented so far**: rendering, resumable via `eval/manifest.json` (re-renders
  when a prompt's text changes), and one contact sheet per prompt in
  `…/<run>/sheets/` (rows: epochs, first row no LoRA; columns: strengths). A run's
  `eye_tags` are added to its eval prompts too. Scoring is not built yet.
- **Scores** (planned; local; `scores.json` per run):

  | Score | How | Use |
  | --- | --- | --- |
  | markings | Qwen3.5 checklist from `subject.features` | rank |
  | identity | DINOv2 similarity to the training photos | rank (weak) |
  | anime-ness | VLM "illustration or photo?" | gate |
  | prompt adherence | VLM checklist of the requested scene | gate |
  | leakage | LPIPS of no-trigger images vs. no-LoRA WAI, same seed | gate |

## Results so far (Siggraph)

| Run | Change | Outcome |
| --- | --- | --- |
| r001 | baseline (rank 16, lr 1e-4) | identity from epoch 6; eyes green below strength 1.0–1.2 |
| r002 | lr 2e-4 | amber eyes at 0.8; stiff (photo poses) from epoch 12 |
| r003 | rank 32/16 | **champion**: e14 @ 1.0, round eyes, keeps chibi style |
| r004 | `orange eyes` tags | too saturated, tints the whole scene orange |

| r005 | rank 32 + lr 1.5e-4 | about the same as r003 |
| r006 | rank 32 + `amber eyes` tags | best hue and chibi, still tints scenes amber |
| r007 | rank 64/32 | sharpest markings; twice the file size |

- Round 1: the user ranked r003 e14 @ 1.0 > r002 e10 @ 1.0 > r001 e10 @ 1.0.
- Round 2: no single winner; preferences split by prompt.
- Round 3: the four finalists over 4 seeds (`wlora eval --seeds`) looked nearly
  alike within each seed: the seed mattered more than the training differences.
  **Chosen: r003 epoch 14 @ 1.0**, installed as `models/loras/siggraph.safetensors`
  and used by the gallery's LoRA flow (`generate.loras`).

Lessons for the automated version:

- Compare close candidates on several seeds; one seed per prompt only shows big
  differences.
- Eye-colour tags in the captions fix the eyes but tint the whole scene.
- Rank mattered more than learning rate; the best epochs were near the end
  (10–14 of 16) at strength 1.0.

## Phase 3: hill-climbing

`wlora tune <dataset> --export v1` keeps a champion and runs rounds:

1. Propose 2–3 neighbours of the champion, each changing one parameter by one
   step: training length ×½/×2, learning rate ×½/×2, network dim 8/16/32,
   style tags on/off, caption dropout 0/0.05, pose/background tags kept/dropped.
2. Train each one, evaluate every checkpoint × strength, gate, rank.
3. Ask the user: champion vs. the top challengers, as A/B grids with the
   same prompts and seeds.
4. The winner becomes champion. A parameter that won gets a bigger step; one
   that lost twice is frozen.
5. Stop after 2 rounds without a new champion.

The first round is only the baseline run with its epoch × strength sweep, to
check the scores against the user's picks before searching. If the automatic
ranking keeps disagreeing with the picks, it only filters, and the user ranks.

State is in `<dataset>/train/tune.json` (champion, history, pending
comparisons). A round finishes on its own; the next round starts once its
comparisons are answered.

A larger move once the basics are tuned: add WAI img2img anime versions of
the subject (approved in the gallery) to the dataset.

## Phase 4: comparisons in the gallery

`/train/<dataset>` in the Train section:

- runs with params, status and progress (read from the run folders);
- the comparison page `/train/<dataset>/compare`: two grids side by side,
  left / right / tie, one pair at a time. Picks go to `tune.json` and are
  combined with Bradley–Terry. Tapping an image opens it in the viewer.

The server reads and writes only the `train/` folder of datasets listed under
`train.datasets` in the gallery config; wlora does the training and rendering.

## Verification

- pytest: config generation, data preparation (downscale, style tags, cache
  key), run naming, `--set` parsing.
- Manual: the baseline run trains to the end, its checkpoints show up in
  ComfyUI's LoRA list, and one renders with the trigger word.
