# LlamaRanch on macOS (dev loop) — Design

**Date:** 2026-06-19
**Status:** Approved for planning
**Scope:** Make LlamaRanch build and run natively on macOS (Apple Silicon) for local development and iteration. No code signing, no notarization, no CI changes, no distribution.

## Goal

A developer on an Apple Silicon Mac can run `npm run tauri dev` (and a local `npm run tauri build`) and get a working LlamaRanch that:

- launches as a **menubar-only** app (no Dock icon),
- automatically finds the Homebrew-installed `llama-server`,
- starts the router and serves models at `http://127.0.0.1:2276/v1`,
- supports load / chat / unload exactly as on Linux.

This unblocks all future work (the agent harness) being developed on the Mac the author actually uses.

## Non-goals (deferred to later slices)

- Code signing and notarization (Gatekeeper-clean install).
- macOS in the GitHub Actions build matrix.
- macOS updater artifacts (`.app.tar.gz` + signature) and in-app auto-update on macOS.
- Any rebrand / identity change (bundle id stays `com.llamaranch.app`).
- Any agent-harness feature (routing, tools, MCP, skills, knowledge base).
- Universal (arm64 + x86_64) binaries — Apple Silicon only for this slice.

## Background / why this is its own slice

LlamaRanch is a Tauri app that drives a single persistent `llama-server` process in router mode. The architecture is already cross-platform; the macOS gaps are **platform-specific defaults and window policy**, not a port.

Two facts drive the design:

1. **Tauri cannot cross-compile.** A macOS build must run on macOS. (Confirmed by the existing CI comment.) Hence macOS is a distinct slice rather than a tweak to the existing Linux/Windows pipeline.
2. **A macOS `.app` does not inherit the shell's `PATH`.** Apps launched from Finder or via a LaunchAgent get a minimal environment without `/opt/homebrew/bin`. So `llama-server` discovery cannot rely on `PATH` / `which` alone; it must probe known absolute locations.

## Current state (as found)

- `config.rs::default_server_bin()` returns `~/llama.cpp/build/bin/llama-server[.exe]`. On a brew-based Mac the binary is at `/opt/homebrew/bin/llama-server`, so a fresh Mac user hits `"llama-server not found"`.
- `lib.rs` builds the tray with `app.default_window_icon()` (a colored PNG) and never sets a macOS activation policy, so the app shows a Dock icon and the menubar glyph is a colored blob.
- `tauri.conf.json` already sets `bundle.targets: "all"`, includes `icon.icns`, and `tauri-plugin-autostart` already uses `MacosLauncher::LaunchAgent`. Icons and bundling are ready.
- Toolchain on the target machine: Apple Silicon (arm64), Rust 1.89, Node 26, Xcode 26.2, `llama-server` at `/opt/homebrew/bin/llama-server`.

## Design

### Component 1 — `llama-server` discovery (`src-tauri/src/config.rs`)

Replace the single hardcoded default path with an ordered candidate search. The first candidate that exists on disk wins. Order:

1. `LLAMARANCH_SERVER_BIN` environment variable, if set and non-empty (explicit override / escape hatch).
2. `/opt/homebrew/bin/llama-server` (Apple Silicon Homebrew).
3. `/usr/local/bin/llama-server` (Intel Homebrew).
4. `~/llama.cpp/build/bin/llama-server` (build-from-source — today's default; preserved for Linux/Windows/source builds).
5. A scan of directories in `PATH` for `llama-server` (last resort; covers non-brew installs when PATH *is* present, e.g. terminal-launched dev runs).

Notes:
- Candidates 2–3 and 5 are macOS/Unix oriented; on Windows the existing `~/llama.cpp/build/bin/llama-server.exe` candidate still resolves, so Windows behavior is unchanged. The list is **additive** — the historical default remains in the list, just lower priority — so Linux and Windows resolve exactly as before.
- If **no** candidate exists, fall back to candidate 4's path (the historical default) so the existing "not found" error message and Settings UX are preserved unchanged.

This logic lives in `default_server_bin()` and is exercised whenever `Config::default()` is constructed (i.e. when no `config.json` exists yet — the fresh-install path).

### Component 2 — Re-discovery on stale config (`src-tauri/src/lib.rs` or `config.rs`)

A user may have a `config.json` whose `server_bin` points at a path that no longer exists (e.g. the old hardcoded default was persisted on a prior run, or Homebrew moved). On startup, after loading config:

- If `config.server_bin` does not exist on disk, re-run discovery (`default_server_bin()`) and adopt the result. Persist the updated config so the fix sticks.
- If discovery also finds nothing, leave the loaded value untouched (preserves the existing error surface).

This is purely corrective and never overrides a path that *does* exist (so a user's explicit Settings choice is respected).

### Component 3 — Native menubar behavior (`src-tauri/src/lib.rs`, macOS-only)

In the Tauri `setup` closure, gated by `#[cfg(target_os = "macos")]`:

- Set `app.set_activation_policy(tauri::ActivationPolicy::Accessory)` → menubar-only, **no Dock icon**. The window remains reachable via the tray's "Open LlamaRanch" item and `show_window()`.
- Build the tray icon as a **template image** via `.icon_as_template(true)` so it renders as a monochrome glyph that adapts to light/dark menubar.

Non-macOS platforms are unaffected (the cfg-gated block compiles out).

Window config in `tauri.conf.json` stays as-is (`visible: true`, `center: true`): on first launch the panel shows so the user sees the app; closing it hides (existing `CloseRequested` handler) and it lives in the menubar thereafter.

### Component 4 — Build / run verification

- **Dev loop:** `npm install` then `npm run tauri dev` (hot-reload of the TS frontend; Rust recompiles on change).
- **Packaged check:** `npm run tauri build` produces an unsigned `.app` / `.dmg` under `src-tauri/target/release/bundle/`. Because it is unsigned, first launch needs a one-time right-click → Open (Gatekeeper). This is expected for an unsigned dev build, not a defect.
- **Docs:** update the README "Platforms" / build section to note LlamaRanch now runs on macOS for local development (brew-installed `llama-server` required). Keep distribution claims unchanged (still Linux/Windows for releases).

## Acceptance criteria

1. On the target Mac with no prior `config.json`, launching the dev build auto-resolves `server_bin` to `/opt/homebrew/bin/llama-server` (no manual Settings edit needed).
2. The app launches **without a Dock icon**; a monochrome tray glyph appears in the menubar; "Open LlamaRanch" shows the panel.
3. Router status reaches `running`; `curl http://127.0.0.1:2276/v1/models` lists models from the models dir.
4. A model loads and answers a chat request via the endpoint; unload works.
5. A `config.json` with a non-existent `server_bin` is auto-corrected on next launch.
6. `cargo test` (in `src-tauri`) passes, including any new discovery unit tests.
7. Linux/Windows discovery behavior is unchanged (verified by unit tests asserting the historical default still resolves when brew paths are absent).

## Risks / open questions

- **Activation policy timing:** `set_activation_policy(Accessory)` must run early enough (in `setup`) to suppress the Dock icon; if a Dock icon still flashes, fall back to setting `LSUIElement`/`ActivationPolicy` via the macOS plist/Info config. Verify empirically.
- **Template icon asset:** the existing colored PNG used as a template image may render poorly (templates expect alpha-only artwork). If it looks wrong, a dedicated monochrome menubar asset is a small follow-up; not blocking the dev loop.
- **`tauri dev` vs Finder PATH:** when launched from the terminal, `PATH` *is* inherited, so candidate 5 may mask the absolute-path candidates. Order puts brew absolute paths ahead of the PATH scan, so behavior is consistent between terminal and Finder launches.

## Testing strategy

- Unit tests in `config.rs`: discovery picks the env override first; picks an existing brew path over the source-build default; falls back to the historical default when nothing exists; respects an existing valid `server_bin` (no re-discovery).
- Manual verification on the target Mac against the acceptance criteria (the GUI/menubar/Gatekeeper behaviors can't be unit-tested).

## Files touched

- `src-tauri/src/config.rs` — discovery + re-discovery helper + unit tests.
- `src-tauri/src/lib.rs` — macOS activation policy + template tray icon; call re-discovery on startup.
- `README.md` — macOS dev-run note.
