// detect.js -- real environment detection for the LlamaRanch install wizard

import os from 'os';
import fs from 'fs';
import path from 'path';
import { execa } from 'execa';
import chalk from 'chalk';

// ---------------------------------------------------------------------------
// GPU detection helpers
// ---------------------------------------------------------------------------

async function detectGpuMacosArm() {
  return { type: 'metal', name: 'Apple Metal (Apple Silicon)', vramGB: null };
}

async function detectGpuLinux() {
  try {
    const { stdout } = await execa('nvidia-smi', [
      '--query-gpu=name,memory.total',
      '--format=csv,noheader,nounits',
    ]);
    const line = stdout.trim().split('\n')[0];
    if (line) {
      const parts = line.split(',');
      const name = parts[0]?.trim() || 'NVIDIA GPU';
      const vramMiB = parseInt(parts[1]?.trim(), 10);
      const vramGB = isNaN(vramMiB) ? null : Math.round((vramMiB / 1024) * 10) / 10;
      return { type: 'cuda', name, vramGB };
    }
  } catch {
    // nvidia-smi not available or failed -- check for vulkan
  }

  // Try Vulkan via vulkaninfo (best-effort)
  try {
    const { stdout } = await execa('vulkaninfo', ['--summary']);
    if (stdout.includes('GPU')) {
      return { type: 'vulkan', name: 'Vulkan GPU', vramGB: null };
    }
  } catch {
    // No Vulkan
  }

  return { type: 'cpu', name: 'CPU (no discrete GPU detected)', vramGB: null };
}

async function detectGpuWindows() {
  try {
    const { stdout } = await execa('wmic', [
      'path', 'win32_VideoController', 'get', 'name',
    ]);
    const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
    // First line is header "Name", skip it
    const name = lines[1] || 'Unknown GPU';
    const type = /nvidia/i.test(name) ? 'cuda' : /amd/i.test(name) ? 'vulkan' : 'cpu';
    return { type, name, vramGB: null };
  } catch {
    return { type: 'cpu', name: 'CPU (no discrete GPU detected)', vramGB: null };
  }
}

async function detectGpu(normalizedOs, normalizedArch) {
  try {
    if (normalizedOs === 'macos' && normalizedArch === 'arm64') {
      return await detectGpuMacosArm();
    } else if (normalizedOs === 'macos') {
      // Intel Mac -- no Metal GPU acceleration for llama.cpp, treat as cpu
      return { type: 'cpu', name: 'Apple GPU (Intel Mac, Metal not supported for llama.cpp)', vramGB: null };
    } else if (normalizedOs === 'linux') {
      return await detectGpuLinux();
    } else if (normalizedOs === 'windows') {
      return await detectGpuWindows();
    }
  } catch {
    // Unexpected error in GPU detection
  }
  return { type: 'cpu', name: 'CPU (no discrete GPU detected)', vramGB: null };
}

// ---------------------------------------------------------------------------
// llama-server detection
// ---------------------------------------------------------------------------

async function detectLlamaServer() {
  const home = os.homedir();
  const candidates = [
    null, // sentinel: run `which` first
    '/opt/homebrew/bin/llama-server',
    '/usr/local/bin/llama-server',
    path.join(home, '.llamaranch', 'llama.cpp', 'llama-server'),
    './llama-server',
  ];

  let foundPath = null;

  // Try `which` first
  try {
    const { stdout } = await execa('which', ['llama-server']);
    const p = stdout.trim();
    if (p) foundPath = p;
  } catch {
    // Not on PATH
  }

  // If `which` failed, try known locations
  if (!foundPath) {
    for (const candidate of candidates) {
      if (candidate === null) continue; // already tried `which`
      try {
        if (fs.existsSync(candidate)) {
          foundPath = path.resolve(candidate);
          break;
        }
      } catch {
        // existsSync threw
      }
    }
  }

  if (!foundPath) {
    return { found: false, path: null, version: null };
  }

  // Try to get version
  let version = null;
  try {
    const { stdout } = await execa(foundPath, ['--version']);
    version = stdout.trim() || null;
  } catch (err) {
    // Some builds print to stderr
    try {
      version = err.stderr?.trim() || null;
    } catch {
      version = null;
    }
  }

  return { found: true, path: foundPath, version };
}

// ---------------------------------------------------------------------------
// App installed detection
// ---------------------------------------------------------------------------

async function detectAppMacos() {
  const appPath = '/Applications/LlamaRanch.app';
  let found = false;
  try {
    found = fs.existsSync(appPath);
  } catch {
    found = false;
  }

  if (!found) {
    return { found: false, path: null, version: null };
  }

  let version = null;
  try {
    const plistPath = `${appPath}/Contents/Info.plist`;
    const { stdout } = await execa('plutil', ['-convert', 'json', '-o', '-', plistPath]);
    const info = JSON.parse(stdout);
    version = info.CFBundleShortVersionString || null;
  } catch {
    version = null;
  }

  return { found: true, path: appPath, version };
}

async function detectAppLinux() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'LlamaRanch.AppImage'),
    path.join(home, 'Applications', 'LlamaRanch.AppImage'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return { found: true, path: p, version: null };
      }
    } catch {
      // continue
    }
  }
  return { found: false, path: null, version: null };
}

async function detectAppWindows() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    localAppData ? path.join(localAppData, 'Programs', 'LlamaRanch') : null,
    'C:\\Program Files\\LlamaRanch',
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return { found: true, path: p, version: null };
      }
    } catch {
      // continue
    }
  }
  return { found: false, path: null, version: null };
}

async function detectApp(normalizedOs) {
  try {
    if (normalizedOs === 'macos') return await detectAppMacos();
    if (normalizedOs === 'linux') return await detectAppLinux();
    if (normalizedOs === 'windows') return await detectAppWindows();
  } catch {
    // Unexpected error
  }
  return { found: false, path: null, version: null };
}

// ---------------------------------------------------------------------------
// brew detection
// ---------------------------------------------------------------------------

async function detectBrew(normalizedOs) {
  if (normalizedOs !== 'macos') return false;
  try {
    const { stdout } = await execa('which', ['brew']);
    return !!stdout.trim();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main detect() entry point
// ---------------------------------------------------------------------------

export async function detect() {
  try {
    const platform = process.platform;
    const arch = process.arch;
    const normalizedOs = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux';
    const normalizedArch = arch === 'arm64' ? 'arm64' : 'x64';

    const totalRamGB = Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10;
    const freeRamGB = Math.round((os.freemem() / (1024 ** 3)) * 10) / 10;

    const [gpu, llamaServer, appInstalled, brew] = await Promise.all([
      detectGpu(normalizedOs, normalizedArch),
      detectLlamaServer(),
      detectApp(normalizedOs),
      detectBrew(normalizedOs),
    ]);

    return {
      os: normalizedOs,
      arch: normalizedArch,
      platform,
      nodeVersion: process.version,
      totalRamGB,
      freeRamGB,
      gpu,
      llamaServer,
      appInstalled,
      brew,
    };
  } catch (err) {
    // detect() must never throw -- return safe defaults
    return {
      os: 'linux',
      arch: 'x64',
      platform: process.platform || 'unknown',
      nodeVersion: process.version || 'unknown',
      totalRamGB: 0,
      freeRamGB: 0,
      gpu: { type: 'cpu', name: 'unknown (detection error)', vramGB: null },
      llamaServer: { found: false, path: null, version: null },
      appInstalled: { found: false, path: null, version: null },
      brew: false,
    };
  }
}

// ---------------------------------------------------------------------------
// formatDetectResult() -- chalk-colored summary string
// ---------------------------------------------------------------------------

export function formatDetectResult(r) {
  const tick = chalk.green('found');
  const cross = chalk.yellow('not found');
  const lines = [];

  lines.push(chalk.bold('Environment Detection Results'));
  lines.push('');
  lines.push(`  OS:           ${chalk.cyan(r.os)} (${r.platform})`);
  lines.push(`  Arch:         ${chalk.cyan(r.arch)}`);
  lines.push(`  Node:         ${chalk.cyan(r.nodeVersion)}`);
  lines.push('');
  lines.push(`  RAM total:    ${chalk.cyan(r.totalRamGB + ' GB')}`);
  lines.push(`  RAM free:     ${chalk.cyan(r.freeRamGB + ' GB')}`);
  lines.push('');

  const gpuLine = `${r.gpu.type.toUpperCase()} - ${r.gpu.name}` +
    (r.gpu.vramGB !== null ? ` (${r.gpu.vramGB} GB VRAM)` : '');
  lines.push(`  GPU:          ${chalk.cyan(gpuLine)}`);
  lines.push('');

  if (r.llamaServer.found) {
    lines.push(`  llama-server: ${tick}  ${chalk.dim(r.llamaServer.path || '')}` +
      (r.llamaServer.version ? chalk.dim('  v' + r.llamaServer.version) : ''));
  } else {
    lines.push(`  llama-server: ${cross}`);
  }

  if (r.appInstalled.found) {
    lines.push(`  App:          ${tick}  ${chalk.dim(r.appInstalled.path || '')}` +
      (r.appInstalled.version ? chalk.dim('  v' + r.appInstalled.version) : ''));
  } else {
    lines.push(`  App:          ${cross}`);
  }

  if (r.os === 'macos') {
    lines.push(`  Homebrew:     ${r.brew ? tick : cross}`);
  }

  lines.push('');
  lines.push(chalk.dim('Press Enter to continue setup...'));

  return lines.join('\n');
}
