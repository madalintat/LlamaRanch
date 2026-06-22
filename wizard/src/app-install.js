// app-install.js -- download and install the LlamaRanch desktop app

import os from 'os';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { execa } from 'execa';

const GITHUB_API = 'https://api.github.com/repos/madalintat/LlamaRanch/releases/latest';
const RELEASES_URL = 'https://github.com/madalintat/LlamaRanch/releases';
const UA = 'llamaranch-wizard/0.1.0';

// ---------------------------------------------------------------------------
// Build GitHub API request headers
// ---------------------------------------------------------------------------

function githubHeaders() {
  const h = {
    'User-Agent': UA,
    'Accept': 'application/vnd.github+json',
  };
  if (process.env.GITHUB_TOKEN) {
    h['Authorization'] = 'Bearer ' + process.env.GITHUB_TOKEN;
  }
  return h;
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
// JSON fetch helper (follows redirects, rejects non-2xx)
// ---------------------------------------------------------------------------

async function fetchJSON(url, headers, redirectCount = 0) {
  if (redirectCount > 5) throw new Error('Too many redirects');
  const useHeaders = headers || { 'User-Agent': UA };
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https://') ? https : http;
    protocol.get(url, { headers: useHeaders }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        const loc = res.headers.location;
        res.resume();
        try { assertHttpsRedirect(url, loc); } catch (e) { reject(e); return; }
        fetchJSON(loc, useHeaders, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let msg = 'HTTP ' + res.statusCode + ' fetching ' + url;
          try {
            const body = JSON.parse(data);
            if (body.message) msg += ': ' + body.message;
          } catch { /* not JSON */ }
          reject(new Error(msg));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (err) { reject(new Error('Failed to parse JSON: ' + err.message)); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Download helper: writes to .part, renames on success, HTTPS-only redirects
// ---------------------------------------------------------------------------

async function downloadAsset(url, destDir, filename, onProgress, redirectCount = 0) {
  if (redirectCount > 10) throw new Error('Too many redirects');

  const destPath = path.join(destDir, filename);
  const partPath = destPath + '.part';
  const protocol = url.startsWith('https://') ? https : http;

  return new Promise((resolve, reject) => {
    protocol.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        const loc = res.headers.location;
        res.resume();
        try { assertHttpsRedirect(url, loc); } catch (e) { reject(e); return; }
        downloadAsset(loc, destDir, filename, onProgress, redirectCount + 1)
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
          onProgress?.('Downloading ' + filename + '... ' + percent + '%');
        } else {
          const mb = Math.round(downloaded / (1024 * 1024) * 10) / 10;
          onProgress?.('Downloading ' + filename + '... ' + mb + ' MB');
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
// Asset selection by OS + arch
// ---------------------------------------------------------------------------

function selectAsset(assets, normalizedOs, normalizedArch) {
  const names = assets.map(a => a.name.toLowerCase());

  if (normalizedOs === 'macos') {
    if (normalizedArch === 'arm64') {
      return (
        assets.find(a => a.name.toLowerCase().includes('aarch64') && a.name.endsWith('.app.tar.gz')) ||
        assets.find(a => a.name.toLowerCase().includes('aarch64') && a.name.toLowerCase().endsWith('.dmg'))
      );
    } else {
      return (
        assets.find(a => a.name.toLowerCase().includes('x64') && a.name.endsWith('.app.tar.gz')) ||
        assets.find(a => a.name.toLowerCase().includes('x64') && a.name.toLowerCase().endsWith('.dmg'))
      );
    }
  }

  if (normalizedOs === 'linux') {
    if (normalizedArch === 'arm64') {
      return (
        assets.find(a => a.name.endsWith('.AppImage') && /aarch64/i.test(a.name)) ||
        assets.find(a => a.name.endsWith('.deb') && /arm64/i.test(a.name))
      );
    } else {
      return (
        assets.find(a => a.name.endsWith('.AppImage') && (/amd64/i.test(a.name) || /x86_64/i.test(a.name))) ||
        assets.find(a => a.name.endsWith('.deb') && !/_arm64/i.test(a.name))
      );
    }
  }

  if (normalizedOs === 'windows') {
    if (normalizedArch === 'arm64') {
      return assets.find(a => a.name.includes('_arm64-setup.exe'));
    } else {
      return assets.find(a => a.name.includes('_x64-setup.exe'));
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Install by asset type
// ---------------------------------------------------------------------------

async function installAssetFile(assetPath, assetName, onProgress) {
  // .app.tar.gz: extract directly to /Applications
  if (assetName.endsWith('.app.tar.gz')) {
    onProgress?.('Extracting to /Applications...');
    try {
      await execa('tar', ['-xzf', assetPath, '-C', '/Applications']);
      onProgress?.('Extracted successfully.');
      return { installed: true, path: '/Applications/LlamaRanch.app', skipped: false };
    } catch (err) {
      onProgress?.('Extraction failed: ' + err.message);
      return { installed: false, manualRequired: true, instructions: 'Download from ' + RELEASES_URL };
    }
  }

  // .dmg: attach, copy, detach
  if (assetName.toLowerCase().endsWith('.dmg')) {
    onProgress?.('Mounting disk image...');
    let mountPoint = null;
    try {
      const { stdout: hdiOut } = await execa('hdiutil', ['attach', assetPath, '-nobrowse', '-noverify', '-noautoopen']);
      // Parse mount point from output (last field of last /dev/disk... line)
      const lines = hdiOut.trim().split('\n');
      for (const line of lines) {
        if (line.includes('/Volumes/')) {
          const parts = line.split('\t');
          const vol = parts[parts.length - 1]?.trim();
          if (vol) mountPoint = vol;
        }
      }

      if (!mountPoint) {
        onProgress?.('Could not determine mount point from hdiutil output.');
        return { installed: false, manualRequired: true, instructions: 'Download from ' + RELEASES_URL };
      }

      onProgress?.('Mounted at ' + mountPoint + '. Copying app...');
      // Use find + cp to avoid shell glob injection from mountPoint
      const { stdout: appName } = await execa('find', [mountPoint, '-maxdepth', '1', '-name', '*.app', '-print', '-quit']);
      const foundApp = appName.trim();
      if (!foundApp) {
        onProgress?.('No .app found in mounted DMG.');
        await execa('hdiutil', ['detach', mountPoint]).catch(() => {});
        return { installed: false, manualRequired: true, instructions: 'Download from ' + RELEASES_URL };
      }
      await execa('cp', ['-R', foundApp, '/Applications/']);
      onProgress?.('App copied to /Applications.');

      try {
        await execa('hdiutil', ['detach', mountPoint]);
      } catch {
        // Non-fatal: detach failure is cosmetic
      }

      return { installed: true, path: '/Applications/LlamaRanch.app', skipped: false };
    } catch (err) {
      onProgress?.('DMG install failed: ' + err.message);
      if (mountPoint) {
        try { await execa('hdiutil', ['detach', mountPoint]); } catch { /* ignore */ }
      }
      return { installed: false, manualRequired: true, instructions: 'Download from ' + RELEASES_URL };
    }
  }

  // .AppImage: chmod +x, copy to ~/.local/bin or ~/Applications
  if (assetName.endsWith('.AppImage')) {
    const home = os.homedir();
    const binDir = path.join(home, '.local', 'bin');
    const appsDir = path.join(home, 'Applications');
    let destDir = binDir;
    try { fs.mkdirSync(binDir, { recursive: true }); } catch { destDir = appsDir; }

    const destPath = path.join(destDir, 'LlamaRanch.AppImage');
    try {
      onProgress?.('Copying AppImage to ' + destDir + '...');
      fs.copyFileSync(assetPath, destPath);
      fs.chmodSync(destPath, 0o755);

      // Create .desktop entry
      const desktopDir = path.join(home, '.local', 'share', 'applications');
      try {
        fs.mkdirSync(desktopDir, { recursive: true });
        const desktopEntry = [
          '[Desktop Entry]',
          'Name=LlamaRanch',
          'Exec=' + destPath,
          'Icon=llamaranch',
          'Type=Application',
          'Categories=Utility;',
          'Comment=Run local LLMs. Nothing leaves the valley.',
        ].join('\n') + '\n';
        fs.writeFileSync(path.join(desktopDir, 'llamaranch.desktop'), desktopEntry, 'utf8');
        onProgress?.('Desktop entry created.');
      } catch {
        // Non-fatal
      }

      return { installed: true, path: destPath, skipped: false };
    } catch (err) {
      onProgress?.('AppImage install failed: ' + err.message);
      return { installed: false, manualRequired: true, instructions: 'Download from ' + RELEASES_URL };
    }
  }

  // .deb: requires sudo, manual
  if (assetName.endsWith('.deb')) {
    const msg = 'Installing .deb requires sudo. Run: sudo dpkg -i ' + assetPath;
    onProgress?.(msg);
    return {
      installed: false,
      manualRequired: true,
      instructions: msg,
    };
  }

  // .exe: launch Windows installer (detached so wizard exits independently)
  if (assetName.endsWith('.exe')) {
    onProgress?.('Launching Windows installer...');
    try {
      const child = execa(assetPath, { detached: true, stdio: 'ignore' });
      child.unref();
      return { installed: true, path: assetPath, skipped: false };
    } catch (err) {
      onProgress?.('Failed to launch installer: ' + err.message);
      return { installed: false, manualRequired: true, instructions: 'Download from ' + RELEASES_URL };
    }
  }

  onProgress?.('Unknown asset type: ' + assetName);
  return { installed: false, manualRequired: true, instructions: 'Download from ' + RELEASES_URL };
}

// ---------------------------------------------------------------------------
// checkAppInstalled(detectResult) -- quick check from detect result
// ---------------------------------------------------------------------------

export async function checkAppInstalled(detectResult) {
  return detectResult.appInstalled;
}

// ---------------------------------------------------------------------------
// installApp(detectResult, { onProgress })
// ---------------------------------------------------------------------------

export async function installApp(detectResult, { onProgress } = {}) {
  try {
    // Already installed: skip
    if (detectResult.appInstalled?.found === true) {
      return {
        installed: true,
        path: detectResult.appInstalled.path,
        skipped: true,
        manualRequired: false,
        instructions: null,
      };
    }

    const normalizedOs = detectResult.os || 'linux';
    const normalizedArch = detectResult.arch || 'x64';

    // Fetch latest GitHub release
    onProgress?.('Fetching latest release from GitHub...');
    let release;
    try {
      release = await fetchJSON(GITHUB_API, githubHeaders());
    } catch (err) {
      onProgress?.('GitHub API error: ' + err.message);
      return {
        installed: false,
        path: null,
        skipped: false,
        manualRequired: true,
        instructions: 'Download from ' + RELEASES_URL,
      };
    }

    const assets = release.assets || [];
    if (assets.length === 0) {
      onProgress?.('No assets found in latest release.');
      return {
        installed: false,
        path: null,
        skipped: false,
        manualRequired: true,
        instructions: 'Download from ' + RELEASES_URL,
      };
    }

    // Select the right asset
    const asset = selectAsset(assets, normalizedOs, normalizedArch);
    if (!asset) {
      onProgress?.('No matching asset found for ' + normalizedOs + '/' + normalizedArch + '.');
      onProgress?.('Available assets: ' + assets.map(a => a.name).join(', '));
      return {
        installed: false,
        path: null,
        skipped: false,
        manualRequired: true,
        instructions: 'Download from ' + RELEASES_URL,
      };
    }

    onProgress?.('Found asset: ' + asset.name);

    // Download to temp directory
    const tmpDir = os.tmpdir();
    let assetPath;
    try {
      assetPath = await downloadAsset(asset.browser_download_url, tmpDir, asset.name, onProgress);
    } catch (err) {
      onProgress?.('Download failed: ' + err.message);
      return {
        installed: false,
        path: null,
        skipped: false,
        manualRequired: true,
        instructions: 'Download from ' + RELEASES_URL,
      };
    }

    onProgress?.('Download complete. Installing...');

    // Install based on type
    const result = await installAssetFile(assetPath, asset.name, onProgress);
    return {
      path: result.path || null,
      skipped: result.skipped || false,
      manualRequired: result.manualRequired || false,
      instructions: result.instructions || null,
      installed: result.installed || false,
    };
  } catch (err) {
    onProgress?.('App install error: ' + err.message);
    return {
      installed: false,
      path: null,
      skipped: false,
      manualRequired: true,
      instructions: 'Download from ' + RELEASES_URL,
    };
  }
}
