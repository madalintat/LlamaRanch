<div align="center">

<img src="src-tauri/icons/128x128.png" width="92" alt="LlamaRanch" />

# LlamaRanch

**A cosy home for your LLMs — on Linux.**

Run local models with [llama.cpp](https://github.com/ggml-org/llama.cpp) from your system tray.
Pick a model, click load, chat.

![Linux](https://img.shields.io/badge/Linux-tray%20app-14202a)
![License](https://img.shields.io/badge/license-MIT-e0a23c)
![Built on](https://img.shields.io/badge/built%20on-llama.cpp-2ea043)

<img src="docs/assets/screenshot.png" width="360" alt="LlamaRanch panel" />

</div>

---

LlamaRanch is a small tray app that runs one `llama-server` in the background and
serves every model behind a single OpenAI-compatible endpoint. A Linux take on
the macOS [LlamaBarn](https://github.com/ggml-org/Llama-macOS).

## Features

- **One-click serving** — load a model from the panel; it loads on demand and unloads when idle.
- **Hardware-aware** — `--fit` auto-sizes GPU layers and context to the memory you have. No flags to tune.
- **Text & vision** — multimodal models are detected and paired with their projector automatically.
- **Big models too** — anything larger than your VRAM runs split across GPU and RAM.
- **OpenAI-compatible** — point Continue, Zed, Open WebUI, or your own scripts at `http://127.0.0.1:2276/v1`.
- **Built-in catalog** — discover and download models from Hugging Face, with a token for gated repos.
- **100% local** — nothing leaves your machine.

## Install

**Package (Debian/Ubuntu):**

```sh
npm run tauri build -- --bundles deb
sudo dpkg -i src-tauri/target/release/bundle/deb/LlamaRanch_*.deb
```

Launch **LlamaRanch** from your app menu. Enable **Start on login** in Settings.

**From source:**

```sh
git clone https://github.com/madalintat/LlamaRanch
cd LlamaRanch
npm install
npm run tauri build -- --no-bundle
./src-tauri/target/release/llamaranch
```

Needs Rust, Node 18+, a built `llama-server`, and (Debian/Ubuntu) the Tauri
system libraries:

```sh
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev \
  build-essential curl wget file libssl-dev libxdo-dev patchelf
```

## Connect any app

The server speaks the OpenAI API, so any compatible client works — just set the
base URL:

```sh
curl http://127.0.0.1:2276/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen3-4B-Q4_K_M","messages":[{"role":"user","content":"hi"}]}'
```

Or click **Open WebUI** in the panel to chat in your browser.

## Models

Drop any `.gguf` in your models folder, or grab one from the **Discover** tab.
Anything that runs in llama.cpp runs here.

- [GGUF models on Hugging Face](https://huggingface.co/models?library=gguf&sort=trending)
- [Official GGUFs from ggml-org](https://huggingface.co/ggml-org)

## How it works

LlamaRanch doesn't embed llama.cpp — it drives the prebuilt `llama-server` binary
and talks to it over HTTP. Update llama.cpp on your own schedule; the ranch keeps
running.

```
LlamaRanch (tray)  --spawn + flags-->  llama-server (llama.cpp)
                   <---- /health -----
                                         serves  127.0.0.1:2276
                                           /v1   OpenAI API
                                           /     built-in WebUI
```

Settings live in `~/.config/llamaranch/config.json` (port, models dir,
`llama-server` path, idle timeout, network exposure, HF token).

## License

MIT
