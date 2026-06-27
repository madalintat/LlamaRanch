// searxng.js -- set up a local, loopback-only SearXNG instance for private web search.
//
// The Rust app owns the container lifecycle (start/stop), so this module only
// provisions the files, pulls the image, and proves the stack works once.
// It must NEVER throw uncaught -- every failure path returns a result object.
//
// Shared contract with the app (do not drift):
//   setup dir   ~/.llamaranch/searxng/
//   files       docker-compose.yml, config/settings.yml (config mounted at /etc/searxng)
//   bind        127.0.0.1:8888 -> container 8080
//   container   llamaranch-searxng, restart: "no" (app manages start/stop)

import os from 'os';
import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { execa } from 'execa';

export const SEARXNG_DIR = path.join(os.homedir(), '.llamaranch', 'searxng');
export const SEARXNG_CONFIG_DIR = path.join(SEARXNG_DIR, 'config');
export const SEARXNG_COMPOSE = path.join(SEARXNG_DIR, 'docker-compose.yml');
export const SEARXNG_SETTINGS = path.join(SEARXNG_CONFIG_DIR, 'settings.yml');
export const SEARXNG_URL = 'http://127.0.0.1:8888';
export const SEARXNG_CONTAINER = 'llamaranch-searxng';

const RUNTIME_HINT =
  'Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or Podman, then run: npx @llamaranch/wizard websearch';

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

function settingsYaml(secretKey) {
  // Minimal override on top of SearXNG defaults. json in formats is the 403 fix.
  // limiter false is safe because we only ever bind to loopback.
  return [
    'use_default_settings: true',
    'server:',
    '  secret_key: "' + secretKey + '"',
    '  limiter: false',
    '  image_proxy: false',
    'search:',
    '  formats:',
    '    - html',
    '    - json',
    '',
  ].join('\n');
}

function composeYaml() {
  return [
    'services:',
    '  searxng:',
    '    image: searxng/searxng:latest',
    '    container_name: ' + SEARXNG_CONTAINER,
    '    ports:',
    '      - "127.0.0.1:8888:8080"',
    '    volumes:',
    '      - ./config:/etc/searxng:rw',
    '    environment:',
    '      - SEARXNG_BASE_URL=http://localhost:8888/',
    '    restart: "no"',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Loopback JSON poll -- waits for SearXNG to answer a json search query
// ---------------------------------------------------------------------------

function probeOnce() {
  return new Promise((resolve) => {
    const req = http.get(
      'http://127.0.0.1:8888/search?q=test&format=json',
      { timeout: 4000 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) { resolve(false); return; }
          try {
            const parsed = JSON.parse(body);
            resolve(parsed && typeof parsed === 'object');
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForJson(timeoutMs, onProgress) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    if (await probeOnce()) return true;
    if (!announced) {
      onProgress?.('Waiting for SearXNG to come up...');
      announced = true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Compose helpers -- prefer `<runtime> compose`, run from the setup dir
// ---------------------------------------------------------------------------

async function compose(runtime, args, onProgress) {
  const proc = execa(runtime, ['compose', '-f', SEARXNG_COMPOSE, ...args], {
    cwd: SEARXNG_DIR,
    all: true,
  });
  proc.all?.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      const t = line.trimEnd();
      if (t) onProgress?.(t);
    }
  });
  return proc;
}

// ---------------------------------------------------------------------------
// setupSearxng({ runtime, onProgress })
// ---------------------------------------------------------------------------

export async function setupSearxng({ runtime, onProgress } = {}) {
  if (!runtime) {
    return { ok: false, needsRuntime: true, instructions: RUNTIME_HINT };
  }

  try {
    // 1. Write files (settings only generated once so we keep a stable secret_key)
    fs.mkdirSync(SEARXNG_CONFIG_DIR, { recursive: true });

    if (!fs.existsSync(SEARXNG_SETTINGS)) {
      const secretKey = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(SEARXNG_SETTINGS, settingsYaml(secretKey), 'utf8');
      onProgress?.('Wrote ' + SEARXNG_SETTINGS);
    } else {
      onProgress?.('Reusing existing settings.yml');
    }

    fs.writeFileSync(SEARXNG_COMPOSE, composeYaml(), 'utf8');
    onProgress?.('Wrote ' + SEARXNG_COMPOSE);
  } catch (err) {
    return {
      ok: false,
      error: 'Could not write SearXNG files: ' + err.message + '\n' + manualSteps(runtime),
    };
  }

  // 2. Pull the image
  onProgress?.('Pulling searxng/searxng:latest (this can take a minute)...');
  try {
    await compose(runtime, ['pull'], onProgress);
  } catch (err) {
    // Fall back to a plain image pull; some older compose plugins lack `pull`.
    try {
      const p = execa(runtime, ['pull', 'searxng/searxng:latest'], { all: true });
      p.all?.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n')) {
          const t = line.trimEnd();
          if (t) onProgress?.(t);
        }
      });
      await p;
    } catch (err2) {
      return {
        ok: false,
        error: 'Image pull failed: ' + err2.message + '\n' + manualSteps(runtime),
      };
    }
  }

  // 3. Bring it up, verify a json search, then bring it back DOWN (app owns start/stop)
  onProgress?.('Starting container to verify...');
  try {
    await compose(runtime, ['up', '-d'], onProgress);
  } catch (err) {
    return {
      ok: false,
      error: 'Could not start the container: ' + err.message + '\n' + manualSteps(runtime),
    };
  }

  const ok = await waitForJson(40000, onProgress);

  // Always try to stop the container -- the app, not the wizard, runs it.
  try {
    onProgress?.('Stopping container (the app will manage it from here)...');
    await compose(runtime, ['down'], onProgress);
  } catch {
    // If down fails the worst case is a running container; not fatal to setup.
    onProgress?.('Note: could not stop the container automatically.');
  }

  if (!ok) {
    return {
      ok: false,
      error:
        'SearXNG did not answer a JSON search within 40s. The files are in place; try again with: ' +
        runtime + ' compose -f ' + SEARXNG_COMPOSE + ' up\n' + manualSteps(runtime),
    };
  }

  onProgress?.('SearXNG verified at ' + SEARXNG_URL);
  return { ok: true, url: SEARXNG_URL, runtime };
}

function manualSteps(runtime) {
  const rt = runtime || 'docker';
  return [
    'Manual steps:',
    '  cd ' + SEARXNG_DIR,
    '  ' + rt + ' compose up -d',
    '  curl "http://127.0.0.1:8888/search?q=test&format=json"',
    '  ' + rt + ' compose down',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// runWebsearch() -- standalone `websearch` subcommand
// Renders the brand header, detects a runtime, runs setup, persists config.
// ---------------------------------------------------------------------------

export async function runWebsearch() {
  const chalk = (await import('chalk')).default;
  const { renderLogo } = await import('./logo.js');
  const { detect } = await import('./detect.js');
  const { writeConfig } = await import('./config.js');

  const gold = (s) => chalk.hex('#f4f4f5')(s);
  const cream = (s) => chalk.hex('#d8d8dd')(s);
  const muted = (s) => chalk.hex('#8a8a92')(s);

  renderLogo();
  console.log(gold('  websearch') + muted('  setting up local web search (SearXNG)...'));
  console.log('');

  const det = await detect();
  const runtime = det.container?.runtime || null;

  if (!runtime) {
    console.log(gold('  ▲ ') + cream('No container runtime found.'));
    console.log(muted('    ' + RUNTIME_HINT));
    process.exitCode = 1;
    return;
  }

  console.log(muted('  runtime  ') + cream(runtime) + (det.container?.daemon ? muted('  (daemon up)') : muted('  (daemon not confirmed)')));
  console.log('');

  const result = await setupSearxng({
    runtime,
    onProgress: (line) => console.log(muted('  · ') + muted(line)),
  });

  console.log('');
  if (result.ok) {
    try {
      const { configPath } = await writeConfig({
        searxngUrl: result.url,
        searxngManaged: true,
      });
      console.log(gold('  ◇ ') + cream('Web search ready at ') + cream(result.url));
      console.log(muted('    config: ' + configPath));
    } catch (err) {
      console.log(gold('  ▲ ') + cream('SearXNG is set up, but writing config failed: ' + err.message));
      console.log(muted('    Add searxng_url + searxng_managed to your config manually.'));
      process.exitCode = 1;
    }
  } else if (result.needsRuntime) {
    console.log(gold('  ▲ ') + cream('No container runtime found.'));
    console.log(muted('    ' + result.instructions));
    process.exitCode = 1;
  } else {
    console.log(gold('  ▲ ') + cream('Web search setup did not complete.'));
    for (const line of (result.error || 'Unknown error').split('\n')) {
      console.log(muted('    ' + line));
    }
    process.exitCode = 1;
  }
}
