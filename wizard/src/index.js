#!/usr/bin/env node

import chalk from 'chalk';
import { renderLogo } from './logo.js';

const VERSION = '0.1.0';
const PKG_NAME = '@llamaranch/wizard';

function printHelp() {
  renderLogo();
  console.log(chalk.bold('Usage:'));
  console.log('');
  console.log(`  ${chalk.hex('#2e8b48')('llamaranch-wizard')}          run the setup wizard`);
  console.log(`  ${chalk.hex('#2e8b48')('llamaranch-wizard serve')}    start headless llama-server`);
  console.log(`  ${chalk.hex('#2e8b48')('llamaranch-wizard update')}   update LlamaRanch to the latest release`);
  console.log(`  ${chalk.hex('#2e8b48')('llamaranch-wizard --help')}   show this help`);
  console.log(`  ${chalk.hex('#2e8b48')('llamaranch-wizard --version')}`);
  console.log('');
  console.log(chalk.dim('LlamaRanch keeps your models local. Nothing leaves the valley.'));
  console.log('');
}

function printVersion() {
  console.log(`${PKG_NAME} v${VERSION}`);
}

async function runWizard() {
  // Guard: non-TTY environments cannot run the interactive wizard
  if (!process.stdout.isTTY) {
    console.log('Run in a terminal for the interactive wizard');
    process.exit(0);
  }

  // Import all dependencies before defining the component
  const { render, Text, Box, useInput, useApp } = await import('ink');
  const { default: Spinner } = await import('ink-spinner');
  const React = (await import('react')).default;
  const { useState, useEffect, useRef } = React;

  const { detect, formatDetectResult } = await import('./detect.js');
  const { installEngine } = await import('./engine.js');
  const { MODEL_CATALOG, suggestModels, downloadModel, getModelsDir } = await import('./models.js');
  const { writeConfig, getConfigPath } = await import('./config.js');
  const { installApp } = await import('./app-install.js');

  // ---------------------------------------------------------------------------
  // ModelPicker: custom multi-select component using useInput
  // ---------------------------------------------------------------------------

  function ModelPicker({ models, suggested, onDone }) {
    const suggestedIds = new Set(suggested.map(m => m.id));
    const [selected, setSelected] = useState(new Set(models.map(m => m.id).filter(id => suggestedIds.has(id))));
    const [cursor, setCursor] = useState(0);

    useInput((input, key) => {
      if (key.upArrow) {
        setCursor(c => Math.max(0, c - 1));
      } else if (key.downArrow) {
        setCursor(c => Math.min(models.length - 1, c + 1));
      } else if (input === ' ') {
        const id = models[cursor]?.id;
        if (id) {
          setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) { next.delete(id); } else { next.add(id); }
            return next;
          });
        }
      } else if (key.return) {
        const picked = models.filter(m => selected.has(m.id));
        onDone(picked);
      } else if (input === 'q' || (key.ctrl && input === 'c')) {
        onDone([]);
      }
    });

    return React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Text, { bold: true, color: '#f5f0e8' }, 'Select models to download:'),
      React.createElement(Text, { dimColor: true }, 'Arrow keys: move  Space: toggle  Enter: confirm'),
      React.createElement(Text, null, ''),
      ...models.map((m, i) => {
        const isCursor = i === cursor;
        const isSelected = selected.has(m.id);
        const isSuggested = suggestedIds.has(m.id);
        const checkbox = isSelected ? '[x]' : '[ ]';
        const prefix = isCursor ? '> ' : '  ';
        const label = m.name + ' (' + m.sizeGB + 'gb) - ' + m.description +
          (isSuggested ? ' *' : '');
        return React.createElement(
          Text,
          { key: m.id, color: isCursor ? '#2e8b48' : (isSelected ? '#f5f0e8' : '#6b5f52') },
          prefix + checkbox + ' ' + label
        );
      }),
      React.createElement(Text, null, ''),
      React.createElement(Text, { dimColor: true }, '* suggested for your RAM'),
    );
  }

  // ---------------------------------------------------------------------------
  // Main WizardApp component
  // ---------------------------------------------------------------------------

  function WizardApp() {
    const [step, setStep] = useState('welcome');
    const [detectResult, setDetectResult] = useState(null);
    const [enginePath, setEnginePath] = useState(null);
    const [engineLines, setEngineLines] = useState([]);
    const [engineDone, setEngineDone] = useState(false);
    const [engineManual, setEngineManual] = useState(null);
    const [selectedModels, setSelectedModels] = useState([]);
    const [downloadIndex, setDownloadIndex] = useState(0);
    const [downloadLine, setDownloadLine] = useState('');
    const [downloadedModels, setDownloadedModels] = useState([]);
    const [configPath, setConfigPath] = useState('');
    const [configData, setConfigData] = useState(null);
    const [appInstallResult, setAppInstallResult] = useState(null);
    const [appLines, setAppLines] = useState([]);
    const [appDone, setAppDone] = useState(false);
    const { exit } = useApp();

    // Handle key input at the top level
    useInput((input, key) => {
      // Ctrl+C always exits
      if (key.ctrl && input === 'c') {
        exit();
        return;
      }

      if (step === 'welcome' && key.return) {
        setStep('detect');
        return;
      }

      if (step === 'detect-done' && key.return) {
        setStep('engine');
        return;
      }

      if (step === 'engine-skip' && key.return) {
        setEnginePath(detectResult.llamaServer.path);
        setStep('model-select');
        return;
      }

      if (step === 'engine-manual' && key.return) {
        setStep('model-select');
        return;
      }

      if (step === 'config-done' && key.return) {
        setStep('app-install');
        return;
      }

      if (step === 'app-manual' && key.return) {
        setStep('finish');
        return;
      }

      if (step === 'finish' && (key.return || input === 'q')) {
        exit();
        return;
      }
    });

    // Step: detect
    useEffect(() => {
      if (step !== 'detect') return;
      let cancelled = false;
      const run = async () => {
        const result = await detect();
        await new Promise(resolve => setTimeout(resolve, 400));
        if (!cancelled) {
          setDetectResult(result);
          setStep('detect-done');
        }
      };
      run();
      return () => { cancelled = true; };
    }, [step]);

    // Step: engine
    useEffect(() => {
      if (step !== 'engine') return;
      if (!detectResult) return;

      // If already found, show skip message
      if (detectResult.llamaServer?.found === true) {
        setStep('engine-skip');
        return;
      }

      // Not found: start install
      let cancelled = false;
      const run = async () => {
        const result = await installEngine(detectResult, {
          onProgress: (line) => {
            if (!cancelled) setEngineLines(prev => [...prev, line]);
          },
          onSkip: (line) => {
            if (!cancelled) setEngineLines(prev => [...prev, line]);
          },
        });

        if (!cancelled) {
          setEngineDone(true);
          if (result.manualRequired) {
            setEngineManual(result.instructions || 'Install llama.cpp manually: https://github.com/ggml-org/llama.cpp');
            setStep('engine-manual');
          } else {
            setEnginePath(result.path);
            setStep('model-select');
          }
        }
      };
      run();
      return () => { cancelled = true; };
    }, [step]);

    // Step: model-download
    useEffect(() => {
      if (step !== 'model-download') return;
      if (selectedModels.length === 0) {
        setStep('config-write');
        return;
      }

      let cancelled = false;
      const modelsDir = getModelsDir();
      const downloaded = [];

      const runDownloads = async () => {
        for (let i = 0; i < selectedModels.length; i++) {
          if (cancelled) return;
          const model = selectedModels[i];
          setDownloadIndex(i);
          setDownloadLine('Starting ' + model.name + '...');

          try {
            await downloadModel(model, modelsDir, {
              onProgress: (evt) => {
                if (cancelled) return;
                if (evt.type === 'skip') {
                  setDownloadLine(model.name + ': already downloaded');
                } else if (evt.type === 'progress' && evt.percent !== null) {
                  setDownloadLine('Downloading ' + model.name + '... ' + evt.percent + '%');
                } else if (evt.type === 'progress') {
                  const mb = evt.downloaded ? Math.round(evt.downloaded / (1024 * 1024) * 10) / 10 : 0;
                  setDownloadLine('Downloading ' + model.name + '... ' + mb + ' MB');
                } else if (evt.type === 'done') {
                  setDownloadLine(model.name + ': done');
                } else if (evt.type === 'error') {
                  setDownloadLine(model.name + ': error - ' + evt.message);
                }
              }
            });
            downloaded.push(model);
          } catch (err) {
            setDownloadLine(model.name + ': failed - ' + err.message);
            await new Promise(r => setTimeout(r, 800));
          }
        }

        if (!cancelled) {
          setDownloadedModels(downloaded);
          setStep('config-write');
        }
      };

      runDownloads();
      return () => { cancelled = true; };
    }, [step]);

    // Step: config-write
    useEffect(() => {
      if (step !== 'config-write') return;
      let cancelled = false;

      const run = async () => {
        const modelsDir = getModelsDir();

        // Pick smallest chat model as general model, or smallest overall
        const chatModels = selectedModels.filter(m => m.group === 'chat');
        const generalModelObj = chatModels.length > 0
          ? chatModels.reduce((a, b) => a.sizeGB <= b.sizeGB ? a : b)
          : selectedModels.length > 0
            ? selectedModels.reduce((a, b) => a.sizeGB <= b.sizeGB ? a : b)
            : null;

        const serverBin = enginePath || detectResult?.llamaServer?.path || null;
        const generalModel = generalModelObj ? generalModelObj.file : null;

        try {
          const { configPath: cp, config } = await writeConfig({
            serverBin,
            modelsDir,
            generalModel,
            port: 2276,
          });
          if (!cancelled) {
            setConfigPath(cp);
            setConfigData(config);
            setStep('config-done');
          }
        } catch (err) {
          if (!cancelled) {
            setConfigPath(getConfigPath());
            setConfigData({ error: err.message });
            setStep('config-done');
          }
        }
      };
      run();
      return () => { cancelled = true; };
    }, [step]);

    // Step: app-install
    useEffect(() => {
      if (step !== 'app-install') return;
      if (!detectResult) return;

      let cancelled = false;
      const run = async () => {
        const result = await installApp(detectResult, {
          onProgress: (msg) => {
            if (!cancelled) setAppLines(prev => [...prev, msg]);
          }
        });

        if (!cancelled) {
          setAppInstallResult(result);
          setAppDone(true);
          if (result.manualRequired) {
            setStep('app-manual');
          } else {
            setStep('finish');
          }
        }
      };
      run();
      return () => { cancelled = true; };
    }, [step]);

    // -------------------------------------------------------------------------
    // Render each step
    // -------------------------------------------------------------------------

    // Welcome
    if (step === 'welcome') {
      return React.createElement(
        Box,
        { flexDirection: 'column', padding: 1 },
        React.createElement(Text, { bold: true, color: '#f5f0e8' }, 'Welcome to LlamaRanch Setup'),
        React.createElement(Text, null, ''),
        React.createElement(Text, { color: '#6b5f52' }, 'This wizard will install the engine, download starter models,'),
        React.createElement(Text, { color: '#6b5f52' }, 'write your config, and install the desktop app.'),
        React.createElement(Text, null, ''),
        React.createElement(Text, { color: '#2e8b48' }, 'Press Enter to begin setup'),
      );
    }

    // Detect (spinner)
    if (step === 'detect') {
      return React.createElement(
        Box,
        { flexDirection: 'column', padding: 1 },
        React.createElement(
          Text,
          null,
          React.createElement(Spinner, { type: 'dots' }),
          React.createElement(Text, { color: '#f5f0e8' }, '  Detecting your environment...'),
        ),
      );
    }

    // Detect done (show results, wait for Enter)
    if (step === 'detect-done') {
      const summary = detectResult ? formatDetectResult(detectResult) : '';
      const summaryLines = summary.split('\n');
      return React.createElement(
        Box,
        { flexDirection: 'column', padding: 1 },
        React.createElement(Text, { bold: true, color: '#2e8b48' }, 'Environment detected'),
        React.createElement(Text, null, ''),
        ...summaryLines.map((line, i) =>
          React.createElement(Text, { key: 'det-' + i }, line)
        ),
      );
    }

    // Engine: already found, skip
    if (step === 'engine-skip') {
      return React.createElement(
        Box,
        { flexDirection: 'column', padding: 1 },
        React.createElement(Text, { bold: true, color: '#2e8b48' }, 'llama-server found'),
        React.createElement(Text, { dimColor: true }, detectResult?.llamaServer?.path || ''),
        detectResult?.llamaServer?.version
          ? React.createElement(Text, { dimColor: true }, 'version: ' + detectResult.llamaServer.version)
          : null,
        React.createElement(Text, null, ''),
        React.createElement(Text, { color: '#6b5f52' }, 'Press Enter to continue'),
      );
    }

    // Engine: installing
    if (step === 'engine') {
      return React.createElement(
        Box,
        { flexDirection: 'column', padding: 1 },
        React.createElement(
          Text,
          null,
          React.createElement(Spinner, { type: 'dots' }),
          React.createElement(Text, { color: '#f5f0e8' }, '  Installing llama-server...'),
        ),
        React.createElement(Text, null, ''),
        ...engineLines.slice(-8).map((line, i) =>
          React.createElement(Text, { key: 'eng-' + i, dimColor: true }, line)
        ),
      );
    }

    // Engine: manual required
    if (step === 'engine-manual') {
      return React.createElement(
        Box,
        { flexDirection: 'column', padding: 1 },
        React.createElement(Text, { bold: true, color: '#c7a228' }, 'Manual installation required'),
        React.createElement(Text, null, ''),
        ...engineLines.slice(-6).map((line, i) =>
          React.createElement(Text, { key: 'engm-' + i, dimColor: true }, line)
        ),
        React.createElement(Text, null, ''),
        React.createElement(Text, { color: '#f5f0e8' }, engineManual || ''),
        React.createElement(Text, null, ''),
        React.createElement(Text, { color: '#6b5f52' }, 'Press Enter to continue without engine'),
      );
    }

    // Model select
    if (step === 'model-select') {
      const suggested = detectResult ? suggestModels(detectResult.totalRamGB) : [];
      return React.createElement(
        Box,
        { flexDirection: 'column', padding: 1 },
        React.createElement(ModelPicker, {
          models: MODEL_CATALOG,
          suggested,
          onDone: (picked) => {
            setSelectedModels(picked);
            setStep('model-download');
          }
        }),
      );
    }

    // Model download
    if (step === 'model-download') {
      const model = selectedModels[downloadIndex];
      return React.createElement(
        Box,
        { flexDirection: 'column', padding: 1 },
        React.createElement(Text, { bold: true, color: '#f5f0e8' }, 'Downloading models...'),
        React.createElement(Text, null, ''),
        React.createElement(
          Text,
          { dimColor: true },
          (downloadIndex + 1) + '/' + selectedModels.length + ': ' + (model?.name || ''),
        ),
        React.createElement(
          Text,
          null,
          React.createElement(Spinner, { type: 'dots' }),
          React.createElement(Text, { color: '#2e8b48' }, '  ' + (downloadLine || '...')),
        ),
      );
    }

    // Config write (auto, no user input needed yet)
    if (step === 'config-write') {
      return React.createElement(
        Box,
        { flexDirection: 'column', padding: 1 },
        React.createElement(
          Text,
          null,
          React.createElement(Spinner, { type: 'dots' }),
          React.createElement(Text, { color: '#f5f0e8' }, '  Writing config...'),
        ),
      );
    }

    // Config done
    if (step === 'config-done') {
      return React.createElement(
        Box,
        { flexDirection: 'column', padding: 1 },
        React.createElement(Text, { bold: true, color: '#2e8b48' }, 'Config written'),
        React.createElement(Text, null, ''),
        React.createElement(Text, { color: '#f5f0e8' }, 'Path: ' + configPath),
        configData?.error
          ? React.createElement(Text, { color: '#c7a228' }, 'Warning: ' + configData.error)
          : null,
        React.createElement(Text, null, ''),
        React.createElement(Text, { color: '#6b5f52' }, 'Press Enter to install desktop app'),
      );
    }

    // App install (spinner)
    if (step === 'app-install') {
      return React.createElement(
        Box,
        { flexDirection: 'column', padding: 1 },
        React.createElement(
          Text,
          null,
          React.createElement(Spinner, { type: 'dots' }),
          React.createElement(Text, { color: '#f5f0e8' }, '  Installing LlamaRanch desktop app...'),
        ),
        React.createElement(Text, null, ''),
        ...appLines.slice(-6).map((line, i) =>
          React.createElement(Text, { key: 'app-' + i, dimColor: true }, line)
        ),
      );
    }

    // App install: manual required
    if (step === 'app-manual') {
      return React.createElement(
        Box,
        { flexDirection: 'column', padding: 1 },
        React.createElement(Text, { bold: true, color: '#c7a228' }, 'Manual app installation required'),
        React.createElement(Text, null, ''),
        ...appLines.slice(-5).map((line, i) =>
          React.createElement(Text, { key: 'appm-' + i, dimColor: true }, line)
        ),
        React.createElement(Text, null, ''),
        appInstallResult?.instructions
          ? React.createElement(Text, { color: '#f5f0e8' }, appInstallResult.instructions)
          : null,
        React.createElement(Text, null, ''),
        React.createElement(Text, { color: '#6b5f52' }, 'Press Enter to finish setup'),
      );
    }

    // Finish
    if (step === 'finish') {
      const modelsDir = getModelsDir();
      const appPath = detectResult?.os === 'macos'
        ? '/Applications/LlamaRanch.app'
        : detectResult?.os === 'linux'
          ? '~/.local/bin/LlamaRanch.AppImage'
          : 'LlamaRanch';

      const appInstalled = appInstallResult?.installed === true ||
        appInstallResult?.skipped === true ||
        detectResult?.appInstalled?.found === true;

      return React.createElement(
        Box,
        { flexDirection: 'column', padding: 1 },
        React.createElement(Text, { bold: true, color: '#2e8b48' }, 'LlamaRanch is ready.'),
        React.createElement(Text, null, ''),
        React.createElement(Text, { color: '#f5f0e8' }, 'Config:   ' + configPath),
        React.createElement(Text, { color: '#f5f0e8' }, 'Models:   ' + modelsDir),
        React.createElement(Text, null, ''),
        React.createElement(Text, { color: '#2e8b48' }, 'Start headless server:'),
        React.createElement(Text, { bold: true, color: '#f5f0e8' }, '  llamaranch-wizard serve'),
        React.createElement(Text, null, ''),
        appInstalled
          ? React.createElement(
              Box,
              { flexDirection: 'column' },
              React.createElement(Text, { color: '#2e8b48' }, 'Open the app:'),
              React.createElement(Text, { bold: true, color: '#f5f0e8' }, '  ' + appPath),
              React.createElement(Text, null, ''),
            )
          : null,
        React.createElement(Text, { dimColor: true }, 'nothing leaves the valley'),
        React.createElement(Text, null, ''),
        React.createElement(Text, { color: '#6b5f52' }, 'Press Enter or q to exit'),
      );
    }

    return null;
  }

  // Print logo before rendering Ink app
  renderLogo();

  render(React.createElement(WizardApp, null));
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

const cmd = process.argv[2];

if (cmd === '--help' || cmd === '-h') {
  printHelp();
  process.exit(0);
} else if (cmd === '--version' || cmd === '-v') {
  printVersion();
  process.exit(0);
} else if (cmd === 'serve') {
  const { runServe } = await import('./serve.js');
  await runServe();
  process.exit(0);
} else if (cmd === 'update') {
  const { runUpdate } = await import('./update.js');
  await runUpdate();
  process.exit(0);
} else if (!cmd || cmd === 'setup') {
  await runWizard();
} else {
  console.error(`Unknown command: ${cmd}`);
  console.error('Run with --help for usage.');
  process.exit(1);
}
