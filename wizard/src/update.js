// update.js -- check GitHub for a newer LlamaRanch release and install it

import chalk from 'chalk';
import { detect } from './detect.js';
import { installApp } from './app-install.js';
import { fetchJSON } from './http.js';

export async function runUpdate() {
  const { renderLogo } = await import('./logo.js');
  renderLogo();

  console.log(chalk.hex('#2e8b48').bold('Updating LlamaRanch...'));
  console.log('');

  const info = await detect();

  // Check for newer app release
  console.log(chalk.dim('Checking for latest release on GitHub...'));

  try {
    const data = await fetchJSON('https://api.github.com/repos/madalintat/LlamaRanch/releases/latest');
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
