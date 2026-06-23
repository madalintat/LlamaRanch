// uninstall.js -- cleanly remove LlamaRanch and everything it installed

import chalk from 'chalk';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { createInterface } from 'readline';
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
const warn   = (s) => colored() ? chalk.hex('#c7a228')(s)  : s;
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

// Known safe prefixes: only delete inside these
function safePrefix(p) {
  const home = HOME;
  const known = [
    // config dir (platform-specific, always inside home)
    path.join(home, 'Library', 'Application Support', 'llamaranch'),
    path.join(home, '.config', 'llamaranch'),
    // Windows APPDATA -- may be outside home, but still guard it
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
  ];

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
  if (resolved === HOME || resolved === '/') {
    throw new Error('refusing to delete home or root: ' + resolved);
  }
  // Must be either: inside home, or /Applications/LlamaRanch.app
  const insideHome = resolved.startsWith(HOME + path.sep);
  const allowedAbs = resolved === '/Applications/LlamaRanch.app' || resolved.startsWith('/Applications/LlamaRanch.app' + path.sep);
  if (!insideHome && !allowedAbs) {
    throw new Error('path outside home and not a known absolute app path: ' + resolved);
  }
  if (!safePrefix(resolved) && !allowedAbs) {
    // Also accept a custom models_dir strictly inside home
    if (!insideHome) {
      throw new Error('path not in a known LlamaRanch location: ' + resolved);
    }
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
// Remove a path (file or directory), return status string
// ---------------------------------------------------------------------------

function removePath(p) {
  if (!fs.existsSync(p)) return 'already removed';
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      fs.rmSync(p, { recursive: true, force: true });
    } else {
      fs.unlinkSync(p);
    }
    return 'removed';
  } catch (err) {
    return 'error: ' + err.message;
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
    const frame = chalk.hex('#f5f0e8')(SPIN_FRAMES[i % SPIN_FRAMES.length]);
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
// Ask yes/no in TTY
// ---------------------------------------------------------------------------

function askConfirm(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(gold('◆ ') + cream(prompt) + ' ' + muted('[y/N] '), (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

// ---------------------------------------------------------------------------
// Collect what we are going to remove
// ---------------------------------------------------------------------------

function collectTargets() {
  const configFilePath = getConfigPath();
  const configDirPath  = path.dirname(configFilePath);
  const config         = readConfig(); // may be null

  // models_dir: prefer config value, fall back to default
  const defaultModelsDir = getModelsDir();
  const configModelsDir  = config?.models_dir || null;
  // Use config if it's different from default; keep both if needed
  const modelsDirs = new Set([defaultModelsDir]);
  if (configModelsDir && configModelsDir !== defaultModelsDir) {
    modelsDirs.add(configModelsDir);
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
    engineInstallDir,
    llamaRanchDir,
    serverBin,
    serverBinIsBrewOrSystem,
    appPath,
    desktopEntryPath,
  };
}

// ---------------------------------------------------------------------------
// Print the removal plan
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
}

// ---------------------------------------------------------------------------
// Execute removal
// ---------------------------------------------------------------------------

async function executeRemoval(targets, { brewConfirmed = false } = {}) {
  const t = targets;

  // Helper: safe-remove with spinner
  function doRemove(label, p, extraGuard) {
    const sp = makeSpinner(label);
    let status;
    try {
      const resolved = assertSafe(p);
      if (extraGuard && !extraGuard(resolved)) {
        sp.stop(G_WARN, 'skipped (safety check)');
        return;
      }
      status = removePath(resolved);
    } catch (err) {
      sp.stop(G_WARN, 'skipped: ' + err.message);
      return;
    }
    if (status === 'removed') {
      sp.stop(G_CHECK, 'removed');
    } else if (status === 'already removed') {
      sp.stop(G_WARN, 'already removed');
    } else {
      sp.stop(G_WARN, status);
    }
  }

  process.stdout.write(G_BAR + '\n');

  // 1. Config file
  doRemove('config file', t.configFilePath);

  // 2. Config dir (only if it becomes empty)
  if (fs.existsSync(t.configDirPath)) {
    try {
      const remaining = fs.readdirSync(t.configDirPath);
      if (remaining.length === 0) {
        doRemove('config dir (empty)', t.configDirPath);
      } else {
        // Warn but leave it: models dir might live here on some platforms
        const sp = makeSpinner('config dir');
        sp.stop(G_WARN, 'not empty, leaving: ' + t.configDirPath);
      }
    } catch {
      // skip
    }
  }

  // 3. Models dirs
  for (const dir of t.modelsDirs) {
    doRemove('models dir', dir);
  }

  // 4. Engine dir
  doRemove('engine dir', t.engineInstallDir);

  // 5. ~/.llamaranch parent dir (only if empty after removing llama.cpp subdir)
  const llamaRanchDir = t.llamaRanchDir;
  if (llamaRanchDir !== HOME && fs.existsSync(llamaRanchDir)) {
    try {
      const remaining = fs.readdirSync(llamaRanchDir);
      if (remaining.length === 0) {
        doRemove('~/.llamaranch (empty)', llamaRanchDir);
      }
    } catch { /* skip */ }
  }

  // 6. Brew/system engine
  if (t.serverBinIsBrewOrSystem && brewConfirmed) {
    const { execa } = await import('execa');
    const sp = makeSpinner('brew uninstall llama.cpp');
    try {
      await execa('brew', ['uninstall', 'llama.cpp'], { all: true });
      sp.stop(G_CHECK, 'uninstalled');
    } catch (err) {
      sp.stop(G_WARN, 'failed: ' + err.message);
    }
  } else if (t.serverBinIsBrewOrSystem && !brewConfirmed) {
    process.stdout.write(G_BAR + '  ' + G_WARN + '  ' + muted('brew engine skipped: run ') + cream('brew uninstall llama.cpp') + muted(' manually') + '\n');
  }

  // 7. Desktop app
  if (process.platform !== 'win32' && t.appPath) {
    doRemove('desktop app', t.appPath);
  }

  // 8. Linux .desktop entry
  if (t.desktopEntryPath) {
    doRemove('.desktop entry', t.desktopEntryPath);
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runUninstall({ yes = false } = {}) {
  const { renderLogo } = await import('./logo.js');
  renderLogo();

  const targets = collectTargets();

  printPlan(targets);

  // Non-TTY without --yes: show plan only, refuse
  if (!process.stdout.isTTY && !yes) {
    process.stdout.write(G_WARN + ' ' + warn('Non-interactive shell detected.') + '\n');
    process.stdout.write(G_BAR + '  ' + muted('Pass ') + cream('--yes') + muted(' to confirm deletion without a prompt.') + '\n');
    process.stdout.write(G_BAR + '  ' + muted('Nothing was removed.') + '\n');
    process.stdout.write(G_CORNER + '\n');
    process.exit(0);
  }

  // Determine confirmation
  let confirmed = yes;

  if (!confirmed) {
    if (!process.stdin.isTTY) {
      // Piped stdin without --yes
      process.stdout.write(G_WARN + ' ' + warn('No TTY for input and --yes not set. Nothing removed.') + '\n');
      process.stdout.write(G_CORNER + '\n');
      process.exit(0);
    }
    confirmed = await askConfirm('Remove all of this?');
  }

  if (!confirmed) {
    process.stdout.write(G_BAR + '\n');
    line(G_CORNER, muted('Nothing removed. The valley stands.'));
    process.exit(0);
  }

  // Extra confirm for brew
  let brewConfirmed = false;
  if (targets.serverBinIsBrewOrSystem && !yes) {
    if (process.stdin.isTTY) {
      brewConfirmed = await askConfirm('Also run brew uninstall llama.cpp?');
    }
  } else if (targets.serverBinIsBrewOrSystem && yes) {
    // --yes: skip brew to be conservative; brew manages its own packages
    brewConfirmed = false;
  }

  await executeRemoval(targets, { brewConfirmed });

  // Outro
  process.stdout.write(G_BAR + '\n');
  process.stdout.write(G_CORNER + ' ' + cream('The valley is clear.') + '  ' + muted('models you added elsewhere are untouched.') + '\n');
  process.stdout.write('\n');
}
