// config.js -- read/write LlamaRanch configuration file

import os from 'os';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// getConfigPath() -- returns the platform-appropriate config file path
// ---------------------------------------------------------------------------

export function getConfigPath() {
  const platform = process.platform;

  if (platform === 'darwin') {
    // macOS: ~/Library/Application Support/llamaranch/config.json
    return path.join(os.homedir(), 'Library', 'Application Support', 'llamaranch', 'config.json');
  }

  if (platform === 'win32') {
    // Windows: %APPDATA%\llamaranch\config.json
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, 'llamaranch', 'config.json');
  }

  // Linux: ${XDG_CONFIG_HOME:-~/.config}/llamaranch/config.json
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'llamaranch', 'config.json');
}

// ---------------------------------------------------------------------------
// writeConfig({ serverBin, modelsDir, generalModel, port })
// ---------------------------------------------------------------------------

export async function writeConfig({ serverBin, modelsDir, generalModel, port, searxngUrl, searxngManaged } = {}) {
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);

  // Load existing config if present (merge, don't clobber unrelated keys)
  let existing = {};
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      existing = JSON.parse(raw);
    }
  } catch {
    // Ignore parse errors -- start fresh
    existing = {};
  }

  // Build new values. Only set a key when its arg was actually provided, so the
  // standalone `websearch` patch never wipes server_bin/models_dir, and the main
  // wizard never clears searxng when web search was skipped.
  const newValues = {};
  if (port !== undefined) newValues.port = port;
  else if (existing.port === undefined) newValues.port = 2276;
  if (serverBin !== undefined) newValues.server_bin = serverBin;
  if (modelsDir !== undefined) newValues.models_dir = modelsDir;
  if (generalModel !== undefined) newValues.general_model = generalModel;
  if (serverBin !== undefined || modelsDir !== undefined || generalModel !== undefined) {
    if (existing.expose_to_network === undefined) newValues.expose_to_network = false;
  }
  if (searxngUrl !== undefined) newValues.searxng_url = searxngUrl;
  if (searxngManaged !== undefined) newValues.searxng_managed = searxngManaged;

  // Merge: existing keys survive, new values overwrite matching keys
  const config = Object.assign(existing, newValues);

  // Create directory if needed
  fs.mkdirSync(configDir, { recursive: true });

  // Write pretty JSON
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

  return { configPath, config };
}

// ---------------------------------------------------------------------------
// readConfig() -- returns parsed config object or null
// ---------------------------------------------------------------------------

export function readConfig() {
  const configPath = getConfigPath();
  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
