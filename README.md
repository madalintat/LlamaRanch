<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" alt="LlamaRanch" />

# LlamaRanch

**A quiet ranch for your local models.**

Power, kept quiet. Privacy you can watch. The truth about your models, on your own machine.

[**Website**](https://madalintat.github.io/LlamaRanch/) &nbsp;·&nbsp; [**Documentation**](https://madalintat.github.io/LlamaRanch/docs/) &nbsp;·&nbsp; [**Download**](https://github.com/madalintat/LlamaRanch/releases/latest) &nbsp;·&nbsp; [**Models on Hugging Face**](https://huggingface.co/models?apps=llama.cpp&sort=trending)

![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-18262e)
![Linux](https://img.shields.io/badge/Linux-x86__64%20%2B%20arm64-18262e)
![Windows](https://img.shields.io/badge/Windows-x86__64%20%2B%20Arm-18262e)
![License](https://img.shields.io/badge/license-MIT-b07a3e)
![Built on](https://img.shields.io/badge/built%20on-llama.cpp-2e8b48)

<img src="docs/assets/readme-hero.jpg" width="860" alt="The LlamaRanch model selector over a quiet ranch, one private endpoint for every local model" />

</div>

---

LlamaRanch is the calm front for [llama.cpp](https://github.com/ggml-org/llama.cpp). It keeps your local models behind one private endpoint at `http://127.0.0.1:2276/v1`, picks the right model for each job and keeps it warm, sizes every model to the memory you actually have, and tells you the plain truth about what running local costs you. Point any app, IDE, or SDK that speaks OpenAI at the endpoint and it just works. Nothing you say leaves the valley.

You run the ranch. It does the dirty work.

## What it is

A quiet valley where your models graze as a herd, each one a different animal with its own gait. You walk up, say what you need, and the right one is already saddled and warm. The hard work, fitting models to your machine, sizing context, picking the job's best fit, swapping experts in and out, happens underneath. The surface stays calm. Local by default, online only when you say so.

It comes down to three things.

### 1. Power, kept quiet

llama.cpp is a deep, fast engine with a lot of power most tools never surface. LlamaRanch surfaces it and makes the expert calls for you, so you get the good behavior without the flag-wrangling.

- **One private endpoint.** `http://127.0.0.1:2276/v1` speaks chat completions, embeddings, and model listing. Drop it into Open WebUI, Continue, Zed, Cline, a curl script, or any OpenAI SDK. No keys, no rewrites.
- **The right model for the job, saddled and warm.** The ranch reads each task and hands it to the model that suits it, keeping a small general model warm so the first token comes fast, and hot-swapping experts so a modest machine carries more than it should.
- **Fit to your machine.** Every model is sized to the memory you actually have, with a running estimate so you always know what fits before you load it. No layers to guess, no context to tune by hand.
- **Many models, one server.** Run more than one at a time. Models load when asked and unload when idle.

### 2. Privacy you can watch

Local-first is only worth something if you can trust it. So the ranch shows you.

- Every model, tool, and connector wears a **LOCAL / ONLINE / OFF** tag. No guessing where your words go.
- A square status LED tells you, at a glance, that a model is saddled and home.
- One **Offline** switch closes every gate to the outside at once.
- No account, no telemetry, no cloud dependency. Nothing leaves the valley.

### 3. The truth about your models

When you run a local model you run a shrunk version of it (a quantization). Smaller fits your machine, but it loses a little sharpness, and almost nothing tells you how much. The ranch measures it.

- **Quant Truth.** On your own machine, the ranch measures how much sharpness a given size actually lost, and shows it as a plain grade.
- **The sweet spot for your hardware:** the lightest size that still rides true.
- **Honest about its own limits.** When two sizes are genuinely too close to call, it says so instead of pretending.
- Measured once, on the night shift, remembered forever, never in your way. New animals you bring yourself get measured in the background, or you can ask for it with one button.

## The endpoint

One quiet address any client can ride.

```sh
# list the models on the ranch
curl http://127.0.0.1:2276/v1/models

# chat
curl http://127.0.0.1:2276/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen3-4B-Q4_K_M","messages":[{"role":"user","content":"Hello"}]}'
```

Full API reference: [llama-server docs](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).

## A real catalog

25+ curated GGUF models, picked to fit common hardware, one click to bring one home (add a Hugging Face token for gated repos). Drop your own `.gguf` into the models folder and it wanders in on its own.

## A design of its own

Warm paper and ink, a live dither texture, square status LEDs, light and dark that follow your system, and three bundled typefaces (Newsreader, Instrument Sans, JetBrains Mono). All offline. No web fonts, nothing phones home.

## Platforms

| OS | Arch | Installers |
|----|------|-----------|
| **macOS** | Apple Silicon | `.dmg` |
| **Linux** | x86_64, arm64 | `.deb`, `.AppImage`, `.rpm` |
| **Windows** | x86_64, Arm | `.exe`, `.msi` |

Every platform is first class and updates itself in place (see [Updating](#updating)). macOS builds are ad-hoc signed but not yet notarized, so on first launch right-click the app and choose **Open**.

## Install

### The fast way: one command

```sh
npx @llamaranch/wizard
```

Runs on macOS, Linux, and Windows. The wizard reads your hardware, installs llama.cpp with the right backend, suggests and downloads models that fit your memory, writes your config, and installs the LlamaRanch app. When it finishes, open the app and everything is ready. If a step can't run on its own (no Homebrew, an odd distro), it tells you exactly what to do by hand. Want it headless on a server? `npx @llamaranch/wizard serve` starts the endpoint straight from the terminal.

### By hand

Grab your build from [**Releases**](https://github.com/madalintat/LlamaRanch/releases/latest). You'll also need a `llama-server` from llama.cpp:

- **macOS:** `brew install llama.cpp`
- **Linux / Windows:** a prebuilt from [llama.cpp Releases](https://github.com/ggml-org/llama.cpp/releases/latest) (CPU, CUDA, Vulkan, Metal)

First run finds `llama-server` on your PATH. Open the tray popover, bring a model home from the catalog (or drop in a `.gguf`), saddle it, and start riding.

## Updating

The quickest way, on any OS:

```sh
npx @llamaranch/wizard update
```

It pulls the latest release and reinstalls the app for you. The app also updates itself: LlamaRanch checks [Releases](https://github.com/madalintat/LlamaRanch/releases/latest) when it starts, and when a newer signed build is out a banner appears inside the app.

- **macOS `.dmg`, Windows `.exe` / `.msi`, and the Linux `.AppImage`** update in place. Click **Update** in the banner; the app downloads the new build, checks its signature, and relaunches into it.
- **Linux `.deb`:** download the new package from Releases and install it over the old one: `sudo dpkg -i LlamaRanch_*.deb`.
- **Linux `.rpm`:** download it and run `sudo rpm -Uvh LlamaRanch-*.rpm` (or `sudo dnf install ./LlamaRanch-*.rpm`).

Every update is checked against the signing key, so a tampered build won't install. To stay on a specific version, just download it from Releases.

## How it works

One `llama-server` does the inference; LlamaRanch drives it. The ranch owns the model lifecycle (load, unload, hot-swap), sizes each model to your memory, and keeps the right one warm so the first token comes fast. The built-in chat is the showroom: it proves the endpoint is good by routing the right model, reaching for tools when it needs them, and showing every choice out loud. Nothing is relayed to an outside service.

## Privacy

Local by default, full stop. Every tool wears a LOCAL or ONLINE tag. Flip Offline mode and no tool can touch the internet. The switch is always one click away. No account, no telemetry, nothing leaves the valley.

## Roadmap

**Shipped**

- macOS, Linux, and Windows apps, all first class
- One private OpenAI-compatible endpoint for every local model
- Multiple models loaded at once, fit to your machine
- Job-to-model routing, a warm pool, and hot-swap
- Per-model context and sampling
- A 25+ model catalog and drop-in `.gguf` support
- Legible privacy: LOCAL / ONLINE / OFF tags and one Offline switch
- A built-in chat showroom: routing, hot-swap, a sandboxed tool loop

**Now**

- **Quant Truth:** measure on your machine how much sharpness each model size loses, and name the sweet spot
- **Power surfaced:** guaranteed-valid structured output and auto speculative decoding, set up for you
- **The Ledger:** a live, honest record that nothing left the valley

**Soon**

- A local RAG stack (embeddings and reranking), wired for you
- Fill-in-the-middle for code, routed to a fast model
- More dialects so any agent plugs in

## Build from source

Needs Rust, Node, and a `llama-server` on your PATH. The [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) page lists current minimums for your OS.

```sh
git clone https://github.com/madalintat/LlamaRanch
cd LlamaRanch
npm install
npm run tauri dev      # hot-reload dev loop
npm run tauri build    # production build
```

## Credits

Built on [llama.cpp](https://github.com/ggml-org/llama.cpp) by ggml-org, the project that makes local inference fast. Kin to their macOS app, [Llama](https://github.com/ggml-org/Llama-macOS). The ranch stands on their shoulders, with thanks.

Fonts: [Newsreader](https://fonts.google.com/specimen/Newsreader), [Instrument Sans](https://fonts.google.com/specimen/Instrument+Sans), [JetBrains Mono](https://www.jetbrains.com/legalnotices/jetbrains_mono/), all bundled and offline.

MIT licensed.
