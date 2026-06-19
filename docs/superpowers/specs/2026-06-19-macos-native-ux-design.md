# LlamaRanch — Native macOS Feel — Design

**Date:** 2026-06-19
**Status:** Approved for planning
**Branch:** `macos-native-ux` (builds on the verified `macos-dev-loop` work)
**Scope:** Bring LlamaRanch's macOS experience to parity with ggml-org's native Llama app, in three components built in order: (A) a real menubar glyph, (B) a popover-style window + router-process robustness, (C) the model list driven by llama-server's router instead of only the filesystem.

## Motivation

Live verification of the `macos-dev-loop` slice surfaced three UX gaps vs. ggml-org's Llama:

1. The tray icon rendered as a solid white blob (an opaque app icon used as a template image).
2. The window opens as a centered floating panel, not a menubar-anchored popover.
3. The Installed list showed "No models yet" even though llama-server's router exposes a catalog — because LlamaRanch only lists filesystem models.

A fourth issue was found while debugging #3: `tauri dev` hot-reload (and any non-clean exit) **orphans the `llama-server` child**, leaving a stale router on the port that blocks the new one. This is folded into component B.

## Non-goals (deferred)

- HF model **search/browse** in-app (ggml's "Browse more"). The existing Discover tab + hardcoded catalog stay as-is this slice.
- True native `NSPopover` via Objective-C/Cocoa. We emulate popover behavior with a positioned Tauri window (no objc, keeps Linux/Windows working).
- Multiple models loaded at once / per-model config (separate roadmap slices).
- Signing/notarization/CI/distribution (still out of scope, as in the dev-loop slice).
- Linux/Windows behavior changes. All macOS-specific code stays `#[cfg(target_os = "macos")]`-gated; the component C data-model change is cross-platform but must not regress the existing Linux/Windows flows.

## Background (verified facts)

- The app drives one `llama-server` in router mode: `--models-preset <models.ini> --models-max 1 --jinja --fit on --props --host 127.0.0.1 --port 2276`.
- `GET /v1/models` returns, per model: `id`, `status.value` (`unloaded|loading|loaded|sleeping|error`), `status.args` (includes `--hf-repo <repo>` for HF-backed models), `architecture.input_modalities` (vision ⇔ contains `"image"`), and `need_download` (bool). It returns **custom presets** (from our models.ini) **plus** llama-server's **built-in cached presets** plus any HF entries.
- `POST /models/load` / `POST /models/unload` drive lifecycle; loading an HF/built-in model triggers an on-demand download in the router.
- `commands::list_models` currently scans the filesystem and intersects with router status, dropping every model not on disk. This is the root cause of gap #3.
- The brew `llama-server` here is build b9670 with this richer router.

## Component A — Menubar glyph

**Files:** `src-tauri/src/lib.rs`, new asset `src-tauri/icons/tray-glyph.png` (+ `tray-glyph@2x.png`), source `src-tauri/icons/tray-glyph.svg`.

- Author a minimal **monochrome llama silhouette**: a hand-drawn SVG with the llama shape only (no background square), filled solid, on a transparent canvas. Rasterize with `rsvg-convert` to 18×18 and 36×36 PNGs (menubar point size is ~18pt).
- In `TrayIconBuilder`, set the icon explicitly from the embedded glyph bytes (`tauri::image::Image::from_bytes(include_bytes!("../icons/tray-glyph.png"))`) instead of `app.default_window_icon()`.
- On macOS only, re-enable `.icon_as_template(true)` — now correct, because the glyph is alpha-shaped, so macOS tints it for light/dark menubars. On Linux/Windows keep the existing colored window icon (no template).

**Acceptance:** the menubar shows a recognizable monochrome llama that adapts to light/dark, not a white square.

## Component B — Popover window + router robustness

**Files:** `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src-tauri/src/server.rs` (pid tracking).

### Popover behavior
- `tauri.conf.json` main window: `"visible": false` (start hidden — a menubar app opens on demand), keep `"decorations": false`, add `"alwaysOnTop": true` and `"skipTaskbar": true`, remove `"center": true` (we position it).
- Tray: `.show_menu_on_left_click(false)` and an `on_tray_icon_event` handler. On a left **Click** (`button: Left, button_state: Up`), toggle the window:
  - if visible → `hide()`;
  - else position it so its top edge sits just below the tray icon and it is horizontally centered under the icon, using the event's `rect` (icon screen position/size), clamped to the work area; then `show()` + `set_focus()`.
- Right-click still shows a minimal menu (Open, Quit).
- Hide-on-blur: in `on_window_event`, `WindowEvent::Focused(false) => window.hide()` (macOS only) so clicking away dismisses the panel like a popover. The in-window Settings `<dialog>` does not blur the window, so it is unaffected.

### Click/blur race
Clicking the tray icon while the window is open fires both blur (→ hide) and the tray Click (→ toggle), which would hide-then-show. Mitigate with a short debounce: record the last hide timestamp; in the tray Click handler, if a hide happened within ~200 ms, treat the window as already toggled (do nothing). Implementation passes a timestamp through shared state, not wall-clock in the hot path. (Stored as a `Mutex<Instant>` in Tauri state.)

### Orphan-router robustness
- Track the router child PID in a file beside the config: `router.pid` (via `config_sibling`).
- On `start_router`, **before** spawning: read `router.pid`; if that PID is alive **and** its process name contains `llama-server` (guard against PID reuse — never kill an unrelated process), kill it. This reclaims the port after a dev-reload, crash, or any non-clean exit. Then spawn, and write the new child PID to `router.pid`.
- Keep the existing clean-exit kill paths (`server::stop` on window quit / `ExitRequested`).
- The kill is scoped to our recorded PID only; it can never touch the separate ggml Llama app (different process, different port, not our PID).

**Acceptance:** clicking the tray icon opens the panel anchored under the icon; clicking elsewhere hides it; after a `tauri dev` reload or relaunch there is exactly one `llama-server` on our port (no orphans), verified with `pgrep`.

## Component C — Router as the model source of truth

**Files:** `src-tauri/src/server.rs`, `src-tauri/src/commands.rs`, `src/main.ts`.

### Backend
- Extend `server::RouterModel` with `need_download: bool` and `hf_repo: Option<String>` (parsed from `need_download` and from `status.args` containing `--hf-repo <repo>`). Keep `id`, `status`, `vision`.
- Rewrite `commands::list_models` so the **router** list is primary:
  - Start from `server::list_models(port)`.
  - For each router model, look up a filesystem match by `id` (via `scanner::scan`) to enrich `size_bytes`, and set `local = true` when a file exists; otherwise `size_bytes = 0`, `local = false`.
  - `group`: for local models keep the scanner group; for non-local use a source bucket — `"downloadable"` (has `hf_repo` / `need_download`) or `"built-in"`.
  - `placement`: `launch::placement_for(size_bytes)` for local; empty/"—" for non-local (unknown until downloaded).
  - `ModelView` gains: `local: bool`, `need_download: bool`.
  - If the router is not running yet, return `[]` (the header already shows "starting router…").
- `delete_model` stays filesystem-only; it must reject non-local ids with a clear error (the frontend won't offer Delete for them, but the backend guards too).
- `load_model` / `unload_model` are unchanged — they already POST `/models/load|unload` by id, which for HF/built-in models triggers the router's on-demand download then load.

### Frontend (`main.ts`)
- `ModelView` type gains `local: boolean` and `need_download: boolean`.
- `renderInstalled`: render every model the backend returns, grouped by `group`.
  - **Local** models: Load/Stop + Delete (as today).
  - **Non-local** models: Load (label "Get & Load" when `need_download`), a small cloud/download indicator, **no Delete**. Stop when loaded.
  - Size cell shows the file size for local models and "—" (or "cloud") for non-local.
- The empty-state text changes from "No models yet. Try the Discover tab." to a router-aware message (e.g. "Starting router…" when status≠running; the built-in catalog will populate the list once running).

**Acceptance:** with a running router, the Installed tab shows the same set ggml's Llama shows (built-ins + any local models) with correct vision tags and statuses; loading a built-in/HF model downloads-on-demand and serves it; local models remain deletable; loading a local model still works.

## Risks / open questions

- **Click/blur race** (B): if the debounce proves flaky, fall back to hiding only on `Focused(false)` events that are *not* immediately followed by a tray Click, or gate hide-on-blur behind a short timer. Verify empirically on the Mac.
- **Tray rect availability** (B): Tauri's `TrayIconEvent::Click` must carry a usable `rect`. If positioning from `rect` is unreliable, fall back to positioning near the cursor (`event.position`) or top-right under the menubar.
- **PID name check portability** (B): the "is it a llama-server" guard uses `ps -p <pid> -o comm=` on unix and is a no-op fallback on Windows (Windows isn't the target and rarely orphans via dev-reload); the clean-exit kill remains the Windows path.
- **Glyph art quality** (A): the hand-authored silhouette is a first pass; it can be refined later without code changes (swap the asset).
- **Router-empty list during startup** (C): the Installed list is briefly empty until the router is healthy. Acceptable; the header communicates state.

## Testing strategy

- **Rust unit tests** (C): parsing of `RouterModel.need_download` / `hf_repo` from a sample `/v1/models` JSON; `list_models` enrichment merges a filesystem match (size/local=true) and marks a router-only model `local=false`; `delete_model` rejects a non-local id. (Pure parsing/merge logic factored to be testable without a live server, mirroring the dev-loop slice's `exists`-closure pattern.)
- **Rust unit test** (B): the PID-reclaim guard does not kill a PID whose process name lacks `llama-server` (use a sentinel/non-existent PID and a name predicate injected for the test).
- **Manual on the Mac** (A, B, C, GUI): glyph renders monochrome; tray-click popover open/close + hide-on-blur; no orphaned routers after reload (`pgrep`); Installed tab shows built-ins + local; load a built-in (downloads) and a local model; delete a local model.

## Files touched (summary)

- `src-tauri/icons/tray-glyph.svg`, `tray-glyph.png`, `tray-glyph@2x.png` — new glyph assets.
- `src-tauri/src/lib.rs` — tray glyph + template; tray-click popover toggle; hide-on-blur; PID-reclaim call.
- `src-tauri/tauri.conf.json` — window flags (hidden, alwaysOnTop, skipTaskbar, no center).
- `src-tauri/src/server.rs` — `RouterModel` fields + parsing; `router.pid` tracking + reclaim helper.
- `src-tauri/src/commands.rs` — `list_models` router-first + enrichment; `ModelView` fields; `delete_model` non-local guard.
- `src/main.ts` — `ModelView` type; `renderInstalled` local vs non-local affordances; empty-state copy.
