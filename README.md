# wandering-gallery

A self-hosted toolkit for a local image and video generation pipeline built around
[ComfyUI](https://github.com/comfyanonymous/ComfyUI): browse and organize what you
generate, prepare training datasets, and (soon) run generation workflows and LoRA
training from one mobile-friendly web app.

| Folder | What it is |
| --- | --- |
| [`web/`](web/) | The web app (Node.js + Preact): the gallery today, plus generation and training sections as they arrive. See [`web/README.md`](web/README.md) for features, configuration, and development. |
| [`ios/`](ios/) | The native iPhone and iPad app (SwiftUI): every section of the web app, against the same backend. See [`ios/README.md`](ios/README.md). |
| [`lora/`](lora/) | `wlora`: local captioning and classification that prepares image datasets for LoRA training (Python, uv). Copied from [wandering-lora](https://github.com/wandermyz/wandering-lora) at `f6d81ec`; see [`lora/README.md`](lora/README.md). |
| [`deploy/`](deploy/) | systemd user unit(s). |
| [`scripts/`](scripts/) | `install.sh`: builds `web/` and installs or updates the service. |
| [`docs/`](docs/) | Design notes and plans. |

## Install and upgrade

```bash
git clone https://github.com/wandermyz/wandering-gallery.git
cd wandering-gallery
./scripts/install.sh      # first run creates ~/.config/wandering-gallery/config.yaml
$EDITOR ~/.config/wandering-gallery/config.yaml
./scripts/install.sh      # builds, installs and starts the service
```

To upgrade: `git pull && ./scripts/install.sh`. Details, including Tailscale access
and operating the service, are in [`web/README.md`](web/README.md).

## License

MIT
