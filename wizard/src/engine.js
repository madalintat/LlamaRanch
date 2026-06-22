// engine.js -- installs llama-server engine for LlamaRanch wizard

import os from 'os';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { execa } from 'execa';

export const LLAMA_INSTALL_DIR = os.homedir() + '/.llamaranch/llama.cpp';

// ---------------------------------------------------------------------------
// JSON fetch helper (follows redirects, always https for GitHub API)
// ---------------------------------------------------------------------------

async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https://') ? https : http;
    protocol.get(url, { headers: { 'User-Agent': 'llamaranch-wizard/0.1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        res.resume();
        fetchJSON(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error('Failed to parse JSON from ' + url + ': ' + err.message));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Download helper with redirect following
// ---------------------------------------------------------------------------

async function downloadFile(url, destPath, onProgress, redirectCount = 0) {
  if (redirectCount > 5) throw new Error('Too many redirects');

  const protocol = url.startsWith('https://') ? https : http;

  return new Promise((resolve, reject) => {
    protocol.get(url, { headers: { 'User-Agent': 'llamaranch-wizard/0.1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        res.resume();
        downloadFile(res.headers.location, destPath, onProgress, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode + ' downloading ' + url));
        return;
      }

      const totalBytes = parseInt(res.headers['content-length'] || '0', 10) || null;
      let downloaded = 0;
      const writeStream = fs.createWriteStream(destPath);

      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (totalBytes) {
          const percent = Math.round((downloaded / totalBytes) * 100);
          onProgress?.({ type: 'progress', downloaded, total: totalBytes, percent });
        } else {
          onProgress?.({ type: 'progress', downloaded, total: null, percent: null });
        }
      });

      res.pipe(writeStream);

      writeStream.on('finish', () => resolve(destPath));
      writeStream.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

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
  const arch = detectResult.arch || 'x64';

  onProgress?.('GPU type: ' + gpuType + ', arch: ' + arch);

  // Select the right asset
  let asset = null;

  if (gpuType === 'cuda') {
    asset = assets.find(a => {
      const n = a.name.toLowerCase();
      return n.includes('ubuntu') && n.includes('x64') && n.includes('cuda') && n.endsWith('.zip');
    }) || assets.find(a => {
      const n = a.name.toLowerCase();
      return n.includes('linux') && n.includes('x64') && n.includes('cuda') && n.endsWith('.zip');
    });
  } else if (gpuType === 'vulkan') {
    asset = assets.find(a => {
      const n = a.name.toLowerCase();
      return n.includes('ubuntu') && n.includes('vulkan') && n.endsWith('.zip');
    }) || assets.find(a => {
      const n = a.name.toLowerCase();
      return n.includes('linux') && n.includes('vulkan') && n.endsWith('.zip');
    });
  }

  // CPU fallback
  if (!asset) {
    const archStr = arch === 'arm64' ? 'arm64' : 'x64';
    asset = assets.find(a => {
      const n = a.name.toLowerCase();
      return n.includes('ubuntu') && n.includes(archStr) && !n.includes('cuda') && !n.includes('vulkan') && n.endsWith('.zip');
    }) || assets.find(a => {
      const n = a.name.toLowerCase();
      return n.includes('linux') && n.includes(archStr) && !n.includes('cuda') && !n.includes('vulkan') && n.endsWith('.zip');
    });
  }

  if (!asset) {
    onProgress?.('Could not find a matching release asset for your system.');
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

  const zipPath = path.join(installDir, asset.name);

  try {
    await downloadFile(asset.browser_download_url, zipPath, (evt) => {
      if (evt.type === 'progress' && evt.percent !== null) {
        onProgress?.('Downloading... ' + evt.percent + '%');
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

  onProgress?.('Download complete. Extracting...');

  try {
    await execa('unzip', ['-o', zipPath, '-d', installDir], { all: true });
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

  // Find llama-server binary
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

    // Windows
    onProgress?.('On Windows: download llama.cpp from https://github.com/ggml-org/llama.cpp/releases and add llama-server.exe to your PATH');
    return {
      path: null,
      skipped: false,
      manualRequired: true,
      instructions: 'Download from https://github.com/ggml-org/llama.cpp/releases',
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
