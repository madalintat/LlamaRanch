import chalk from 'chalk';

// Brand palette
const CREAM = '#f5f0e8';
const GOLD = '#c7a228';
const MUTED = '#6b6456';

function useColor() {
  if (process.env.NO_COLOR) return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

// ASCII llama, derived from our real logo (src/assets/llama.svg) by
// half-block downsampling. Head + ears top-left, long neck curving down
// into the body. Rendered in brand cream.
const LLAMA_LINES = [
  '          ▄',
  '       ██ ██',
  '       ▀█▄██',
  '        ████',
  '       ▄████',
  '       ██████',
  '      ███████',
  '     ████████',
  '     ▀███████▄',
  '      ▀  █████',
  '         █████',
  '         █████',
  '         █████',
  '          ▀▀▀▀',
];

// Block glyphs render in brand cream.
function colorLine(line, colored) {
  if (!colored) return line;
  return line.replace(/[█▀▄]/g, m => chalk.hex(CREAM)(m));
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
      chalk.bgHex(CREAM).hex('#16150f').bold(' LlamaRanch ') +
      '  ' +
      chalk.hex(MUTED)('setup wizard · v0.1.0')
    );
    output.push('');
    output.push(chalk.hex(MUTED)('  A quiet ranch for your local models. Nothing leaves the valley.'));
  } else {
    output.push('  LlamaRanch  setup wizard · v0.1.0');
    output.push('');
    output.push('  A quiet ranch for your local models. Nothing leaves the valley.');
  }

  output.push('');
  console.log(output.join('\n'));
}
