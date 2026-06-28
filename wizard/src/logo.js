import chalk from 'chalk';
import { VERSION } from './version.js';

// Brand palette (monochrome): soft-white text, cool-grey muted.
const TEXT = '#d8d8dd';
const MUTED = '#8a8a92';

function useColor() {
  if (process.env.NO_COLOR) return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

// ASCII llama, derived from our real logo (src/assets/llama.svg) by
// half-block downsampling. Head + ears top-left, long neck curving down
// into the body. Rendered in soft white.
export const LLAMA_LINES = [
  '         ███        ████',
  '         █████      █████',
  '          █████     ██████',
  '           █████     ██████',
  '            ██████   ██████',
  '             ██████████████',
  '            ███████████████',
  '          ██████████████████',
  '         ███████████████████',
  '       ██████████    ████████',
  '     ██████████     ██████████',
  '   ███████████████████████████',
  '  █████████████████████████████',
  '  █████████████████████████████',
  '  █████████████████████████████',
  '  ████████████████████ █████████',
  '   ████████████████   ██████████',
  '                  ██████████████',
  '                █████████████████',
  '                █████████████████',
  '                 █████████████████',
  '                 █████████████████',
  '                 ██████████████████',
  '                  █████████████████',
  '                  █████████████████',
  '                   █████████████████',
];

// Block glyphs render in soft white.
function colorLine(line, colored) {
  if (!colored) return line;
  return line.replace(/[█▀▄]/g, m => chalk.hex(TEXT)(m));
}

export function renderLogo() {
  const colored = useColor();

  const lines = LLAMA_LINES.map(l => colorLine(l, colored));

  const output = [];
  output.push('');
  for (const line of lines) {
    output.push(line);
  }
  output.push('');

  if (colored) {
    output.push(
      '  ' +
      chalk.bgHex(TEXT).hex('#0c0c0e').bold(' LlamaRanch ') +
      '  ' +
      chalk.hex(MUTED)('setup wizard · v' + VERSION)
    );
    output.push('');
    output.push(chalk.hex(MUTED)('  A quiet ranch for your local models. Nothing leaves the valley.'));
  } else {
    output.push('  LlamaRanch  setup wizard · v' + VERSION);
    output.push('');
    output.push('  A quiet ranch for your local models. Nothing leaves the valley.');
  }

  output.push('');
  console.log(output.join('\n'));
}
