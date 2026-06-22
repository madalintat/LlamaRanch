import chalk from 'chalk';

// Brand palette
const COLOR_GREEN = '#2e8b48';
const COLOR_LLAMA = '#f5f0e8';
const COLOR_DARK = '#1a1a1a';
const COLOR_MID = '#3a3028';
const COLOR_DIM = '#6b5f52';

// Check if color output is supported
function useColor() {
  if (process.env.NO_COLOR) return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

// Pixel-art llama glyph: 10 cols x 12 rows
// Head with ear points, long neck, wide body, legs
const LLAMA_ROWS = [
  '  ▓█▓   ',  // ear tip
  ' ▓███▓  ',  // head
  ' █████  ',  // head wide
  '  ███   ',  // neck top
  '  ███   ',  // neck mid
  ' █████  ',  // neck/shoulder
  '███████ ',  // body top
  '███████ ',  // body mid
  '███████ ',  // body lower
  ' ██ ██  ',  // upper legs
  ' █   █  ',  // lower legs
  ' █   █  ',  // hooves
];

// Color each row of the glyph
function colorGlyphRow(row, useColorOutput) {
  if (!useColorOutput) return row;
  return row
    .replace(/█/g, chalk.hex(COLOR_LLAMA)('█'))
    .replace(/▓/g, chalk.hex(COLOR_DIM)('▓'))
    .replace(/▒/g, chalk.hex(COLOR_MID)('▒'))
    .replace(/░/g, chalk.hex(COLOR_DARK)('░'));
}

// Dither band: gradient wash aesthetic
const DITHER_BAND = [
  '░░▒▒▓▓██▓▓▒▒░░',
  '░▒▓██████████▓▒░',
  '░░▒▒▓▓██▓▓▒▒░░',
];

function colorDitherRow(row, useColorOutput) {
  if (!useColorOutput) return row;
  return row
    .replace(/█/g, chalk.hex(COLOR_GREEN)('█'))
    .replace(/▓/g, chalk.hex(COLOR_MID)('▓'))
    .replace(/▒/g, chalk.hex(COLOR_DIM)('▒'))
    .replace(/░/g, chalk.hex(COLOR_DARK).dim('░'));
}

// Wordmark lines: "Llama" + "Ranch" in large bold text
function renderWordmark(useColorOutput) {
  const llama = 'Llama';
  const ranch = 'Ranch';

  if (!useColorOutput) {
    return [
      '',
      `  ${llama}${ranch}`,
      '',
    ];
  }

  const llamaStyled = chalk.bold.hex(COLOR_LLAMA)(llama);
  const ranchStyled = chalk.bold.hex(COLOR_GREEN)(ranch);

  return [
    '',
    `  ${llamaStyled}${ranchStyled}`,
    '',
  ];
}

// Tagline
function renderTagline(useColorOutput) {
  const text = 'nothing leaves the valley';
  if (!useColorOutput) return `  ${text}`;
  return `  ${chalk.dim.hex(COLOR_DIM)(text)}`;
}

export function renderLogo() {
  const colored = useColor();

  const glyphLines = LLAMA_ROWS.map(row => colorGlyphRow(row, colored));
  const wordmark = renderWordmark(colored);
  const tagline = renderTagline(colored);

  // Pad glyph to align with wordmark block
  // Glyph is 12 rows, wordmark block is 3 lines -- center them
  const glyphPad = '        '; // glyph is ~8 chars wide

  // Side-by-side layout: glyph on left, wordmark+info on right
  // We print them interleaved: first few rows of glyph get wordmark text alongside

  const output = [];

  // Top spacer
  output.push('');

  // Combine glyph and wordmark side by side
  // Glyph rows: 12. Wordmark: placed at rows 3-5 (0-indexed)
  const wordmarkStartRow = 3;
  const wordmarkLines = wordmark;

  for (let i = 0; i < LLAMA_ROWS.length; i++) {
    const glyphPart = colored
      ? chalk.bgHex(COLOR_DARK)(' ' + glyphLines[i] + ' ')
      : ' ' + glyphLines[i] + ' ';

    let rightPart = '';
    const wmIdx = i - wordmarkStartRow;
    if (wmIdx >= 0 && wmIdx < wordmarkLines.length) {
      rightPart = wordmarkLines[wmIdx];
    }

    output.push(glyphPart + rightPart);
  }

  // Tagline row
  output.push('');

  // Dither band
  for (const row of DITHER_BAND) {
    output.push(colorDitherRow(row, colored));
  }

  // Tagline
  output.push('');
  output.push(tagline);
  output.push('');

  console.log(output.join('\n'));
}
