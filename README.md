# LlamaRanch

A lightweight Linux tray app for running local LLMs with [llama.cpp](https://github.com/ggml-org/llama.cpp).

Click the tray icon, pick a model, and LlamaRanch launches `llama-server` with
hardware-aware flags and exposes an OpenAI-compatible API plus the built-in
WebUI. A Linux take on the macOS LlamaBarn app.

## Features

- **One-click model serving** - scans your models directory, groups models by
  folder, and starts/stops a single `llama-server` on demand.
- **Hardware-aware launch** - picks GPU offload (`-ngl`) from model size:
  full GPU for small models, partial offload for mid-size, mostly CPU for large
  MoE models.
- **OpenAI-compatible endpoint** - point any compatible client at
  `http://127.0.0.1:2276/v1`, or open the built-in WebUI in one click.
- **Vision support** - automatically pairs multimodal models with their
  `mmproj` file.
- **Native tray popover** - a borderless panel that opens next to the tray icon.

## How it works

LlamaRanch does not embed llama.cpp. It spawns the prebuilt `llama-server`
binary as a subprocess and polls its `/health` endpoint to track readiness.
Update or rebuild llama.cpp independently and LlamaRanch keeps working.

```
LlamaRanch (tray)  --spawn + flags-->  llama-server (llama.cpp)
                   <--GET /health----
                                          serves http://127.0.0.1:2276
                                            /v1  OpenAI API
                                            /    WebUI
```

## Requirements

- Linux with a system tray (e.g. i3bar, GNOME with AppIndicator, KDE)
- A built `llama-server` from llama.cpp
- GGUF models on disk

Build prerequisites (Debian/Ubuntu):

```sh
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev \
  build-essential curl wget file libssl-dev libxdo-dev patchelf
```

Plus Rust and Node 18+.

## Build & run

```sh
npm install
npm run tauri build -- --no-bundle
./src-tauri/target/release/llamaranch
```

### Install as a package

Build a `.deb` and install it (adds the app launcher entry + icon):

```sh
npm run tauri build -- --bundles deb
sudo dpkg -i src-tauri/target/release/bundle/deb/LlamaRanch_*.deb
```

Then launch "LlamaRanch" from your app menu. Enable **Start on login** in
Settings to run it automatically.

## Configuration

Settings live at `~/.config/llamaranch/config.json`:

| Key | Default | Description |
|-----|---------|-------------|
| `port` | `2276` | Server port |
| `models_dir` | `~/llama.cpp/models` | Where to scan for `.gguf` files |
| `server_bin` | `~/llama.cpp/build/bin/llama-server` | Path to `llama-server` |
| `expose_to_network` | `false` | Bind `0.0.0.0` instead of `127.0.0.1` |

Edit them in the app's Settings dialog or directly in the file.

### i3 note

i3 tiles new windows by default. To let the panel float next to the tray, add:

```
for_window [class="Llamaranch"] floating enable, border none
```

## License

MIT
