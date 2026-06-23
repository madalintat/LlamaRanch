// uninstall.js -- cleanly remove LlamaRanch and everything it installed

import chalk from 'chalk';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { getConfigPath, readConfig } from './config.js';
import { getModelsDir } from './models.js';
import { LLAMA_INSTALL_DIR } from './engine.js';

// ---------------------------------------------------------------------------
// Brand palette helpers
// ---------------------------------------------------------------------------

const colored = () => !process.env.NO_COLOR && process.stdout.isTTY;

const gold   = (s) => colored() ? chalk.hex('#c7a228')(s)  : s;
const cream  = (s) => colored() ? chalk.hex('#f5f0e8')(s)  : s;
const muted  = (s) => colored() ? chalk.hex('#6b6456')(s)  : s;
const dim    = (s) => colored() ? chalk.hex('#3f3d34')(s)  : s;

// Clack-style glyphs
const G_BAR    = dim('│');
const G_CORNER = dim('└');
const G_TOP    = dim('┌');
const G_CHECK  = gold('◇');
const G_WARN   = gold('▲');
const G_SPIN   = gold('◆');

function line(glyph, text) {
  process.stdout.write(glyph + ' ' + text + '\n');
}

function row(label, value) {
  const paddedLabel = (label + ':').padEnd(16);
  process.stdout.write(G_BAR + '  ' + muted(paddedLabel) + cream(value) + '\n');
}

function subrow(text) {
  process.stdout.write(G_BAR + '    ' + muted(text) + '\n');
}

function blank() {
  process.stdout.write(G_BAR + '\n');
}

// ---------------------------------------------------------------------------
// Path safety guard
// ---------------------------------------------------------------------------

const HOME = os.homedir();
// Also track the real (symlink-resolved) home so that realpathSync results
// pass the safety check on platforms where the user home dir is itself a
// symlink (e.g. macOS /var -> /private/var).
let HOME_REAL = HOME;
try { HOME_REAL = fs.realpathSync(HOME); } catch { /* leave as HOME */ }

// Known safe prefixes: only delete inside these
function safePrefix(p) {
  const homes = HOME_REAL !== HOME ? [HOME, HOME_REAL] : [HOME];
  const known = [];
  for (const home of homes) {
    known.push(
      // config dir (platform-specific, always inside home)
      path.join(home, 'Library', 'Application Support', 'llamaranch'),
      path.join(home, '.config', 'llamaranch'),
      // models dir defaults
      path.join(home, 'Library', 'Application Support', 'llamaranch', 'models'),
      path.join(home, '.local', 'share', 'llamaranch', 'models'),
      // engine
      path.join(home, '.llamaranch'),
      // desktop app (macOS)
      '/Applications/LlamaRanch.app',
      // desktop app (Linux)
      path.join(home, '.local', 'bin', 'LlamaRanch.AppImage'),
      path.join(home, 'Applications', 'LlamaRanch.AppImage'),
      path.join(home, '.local', 'share', 'applications', 'llamaranch.desktop'),
      // Windows APPDATA llamaranch dir
      path.join(home, 'AppData', 'Roaming', 'llamaranch'),
    );
  }

  // Also accept dynamic APPDATA path
  if (process.env.APPDATA) {
    known.push(path.join(process.env.APPDATA, 'llamaranch'));
  }

  // XDG_CONFIG_HOME
  if (process.env.XDG_CONFIG_HOME) {
    known.push(path.join(process.env.XDG_CONFIG_HOME, 'llamaranch'));
  }

  // A custom models_dir from config is allowed if it lives inside home
  // (handled by caller after checking it starts with HOME + sep)
  return known.some(prefix => p === prefix || p.startsWith(prefix + path.sep));
}

function assertSafe(p) {
  if (!p || p.trim() === '') {
    throw new Error('path is empty');
  }
  const resolved = path.resolve(p);
  if (resolved === HOME || resolved === HOME_REAL || resolved === '/') {
    throw new Error('refusing to delete home or root: ' + resolved);
  }
  // Only the macOS app absolute path is allowed outside home.
  const allowedAbs = resolved === '/Applications/LlamaRanch.app' || resolved.startsWith('/Applications/LlamaRanch.app' + path.sep);
  // A path MUST match a known LlamaRanch prefix OR be the exact macOS app path.
  // There is no blanket "anything inside home" allowance.
  if (!safePrefix(resolved) && !allowedAbs) {
    throw new Error('path not in a known LlamaRanch location: ' + resolved);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Disk size (best-effort)
// ---------------------------------------------------------------------------

function dirSizeBytes(p) {
  let total = 0;
  try {
    const entries = fs.readdirSync(p, { recursive: true });
    for (const e of entries) {
      try {
        const full = path.join(p, e.toString());
        const st = fs.statSync(full);
        if (st.isFile()) total += st.size;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return total;
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (bytes >= 1024 * 1024)        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024)               return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

// ---------------------------------------------------------------------------
// Remove a path (file or directory), return status string.
// Safety: if the target is a symlink, remove only the link itself (never
// recurse through it). If the resolved realpath falls outside the whitelist,
// skip and warn instead of deleting.
// ---------------------------------------------------------------------------

function removePath(logicalPath) {
  if (!fs.existsSync(logicalPath) && !isSymlink(logicalPath)) return 'already removed';
  try {
    // Symlink guard: if this entry is itself a symlink, unlink the link only.
    if (isSymlink(logicalPath)) {
      // Resolve the real destination and re-run the safety check on it.
      let realTarget;
      try {
        realTarget = fs.realpathSync(logicalPath);
      } catch {
        // If we cannot resolve it (dangling symlink), it is safe to remove the
        // link itself because there is no destination to accidentally destroy.
        fs.unlinkSync(logicalPath);
        return 'removed (dangling symlink)';
      }
      if (realTarget !== logicalPath) {
        // Real destination differs: ensure it is also a whitelisted location.
        const allowedAbs = realTarget === '/Applications/LlamaRanch.app' ||
          realTarget.startsWith('/Applications/LlamaRanch.app' + path.sep);
        if (!safePrefix(realTarget) && !allowedAbs) {
          return 'symlink-skip:' + realTarget;
        }
      }
      // Remove only the symlink entry, never recurse through it.
      fs.unlinkSync(logicalPath);
      return 'removed';
    }

    // Regular file or directory: standard removal.
    const st = fs.statSync(logicalPath);
    if (st.isDirectory()) {
      fs.rmSync(logicalPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(logicalPath);
    }
    return 'removed';
  } catch (err) {
    return 'error: ' + err.message;
  }
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Spinner (non-TTY safe: just print the line)
// ---------------------------------------------------------------------------

const SPIN_FRAMES = ['◒', '◐', '◓', '◑'];

function makeSpinner(label) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    process.stdout.write(G_BAR + '  ' + muted('removing') + '  ' + cream(label) + '\n');
    return { stop: () => {} };
  }
  let i = 0;
  let last = '';
  const tick = setInterval(() => {
    const frame = cream(SPIN_FRAMES[i % SPIN_FRAMES.length]);
    const msg = '\r' + G_BAR + '  ' + frame + '  ' + cream(label);
    process.stdout.write(msg + ' '.repeat(Math.max(0, last.length - msg.length)));
    last = msg;
    i++;
  }, 100);
  return {
    stop: (statusGlyph, statusLabel) => {
      clearInterval(tick);
      const msg = '\r' + G_BAR + '  ' + statusGlyph + '  ' + cream(label) + ' ' + muted(statusLabel || '');
      process.stdout.write(msg + ' '.repeat(Math.max(0, last.length - msg.length)) + '\n');
    },
  };
}

// ---------------------------------------------------------------------------
// Collect what we are going to remove
// ---------------------------------------------------------------------------

function collectTargets() {
  const configFilePath = getConfigPath();
  const configDirPath  = path.dirname(configFilePath);
  const config         = readConfig(); // may be null

  // models_dir: only consider a config value that is an absolute path string.
  // Relative values (e.g. "." or "models") are never resolved into deletion
  // targets, and tilde paths ("~/Documents") are not absolute per path.isAbsolute.
  const defaultModelsDir = getModelsDir();
  const rawConfigModelsDir = config?.models_dir ?? null;
  const configModelsDir = (
    typeof rawConfigModelsDir === 'string' &&
    path.isAbsolute(rawConfigModelsDir)
  ) ? rawConfigModelsDir : null;

  // Determine whether the config models_dir is a known LlamaRanch location.
  // If it differs from the default AND is not inside a known safe prefix, treat
  // it as a manual item: show it but never delete it.
  const modelsDirs = new Set([defaultModelsDir]);
  let manualModelsDir = null; // shown to user but not removed
  if (configModelsDir && configModelsDir !== defaultModelsDir) {
    if (safePrefix(configModelsDir)) {
      modelsDirs.add(configModelsDir);
    } else {
      // Custom location outside known LlamaRanch paths: inform the user but
      // never auto-delete a folder they may have chosen for their own data.
      manualModelsDir = configModelsDir;
    }
  }

  // engine: LLAMA_INSTALL_DIR (~/.llamaranch/llama.cpp), parent ~/.llamaranch
  const engineInstallDir = path.resolve(LLAMA_INSTALL_DIR); // ~/.llamaranch/llama.cpp
  const llamaRanchDir    = path.dirname(engineInstallDir);   // ~/.llamaranch

  // server_bin from config
  const serverBin = config?.server_bin || null;
  const serverBinIsBrewOrSystem = serverBin && (
    serverBin.startsWith('/opt/homebrew/') ||
    serverBin.startsWith('/usr/local/') ||
    serverBin.startsWith('/usr/bin/') ||
    serverBin.startsWith('/usr/share/')
  );

  // Desktop app paths
  let appPath = null;
  let desktopEntryPath = null;

  if (process.platform === 'darwin') {
    appPath = '/Applications/LlamaRanch.app';
  } else if (process.platform === 'linux') {
    const appImagePrimary = path.join(HOME, '.local', 'bin', 'LlamaRanch.AppImage');
    const appImageFallback = path.join(HOME, 'Applications', 'LlamaRanch.AppImage');
    appPath = fs.existsSync(appImagePrimary) ? appImagePrimary : appImageFallback;
    desktopEntryPath = path.join(HOME, '.local', 'share', 'applications', 'llamaranch.desktop');
  } else {
    // Windows: NSIS owns it; report manual path only
    appPath = null;
  }

  return {
    configFilePath,
    configDirPath,
    config,
    modelsDirs: [...modelsDirs],
    manualModelsDir,
    engineInstallDir,
    llamaRanchDir,
    serverBin,
    serverBinIsBrewOrSystem,
    appPath,
    desktopEntryPath,
  };
}

// ---------------------------------------------------------------------------
// Print the removal plan (used for non-TTY and --yes paths)
// ---------------------------------------------------------------------------

function printPlan(targets) {
  const t = targets;
  process.stdout.write(G_TOP + '\n');
  blank();
  line(G_SPIN, cream('LlamaRanch uninstall') + '  ' + muted('review before removing'));
  blank();

  // Config
  const configExists = fs.existsSync(t.configFilePath);
  row('config file', t.configFilePath + (configExists ? '' : muted(' (not found)')));
  row('config dir',  t.configDirPath);

  // Models
  for (const dir of t.modelsDirs) {
    const exists = fs.existsSync(dir);
    let sizeStr = '';
    if (exists) {
      const bytes = dirSizeBytes(dir);
      sizeStr = '  ' + muted(humanSize(bytes));
    }
    row('models dir', dir + (exists ? '' : muted(' (not found)')) + sizeStr);
  }
  // Custom models_dir outside known LlamaRanch locations: shown but not removed
  if (t.manualModelsDir) {
    row('models (custom location, remove manually)', t.manualModelsDir);
  }

  // Engine
  const engineExists = fs.existsSync(t.engineInstallDir);
  row('engine dir', t.engineInstallDir + (engineExists ? '' : muted(' (not found)')));

  if (t.serverBinIsBrewOrSystem) {
    blank();
    subrow('engine installed via brew/system: ' + t.serverBin);
    subrow('will offer a separate prompt to run: brew uninstall llama.cpp');
  }

  // Desktop app
  if (process.platform === 'win32') {
    blank();
    row('desktop app', 'managed by Windows installer');
    subrow('manual: Settings > Apps > LlamaRanch > Uninstall');
  } else if (t.appPath) {
    const appExists = fs.existsSync(t.appPath);
    row('desktop app', t.appPath + (appExists ? '' : muted(' (not found)')));
    if (t.desktopEntryPath) {
      const deExists = fs.existsSync(t.desktopEntryPath);
      row('.desktop entry', t.desktopEntryPath + (deExists ? '' : muted(' (not found)')));
    }
  }

  blank();

  // Destructive action warning
  process.stdout.write(
    G_BAR + '  ' + G_WARN + '  ' +
    gold('This permanently deletes the items above. Models and config cannot be recovered.') +
    '\n'
  );
  blank();
}

// ---------------------------------------------------------------------------
// Safe-remove helper with spinner (used in --yes path)
// ---------------------------------------------------------------------------

function doRemoveWithSpinner(label, p) {
  const sp = makeSpinner(label);
  let status;
  try {
    const resolved = assertSafe(p);

    // Symlink-resolve guard: compute realpath and re-run assertSafe on it.
    if (fs.existsSync(p) || isSymlink(p)) {
      try {
        const realp = fs.realpathSync(p);
        if (realp !== resolved) {
          assertSafe(realp);
        }
      } catch (realErr) {
        if (realErr.message && realErr.message.startsWith('path not in')) {
          try {
            const realp2 = fs.realpathSync(p);
            sp.stop(G_WARN, p + ' resolves outside LlamaRanch (' + realp2 + '), skipped for safety');
          } catch {
            sp.stop(G_WARN, 'skipped (symlink resolves outside LlamaRanch)');
          }
          return;
        }
      }
    }

    status = removePath(resolved);
  } catch (err) {
    sp.stop(G_WARN, 'skipped: ' + err.message);
    return;
  }

  if (status && status.startsWith('symlink-skip:')) {
    const realTarget = status.slice('symlink-skip:'.length);
    sp.stop(G_WARN, p + ' resolves outside LlamaRanch (' + realTarget + '), skipped for safety');
  } else if (status === 'removed' || status === 'removed (dangling symlink)') {
    sp.stop(G_CHECK, 'removed');
  } else if (status === 'already removed') {
    sp.stop(G_WARN, 'already removed');
  } else {
    sp.stop(G_WARN, status);
  }
}

// ---------------------------------------------------------------------------
// --yes path: remove config + engine + app, keep models and brew
// ---------------------------------------------------------------------------

async function executeYesRemoval(targets) {
  const t = targets;

  process.stdout.write(G_BAR + '\n');

  // Config file
  doRemoveWithSpinner('config file', t.configFilePath);

  // Config dir (only if empty after config file removal)
  if (fs.existsSync(t.configDirPath)) {
    try {
      const remaining = fs.readdirSync(t.configDirPath);
      if (remaining.length === 0) {
        doRemoveWithSpinner('config dir (empty)', t.configDirPath);
      } else {
        const sp = makeSpinner('config dir');
        sp.stop(G_WARN, 'not empty, leaving: ' + t.configDirPath);
      }
    } catch { /* skip */ }
  }

  // Engine dir
  doRemoveWithSpinner('engine dir', t.engineInstallDir);

  // ~/.llamaranch parent dir (only if empty after removing llama.cpp subdir)
  if (t.llamaRanchDir !== HOME && fs.existsSync(t.llamaRanchDir)) {
    try {
      const remaining = fs.readdirSync(t.llamaRanchDir);
      if (remaining.length === 0) {
        doRemoveWithSpinner('~/.llamaranch (empty)', t.llamaRanchDir);
      }
    } catch { /* skip */ }
  }

  // Desktop app (Windows installer owns its own uninstall, so leave a note there)
  if (t.appPath && process.platform !== 'win32') {
    doRemoveWithSpinner('desktop app', t.appPath);
  }

  // Kept items note
  process.stdout.write(G_BAR + '\n');
  process.stdout.write(G_BAR + '  ' + G_WARN + '  ' + muted('kept: models, brew/system engine (if any)') + '\n');
  if (t.modelsDirs.length > 0) {
    for (const dir of t.modelsDirs) {
      subrow('models at: ' + dir + '  (remove manually if desired)');
    }
  }
  if (t.manualModelsDir) {
    subrow('custom models at: ' + t.manualModelsDir + '  (remove manually if desired)');
  }
  if (t.serverBinIsBrewOrSystem) {
    subrow('brew engine: run  brew uninstall llama.cpp  to remove');
  }
  if (t.appPath && process.platform === 'win32') {
    subrow('desktop app: remove from Settings > Apps');
  }
  process.stdout.write(G_BAR + '\n');
}

// ---------------------------------------------------------------------------
// Ink-based selective removal for interactive TTY
// ---------------------------------------------------------------------------

export async function runUninstall({ yes = false } = {}) {
  const { renderLogo } = await import('./logo.js');
  renderLogo();

  const targets = collectTargets();

  // --yes path: plain stdout, remove config + engine + app
  if (yes) {
    printPlan(targets);
    await executeYesRemoval(targets);
    process.stdout.write(G_CORNER + ' ' + cream('The valley is clear.') + '  ' + muted('models and brew engine were kept.') + '\n');
    process.stdout.write('\n');
    return;
  }

  // Non-TTY without --yes: plain stdout, show plan, remove nothing
  if (!process.stdout.isTTY) {
    printPlan(targets);
    process.stdout.write(G_WARN + ' ' + gold('Non-interactive shell detected.') + '\n');
    process.stdout.write(G_BAR + '  ' + muted('Run interactively to choose what to remove, or pass ') + cream('--yes') + muted(' to remove the default set.') + '\n');
    process.stdout.write(G_BAR + '  ' + muted('Nothing was removed.') + '\n');
    process.stdout.write(G_CORNER + '\n');
    process.exit(0);
  }

  // Ink interactive path
  const { render, Text, Box, useInput, useApp } = await import('ink');
  const React = (await import('react')).default;
  const { useState, useEffect } = React;

  // Build the items array from targets (closure over targets)
  function buildItems(t) {
    const items = [];

    // config
    items.push({
      key: 'config',
      label: 'config',
      path: t.configFilePath,
      size: '',
      defaultChecked: true,
    });

    // models
    for (let i = 0; i < t.modelsDirs.length; i++) {
      const dir = t.modelsDirs[i];
      const exists = fs.existsSync(dir);
      let sizeStr = '';
      if (exists) {
        const bytes = dirSizeBytes(dir);
        sizeStr = humanSize(bytes);
      }
      items.push({
        key: i === 0 ? 'models' : 'models_' + i,
        label: 'models',
        path: dir,
        size: sizeStr,
        defaultChecked: false,
      });
    }

    // engine
    items.push({
      key: 'engine',
      label: 'llama.cpp engine',
      path: t.engineInstallDir,
      size: '',
      defaultChecked: true,
    });

    // brew (only if applicable)
    if (t.serverBinIsBrewOrSystem) {
      items.push({
        key: 'brew',
        label: 'brew uninstall llama.cpp',
        path: t.serverBin || '',
        size: '',
        defaultChecked: false,
      });
    }

    // desktop app (macOS or Linux, not Windows)
    if (t.appPath && process.platform !== 'win32') {
      items.push({
        key: 'app',
        label: 'desktop app',
        path: t.appPath,
        size: '',
        defaultChecked: true,
      });
    }

    return items;
  }

  // Safe-remove a single key, return { key, label, status } asynchronously
  async function removeKey(key, t) {
    const doSafe = (label, p) => {
      try {
        const resolved = assertSafe(p);
        if (fs.existsSync(p) || isSymlink(p)) {
          try {
            const realp = fs.realpathSync(p);
            if (realp !== resolved) {
              assertSafe(realp);
            }
          } catch (realErr) {
            if (realErr.message && realErr.message.startsWith('path not in')) {
              return 'skipped (symlink outside LlamaRanch)';
            }
          }
        }
        const status = removePath(resolved);
        if (status && status.startsWith('symlink-skip:')) return 'skipped (symlink outside LlamaRanch)';
        return status;
      } catch (err) {
        return 'skipped: ' + err.message;
      }
    };

    if (key === 'config') {
      const primaryStatus = doSafe('config file', t.configFilePath);
      // Secondary: clean up empty config dir silently
      if (fs.existsSync(t.configDirPath)) {
        try {
          const rem = fs.readdirSync(t.configDirPath);
          if (rem.length === 0) doSafe('config dir', t.configDirPath);
        } catch { /* skip */ }
      }
      return primaryStatus;
    }

    if (key === 'models' || key.startsWith('models_')) {
      // Find corresponding dir by index
      const idx = key === 'models' ? 0 : parseInt(key.slice('models_'.length), 10);
      const dir = t.modelsDirs[idx];
      if (!dir) return 'skipped: dir not found';
      return doSafe('models dir', dir);
    }

    if (key === 'engine') {
      const primaryStatus = doSafe('engine dir', t.engineInstallDir);
      // Secondary: clean up empty parent dir silently
      if (t.llamaRanchDir !== HOME && fs.existsSync(t.llamaRanchDir)) {
        try {
          const rem = fs.readdirSync(t.llamaRanchDir);
          if (rem.length === 0) doSafe('~/.llamaranch', t.llamaRanchDir);
        } catch { /* skip */ }
      }
      return primaryStatus;
    }

    if (key === 'brew') {
      try {
        const { execa } = await import('execa');
        await execa('brew', ['uninstall', 'llama.cpp'], { all: true });
        return 'uninstalled';
      } catch (err) {
        return 'failed: ' + err.message;
      }
    }

    if (key === 'app') {
      const primaryStatus = doSafe('desktop app', t.appPath);
      // Secondary: remove .desktop entry silently
      if (t.desktopEntryPath) doSafe('.desktop entry', t.desktopEntryPath);
      return primaryStatus;
    }

    return 'unknown key';
  }

  // ---------------------------------------------------------------------------
  // Path display helpers (for multiselect rows)
  // ---------------------------------------------------------------------------

  // Replace home dir prefix with ~ and middle-truncate to fit within maxLen chars.
  function shortenPath(p, maxLen) {
    if (!p) return '';
    // Substitute home and real-home prefixes with ~
    let s = p;
    for (const home of HOME_REAL !== HOME ? [HOME_REAL, HOME] : [HOME]) {
      if (s === home) { s = '~'; break; }
      if (s.startsWith(home + path.sep)) { s = '~' + s.slice(home.length); break; }
    }
    if (s.length <= maxLen) return s;
    // Middle-truncate: keep start and the final segment
    const tail = path.basename(s);
    const head = s.slice(0, Math.max(4, maxLen - tail.length - 5));
    return head + '...' + path.sep + tail;
  }

  // Build the items array once outside the component so identity is stable.
  const inkItems = buildItems(targets);

  // The Ink component (closure over targets)
  function UninstallApp({ outroInfo }) {
    const { exit } = useApp();
    const items = inkItems;
    const checkboxItems = items; // all are checkbox items

    const [checked, setChecked] = useState(() => {
      const init = {};
      for (const it of items) init[it.key] = it.defaultChecked;
      return init;
    });
    const [cursor, setCursor] = useState(0);
    const [step, setStep] = useState('select'); // select | confirm | removing | outro
    const [confirmIdx, setConfirmIdx] = useState(0); // 0 = No (default), 1 = Yes
    const [removeResults, setRemoveResults] = useState([]);
    const [nothingSelected, setNothingSelected] = useState(false);
    const [cancelled, setCancelled] = useState(false);

    // Live refs mirror state so the stable input handler never reads stale
    // values and useInput never re-registers mid-typing (which drops keys).
    const stepRef = React.useRef(step); stepRef.current = step;
    const cursorRef = React.useRef(cursor); cursorRef.current = cursor;
    const checkedRef = React.useRef(checked); checkedRef.current = checked;
    const confirmRef = React.useRef(confirmIdx); confirmRef.current = confirmIdx;

    // Guard: call exit() exactly once
    const exitCalled = React.useRef(false);
    const safeExit = React.useCallback(() => {
      if (!exitCalled.current) {
        exitCalled.current = true;
        exit();
      }
    }, [exit]);

    // --- Step: select + confirm input handler ---
    // Memoized with useCallback so that Ink's useInput only re-registers the
    // listener when the values it actually uses change.  Without memoization
    // the anonymous function is new on every render, which causes Ink to
    // remove and re-add the listener on every render tick - opening a window
    // where an incoming keypress is silently dropped.
    // Ink maps \r (carriage return) to key.return=true, and \n (linefeed from
    // PTY on macOS) to key.name='enter' but key.return=false.  Accept both.
    const isEnter = (input, key) => key.return || input === '\r' || input === '\n';

    // Stable handler (refs, not closure values) so useInput registers exactly
    // once. A handler whose identity changed each keystroke made useInput
    // deregister and re-register, and a key pressed in that gap was dropped,
    // which is what silently swallowed the typed confirmation input.
    const handleInput = React.useCallback((input, key) => {
      const s = stepRef.current;
      if (s === 'select') {
        if (key.upArrow) { setCursor(c => Math.max(0, c - 1)); return; }
        if (key.downArrow) { setCursor(c => Math.min(checkboxItems.length - 1, c + 1)); return; }
        if (input === ' ') {
          const itemKey = checkboxItems[cursorRef.current]?.key;
          if (itemKey) setChecked(prev => ({ ...prev, [itemKey]: !prev[itemKey] }));
          return;
        }
        if (isEnter(input, key)) {
          const anyChecked = Object.values(checkedRef.current).some(Boolean);
          if (!anyChecked) { setNothingSelected(true); setStep('outro'); }
          else { setStep('confirm'); }
          return;
        }
        if (input === 'q' || (key.ctrl && input === 'c')) { safeExit(); return; }
        return;
      }
      if (s === 'confirm') {
        if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
          setConfirmIdx(i => (i === 0 ? 1 : 0));
          return;
        }
        if (isEnter(input, key)) {
          if (confirmRef.current === 1) setStep('removing');
          else { setCancelled(true); setStep('outro'); }
          return;
        }
        if (input === 'q' || (key.ctrl && input === 'c')) { setCancelled(true); setStep('outro'); return; }
        return;
      }
    }, [checkboxItems, safeExit]);

    useInput(handleInput, { isActive: true });

    // Snapshot checked at the moment step transitions to 'removing' so the
    // async IIFE never reads stale state via closure.
    const checkedAtRemove = React.useRef(null);

    // --- Step: removing ---
    useEffect(() => {
      if (step !== 'removing') return;
      // Capture checked state once at removal time
      checkedAtRemove.current = checked;
      const selectedKeys = Object.entries(checked)
        .filter(([, v]) => v)
        .map(([k]) => k);

      let active = true;
      (async () => {
        for (const key of selectedKeys) {
          if (!active) break;
          const itemDef = items.find(it => it.key === key);
          const label = itemDef ? itemDef.label : key;
          setRemoveResults(prev => [...prev, { key, label, status: 'working...' }]);
          const status = await removeKey(key, targets);
          if (!active) break;
          setRemoveResults(prev =>
            prev.map(r => r.key === key ? { ...r, status } : r)
          );
        }
        if (active) setStep('outro');
      })();
      return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step]);

    // --- Step: outro exit ---
    // Populate outroInfo, then exit immediately so Ink renders an empty frame.
    // The caller prints the outro once after waitUntilExit() resolves, avoiding
    // the double-print that occurs when Ink renders the final frame both
    // normally and again inside unmount().
    useEffect(() => {
      if (step !== 'outro') return;
      const keptNow = Object.entries(checked).filter(([, v]) => !v).map(([k]) => {
        const it = items.find(i => i.key === k);
        return it ? it.label : k;
      });
      outroInfo.cancelled = cancelled;
      outroInfo.nothingSelected = nothingSelected;
      outroInfo.removed = removeResults.map(r => r.label);
      outroInfo.kept = keptNow;
      safeExit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step]);

    // ---- Render ----

    // Label column width: pad to 18 chars so all labels align.
    const LABEL_W = 18;

    if (step === 'select') {
      return React.createElement(Box, { flexDirection: 'column' },
        React.createElement(Text, { color: '#3f3d34' }, '┌'),
        React.createElement(Text, { color: '#3f3d34' }, '│'),
        React.createElement(Text, null,
          React.createElement(Text, { color: '#c7a228' }, '◆ '),
          React.createElement(Text, { color: '#f5f0e8', bold: true }, 'LlamaRanch'),
          React.createElement(Text, { color: '#6b6456' }, '  uninstall · choose what to remove'),
        ),
        React.createElement(Text, { color: '#3f3d34' }, '│'),
        ...checkboxItems.map((item, i) => {
          const isActive = i === cursor;
          const isChecked = checked[item.key];
          const cursorGlyph = isActive
            ? React.createElement(Text, { color: '#c7a228' }, '❯')
            : React.createElement(Text, null, ' ');
          const boxGlyph = isChecked
            ? React.createElement(Text, { color: '#c7a228' }, '◼')
            : React.createElement(Text, { color: '#6b6456' }, '◻');
          // Fixed-width label, then optional size, then shortened path
          const paddedLabel = item.label.padEnd(LABEL_W);
          const sizeStr = item.size ? item.size.padStart(7) : '       ';
          // Available path width: 80 cols - prefix(5) - cursor(1) - sp(1) - box(1) - sp(1) - label(LABEL_W) - size(7) - sp(2)
          const pathMaxLen = Math.max(20, 80 - 5 - 1 - 1 - 1 - 1 - LABEL_W - 7 - 2);
          const displayPath = shortenPath(item.path, pathMaxLen);
          return React.createElement(Box, { key: item.key },
            React.createElement(Text, { color: '#3f3d34' }, '│  '),
            cursorGlyph,
            React.createElement(Text, null, ' '),
            boxGlyph,
            React.createElement(Text, null, ' '),
            React.createElement(Text, { color: '#f5f0e8' }, paddedLabel),
            React.createElement(Text, { color: '#6b6456' }, sizeStr),
            React.createElement(Text, { color: '#6b6456', wrap: 'truncate-end' }, '  ' + displayPath),
          );
        }),
        targets.manualModelsDir
          ? React.createElement(Box, { key: 'manual-models-info' },
              React.createElement(Text, { color: '#3f3d34' }, '│     '),
              React.createElement(Text, { color: '#6b6456', wrap: 'truncate-end' }, 'models (custom location, remove manually): ' + shortenPath(targets.manualModelsDir, 40)),
            )
          : null,
        React.createElement(Text, { color: '#3f3d34' }, '│'),
        React.createElement(Text, { color: '#6b6456' },
          '│  space toggles · enter confirms · your models and llama.cpp are kept unless you check them'
        ),
      );
    }

    if (step === 'confirm') {
      return React.createElement(Box, { flexDirection: 'column' },
        React.createElement(Text, { color: '#3f3d34' }, '│'),
        React.createElement(Text, null,
          React.createElement(Text, { color: '#3f3d34' }, '│  '),
          React.createElement(Text, { color: '#c7a228' }, '▲  '),
          React.createElement(Text, { color: '#c7a228' }, 'This permanently deletes the items above. Models and config cannot be recovered.'),
        ),
        React.createElement(Text, { color: '#3f3d34' }, '│'),
        React.createElement(Text, null,
          React.createElement(Text, { color: '#c7a228' }, '◆  '),
          React.createElement(Text, { color: '#f5f0e8' }, 'Remove the selected items?'),
        ),
        React.createElement(Text, null,
          React.createElement(Text, { color: '#3f3d34' }, '│  '),
          React.createElement(Text, { color: confirmIdx === 0 ? '#c7a228' : '#6b6456' }, (confirmIdx === 0 ? '❯ ' : '  ') + 'No, keep everything'),
        ),
        React.createElement(Text, null,
          React.createElement(Text, { color: '#3f3d34' }, '│  '),
          React.createElement(Text, { color: confirmIdx === 1 ? '#c7a228' : '#6b6456' }, (confirmIdx === 1 ? '❯ ' : '  ') + 'Yes, remove the selected items'),
        ),
        React.createElement(Text, { color: '#3f3d34' }, '│'),
        React.createElement(Text, { color: '#6b6456' }, '│  arrow keys move · enter selects · default is No'),
      );
    }

    if (step === 'removing') {
      return React.createElement(Box, { flexDirection: 'column' },
        React.createElement(Text, { color: '#3f3d34' }, '│'),
        React.createElement(Text, null,
          React.createElement(Text, { color: '#c7a228' }, '◆  '),
          React.createElement(Text, { color: '#f5f0e8' }, 'Removing selected items...'),
        ),
        ...removeResults.map(r =>
          React.createElement(Text, { key: r.key },
            React.createElement(Text, { color: '#3f3d34' }, '│  '),
            React.createElement(Text, { color: '#c7a228' }, '◒  '),
            React.createElement(Text, { color: '#f5f0e8' }, r.label),
            React.createElement(Text, { color: '#6b6456' }, '   ' + r.status),
          )
        ),
      );
    }

    // outro: return null so Ink renders nothing; the caller prints the message
    // after waitUntilExit() so it appears exactly once.
    return null;
  }

  // Shared mutable object: the component writes its outro info here before
  // calling exit().  The caller reads it after waitUntilExit() and prints it
  // once, avoiding the double-print that happens when Ink renders the final
  // frame both normally and again during unmount().
  const outroInfo = { cancelled: false, nothingSelected: false, removed: [], kept: [] };

  const app = render(React.createElement(UninstallApp, { outroInfo }));
  await app.waitUntilExit();

  // Print outro exactly once, outside of Ink.
  const { cancelled: wasCancelled, nothingSelected: wasNothing, removed, kept } = outroInfo;
  process.stdout.write(G_CORNER + '  ' + cream('The valley is clear.') + '\n');
  if (wasCancelled) {
    process.stdout.write('   ' + muted('cancelled: nothing was removed.') + '\n');
  } else if (removed.length > 0) {
    process.stdout.write('   ' + muted('removed: ' + removed.join(', ')) + '\n');
    if (kept.length > 0) {
      process.stdout.write('   ' + muted('kept: ' + kept.join(', ')) + '\n');
    }
  }
  if (targets.manualModelsDir) {
    process.stdout.write('   ' + muted('your custom models dir is at: ' + targets.manualModelsDir) + '\n');
  }
  process.stdout.write('\n');
}
