# LlamaRanch - Design Spec

**Date:** 2026-06-18
**Status:** Approved (design), pending spec review

## Summary

LlamaRanch is a Linux desktop tray application - a port of the macOS LlamaBarn
app (ggml-org/Llama-macOS) - that manages local llama.cpp GGUF models and runs
an OpenAI-compatible inference server. It lives in the system tray (i3bar /
StatusNotifierItem), lets the user pick a model and start/stop `llama-server`
with hardware-aware launch flags, exposes the local endpoint, and opens the
built-in WebUI.

This spec covers the **focused MVP**. A model-catalog/download manager and
auto-unload-on-idle are explicitly out of scope for v1 (see Non-Goals).

## Context

- Target machine: Ubuntu 24.04, **i3 on X11** (GNOME 46 also installed but i3 is
  the active session). i3 has no native tray; `i3bar` renders SNI/AppIndicator
  icons.
- Hardware: NVIDIA RTX A1000 Laptop GPU, ~3.7 GB VRAM (compute 8.6); 20 cores;
  31 GB RAM.
- llama.cpp is already built with CUDA at `/home/madalin/llama.cpp`. Server
  binary: `/home/madalin/llama.cpp/build/bin/llama-server`.
- Models already downloaded under `/home/madalin/llama.cpp/models/`, grouped:
  `chat/` (Qwen3-4B), `coding/` (Qwen2.5-Coder-7B), `vision/` (MiniCPM-V-4.6 +
  `mmproj-*.gguf`), `big-moe/` (Qwen3.6-35B-A3B IQ4_XS).
- Stack: **Tauri v2** (Rust backend + web frontend). Verified present: Rust
  1.94, Node 20, npm 10.8, and system libs webkit2gtk-4.1, gtk+-3.0, libsoup-3.0,
  ayatana-appindicator3-0.1, librsvg-2.0.

## Goals

1. Tray icon (the provided llama SVG) that toggles a small panel window.
2. Discover local GGUF models grouped by folder; pair vision models with mmproj.
3. Start/stop a single `llama-server` with hardware-aware flags; show live status.
4. Show endpoint (`http://127.0.0.1:<port>/v1`) with copy button; open WebUI.
5. Settings: port, models dir, llama-server binary path, expose-to-network.
6. Clean process lifecycle: child server is killed on Stop and on app quit.

## Non-Goals (v1)

- Model catalog browsing / one-click HuggingFace downloads.
- Auto load-on-request and unload-on-idle.
- Running multiple models simultaneously.
- Per-model saved config profiles (beyond the global ngl heuristic + overrides).
- Packaging to distro repos. (A local AppImage/.deb build is a nice-to-have.)

## Architecture

Two halves communicating over Tauri's command/IPC bridge.

### Rust backend (`src-tauri/`)

Modules, each with one clear purpose:

- **`scanner`** - given a models root, walk it recursively, collect `.gguf`
  files (excluding `mmproj-*`), record `{name, path, group(=parent dir), size}`,
  and attach a `mmproj_path` when a sibling `mmproj-*.gguf` exists in the same
  folder. Pure function over a directory; unit-testable with a temp dir.
- **`launch`** - pure function `flags_for(model, hw, config) -> Vec<String>`.
  Hardware-aware `-ngl` heuristic keyed on file size:
  - `<= 3.0 GB`  -> `-ngl 99` (full GPU)
  - `3.0-6.0 GB` -> `-ngl 18` (partial offload)
  - `> 6.0 GB`   -> `-ngl 6`  (mostly CPU, big MoE)
  Always: `--host 127.0.0.1` (or `0.0.0.0` if expose-to-network), `--port`,
  `--ctx-size 4096`, and `--mmproj <path>` when the model has one. Values are
  defaults; a future Settings field can override `-ngl` and `--ctx-size`.
- **`server`** - owns the `llama-server` child process. `start(model)` stops any
  existing child, spawns the process with `launch::flags_for(...)`, captures
  stderr, and polls `GET /health` until ready or timeout. `stop()` kills the
  child. Holds `ServerState { model, pid, port, status }` behind a Mutex in
  Tauri state. On app exit, the child is killed.
- **`config`** - load/save `~/.config/llamaranch/config.json` with defaults:
  `port = 2276`, `models_dir = /home/madalin/llama.cpp/models`,
  `server_bin = /home/madalin/llama.cpp/build/bin/llama-server`,
  `expose_to_network = false`.
- **`commands`** - thin Tauri command layer exposed to the frontend:
  `list_models`, `server_status`, `start_server(model_id)`, `stop_server`,
  `get_endpoint`, `open_webui`, `get_config`, `set_config`, `llama_cpp_version`.
- **`tray`** - build the tray icon from the bundled PNG; left-click toggles the
  panel window, right-click menu offers Show / Quit.

### Web frontend (`src/`)

Vanilla TypeScript + Vite (Tauri default template), no UI framework. A single
panel window styled after the LlamaBarn screenshot:

- Header: app name + "serving: <model>" (or "idle").
- Endpoint row: `localhost:<port>/v1` + copy button.
- "Open WebUI" button.
- Model list grouped by folder; each row: name, size, GPU/CPU badge derived from
  the ngl heuristic, and a Load/Stop button reflecting status.
- Footer: `llama.cpp <version>`, Settings (opens a small form), Quit.

State is pulled from backend commands; after Load/Stop the UI re-queries
`server_status`. A lightweight poll (e.g. every 2s while a start is in progress)
drives the "starting -> running" transition.

## Data Flow

1. **Launch:** backend reads config, scanner lists models, tray icon appears.
   Panel (on first open) calls `list_models` + `server_status` + `get_config`.
2. **Load model:** UI calls `start_server(id)` -> backend stops any child,
   spawns `llama-server`, polls `/health` -> status `running` -> UI updates.
3. **Open WebUI:** `open_webui` opens `http://127.0.0.1:<port>` in the default
   browser (llama-server serves its WebUI at root).
4. **Stop / Quit:** `stop_server` (or app exit) kills the child cleanly.

## Error Handling

- **Missing `llama-server` binary** - `start_server` returns an error; panel
  shows it and points at the configured binary path / Settings.
- **Port in use** - detected on spawn failure or failed `/health`; surfaced as a
  panel message suggesting a different port in Settings.
- **Model load failure (e.g. OOM)** - captured `llama-server` stderr tail is
  shown in the panel instead of a silent hang; status returns to `idle`.
- **Health timeout** - after N seconds with no healthy `/health`, mark failed,
  kill child, show captured stderr.

## Icon & Packaging

- Save the provided SVG as `assets/llamaranch.svg`; render PNGs (e.g. 32, 128,
  256, 512) for tray + app icon via `librsvg`/`resvg`.
- Provide a `llamaranch.desktop` launcher and a small install script.
- Dev loop: `cargo tauri dev`. Release: `cargo tauri build` (AppImage/.deb) as a
  nice-to-have once the MVP runs.

## Testing

- **Unit (Rust):**
  - `scanner`: temp dir of fake `.gguf` + `mmproj-*.gguf` -> correct grouping and
    mmproj pairing; non-gguf ignored.
  - `launch::flags_for`: size buckets -> expected `-ngl`; mmproj appended for
    vision; expose-to-network flips host.
  - `config`: defaults when file absent; round-trip load/save.
  - `server`: command-building and lifecycle exercised against a fake binary
    (a shell script that serves `/health`), avoiding a real model load in tests.
- **Manual verification:** run on the machine - load Qwen3-4B (full GPU), confirm
  WebUI opens and chat works; load the 35B MoE (CPU offload) and confirm it
  starts; Stop and Quit leave no orphaned `llama-server` process.

## Open Questions / Deferred

- Exact panel styling polish (colors, spacing) - refine during implementation
  against the screenshot.
- AppImage/.deb packaging - implement only if time allows after MVP runs.
