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
// Ask the user to TYPE a confirmation word, not just press Enter.
// Accepts: "yes" or "remove" (case-insensitive). Anything else cancels.
// ---------------------------------------------------------------------------

function askTypedConfirm() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(
      G_SPIN + ' ' + cream('Type ') + gold('yes') + cream(' or ') + gold('remove') +
      cream(' and press Enter to proceed, or anything else to cancel: ')
    );
    rl.question('', (answer) => {
      rl.close();
      const val = answer.trim().toLowerCase();
      resolve(val === 'yes' || val === 'remove');
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
  // Custom models_dir outside known LlamaRanch locations: shown but not removed
  if (t.manualModelsDir) {
    row('models (custom,', t.manualModelsDir);
    subrow('custom location, remove manually if desired)');
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
// Execute removal
// ---------------------------------------------------------------------------

async function executeRemoval(targets, { brewConfirmed = false } = {}) {
  const t = targets;

  // Helper: safe-remove with spinner, including symlink-resolve guard.
  function doRemove(label, p, extraGuard) {
    const sp = makeSpinner(label);
    let status;
    try {
      const resolved = assertSafe(p);
      if (extraGuard && !extraGuard(resolved)) {
        sp.stop(G_WARN, 'skipped (safety check)');
        return;
      }

      // Symlink-resolve guard: compute realpath and re-run assertSafe on it.
      // If the real path falls outside whitelisted locations, skip entirely.
      if (fs.existsSync(p) || isSymlink(p)) {
        try {
          const realp = fs.realpathSync(p);
          if (realp !== resolved) {
            // Real path differs from the logical resolved path.
            // Re-check the real destination against the whitelist.
            assertSafe(realp);
          }
        } catch (realErr) {
          // realpathSync may throw on dangling symlinks; that is fine, we
          // will handle it in removePath. But if assertSafe threw, skip.
          if (realErr.message && realErr.message.startsWith('path not in')) {
            try {
              const realp2 = fs.realpathSync(p);
              sp.stop(G_WARN, p + ' resolves outside LlamaRanch (' + realp2 + '), skipped for safety');
            } catch {
              sp.stop(G_WARN, 'skipped (symlink resolves outside LlamaRanch)');
            }
            return;
          }
          // Other errors from realpathSync are fine: removePath handles them.
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
    process.stdout.write(G_WARN + ' ' + gold('Non-interactive shell detected.') + '\n');
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
      process.stdout.write(G_WARN + ' ' + gold('No TTY for input and --yes not set. Nothing removed.') + '\n');
      process.stdout.write(G_CORNER + '\n');
      process.exit(0);
    }
    // Typed confirmation: user must type "yes" or "remove", not just press Enter.
    confirmed = await askTypedConfirm();
  }

  if (!confirmed) {
    process.stdout.write(G_BAR + '\n');
    line(G_CORNER, muted('Nothing was removed.'));
    process.exit(0);
  }

  // Extra confirm for brew (brew still uses the simple y/N prompt, not typed)
  let brewConfirmed = false;
  if (targets.serverBinIsBrewOrSystem && !yes) {
    if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      brewConfirmed = await new Promise((resolve) => {
        rl.question(gold('◆ ') + cream('Also run brew uninstall llama.cpp?') + ' ' + muted('[y/N] '), (answer) => {
          rl.close();
          resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
        });
      });
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
