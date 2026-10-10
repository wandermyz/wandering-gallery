# Plan: first generation flow (prompt → tags → images)

Status: implemented · 2026-10-10

## Goal

Bring the `comfy-tags` terminal script into the Generate section as its first flow,
`/generate/wai-illustrious-tags`. The script itself is not reused; ComfyUI is driven
through `comfy-cli` wherever it offers the operation.

1. Type a description (中文 / English) and pick a number of tag variations.
   Qwen (inside ComfyUI) turns it into Danbooru tags. Variation 1 uses the
   description as-is; every other variation gets randomly suggested traits and
   sampling on, so each one is a different-looking character.
2. Every variation is an editable text box; variations can be regenerated,
   removed or added one at a time.
3. Pick images per variation and generate variations × batch images (random
   seeds). Progress and finished images show on the page; tapping an image opens
   it in the gallery viewer.

## Decisions

- **comfy-cli does the ComfyUI work**: `run --wait --json` for the tagging graph,
  `jobs status` for its text output, `jobs watch` for progress and outputs,
  `jobs cancel` for cancelling.
- **Image jobs are posted straight to ComfyUI's `/prompt`**, because `comfy-cli run`
  can't attach `extra_pnginfo`. That metadata is what puts the UI workflow,
  `source_prompt` and `tags` into each PNG, so the image can be dragged back into
  ComfyUI and the gallery can show the source prompt. Everything after submission
  goes through comfy-cli.
- **Workflow graphs live in the repo** (`comfyui/workflows/`, API and UI format),
  with every prompt field blanked.
- **Prompts never go into git.** The tagger system prompt, the variation
  instruction, the trait lists, the quality tags and the negative prompt are read
  from a local file, `~/.config/wandering-gallery/prompts/wai-illustrious-tags.yaml`.
  If the file is missing, the page says so and lists the keys it needs.
- **Runs are tracked in server memory** (most recent 30): they survive closing or
  reloading the page, but not a server restart. The images are in the gallery
  either way.
- **ComfyUI not running → error message.** The app never starts ComfyUI.
- Output images are matched to gallery assets through `generate.outputLibrary`
  (default: the library with id `comfyui`).

## Config (`generate:` in config.yaml, all optional)

```yaml
generate:
  comfyui: http://127.0.0.1:8188   # ComfyUI server
  comfyCli: comfy-cli              # comfy-cli executable
  outputLibrary: comfyui           # library that holds ComfyUI's output folder
  promptsDir: ~/.config/wandering-gallery/prompts
  # workflowsDir: defaults to <repo>/comfyui/workflows
```

## API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/generate/flows` | flows and whether each is ready (prompts file found) |
| GET | `/api/generate/status` | ComfyUI reachable? |
| POST | `/api/generate/flows/:flow/tags` | `{prompt, vary}` → `{tags}` |
| POST | `/api/generate/flows/:flow/runs` | `{prompt, variations[], batch}` → run |
| GET | `/api/generate/runs` | recent runs |
| GET | `/api/generate/runs/:id` | one run (jobs, progress, outputs → asset ids) |
| POST | `/api/generate/runs/:id/cancel` | cancel unfinished jobs |

## Verification

- vitest: graph building, prompts-file validation, run tracking with a fake
  ComfyUI client, API validation.
- Playwright: the page against a fake comfy-cli + fake ComfyUI (desktop and
  iPhone), with no horizontal scrolling.
- Manual: one real run (1 variation × 1 image) against the local ComfyUI, then
  check the PNG metadata in the gallery.
