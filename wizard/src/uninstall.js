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
// --yes path: remove only config + engine, keep models and brew
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
  if (t.appPath && process.platform !== 'win32') {
    subrow('desktop app at: ' + t.appPath + '  (remove manually if desired)');
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

  // --yes path: plain stdout, remove only config + engine
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

  // The Ink component (closure over targets)
  function UninstallApp() {
    const { exit } = useApp();
    const items = buildItems(targets);
    const checkboxItems = items; // all are checkbox items

    const [checked, setChecked] = useState(() => {
      const init = {};
      for (const it of items) init[it.key] = it.defaultChecked;
      return init;
    });
    const [cursor, setCursor] = useState(0);
    const [step, setStep] = useState('select'); // select | confirm | removing | outro
    const [typedInput, setTypedInput] = useState('');
    const [removeResults, setRemoveResults] = useState([]);
    const [nothingSelected, setNothingSelected] = useState(false);
    const [cancelled, setCancelled] = useState(false);

    // --- Step: select ---
    useInput((input, key) => {
      if (step === 'select') {
        if (key.upArrow) {
          setCursor(c => Math.max(0, c - 1));
          return;
        }
        if (key.downArrow) {
          setCursor(c => Math.min(checkboxItems.length - 1, c + 1));
          return;
        }
        if (input === ' ') {
          const itemKey = checkboxItems[cursor]?.key;
          if (itemKey) {
            setChecked(prev => ({ ...prev, [itemKey]: !prev[itemKey] }));
          }
          return;
        }
        if (key.return) {
          const anyChecked = Object.values(checked).some(Boolean);
          if (!anyChecked) {
            setNothingSelected(true);
            setStep('outro');
          } else {
            setStep('confirm');
          }
          return;
        }
        if (input === 'q' || key.ctrl && input === 'c') {
          exit();
          return;
        }
      }

      if (step === 'confirm') {
        if (key.return) {
          const val = typedInput.trim().toLowerCase();
          if (val === 'yes' || val === 'remove') {
            setStep('removing');
          } else {
            setCancelled(true);
            setStep('outro');
          }
          return;
        }
        if (key.backspace || key.delete) {
          setTypedInput(prev => prev.slice(0, -1));
          return;
        }
        if (input && input.length === 1 && input >= ' ') {
          setTypedInput(prev => prev + input);
          return;
        }
      }
    }, { isActive: step === 'select' || step === 'confirm' });

    // --- Step: removing ---
    useEffect(() => {
      if (step !== 'removing') return;
      const selectedKeys = Object.entries(checked)
        .filter(([, v]) => v)
        .map(([k]) => k);

      (async () => {
        const results = [];
        for (const key of selectedKeys) {
          const itemDef = items.find(it => it.key === key);
          const label = itemDef ? itemDef.label : key;
          setRemoveResults(prev => [...prev, { key, label, status: 'working...' }]);
          const status = await removeKey(key, targets);
          setRemoveResults(prev =>
            prev.map(r => r.key === key ? { ...r, status } : r)
          );
          results.push({ key, label, status });
        }
        setStep('outro');
      })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step]);

    // --- Step: outro exit ---
    useEffect(() => {
      if (step !== 'outro') return;
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }, [step, exit]);

    const selectedKeys = Object.entries(checked).filter(([, v]) => v).map(([k]) => k);
    const keptKeys = Object.entries(checked).filter(([, v]) => !v).map(([k]) => k);

    const keyLabel = (key) => {
      const it = items.find(i => i.key === key);
      return it ? it.label : key;
    };

    // ---- Render ----

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
          const cursor_glyph = isActive ? React.createElement(Text, { color: '#c7a228' }, '❯') : React.createElement(Text, null, ' ');
          const box_glyph = isChecked
            ? React.createElement(Text, { color: '#c7a228' }, '◼')
            : React.createElement(Text, { color: '#6b6456' }, '◻');
          return React.createElement(Box, { key: item.key },
            React.createElement(Text, { color: '#3f3d34' }, '│  '),
            cursor_glyph,
            React.createElement(Text, null, ' '),
            box_glyph,
            React.createElement(Text, null, ' '),
            React.createElement(Text, { color: '#f5f0e8' }, item.label),
            React.createElement(Text, { color: '#6b6456' }, '   ' + item.path),
            item.size ? React.createElement(Text, { color: '#6b6456' }, '   ' + item.size) : null,
          );
        }),
        targets.manualModelsDir
          ? React.createElement(Box, { key: 'manual-models-info' },
              React.createElement(Text, { color: '#3f3d34' }, '│     '),
              React.createElement(Text, { color: '#6b6456' }, 'models (custom location, remove manually): ' + targets.manualModelsDir),
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
          React.createElement(Text, { color: '#f5f0e8' }, 'Type '),
          React.createElement(Text, { color: '#c7a228' }, 'yes'),
          React.createElement(Text, { color: '#f5f0e8' }, ' or '),
          React.createElement(Text, { color: '#c7a228' }, 'remove'),
          React.createElement(Text, { color: '#f5f0e8' }, ' and press Enter to proceed:'),
        ),
        React.createElement(Text, null,
          React.createElement(Text, { color: '#3f3d34' }, '│  '),
          React.createElement(Text, { color: '#f5f0e8' }, typedInput || ''),
          React.createElement(Text, { color: '#c7a228' }, '_'),
        ),
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

    // outro
    const removedLabels = removeResults.length > 0
      ? removeResults.map(r => r.label).join(', ')
      : (nothingSelected ? 'nothing' : 'nothing');

    const keptLabels = keptKeys.length > 0
      ? keptKeys.map(keyLabel).join(', ')
      : 'nothing';

    return React.createElement(Box, { flexDirection: 'column' },
      React.createElement(Text, null,
        React.createElement(Text, { color: '#3f3d34' }, '└  '),
        React.createElement(Text, { color: '#f5f0e8' }, 'The valley is clear.'),
      ),
      cancelled
        ? React.createElement(Text, null,
            React.createElement(Text, { color: '#3f3d34' }, '   '),
            React.createElement(Text, { color: '#6b6456' }, 'cancelled: nothing was removed.'),
          )
        : null,
      !cancelled && !nothingSelected
        ? React.createElement(Text, null,
            React.createElement(Text, { color: '#3f3d34' }, '   '),
            React.createElement(Text, { color: '#6b6456' }, 'removed: ' + removedLabels),
          )
        : null,
      !cancelled && keptKeys.length > 0
        ? React.createElement(Text, null,
            React.createElement(Text, { color: '#3f3d34' }, '   '),
            React.createElement(Text, { color: '#6b6456' }, 'kept: ' + keptLabels),
          )
        : null,
      targets.manualModelsDir
        ? React.createElement(Text, null,
            React.createElement(Text, { color: '#3f3d34' }, '   '),
            React.createElement(Text, { color: '#6b6456' }, 'your custom models dir is at: ' + targets.manualModelsDir),
          )
        : null,
    );
  }

  const app = render(React.createElement(UninstallApp, null));
  await app.waitUntilExit();
}
