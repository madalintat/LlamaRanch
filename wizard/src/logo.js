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

// ASCII llama art: 9 lines, crafted block look
// Head with ears, long neck, body, legs
const LLAMA_LINES = [
  '  ╔══╗   ',
  '  ║  ║   ',
  '  ╚╗ ╔╝  ',
  '   ║ ║   ',
  '  ██████ ',
  '  ██████ ',
  '  ██████ ',
  '  █  █   ',
  '  █  █   ',
];

// Each character type maps to a color
function colorLine(line, colored) {
  if (!colored) return line;
  // Gold accent on ear/corner characters
  return line
    .replace(/[╔╗╚╝╠╣╦╩╬]/g, m => chalk.hex(GOLD)(m))
    .replace(/[║═]/g, m => chalk.hex(GOLD)(m))
    .replace(/█/g, m => chalk.hex(CREAM)(m))
    .replace(/▓/g, m => chalk.hex(CREAM)(m))
    .replace(/[│ ]/g, m => m);
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
