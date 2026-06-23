#!/usr/bin/env node

import chalk from 'chalk';
import { renderLogo, LLAMA_LINES } from './logo.js';
import { VERSION } from './version.js';
const PKG_NAME = '@llamaranch/wizard';

// ---------------------------------------------------------------------------
// Top-level process error guards
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  console.error('\n' + chalk.red('Unexpected error: ') + err.message);
  console.error(chalk.dim('Run with NODE_DEBUG=* for details, or file an issue at https://github.com/madalintat/LlamaRanch'));
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('\n' + chalk.red('Unexpected error: ') + msg);
  console.error(chalk.dim('Run with NODE_DEBUG=* for details, or file an issue at https://github.com/madalintat/LlamaRanch'));
  process.exit(1);
});

// ---------------------------------------------------------------------------
// --help / --version (non-Ink paths)
// ---------------------------------------------------------------------------

function printHelp() {
  renderLogo();
  const gold = (s) => chalk.hex('#c7a228')(s);
  const cream = (s) => chalk.hex('#f5f0e8')(s);
  const muted = (s) => chalk.hex('#6b6456')(s);
  console.log(cream('Usage:'));
  console.log('');
  console.log('  ' + gold('llamaranch-wizard') + '             ' + muted('run the setup wizard'));
  console.log('  ' + gold('llamaranch-wizard serve') + '       ' + muted('start headless llama-server'));
  console.log('  ' + gold('llamaranch-wizard update') + '      ' + muted('update LlamaRanch to the latest release'));
  console.log('  ' + gold('llamaranch-wizard uninstall') + '   ' + muted('remove LlamaRanch and its models'));
  console.log('  ' + gold('llamaranch-wizard --help') + '      ' + muted('show this help'));
  console.log('  ' + gold('llamaranch-wizard --version'));
  console.log('');
  console.log(muted('LlamaRanch keeps your models local. Nothing leaves the valley.'));
  console.log('');
}

function printVersion() {
  console.log(`${PKG_NAME} v${VERSION}`);
}

// ---------------------------------------------------------------------------
// Main wizard (Ink TUI)
// ---------------------------------------------------------------------------

async function runWizard() {
  if (!process.stdout.isTTY) {
    console.log('Run in a terminal for the interactive wizard');
    process.exit(0);
  }

  const { render, Text, Box, useInput, useApp } = await import('ink');
  const React = (await import('react')).default;
  const { useState, useEffect } = React;

  const { detect } = await import('./detect.js');
  const { installEngine } = await import('./engine.js');
  const { MODEL_CATALOG, suggestModels, downloadModel, getModelsDir } = await import('./models.js');
  const { writeConfig, getConfigPath } = await import('./config.js');
  const { installApp } = await import('./app-install.js');

  process.on('SIGINT', () => { process.exit(130); });

  // -------------------------------------------------------------------------
  // Custom spinner hook: ◒ ◐ ◓ ◑ at ~120ms
  // -------------------------------------------------------------------------

  function useSpinner() {
    const frames = ['◒', '◐', '◓', '◑'];
    const [frame, setFrame] = useState(0);
    useEffect(() => {
      const t = setInterval(() => setFrame(f => (f + 1) % frames.length), 120);
      return () => clearInterval(t);
    }, []);
    return frames[frame];
  }

  // -------------------------------------------------------------------------
  // Segmented progress bar (~26 cells)
  // -------------------------------------------------------------------------

  function ProgressBar({ percent, width }) {
    const w = width != null ? width : 26;
    const p = typeof percent === 'number' && isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
    const filled = Math.round((p / 100) * w);
    return React.createElement(
      Text,
      null,
      React.createElement(Text, { color: '#f5f0e8' }, '█'.repeat(filled)),
      React.createElement(Text, { color: '#2a2820' }, '░'.repeat(w - filled))
    );
  }

  // -------------------------------------------------------------------------
  // KV row helper
  // -------------------------------------------------------------------------

  function KVRow({ label, value, tag }) {
    const paddedLabel = (label || '').padEnd(14);
    return React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(Text, { color: '#3f3d34' }, '│ '),
      React.createElement(Text, { color: '#8a8270' }, paddedLabel),
      React.createElement(Text, { color: '#f5f0e8' }, value || ''),
      tag ? React.createElement(Text, { color: '#c7a228' }, '  ' + tag) : null
    );
  }

  // -------------------------------------------------------------------------
  // Gutter row: [gutter symbol] + content
  // -------------------------------------------------------------------------

  function GutterRow({ symbol, symbolColor, children }) {
    return React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(Text, { color: symbolColor || '#3f3d34' }, symbol + ' '),
      children
    );
  }

  // -------------------------------------------------------------------------
  // SubLog row: a muted line indented under the gutter
  // -------------------------------------------------------------------------

  function SubLog({ text }) {
    return React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(Text, { color: '#3f3d34' }, '│   '),
      React.createElement(Text, { color: '#6b6456' }, text || '')
    );
  }

  // -------------------------------------------------------------------------
  // ModelPicker: interactive multi-select with useInput
  // -------------------------------------------------------------------------

  function ModelPicker({ models, suggested, onDone }) {
    const suggestedIds = new Set(suggested.map(m => m.id));
    const [selected, setSelected] = useState(
      new Set(models.map(m => m.id).filter(id => suggestedIds.has(id)))
    );
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

    const rows = models.map((m, i) => {
      const isCursor = i === cursor;
      const isSelected = selected.has(m.id);
      const isSuggested = suggestedIds.has(m.id);

      const checkbox = isSelected
        ? React.createElement(Text, { color: '#f5f0e8' }, '◼ ')
        : React.createElement(Text, { color: '#8a8270' }, '◻ ');

      const nameColor = isCursor ? '#f5f0e8' : isSelected ? '#e6e0d4' : '#8a8270';

      return React.createElement(
        Box,
        { key: m.id, flexDirection: 'row' },
        React.createElement(Text, { color: '#3f3d34' }, '│  '),
        isCursor
          ? React.createElement(Text, { color: '#c7a228' }, '❯ ')
          : React.createElement(Text, null, '  '),
        checkbox,
        React.createElement(Text, { color: nameColor }, (m.name || '').padEnd(18).slice(0, 18)),
        React.createElement(Text, null, '  '),
        React.createElement(Text, { color: '#6b6456' }, (m.sizeGB + ' GB').padEnd(8)),
        React.createElement(Text, { color: '#8a8270' }, m.description || ''),
        isSuggested
          ? React.createElement(Text, { color: '#c7a228' }, '  ★')
          : null
      );
    });

    const hintRow = React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(Text, { color: '#3f3d34' }, '│  '),
      React.createElement(Text, { color: '#6b6456' }, 'space toggles · enter confirms')
    );

    return React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(Text, { color: '#c7a228' }, '◆ '),
        React.createElement(Text, { color: '#f5f0e8' }, 'Select models to download')
      ),
      ...rows,
      hintRow
    );
  }

  // -------------------------------------------------------------------------
  // Intro static frame
  // -------------------------------------------------------------------------

  function IntroFrame() {
    const llamaLines = LLAMA_LINES;

    const colorLine = (line) =>
      React.createElement(
        Text,
        null,
        ...line.split('').map((ch, ci) => {
          if ('█▀▄'.includes(ch)) return React.createElement(Text, { key: ci, color: '#f5f0e8' }, ch);
          return React.createElement(Text, { key: ci }, ch);
        })
      );

    return React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Text, { color: '#c7a228' }, '┌'),
      ...llamaLines.map((l, i) =>
        React.createElement(Box, { key: i, flexDirection: 'row' },
          React.createElement(Text, { color: '#3f3d34' }, '  '),
          colorLine(l)
        )
      ),
      React.createElement(Text, { color: '#3f3d34' }, '│'),
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(Text, { color: '#3f3d34' }, '  '),
        React.createElement(
          Text,
          { backgroundColor: '#f5f0e8', color: '#16150f', bold: true },
          ' LlamaRanch '
        ),
        React.createElement(Text, null, ' '),
        React.createElement(Text, { color: '#6b6456' }, 'setup wizard · v' + VERSION)
      ),
      React.createElement(Text, { color: '#3f3d34' }, '│'),
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(Text, { color: '#3f3d34' }, '  '),
        React.createElement(Text, { color: '#6b6456' }, 'A quiet ranch for your local models. Nothing leaves the valley.')
      ),
      React.createElement(Text, { color: '#3f3d34' }, '│')
    );
  }

  // -------------------------------------------------------------------------
  // Main WizardApp component
  // -------------------------------------------------------------------------

  function WizardApp() {
    // step state machine
    // intro -> confirm -> detect-running -> detect-done -> engine-running ->
    // engine-done -> model-select -> download-running -> download-done ->
    // config-writing -> config-done -> app-install-running -> app-install-done -> outro
    const [step, setStep] = useState('confirm');

    // detect
    const [detectResult, setDetectResult] = useState(null);

    // engine
    const [enginePath, setEnginePath] = useState(null);
    const [engineLines, setEngineLines] = useState([]);
    const [engineManual, setEngineManual] = useState(null);

    // models
    const [selectedModels, setSelectedModels] = useState([]);
    const [modelsDone, setModelsDone] = useState(false);
    const [downloadPercents, setDownloadPercents] = useState({});
    const [downloadedModels, setDownloadedModels] = useState([]);
    const [failedModels, setFailedModels] = useState([]);

    // config
    const [configPath, setConfigPath] = useState('');
    const [configData, setConfigData] = useState(null);

    // app install
    const [appLines, setAppLines] = useState([]);
    const [appInstallResult, setAppInstallResult] = useState(null);

    // outro
    const [outroKey, setOutroKey] = useState(false);

    // error
    const [errorMsg, setErrorMsg] = useState(null);

    const { exit } = useApp();
    const spinFrame = useSpinner();

    // Top-level key handler (global)
    useInput((input, key) => {
      if (key.ctrl && input === 'c') { exit(); return; }

      if (step === 'confirm' && key.return) {
        setStep('detect-running');
        return;
      }

      if (step === 'outro' || step === 'error') {
        exit();
        return;
      }
    });

    // -----------------------------------------------------------------------
    // Effects: one per async step
    // -----------------------------------------------------------------------

    // detect-running
    useEffect(() => {
      if (step !== 'detect-running') return;
      let cancelled = false;
      const run = async () => {
        try {
          const result = await detect();
          if (!cancelled) {
            setDetectResult(result);
            setStep('detect-done');
          }
        } catch (err) {
          if (!cancelled) {
            setErrorMsg('Environment detection failed: ' + err.message);
            setStep('error');
          }
        }
      };
      run();
      return () => { cancelled = true; };
    }, [step]);

    // After detect-done auto-advance to engine-running after short delay
    useEffect(() => {
      if (step !== 'detect-done') return;
      const t = setTimeout(() => setStep('engine-running'), 700);
      return () => clearTimeout(t);
    }, [step]);

    // engine-running
    useEffect(() => {
      if (step !== 'engine-running') return;
      if (!detectResult) return;

      if (detectResult.llamaServer?.found === true) {
        setEnginePath(detectResult.llamaServer.path);
        setStep('engine-done');
        return;
      }

      let cancelled = false;
      const run = async () => {
        try {
          const result = await installEngine(detectResult, {
            onProgress: (line) => {
              if (!cancelled) setEngineLines(prev => [...prev, line]);
            },
            onSkip: (line) => {
              if (!cancelled) setEngineLines(prev => [...prev, line]);
            },
          });
          if (!cancelled) {
            if (result.manualRequired) {
              setEngineManual(result.instructions || 'Install llama.cpp manually: https://github.com/ggml-org/llama.cpp');
            } else {
              setEnginePath(result.path);
            }
            setStep('engine-done');
          }
        } catch (err) {
          if (!cancelled) {
            setEngineManual('Engine install failed: ' + err.message + '\n\nInstall manually: https://github.com/ggml-org/llama.cpp');
            setStep('engine-done');
          }
        }
      };
      run();
      return () => { cancelled = true; };
    }, [step]);

    // engine-done auto-advances to model-select
    useEffect(() => {
      if (step !== 'engine-done') return;
      const t = setTimeout(() => setStep('model-select'), 400);
      return () => clearTimeout(t);
    }, [step]);

    // download-running
    useEffect(() => {
      if (step !== 'download-running') return;
      if (selectedModels.length === 0) {
        setModelsDone(true);
        setStep('download-done');
        return;
      }

      let cancelled = false;
      const modelsDir = getModelsDir();
      const downloaded = [];
      const failed = [];

      const initPercents = {};
      for (const m of selectedModels) initPercents[m.id] = 0;
      setDownloadPercents(initPercents);

      const run = async () => {
        try {
          for (const model of selectedModels) {
            if (cancelled) return;
            try {
              await downloadModel(model, modelsDir, {
                onProgress: (evt) => {
                  if (cancelled) return;
                  let pct = null;
                  if (evt.type === 'skip') {
                    pct = 100;
                  } else if (evt.type === 'done') {
                    pct = 100;
                  } else if (evt.type === 'progress') {
                    if (evt.percent !== null && typeof evt.percent === 'number') {
                      pct = evt.percent;
                    } else if (evt.downloaded && evt.total) {
                      pct = Math.round((evt.downloaded / evt.total) * 100);
                    }
                  }
                  if (pct !== null) {
                    setDownloadPercents(prev => ({ ...prev, [model.id]: pct }));
                  }
                }
              });
              downloaded.push(model);
              setDownloadPercents(prev => ({ ...prev, [model.id]: 100 }));
            } catch (err) {
              failed.push({ model, error: err.message, hfUrl: 'https://huggingface.co/' + model.repo + '/resolve/main/' + model.file });
            }
          }
        } catch (err) {
          if (!cancelled) {
            setErrorMsg('Model download step failed unexpectedly: ' + err.message);
            setStep('error');
            return;
          }
        }
        if (!cancelled) {
          setDownloadedModels(downloaded);
          setFailedModels(failed);
          setModelsDone(true);
          setStep('download-done');
        }
      };
      run();
      return () => { cancelled = true; };
    }, [step]);

    // download-done auto-advances to config-writing
    useEffect(() => {
      if (step !== 'download-done') return;
      const t = setTimeout(() => setStep('config-writing'), 400);
      return () => clearTimeout(t);
    }, [step]);

    // config-writing
    useEffect(() => {
      if (step !== 'config-writing') return;
      let cancelled = false;
      const run = async () => {
        try {
          const modelsDir = getModelsDir();
          const successfulChat = downloadedModels.filter(m => m.group === 'chat');
          const generalModelObj = successfulChat.length > 0
            ? successfulChat.reduce((a, b) => a.sizeGB <= b.sizeGB ? a : b)
            : downloadedModels.length > 0
              ? downloadedModels.reduce((a, b) => a.sizeGB <= b.sizeGB ? a : b)
              : null;
          const serverBin = enginePath || detectResult?.llamaServer?.path || null;
          const generalModel = generalModelObj ? generalModelObj.file : null;
          const { configPath: cp, config } = await writeConfig({ serverBin, modelsDir, generalModel, port: 2276 });
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

    // config-done auto-advances to app-install-running
    useEffect(() => {
      if (step !== 'config-done') return;
      const t = setTimeout(() => setStep('app-install-running'), 600);
      return () => clearTimeout(t);
    }, [step]);

    // app-install-running
    useEffect(() => {
      if (step !== 'app-install-running') return;
      if (!detectResult) return;
      let cancelled = false;
      const run = async () => {
        try {
          const result = await installApp(detectResult, {
            onProgress: (msg) => {
              if (!cancelled) setAppLines(prev => [...prev, msg]);
            }
          });
          if (!cancelled) {
            setAppInstallResult(result);
            setStep('app-install-done');
          }
        } catch (err) {
          if (!cancelled) {
            setAppInstallResult({ manualRequired: true, instructions: 'Download from https://github.com/madalintat/LlamaRanch/releases' });
            setStep('app-install-done');
          }
        }
      };
      run();
      return () => { cancelled = true; };
    }, [step]);

    // app-install-done auto-advances to outro
    useEffect(() => {
      if (step !== 'app-install-done') return;
      const t = setTimeout(() => setStep('outro'), 500);
      return () => clearTimeout(t);
    }, [step]);

    // outro: auto-exit after 2s, or on any key (handled in top-level useInput)
    useEffect(() => {
      if (step !== 'outro') return;
      setOutroKey(true);
      const t = setTimeout(() => exit(), 2000);
      return () => clearTimeout(t);
    }, [step]);

    // -----------------------------------------------------------------------
    // Rendering helpers
    // -----------------------------------------------------------------------

    // OS label
    const osLabel = (r) => {
      if (!r) return '';
      if (r.os === 'macos') return 'macOS';
      if (r.os === 'windows') return 'Windows';
      return 'Linux';
    };

    // GPU short label
    const gpuLabel = (r) => {
      if (!r) return '';
      if (r.gpu?.type === 'metal') return 'Apple Metal';
      if (r.gpu?.type === 'cuda') return 'NVIDIA CUDA' + (r.gpu.vramGB ? ' (' + r.gpu.vramGB + ' GB)' : '');
      if (r.gpu?.type === 'vulkan') return 'Vulkan GPU';
      return 'CPU only';
    };

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------

    const rows = [];

    // Intro frame (always shown)
    rows.push(React.createElement(IntroFrame, { key: 'intro' }));

    // Confirm prompt
    if (step === 'confirm') {
      rows.push(
        React.createElement(
          Box,
          { key: 'confirm', flexDirection: 'row' },
          React.createElement(Text, { color: '#c7a228' }, '◆ '),
          React.createElement(Text, { color: '#f5f0e8' }, 'Ready to set up LlamaRanch?  '),
          React.createElement(Text, { color: '#6b6456' }, '[enter ↵]')
        )
      );
    }

    // detect-running
    if (['detect-running', 'detect-done', 'engine-running', 'engine-done',
         'model-select', 'download-running', 'download-done',
         'config-writing', 'config-done', 'app-install-running',
         'app-install-done', 'outro'].includes(step)) {

      const isRunning = step === 'detect-running';
      const isDone = !isRunning;

      if (isRunning) {
        rows.push(
          React.createElement(
            Box,
            { key: 'detect-spin', flexDirection: 'row' },
            React.createElement(Text, { color: '#f5f0e8' }, spinFrame + ' '),
            React.createElement(Text, { color: '#f5f0e8' }, 'Detecting your environment')
          )
        );
      } else {
        rows.push(
          React.createElement(
            Box,
            { key: 'detect-done', flexDirection: 'row' },
            React.createElement(Text, { color: '#cbb78a' }, '◇ '),
            React.createElement(Text, { color: '#cbb78a' }, 'Detecting your environment')
          )
        );
        if (detectResult) {
          rows.push(React.createElement(KVRow, { key: 'kv-os', label: 'os', value: osLabel(detectResult) + ' · ' + detectResult.arch }));
          rows.push(React.createElement(KVRow, { key: 'kv-node', label: 'node', value: detectResult.nodeVersion }));
          rows.push(React.createElement(KVRow, { key: 'kv-ram', label: 'ram', value: detectResult.totalRamGB + ' GB' }));
          rows.push(React.createElement(KVRow, { key: 'kv-gpu', label: 'gpu', value: gpuLabel(detectResult) }));
          const llamaVal = detectResult.llamaServer?.found
            ? detectResult.llamaServer.path
            : 'not found';
          const llamaTag = detectResult.llamaServer?.found ? null : '→ build';
          rows.push(React.createElement(KVRow, { key: 'kv-llama', label: 'llama-server', value: llamaVal, tag: llamaTag }));
          const appVal = detectResult.appInstalled?.found
            ? detectResult.appInstalled.path
            : 'not found';
          const appTag = detectResult.appInstalled?.found ? null : '→ install';
          rows.push(React.createElement(KVRow, { key: 'kv-app', label: 'desktop app', value: appVal, tag: appTag }));
        }
      }
    }

    // engine step
    if (['engine-running', 'engine-done', 'model-select', 'download-running',
         'download-done', 'config-writing', 'config-done',
         'app-install-running', 'app-install-done', 'outro'].includes(step)) {

      const isRunning = step === 'engine-running';

      if (isRunning) {
        rows.push(
          React.createElement(
            Box,
            { key: 'eng-spin', flexDirection: 'row' },
            React.createElement(Text, { color: '#f5f0e8' }, spinFrame + ' '),
            React.createElement(Text, { color: '#f5f0e8' }, 'Installing engine')
          )
        );
        for (let i = Math.max(0, engineLines.length - 6); i < engineLines.length; i++) {
          rows.push(React.createElement(SubLog, { key: 'engline-' + i, text: engineLines[i] }));
        }
      } else {
        rows.push(
          React.createElement(
            Box,
            { key: 'eng-done', flexDirection: 'row' },
            React.createElement(Text, { color: '#cbb78a' }, '◇ '),
            React.createElement(Text, { color: '#cbb78a' }, 'Installing engine')
          )
        );
        if (detectResult?.llamaServer?.found) {
          rows.push(React.createElement(SubLog, { key: 'eng-found', text: 'llama-server found at ' + detectResult.llamaServer.path }));
        } else if (engineManual) {
          rows.push(
            React.createElement(
              Box,
              { key: 'eng-warn', flexDirection: 'row' },
              React.createElement(Text, { color: '#c7a228' }, '▲ '),
              React.createElement(Text, { color: '#f5f0e8' }, 'Manual install required: ' + engineManual.split('\n')[0])
            )
          );
        } else if (enginePath) {
          rows.push(React.createElement(SubLog, { key: 'eng-path', text: 'installed at ' + enginePath }));
        }
      }
    }

    // model-select
    if (step === 'model-select') {
      const suggested = detectResult ? suggestModels(detectResult.totalRamGB) : [];
      rows.push(
        React.createElement(ModelPicker, {
          key: 'model-picker',
          models: MODEL_CATALOG,
          suggested,
          onDone: (picked) => {
            setSelectedModels(picked);
            setStep('download-running');
          }
        })
      );
    }

    // model-select done (collapsed)
    if (['download-running', 'download-done', 'config-writing', 'config-done',
         'app-install-running', 'app-install-done', 'outro'].includes(step)) {
      rows.push(
        React.createElement(
          Box,
          { key: 'model-sel-done', flexDirection: 'row' },
          React.createElement(Text, { color: '#cbb78a' }, '◇ '),
          React.createElement(Text, { color: '#cbb78a' }, 'Select models to download'),
          React.createElement(Text, { color: '#8a8270' }, '   ' + selectedModels.length + ' selected')
        )
      );
    }

    // download-running
    if (step === 'download-running') {
      rows.push(
        React.createElement(
          Box,
          { key: 'dl-spin', flexDirection: 'row' },
          React.createElement(Text, { color: '#f5f0e8' }, spinFrame + ' '),
          React.createElement(Text, { color: '#f5f0e8' }, 'Downloading from Hugging Face')
        )
      );
      for (const model of selectedModels) {
        const pct = downloadPercents[model.id] || 0;
        const nameCol = (model.name || '').padEnd(18).slice(0, 18);
        const pctStr = String(Math.round(pct)).padStart(3) + '%';
        rows.push(
          React.createElement(
            Box,
            { key: 'dl-row-' + model.id, flexDirection: 'row' },
            React.createElement(Text, { color: '#3f3d34' }, '│   '),
            React.createElement(Text, { color: '#8a8270' }, nameCol),
            React.createElement(Text, null, '  '),
            React.createElement(ProgressBar, { percent: pct }),
            React.createElement(Text, null, '  '),
            React.createElement(Text, { color: '#6b6456' }, pctStr)
          )
        );
      }
    }

    // download-done (collapsed)
    if (['download-done', 'config-writing', 'config-done',
         'app-install-running', 'app-install-done', 'outro'].includes(step)) {
      rows.push(
        React.createElement(
          Box,
          { key: 'dl-done', flexDirection: 'row' },
          React.createElement(Text, { color: '#cbb78a' }, '◇ '),
          React.createElement(Text, { color: '#cbb78a' }, 'Downloading from Hugging Face'),
          React.createElement(Text, { color: '#8a8270' }, '   ' + downloadedModels.length + ' downloaded')
        )
      );
    }

    // config-writing
    if (step === 'config-writing') {
      rows.push(
        React.createElement(
          Box,
          { key: 'cfg-spin', flexDirection: 'row' },
          React.createElement(Text, { color: '#f5f0e8' }, spinFrame + ' '),
          React.createElement(Text, { color: '#f5f0e8' }, 'Writing config')
        )
      );
    }

    // config-done (collapsed)
    if (['config-done', 'app-install-running', 'app-install-done', 'outro'].includes(step)) {
      if (configData && configData.error) {
        rows.push(
          React.createElement(
            Box,
            { key: 'cfg-done', flexDirection: 'row' },
            React.createElement(Text, { color: '#c7a228' }, '▲ '),
            React.createElement(Text, { color: '#f5f0e8' }, 'Config write failed: ' + configData.error)
          )
        );
      } else {
        rows.push(
          React.createElement(
            Box,
            { key: 'cfg-done', flexDirection: 'row' },
            React.createElement(Text, { color: '#cbb78a' }, '◇ '),
            React.createElement(Text, { color: '#cbb78a' }, 'Config written'),
            React.createElement(Text, null, '  '),
            React.createElement(Text, { color: '#6b6456' }, configPath)
          )
        );
      }
    }

    // app-install-running
    if (step === 'app-install-running') {
      rows.push(
        React.createElement(
          Box,
          { key: 'app-spin', flexDirection: 'row' },
          React.createElement(Text, { color: '#f5f0e8' }, spinFrame + ' '),
          React.createElement(Text, { color: '#f5f0e8' }, 'Installing desktop app')
        )
      );
      for (let i = Math.max(0, appLines.length - 5); i < appLines.length; i++) {
        rows.push(React.createElement(SubLog, { key: 'appline-' + i, text: appLines[i] }));
      }
    }

    // app-install-done (collapsed)
    if (['app-install-done', 'outro'].includes(step)) {
      if (appInstallResult?.manualRequired) {
        rows.push(
          React.createElement(
            Box,
            { key: 'app-warn', flexDirection: 'row' },
            React.createElement(Text, { color: '#c7a228' }, '▲ '),
            React.createElement(Text, { color: '#f5f0e8' }, 'Desktop app: manual install required')
          )
        );
        if (appInstallResult.instructions) {
          rows.push(React.createElement(SubLog, { key: 'app-instr', text: appInstallResult.instructions }));
        }
      } else {
        rows.push(
          React.createElement(
            Box,
            { key: 'app-done', flexDirection: 'row' },
            React.createElement(Text, { color: '#cbb78a' }, '◇ '),
            React.createElement(Text, { color: '#cbb78a' }, 'Installing desktop app')
          )
        );
      }
    }

    // outro
    if (step === 'outro') {
      const serverBin = enginePath || detectResult?.llamaServer?.path || null;
      // Use the same general model selection logic as the config-writing step:
      // smallest chat model among downloaded, falling back to smallest overall.
      const successfulChat = downloadedModels.filter(m => m.group === 'chat');
      const generalModelObj = successfulChat.length > 0
        ? successfulChat.reduce((a, b) => a.sizeGB <= b.sizeGB ? a : b)
        : downloadedModels.length > 0
          ? downloadedModels.reduce((a, b) => a.sizeGB <= b.sizeGB ? a : b)
          : null;
      const generalModelFile = generalModelObj ? generalModelObj.file : null;
      const appPath = detectResult?.os === 'macos'
        ? '/Applications/LlamaRanch.app'
        : detectResult?.os === 'linux'
          ? '~/.local/bin/LlamaRanch.AppImage'
          : 'LlamaRanch';

      rows.push(React.createElement(Text, { key: 'outro-gap', color: '#3f3d34' }, '│'));
      rows.push(
        React.createElement(
          Box,
          { key: 'outro-head', flexDirection: 'row' },
          React.createElement(Text, { color: '#c7a228' }, '└ '),
          React.createElement(Text, { color: '#f5f0e8', bold: true }, 'The ranch is up.')
        )
      );
      if (serverBin) {
        rows.push(
          React.createElement(
            Box,
            { key: 'outro-serve', flexDirection: 'row' },
            React.createElement(Text, null, '   '),
            React.createElement(Text, { color: '#f5f0e8', bold: true }, 'serve  '),
            React.createElement(Text, { color: '#f5f0e8' }, '127.0.0.1:2276/v1'),
            generalModelFile
              ? React.createElement(Text, { color: '#f5f0e8' }, ' · ' + generalModelFile)
              : null,
            React.createElement(Text, { color: '#6b6456' }, ' · local')
          )
        );
      }
      rows.push(
        React.createElement(
          Box,
          { key: 'outro-app', flexDirection: 'row' },
          React.createElement(Text, null, '   '),
          React.createElement(Text, { color: '#f5f0e8', bold: true }, 'app    '),
          React.createElement(Text, { color: '#f5f0e8' }, appPath)
        )
      );
      rows.push(React.createElement(Text, { key: 'outro-gap2', color: '#3f3d34' }, '│'));
      rows.push(
        React.createElement(
          Box,
          { key: 'outro-cmd1', flexDirection: 'row' },
          React.createElement(Text, null, '   '),
          React.createElement(Text, { color: '#c7a228' }, 'llamaranch chat'),
          React.createElement(Text, { color: '#6b6456' }, '     # start a local conversation')
        )
      );
      rows.push(
        React.createElement(
          Box,
          { key: 'outro-cmd2', flexDirection: 'row' },
          React.createElement(Text, null, '   '),
          React.createElement(Text, { color: '#c7a228' }, 'llamaranch ui'),
          React.createElement(Text, { color: '#6b6456' }, '       # open the desktop app')
        )
      );
      // Surface config write failure if it occurred
      if (configData && configData.error) {
        rows.push(React.createElement(Text, { key: 'outro-cfg-gap', color: '#3f3d34' }, '│'));
        rows.push(
          React.createElement(
            Box,
            { key: 'outro-cfg-err', flexDirection: 'row' },
            React.createElement(Text, { color: '#c7a228' }, '▲ '),
            React.createElement(Text, { color: '#f5f0e8' }, 'Config write failed: ' + configData.error)
          )
        );
        rows.push(
          React.createElement(
            Box,
            { key: 'outro-cfg-hint', flexDirection: 'row' },
            React.createElement(Text, { color: '#3f3d34' }, '│ '),
            React.createElement(Text, { color: '#6b6456' }, 'Create ' + configPath + ' manually, then re-run.')
          )
        );
      }
      // Surface any download failures
      if (failedModels.length > 0) {
        rows.push(React.createElement(Text, { key: 'outro-fail-gap', color: '#3f3d34' }, '│'));
        rows.push(
          React.createElement(
            Box,
            { key: 'outro-fail-head', flexDirection: 'row' },
            React.createElement(Text, { color: '#c7a228' }, '▲ '),
            React.createElement(Text, { color: '#f5f0e8' }, failedModels.length + ' model(s) did not download:')
          )
        );
        for (let fi = 0; fi < failedModels.length; fi++) {
          const fm = failedModels[fi];
          rows.push(
            React.createElement(
              Box,
              { key: 'outro-fail-' + fi, flexDirection: 'row' },
              React.createElement(Text, { color: '#3f3d34' }, '│   '),
              React.createElement(Text, { color: '#8a8270' }, (fm.model?.name || fm.model?.file || 'unknown') + ': '),
              React.createElement(Text, { color: '#6b6456' }, fm.error || 'download error')
            )
          );
        }
        rows.push(
          React.createElement(
            Box,
            { key: 'outro-fail-hint', flexDirection: 'row' },
            React.createElement(Text, { color: '#3f3d34' }, '│ '),
            React.createElement(Text, { color: '#6b6456' }, 'Re-run the wizard to retry failed downloads.')
          )
        );
      }
      rows.push(
        React.createElement(
          Box,
          { key: 'outro-caret', flexDirection: 'row' },
          React.createElement(Text, { color: '#c7a228' }, '❯')
        )
      );
    }

    // error
    if (step === 'error') {
      rows.push(
        React.createElement(
          Box,
          { key: 'err-head', flexDirection: 'row' },
          React.createElement(Text, { color: '#c7a228' }, '▲ '),
          React.createElement(Text, { color: '#f5f0e8' }, errorMsg || 'An unexpected error occurred.')
        )
      );
      rows.push(
        React.createElement(
          Box,
          { key: 'err-hint', flexDirection: 'row' },
          React.createElement(Text, { color: '#3f3d34' }, '│ '),
          React.createElement(Text, { color: '#6b6456' }, 'Press any key to exit')
        )
      );
    }

    return React.createElement(Box, { flexDirection: 'column' }, ...rows);
  }

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
  // Branded header
  renderLogo();
  console.log(chalk.hex('#c7a228')('  serve') + chalk.hex('#6b6456')('  starting llama-server...'));
  console.log('');
  await runServe();
  process.exit(0);
} else if (cmd === 'update') {
  const { runUpdate } = await import('./update.js');
  // Branded header
  renderLogo();
  console.log(chalk.hex('#c7a228')('  update') + chalk.hex('#6b6456')('  checking for new releases...'));
  console.log('');
  await runUpdate();
  process.exit(0);
} else if (cmd === 'uninstall') {
  const { runUninstall } = await import('./uninstall.js');
  const yes = process.argv.includes('--yes') || process.argv.includes('-y');
  await runUninstall({ yes });
  process.exit(0);
} else if (!cmd || cmd === 'setup') {
  await runWizard();
} else {
  console.error(chalk.hex('#c7a228')('▲ ') + 'Unknown command: ' + cmd);
  console.error(chalk.hex('#6b6456')('  Run with --help for usage.'));
  process.exit(1);
}
