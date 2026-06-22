// engine.js -- installs llama-server engine for LlamaRanch wizard

import os from 'os';
import fs from 'fs';
import path from 'path';
import { execa } from 'execa';
import { fetchJSON, downloadFile } from './http.js';

export const LLAMA_INSTALL_DIR = os.homedir() + '/.llamaranch/llama.cpp';

// ---------------------------------------------------------------------------
// macOS install via brew
// ---------------------------------------------------------------------------

async function installMacos(detectResult, onProgress) {
  if (!detectResult.brew) {
    onProgress?.('brew not found. Install brew first: https://brew.sh');
    return {
      path: null,
      skipped: false,
      manualRequired: true,
      instructions: 'Install Homebrew then run: brew install llama.cpp',
    };
  }

  onProgress?.('Running: brew install llama.cpp');

  try {
    const proc = execa('brew', ['install', 'llama.cpp'], { all: true });

    proc.all?.on('data', (chunk) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        const trimmed = line.trimEnd();
        if (trimmed) onProgress?.(trimmed);
      }
    });

    await proc;

    // Get the path to the installed binary
    const { stdout: whichOut } = await execa('which', ['llama-server']);
    const binPath = whichOut.trim() || null;
    onProgress?.('llama-server installed at ' + binPath);
    return { path: binPath, skipped: false };
  } catch (err) {
    onProgress?.('brew install failed: ' + err.message);
    onProgress?.('Install llama.cpp manually: https://github.com/ggml-org/llama.cpp');
    return {
      path: null,
      skipped: false,
      manualRequired: true,
      instructions: 'Install Homebrew then run: brew install llama.cpp',
    };
  }
}

// ---------------------------------------------------------------------------
// Linux install via GitHub release download
// Real asset pattern (b9757 release example):
//   llama-b9757-bin-ubuntu-x64.tar.gz        (cpu, x64)
//   llama-b9757-bin-ubuntu-arm64.tar.gz      (cpu, arm64)
//   llama-b9757-bin-ubuntu-vulkan-x64.tar.gz (vulkan, x64)
//   llama-b9757-bin-ubuntu-vulkan-arm64.tar.gz (vulkan, arm64)
//   llama-b9757-bin-ubuntu-rocm-7.2-x64.tar.gz (rocm/amd)
//   NO standalone cuda tar.gz for ubuntu (cuda assets are win-only zips)
// ---------------------------------------------------------------------------

async function installLinux(detectResult, onProgress) {
  onProgress?.('Fetching latest llama.cpp release from GitHub...');

  let release;
  try {
    release = await fetchJSON('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest');
  } catch (err) {
    onProgress?.('Failed to fetch release info: ' + err.message);
    return {
      path: null,
      skipped: false,
      error: err.message,
      manualRequired: true,
      instructions: 'Install llama.cpp manually: https://github.com/ggml-org/llama.cpp',
    };
  }

  const assets = release.assets || [];
  const gpuType = detectResult.gpu?.type || 'cpu';
  // detect.js normalises arch to 'x64' or 'arm64' -- both match the ubuntu asset names directly
  const arch = detectResult.arch || 'x64';

  onProgress?.('GPU type: ' + gpuType + ', arch: ' + arch);

  let asset = null;
  let cudaFallback = false;

  // GPU-specific assets (all .tar.gz on Linux)
  if (gpuType === 'cuda') {
    // There are no standalone cuda ubuntu tar.gz in recent releases; fall back to CPU with note.
    // ROCm exists for x64 but not for arm64 and is not CUDA, so we skip it.
    asset = null;
    cudaFallback = true;
  } else if (gpuType === 'vulkan') {
    asset = assets.find(a => {
      const n = a.name.toLowerCase();
      return n.includes('ubuntu') && n.includes('vulkan') && n.includes(arch) && n.endsWith('.tar.gz');
    });
  }

  // CPU fallback (also used when no matching gpu asset found)
  if (!asset) {
    // Match: llama-<build>-bin-ubuntu-<arch>.tar.gz
    // exclude vulkan/rocm/openvino/sycl/s390x variants for the cpu pick
    asset = assets.find(a => {
      const n = a.name.toLowerCase();
      return (
        n.includes('ubuntu') &&
        n.includes(arch) &&
        n.endsWith('.tar.gz') &&
        !n.includes('vulkan') &&
        !n.includes('rocm') &&
        !n.includes('openvino') &&
        !n.includes('sycl') &&
        !n.includes('opencl') &&
        !n.includes('android')
      );
    });

    if (cudaFallback && asset) {
      onProgress?.('No CUDA asset found for Linux -- using CPU build instead.');
      onProgress?.('For CUDA support, build llama.cpp from source: https://github.com/ggml-org/llama.cpp');
    }
  }

  if (!asset) {
    onProgress?.('Could not find a matching release asset for your system (arch=' + arch + ').');
    return {
      path: null,
      skipped: false,
      manualRequired: true,
      instructions: 'Install llama.cpp manually: https://github.com/ggml-org/llama.cpp',
    };
  }

  onProgress?.('Downloading asset: ' + asset.name);

  // Prepare install dir
  const installDir = LLAMA_INSTALL_DIR;
  try {
    fs.mkdirSync(installDir, { recursive: true });
  } catch (err) {
    onProgress?.('Failed to create install dir: ' + err.message);
    return {
      path: null,
      skipped: false,
      error: err.message,
      manualRequired: true,
      instructions: 'Install llama.cpp manually: https://github.com/ggml-org/llama.cpp',
    };
  }

  const archivePath = path.join(installDir, asset.name);

  // Skip download only if the FINAL file (not a .part) already exists
  if (!fs.existsSync(archivePath)) {
    try {
      await downloadFile(asset.browser_download_url, archivePath, (received, total) => {
        if (total) {
          onProgress?.('Downloading... ' + Math.round((received / total) * 100) + '%');
        }
      });
    } catch (err) {
      onProgress?.('Download failed: ' + err.message);
      return {
        path: null,
        skipped: false,
        error: err.message,
        manualRequired: true,
        instructions: 'Install llama.cpp manually: https://github.com/ggml-org/llama.cpp',
      };
    }
  } else {
    onProgress?.('Archive already downloaded, re-extracting...');
  }

  onProgress?.('Download complete. Extracting...');

  try {
    await execa('tar', ['-xzf', archivePath, '-C', installDir], { all: true });
  } catch (err) {
    onProgress?.('Extraction failed: ' + err.message);
    return {
      path: null,
      skipped: false,
      error: err.message,
      manualRequired: true,
      instructions: 'Install llama.cpp manually: https://github.com/ggml-org/llama.cpp',
    };
  }

  // Find llama-server binary -- may be under build/bin/ or bin/ or root of extracted dir
  let binPath = null;
  try {
    const entries = fs.readdirSync(installDir, { recursive: true });
    for (const entry of entries) {
      const basename = path.basename(entry.toString());
      if (basename === 'llama-server') {
        const full = path.join(installDir, entry.toString());
        try {
          const stat = fs.statSync(full);
          if (stat.isFile()) {
            binPath = full;
            break;
          }
        } catch {
          // stat failed, skip
        }
      }
    }
  } catch (err) {
    onProgress?.('Failed to locate llama-server binary: ' + err.message);
  }

  if (!binPath) {
    onProgress?.('llama-server binary not found after extraction.');
    return {
      path: null,
      skipped: false,
      manualRequired: true,
      instructions: 'Install llama.cpp manually: https://github.com/ggml-org/llama.cpp',
    };
  }

  // chmod +x
  try {
    fs.chmodSync(binPath, 0o755);
  } catch (err) {
    onProgress?.('Warning: could not chmod binary: ' + err.message);
  }

  onProgress?.('llama-server installed at ' + binPath);
  return { path: binPath, skipped: false };
}

// ---------------------------------------------------------------------------
// Main installEngine() export
// ---------------------------------------------------------------------------

export async function installEngine(detectResult, { onProgress, onSkip } = {}) {
  try {
    // Already installed -- skip
    if (detectResult.llamaServer?.found === true) {
      const msg = 'llama-server already installed at ' + detectResult.llamaServer.path;
      onSkip?.(msg);
      return { path: detectResult.llamaServer.path, skipped: true };
    }

    const osType = detectResult.os;

    if (osType === 'macos') {
      return await installMacos(detectResult, onProgress);
    }

    if (osType === 'linux') {
      return await installLinux(detectResult, onProgress);
    }

    // Windows: provide clear manual instructions with .exe awareness
    const instructions = [
      'Download llama.cpp for Windows from:',
      '  https://github.com/ggml-org/llama.cpp/releases',
      'Choose llama-<build>-bin-win-cpu-x64.zip (or cuda/vulkan variant).',
      'Extract it and add the folder containing llama-server.exe to your PATH.',
    ].join('\n');
    onProgress?.(instructions);
    return {
      path: null,
      skipped: false,
      manualRequired: true,
      instructions,
    };
  } catch (err) {
    onProgress?.('Engine install error: ' + err.message);
    return {
      path: null,
      skipped: false,
      error: err.message,
      manualRequired: true,
      instructions: 'Install llama.cpp manually: https://github.com/ggml-org/llama.cpp',
    };
  }
}
