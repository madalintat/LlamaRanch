// http.js -- shared HTTP helpers for the LlamaRanch wizard
//
// Exports:
//   fetchJSON(url)                        -- GitHub API JSON fetch with auth
//   downloadFile(url, destPath, onProgress) -- atomic download with .part staging

import fs from 'fs';
import https from 'https';
import http from 'http';

const UA = 'llamaranch-wizard';
const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// HTTPS-only redirect guard
// ---------------------------------------------------------------------------

function assertHttpsRedirect(from, to) {
  if (from.startsWith('https://') && !to.startsWith('https://')) {
    throw new Error('Redirect from https to non-https refused: ' + to);
  }
}

// ---------------------------------------------------------------------------
// fetchJSON(url)
//
// Follows redirects (https-only, capped at MAX_REDIRECTS).
// Sends Accept: application/vnd.github+json and User-Agent headers.
// Sends Authorization: Bearer <GITHUB_TOKEN> when env var is set.
// Rejects on non-2xx with "<status> <body.message if any>".
// ---------------------------------------------------------------------------

export async function fetchJSON(url, _redirectCount = 0) {
  if (_redirectCount > MAX_REDIRECTS) throw new Error('Too many redirects');

  const headers = {
    'User-Agent': UA,
    'Accept': 'application/vnd.github+json',
  };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = 'Bearer ' + process.env.GITHUB_TOKEN;
  }

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https://') ? https : http;
    protocol.get(url, { headers }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        const loc = res.headers.location;
        res.resume();
        try { assertHttpsRedirect(url, loc); } catch (e) { reject(e); return; }
        fetchJSON(loc, _redirectCount + 1).then(resolve).catch(reject);
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
// downloadFile(url, destPath, onProgress)
//
// Follows redirects (https-only, capped at MAX_REDIRECTS).
// Rejects on non-2xx.
// Writes to destPath+'.part', renames to destPath on success.
// Deletes the .part file on error.
// Calls onProgress(receivedBytes, totalBytes|null) when data arrives.
// ---------------------------------------------------------------------------

export async function downloadFile(url, destPath, onProgress, _redirectCount = 0) {
  if (_redirectCount > MAX_REDIRECTS) throw new Error('Too many redirects');

  const partPath = destPath + '.part';
  const protocol = url.startsWith('https://') ? https : http;

  return new Promise((resolve, reject) => {
    protocol.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        const loc = res.headers.location;
        res.resume();
        try { assertHttpsRedirect(url, loc); } catch (e) { reject(e); return; }
        downloadFile(loc, destPath, onProgress, _redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode + ' downloading ' + url));
        return;
      }

      const totalBytes = parseInt(res.headers['content-length'] || '0', 10) || null;
      let received = 0;
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
        received += chunk.length;
        onProgress?.(received, totalBytes);
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
