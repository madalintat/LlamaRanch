// models.js -- model catalog and download logic for the LlamaRanch install wizard

import os from 'os';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

export const MODEL_CATALOG = [
  {
    id: 'gemma-3-4b-vision',
    name: 'Gemma 3 4B Vision',
    repo: 'ggml-org/gemma-3-4b-it-GGUF',
    file: 'gemma-3-4b-it-Q4_K_M.gguf',
    sizeGB: 3.4,
    group: 'vision',
    description: 'Multimodal: image + text understanding',
  },
  {
    id: 'qwen3-8b',
    name: 'Qwen3 8B',
    repo: 'unsloth/Qwen3-8B-GGUF',
    file: 'Qwen3-8B-Q4_K_M.gguf',
    sizeGB: 5.0,
    group: 'chat',
    description: 'Fast general-purpose chat (8B)',
  },
  {
    id: 'qwen2.5-coder-7b',
    name: 'Qwen2.5 Coder 7B',
    repo: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF',
    file: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
    sizeGB: 4.7,
    group: 'coding',
    description: 'Code generation and completion',
  },
  {
    id: 'llama-3.2-3b',
    name: 'Llama 3.2 3B',
    repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
    file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    sizeGB: 1.9,
    group: 'chat',
    description: 'Lightweight chat, great for low RAM',
  },
  {
    id: 'qwen3-1.7b',
    name: 'Qwen3 1.7B',
    repo: 'unsloth/Qwen3-1.7B-GGUF',
    file: 'Qwen3-1.7B-Q4_K_M.gguf',
    sizeGB: 1.1,
    group: 'chat',
    description: 'Ultra-light, fits in any RAM',
  },
];

// ---------------------------------------------------------------------------
// suggestModels(totalRamGB)
// ---------------------------------------------------------------------------

export function suggestModels(totalRamGB) {
  const budget = totalRamGB - 2;

  const smallest = MODEL_CATALOG.find(m => m.id === 'qwen3-1.7b');

  const suggestions = MODEL_CATALOG.filter(m => m.sizeGB <= budget);

  // Always include smallest even if barely fits
  if (smallest && !suggestions.find(m => m.id === smallest.id)) {
    suggestions.push(smallest);
  }

  suggestions.sort((a, b) => a.sizeGB - b.sizeGB);
  return suggestions;
}

// ---------------------------------------------------------------------------
// getModelsDir()
// ---------------------------------------------------------------------------

export function getModelsDir() {
  const platform = process.platform;
  if (platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, 'llamaranch', 'models');
  }
  if (platform === 'darwin') {
    // Match config.js convention: ~/Library/Application Support/llamaranch/models
    return path.join(os.homedir(), 'Library', 'Application Support', 'llamaranch', 'models');
  }
  // Linux
  return path.join(os.homedir(), '.local', 'share', 'llamaranch', 'models');
}

// ---------------------------------------------------------------------------
// HTTPS-only redirect guard
// ---------------------------------------------------------------------------

function assertHttpsRedirect(from, to) {
  if (from.startsWith('https://') && !to.startsWith('https://')) {
    throw new Error('Redirect from https to non-https refused: ' + to);
  }
}

// ---------------------------------------------------------------------------
// Download helper: writes to destPath+'.part', renames on success
// ---------------------------------------------------------------------------

async function downloadFile(url, destPath, onProgress, redirectCount = 0) {
  if (redirectCount > 5) throw new Error('Too many redirects');

  const partPath = destPath + '.part';
  const protocol = url.startsWith('https://') ? https : http;

  return new Promise((resolve, reject) => {
    protocol.get(url, { headers: { 'User-Agent': 'llamaranch-wizard/0.1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        const loc = res.headers.location;
        res.resume();
        try { assertHttpsRedirect(url, loc); } catch (e) { reject(e); return; }
        downloadFile(loc, destPath, onProgress, redirectCount + 1)
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
      let writeStream;
      try {
        writeStream = fs.createWriteStream(partPath);
      } catch (err) {
        reject(err);
        return;
      }

      const cleanup = () => {
        try { fs.unlinkSync(partPath); } catch { /* ignore */ }
      };

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

      writeStream.on('finish', () => {
        try {
          fs.renameSync(partPath, destPath);
          resolve(destPath);
        } catch (err) {
          cleanup();
          reject(err);
        }
      });
      writeStream.on('error', (err) => { cleanup(); reject(err); });
      res.on('error', (err) => { cleanup(); reject(err); });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// downloadModel(model, modelsDir, { onProgress })
// ---------------------------------------------------------------------------

export async function downloadModel(model, modelsDir, { onProgress } = {}) {
  const destPath = path.join(modelsDir, model.file);

  // Skip only when the complete final file exists (a .part means a prior run was interrupted)
  if (fs.existsSync(destPath)) {
    onProgress?.({ type: 'skip', message: model.file + ' already downloaded' });
    return destPath;
  }
  // Clean up any leftover partial file from a prior interrupted download
  const partPath = destPath + '.part';
  if (fs.existsSync(partPath)) {
    try { fs.unlinkSync(partPath); } catch { /* ignore */ }
  }

  // Create modelsDir if needed
  fs.mkdirSync(modelsDir, { recursive: true });

  const url = 'https://huggingface.co/' + model.repo + '/resolve/main/' + model.file;

  try {
    await downloadFile(url, destPath, onProgress);
    onProgress?.({ type: 'done', path: destPath });
    return destPath;
  } catch (err) {
    onProgress?.({ type: 'error', message: err.message });
    // Delete partial file
    try {
      fs.unlinkSync(destPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}
