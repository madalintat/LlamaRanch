// update.js -- check GitHub for a newer LlamaRanch release and install it

import chalk from 'chalk';
import { detect } from './detect.js';
import { installApp } from './app-install.js';

export async function runUpdate() {
  const { renderLogo } = await import('./logo.js');
  renderLogo();

  console.log(chalk.hex('#2e8b48').bold('Updating LlamaRanch...'));
  console.log('');

  const info = await detect();

  // Check for newer app release
  console.log(chalk.dim('Checking for latest release on GitHub...'));

  try {
    const ghHeaders = {
      'User-Agent': 'llamaranch-wizard/0.1.0',
      'Accept': 'application/vnd.github+json',
    };
    if (process.env.GITHUB_TOKEN) {
      ghHeaders['Authorization'] = 'Bearer ' + process.env.GITHUB_TOKEN;
    }
    const res = await fetch('https://api.github.com/repos/madalintat/LlamaRanch/releases/latest', {
      headers: ghHeaders,
    });

    if (!res.ok) {
      let msg = 'GitHub API returned ' + res.status;
      try {
        const body = await res.json();
        if (body.message) msg += ': ' + body.message;
      } catch { /* not JSON */ }
      throw new Error(msg);
    }

    const data = await res.json();
    const latestVersion = data.tag_name;
    const installedVersion = info.appInstalled.version;

    if (installedVersion && installedVersion === latestVersion.replace(/^v/, '')) {
      console.log(chalk.hex('#2e8b48')('LlamaRanch is already up to date: ' + installedVersion));
    } else {
      if (installedVersion) {
        console.log('Installed: ' + installedVersion + ', Latest: ' + latestVersion);
      } else {
        console.log('Latest release: ' + latestVersion);
      }
      console.log(chalk.dim('Downloading and installing latest release...'));
      await installApp(info, { onProgress: (msg) => console.log(chalk.dim('  ' + msg)) });
      console.log(chalk.hex('#2e8b48').bold('Update complete.'));
    }
  } catch (err) {
    console.error(chalk.red('Update check failed: ' + err.message));
    console.log(chalk.dim('You can update manually at: https://github.com/madalintat/LlamaRanch/releases'));
  }

  // Also offer engine update on macOS (brew)
  if (info.os === 'macos' && info.brew && info.llamaServer.found) {
    console.log('');
    console.log(chalk.dim('To update llama.cpp engine: brew upgrade llama.cpp'));
  }

  console.log('');
}
