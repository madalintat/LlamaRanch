// serve.js -- start the llama-server using the stored config

import chalk from 'chalk';
import { readConfig } from './config.js';
import { execa } from 'execa';
import path from 'path';
import fs from 'fs';

export async function runServe({ port, host } = {}) {
  const config = readConfig();
  if (!config) {
    console.error('No config found. Run llamaranch-wizard first to set up.');
    process.exit(1);
  }

  const serverBin = config.server_bin;
  if (!serverBin || !fs.existsSync(serverBin)) {
    console.error('llama-server not found at: ' + (serverBin || 'unknown'));
    console.error('Run llamaranch-wizard to install the engine.');
    process.exit(1);
  }

  const modelFile = config.general_model ? path.basename(config.general_model) : null;
  const modelPath = modelFile && config.models_dir ? path.join(config.models_dir, modelFile) : null;
  const effectiveModel = modelPath && fs.existsSync(modelPath) ? modelPath : null;

  const effectivePort = port || config.port || 2276;
  const effectiveHost = host || (config.expose_to_network ? '0.0.0.0' : '127.0.0.1');

  const args = effectiveModel
    ? ['--model', effectiveModel, '--host', effectiveHost, '--port', String(effectivePort), '--jinja', '--props']
    : ['--host', effectiveHost, '--port', String(effectivePort), '--jinja', '--props'];

  // Print branded startup banner
  const { renderLogo } = await import('./logo.js');
  renderLogo();
  console.log(chalk.hex('#2e8b48').bold('Starting LlamaRanch server'));
  console.log(chalk.dim('  engine: ' + serverBin));
  if (effectiveModel) console.log(chalk.dim('  model:  ' + effectiveModel));
  console.log(chalk.dim('  listen: ' + effectiveHost + ':' + effectivePort));
  console.log('');

  try {
    await execa(serverBin, args, { stdio: 'inherit' });
  } catch (err) {
    if (err.signal === 'SIGINT') {
      console.log('');
      console.log(chalk.dim('Server stopped.'));
      process.exit(0);
    }
    console.error('Server error: ' + err.message);
    process.exit(1);
  }
}
