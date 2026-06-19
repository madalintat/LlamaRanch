# macOS Dev Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LlamaRanch build and run natively on Apple Silicon for local development — auto-discover the Homebrew `llama-server`, run as a menubar-only app, and serve models like it does on Linux.

**Architecture:** LlamaRanch is a Tauri app driving one `llama-server` router process. The macOS gaps are platform-specific *defaults and window policy*, not a port. We add (1) ordered, PATH-independent `llama-server` discovery in `config.rs`, (2) startup re-discovery for stale config, and (3) a macOS-only activation policy + template tray icon in `lib.rs`.

**Tech Stack:** Rust, Tauri 2, `cargo` (tests), Node/Vite (frontend, unchanged this slice).

## Global Constraints

- **Apple Silicon (arm64) only** this slice. No universal binaries.
- **No code signing, no notarization, no CI changes, no distribution.** Unsigned local `.app` is acceptable (first launch may need right-click → Open).
- **Discovery is additive.** New candidates go *ahead of* the historical default; Linux/Windows resolution must stay identical (the source-build path still resolves when brew paths are absent).
- **macOS-specific code is `#[cfg(target_os = "macos")]`-gated** so other platforms compile out unaffected.
- **Bundle identity unchanged:** `com.llamaranch.app`, productName `LlamaRanch`.
- All Rust commands run from the repo root using `--manifest-path src-tauri/Cargo.toml`.

---

### Task 1: `llama-server` discovery in `config.rs`

Pure, testable selection helpers + the real environment glue that wires them in. Replaces the single hardcoded `default_server_bin()`.

**Files:**
- Modify: `src-tauri/src/config.rs`
- Test: `src-tauri/src/config.rs` (inline `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: nothing (uses `home()` already in the file; `std::path::{Path, PathBuf}` already imported).
- Produces:
  - `fn first_existing(candidates: &[PathBuf], exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf>`
  - `fn reconcile(current: &Path, candidates: &[PathBuf], exists: &dyn Fn(&Path) -> bool) -> PathBuf`
  - `pub fn discover_server_bin() -> String`
  - `pub fn ensure_server_bin(current: &str) -> String`
  - `default_server_bin()` keeps its signature `fn() -> String` (now delegates to `discover_server_bin`), so `Config::default()` is unchanged for callers.

- [ ] **Step 1: Write the failing tests**

Add to the `mod tests` block at the bottom of `src-tauri/src/config.rs`:

```rust
    #[test]
    fn first_existing_returns_earliest_present() {
        let cands = vec![
            PathBuf::from("/a/llama-server"),
            PathBuf::from("/b/llama-server"),
            PathBuf::from("/c/llama-server"),
        ];
        let present = |p: &Path| {
            p == Path::new("/b/llama-server") || p == Path::new("/c/llama-server")
        };
        assert_eq!(
            first_existing(&cands, &present),
            Some(PathBuf::from("/b/llama-server"))
        );
    }

    #[test]
    fn first_existing_none_when_absent() {
        let cands = vec![PathBuf::from("/a/llama-server")];
        assert_eq!(first_existing(&cands, &|_| false), None);
    }

    #[test]
    fn reconcile_keeps_current_when_present() {
        let current = PathBuf::from("/usr/bin/llama-server");
        let cands = vec![PathBuf::from("/opt/homebrew/bin/llama-server")];
        let present = |p: &Path| {
            p == Path::new("/usr/bin/llama-server")
                || p == Path::new("/opt/homebrew/bin/llama-server")
        };
        assert_eq!(reconcile(&current, &cands, &present), current);
    }

    #[test]
    fn reconcile_picks_candidate_when_current_missing() {
        let current = PathBuf::from("/old/llama-server");
        let cands = vec![PathBuf::from("/opt/homebrew/bin/llama-server")];
        let present = |p: &Path| p == Path::new("/opt/homebrew/bin/llama-server");
        assert_eq!(
            reconcile(&current, &cands, &present),
            PathBuf::from("/opt/homebrew/bin/llama-server")
        );
    }

    #[test]
    fn reconcile_keeps_current_when_nothing_present() {
        let current = PathBuf::from("/old/llama-server");
        let cands = vec![PathBuf::from("/opt/homebrew/bin/llama-server")];
        assert_eq!(reconcile(&current, &cands, &|_| false), current);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml first_existing reconcile`
Expected: FAIL — `cannot find function 'first_existing'` / `'reconcile'` (not yet defined).

- [ ] **Step 3: Implement the selection helpers**

In `src-tauri/src/config.rs`, above the existing `fn default_server_bin()`, add:

```rust
/// First candidate that satisfies `exists`, if any. Order = priority.
fn first_existing(candidates: &[PathBuf], exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    candidates.iter().find(|p| exists(p.as_path())).cloned()
}

/// Keep `current` if it exists; otherwise the first existing candidate;
/// otherwise `current` unchanged (preserves the existing not-found UX).
fn reconcile(current: &Path, candidates: &[PathBuf], exists: &dyn Fn(&Path) -> bool) -> PathBuf {
    if exists(current) {
        return current.to_path_buf();
    }
    first_existing(candidates, exists).unwrap_or_else(|| current.to_path_buf())
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml first_existing reconcile`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the real environment glue and swap `default_server_bin`**

Still in `src-tauri/src/config.rs`, replace the existing:

```rust
/// `~/llama.cpp/build/bin/llama-server[.exe]`, resolved per-user and per-OS.
fn default_server_bin() -> String {
    let name = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    home()
        .join("llama.cpp")
        .join("build")
        .join("bin")
        .join(name)
        .to_string_lossy()
        .into_owned()
}
```

with:

```rust
fn server_bin_name() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

/// The historical default: `~/llama.cpp/build/bin/llama-server[.exe]`.
fn source_build_bin() -> PathBuf {
    home()
        .join("llama.cpp")
        .join("build")
        .join("bin")
        .join(server_bin_name())
}

/// Scan `PATH` for `llama-server[.exe]` (last resort; only useful when the
/// process actually has a populated PATH, e.g. terminal-launched dev runs).
fn which_server() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(server_bin_name()))
        .find(|p| p.is_file())
}

/// Ordered `llama-server` locations; first existing wins. Additive across
/// platforms: brew paths are macOS/Unix; `source_build_bin()` keeps Linux,
/// Windows and source builds resolving exactly as before.
fn server_bin_candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(p) = std::env::var_os("LLAMARANCH_SERVER_BIN") {
        if !p.is_empty() {
            v.push(PathBuf::from(p));
        }
    }
    v.push(PathBuf::from("/opt/homebrew/bin/llama-server")); // Apple Silicon brew
    v.push(PathBuf::from("/usr/local/bin/llama-server")); // Intel brew
    v.push(source_build_bin());
    if let Some(p) = which_server() {
        v.push(p);
    }
    v
}

/// Resolve `llama-server` for a fresh config: first existing candidate, else
/// the historical default (so the existing "not found" error/UX is preserved).
pub fn discover_server_bin() -> String {
    first_existing(&server_bin_candidates(), &|p| p.is_file())
        .unwrap_or_else(source_build_bin)
        .to_string_lossy()
        .into_owned()
}

/// Given a possibly-stale stored path, keep it if it still exists, otherwise
/// re-discover. Never overrides a path that exists (respects user's choice).
pub fn ensure_server_bin(current: &str) -> String {
    reconcile(Path::new(current), &server_bin_candidates(), &|p| p.is_file())
        .to_string_lossy()
        .into_owned()
}

fn default_server_bin() -> String {
    discover_server_bin()
}
```

- [ ] **Step 6: Run the full config test suite + build**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — all tests, including the pre-existing `load_missing_returns_default` and `save_then_load_roundtrips` (both sides call the same `default_server_bin`, so equality holds regardless of filesystem). No warnings about unused functions (`discover_server_bin`/`ensure_server_bin` are `pub`).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/config.rs
git commit -m "feat(config): brew-aware, PATH-independent llama-server discovery

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Startup re-discovery wiring in `lib.rs`

On launch, auto-correct a `config.json` whose `server_bin` no longer exists, and persist the fix.

**Files:**
- Modify: `src-tauri/src/lib.rs:20` (the `let cfg = config::load_from(...)` line in `run()`)

**Interfaces:**
- Consumes: `config::ensure_server_bin(&str) -> String`, `config::save_to`, `config::config_path` (Task 1 + existing).
- Produces: in-memory `cfg` with a resolved `server_bin`; updated `config.json` when corrected.

- [ ] **Step 1: Replace the config load with a reconcile-and-persist block**

In `src-tauri/src/lib.rs`, inside `pub fn run()`, replace:

```rust
    let cfg = config::load_from(&config::config_path());
```

with:

```rust
    let mut cfg = config::load_from(&config::config_path());
    // If the stored llama-server path went missing (or a fresh config picked the
    // historical default on a brew-only Mac), re-resolve and persist the fix.
    let resolved = config::ensure_server_bin(&cfg.server_bin);
    if resolved != cfg.server_bin {
        cfg.server_bin = resolved;
        let _ = config::save_to(&config::config_path(), &cfg);
    }
```

(`cfg` is later moved into `AppConfig(Mutex::new(cfg))` unchanged — only its binding becomes `mut`.)

- [ ] **Step 2: Verify it compiles**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds cleanly. (No `unused mut` warning — `cfg.server_bin` is assigned in the `if`.)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(startup): re-discover llama-server when stored path is missing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: macOS menubar behavior in `lib.rs`

Menubar-only (no Dock icon) + template tray icon, macOS-gated.

**Files:**
- Modify: `src-tauri/src/lib.rs` (the `.setup(|app| { ... })` closure, ~lines 50–73)

**Interfaces:**
- Consumes: `tauri::ActivationPolicy` (macOS), existing `TrayIconBuilder`.
- Produces: no Dock icon on macOS; monochrome menubar glyph.

- [ ] **Step 1: Set the accessory activation policy at the top of `setup`**

In `src-tauri/src/lib.rs`, immediately inside `.setup(|app| {` (before the `let open = ...` line), add:

```rust
            // macOS: menubar-only app — no Dock icon, no Cmd-Tab entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
```

- [ ] **Step 2: Make the tray icon a template image**

In the same closure, in the `TrayIconBuilder` chain, add `.icon_as_template(true)` after `.icon(...)`:

```rust
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .tooltip("LlamaRanch")
                .menu(&menu)
```

(`.icon_as_template(true)` only affects macOS rendering; it is ignored on Linux/Windows.)

- [ ] **Step 3: Verify it compiles**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds cleanly on macOS.

> If `app.set_activation_policy(...)` does not resolve on `&mut App` in this Tauri version, use `app.handle().set_activation_policy(tauri::ActivationPolicy::Accessory);` instead — the `AppHandle` method exists on all Tauri 2 macOS builds.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(macos): menubar-only activation policy and template tray icon

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: README note + full manual verification on the Mac

Document the macOS dev run and verify the end-to-end acceptance criteria (GUI/menubar/Gatekeeper behaviors can't be unit-tested).

**Files:**
- Modify: `README.md` (Platforms table + a short "Run on macOS (dev)" note)

- [ ] **Step 1: Update the README**

In `README.md`, under the Platforms section, add a line noting macOS now runs for local development, and add a short subsection after "Build from source":

```markdown
### Run on macOS (development)

LlamaRanch runs natively on Apple Silicon for local development. Install a
`llama-server` first (`brew install llama.cpp`), then:

```sh
npm install
npm run tauri dev          # hot-reload dev loop
npm run tauri build        # unsigned .app/.dmg in src-tauri/target/release/bundle/
```

The dev build is unsigned, so the first launch needs a one-time
right-click → Open (Gatekeeper). `llama-server` is auto-detected from
`/opt/homebrew/bin` (or set `LLAMARANCH_SERVER_BIN`). The app lives in the
menubar — there is no Dock icon.
```

- [ ] **Step 2: Run the dev build**

Run: `npm install` then `npm run tauri dev`
Expected: app window opens; **no Dock icon appears**; a monochrome glyph appears in the menubar.

- [ ] **Step 3: Verify discovery + router**

With the app running, check the endpoint:

Run: `curl -s http://127.0.0.1:2276/v1/models`
Expected: JSON listing the models in your models dir (router status reached `running`). If you have no models yet, download one from the Discover tab first, or drop a `.gguf` in `~/llama.cpp/models`.

- [ ] **Step 4: Verify a chat round-trip**

Run (substitute a real id from Step 3):

```bash
curl -s http://127.0.0.1:2276/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<id-from-step-3>","messages":[{"role":"user","content":"Say hi in 3 words"}]}'
```

Expected: a JSON chat completion (model loads on demand, then answers).

- [ ] **Step 5: Verify stale-config re-discovery**

With the app quit, point the config at a bogus binary and relaunch:

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home()/ "Library/Application Support/llamaranch/config.json"
c = json.loads(p.read_text()) if p.exists() else {}
c["server_bin"] = "/nonexistent/llama-server"
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(c, indent=2))
print("set bogus server_bin")
PY
```

Run `npm run tauri dev` again, then:

Run: `python3 -c "import json,pathlib;print(json.loads((pathlib.Path.home()/'Library/Application Support/llamaranch/config.json').read_text())['server_bin'])"`
Expected: prints `/opt/homebrew/bin/llama-server` (auto-corrected and persisted), and the router reaches `running`.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: document running LlamaRanch on macOS for development

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Acceptance criteria (from the spec)

1. Fresh Mac (no `config.json`) auto-resolves `server_bin` to `/opt/homebrew/bin/llama-server` — verified in Task 4 Step 3 (and Task 1 logic).
2. App launches with **no Dock icon**; monochrome tray glyph; "Open LlamaRanch" shows the panel — Task 3 + Task 4 Step 2.
3. Router reaches `running`; `/v1/models` lists models — Task 4 Step 3.
4. A model loads and answers; unload works — Task 4 Step 4.
5. Stale `server_bin` auto-corrected on next launch — Task 1 (`reconcile`) + Task 2 wiring + Task 4 Step 5.
6. `cargo test` passes incl. new discovery tests — Task 1 Step 6.
7. Linux/Windows discovery unchanged — Task 1 (additive order; `source_build_bin` still resolves) + existing tests still pass.

## Notes / risks

- **Activation-policy timing / Dock flash:** if a Dock icon briefly flashes, the fallback is `app.handle().set_activation_policy(...)` (Task 3 Step 3 note) or setting `LSUIElement` in the macOS Info plist. Verify empirically.
- **Template icon artwork:** the existing colored PNG used as a template may render as a solid silhouette. If it looks wrong in the menubar, a dedicated alpha-only monochrome asset is a small, non-blocking follow-up.
- **Config path:** macOS `dirs::config_dir()` is `~/Library/Application Support`, so config lives at `~/Library/Application Support/llamaranch/config.json` (used in Task 4 Step 5).
