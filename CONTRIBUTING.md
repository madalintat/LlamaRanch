# Contributing to LlamaRanch

Glad you are here. LlamaRanch is a small, friendly project, and help is welcome,
whether that is a bug report, a fix, a new catalog model, or a whole feature.

## Ground rules

- Be kind. This is a calm place.
- Keep changes small and focused. One idea per pull request is easier to review and to live with.
- Match the surrounding code. The Rust modules are small and single purpose on purpose; please keep them that way.
- Open an issue first for anything large, so we can agree on the shape before you spend time on it.

## Project layout

```
src-tauri/src/
  lib.rs        app wiring, tray, router lifecycle
  server.rs     drives the llama-server router, HTTP calls, preset
  commands.rs   the Tauri commands the UI calls
  scanner.rs    finds models on disk, pairs vision projectors
  catalog.rs    the built-in download catalog
  config.rs     settings load and save
  launch.rs     the placement badge heuristic
src/            the panel UI (vanilla TypeScript)
docs/           the website (GitHub Pages)
```

## Develop

```sh
npm install
npm run tauri build -- --no-bundle      # builds and produces ./src-tauri/target/release/llamaranch
cargo test --manifest-path src-tauri/Cargo.toml   # run the Rust tests
```

You need Rust, Node 18+, a built `llama-server`, and the Tauri system libraries
listed in the README.

## Pull requests

- Run `cargo test` and make sure the app still builds before you open a PR.
- Write a clear title and a short description of what changed and why.
- Plain commit messages are perfect. No need for trailers.

## Reporting bugs

Open an issue with what you expected, what happened, your distro and desktop,
and the model you were loading. The router log at `~/.config/llamaranch/router.log`
is often the fastest clue.

## A note on llama.cpp

LlamaRanch drives the prebuilt `llama-server` from
[llama.cpp](https://github.com/ggml-org/llama.cpp). Inference bugs usually belong
upstream; tray, panel, catalog, and packaging bugs belong here.

Thanks for helping out.
