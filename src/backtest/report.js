'use strict';

/**
 * Console summary table (no external deps) + parameter-flagging warnings.
 *
 * Layout is one row per ticker (plus a PORTFOLIO row) with metrics as columns,
 * and every column is auto-sized — so it stays readable whether TICKERS holds
 * 3 names or 30.
 */

const { TICKERS } = require('../config');

const money = (n) =>
  (n < 0 ? '-$' : '$') +
  Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n) => `${n.toFixed(2)}%`;
const ratio = (n) => (n === Infinity ? 'Inf' : n.toFixed(2));

/** Render a table from headers + rows with per-column auto width. */
function renderTable(headers, rows, aligns) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length))
  );
  const fmtRow = (cells) =>
    cells
      .map((c, i) => {
        const s = String(c);
        const padLen = Math.max(0, widths[i] - s.length);
        return aligns[i] === 'l' ? s + ' '.repeat(padLen) : ' '.repeat(padLen) + s;
      })
      .join(' | ');
  const divider = widths.map((w) => '-'.repeat(w)).join('-+-');
  return { text: [fmtRow(headers), divider, ...rows.map(fmtRow)].join('\n'), width: divider.length };
}

function metricRow(label, m) {
  return [
    label,
    m.trades,
    pct(m.winRate),
    money(m.avgWin),
    money(m.avgLoss),
    ratio(m.profitFactor),
    pct(m.maxDDPct),
    m.sharpe.toFixed(2),
    pct(m.totalReturn),
  ];
}

function printReport(report, meta) {
  const headers = [
    'Ticker', 'Trades', 'Win Rate', 'Avg Win', 'Avg Loss',
    'Profit Factor', 'Max DD', 'Sharpe', 'Total Return',
  ];
  const aligns = ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'];

  const rows = TICKERS.map((t) => metricRow(t, report.perTicker[t]));
  rows.push(metricRow('PORTFOLIO', report.combined));

  const table = renderTable(headers, rows, aligns);
  const bar = '='.repeat(table.width);

  console.log('\n' + bar);
  console.log(`  BACKTEST RESULTS  |  ${meta.start} → ${meta.end}  |  feed: ${meta.feed}  |  ${TICKERS.length} tickers`);
  console.log(
    `  Start equity: ${money(report.combined.startEquity)}   ` +
    `End equity: ${money(report.combined.endEquity)}`
  );
  console.log(bar);
  console.log(table.text);
  console.log(bar + '\n');

  // --- Parameter flagging ---
  if (report.combined.sharpe < 0) {
    console.warn(
      '⚠️  WARNING: Combined Sharpe ratio is NEGATIVE ' +
      `(${report.combined.sharpe.toFixed(2)}).\n` +
      '    The strategy lost money on a risk-adjusted basis over this period.\n' +
      '    Strategy parameters or asset selection need adjustment before any use.\n'
    );
  } else {
    console.log(`✓  Combined Sharpe ratio: ${report.combined.sharpe.toFixed(2)} (non-negative).\n`);
  }

  const negTickers = TICKERS.filter((t) => report.perTicker[t].sharpe < 0);
  if (negTickers.length) {
    console.warn(`⚠️  Negative Sharpe on individual ticker(s): ${negTickers.join(', ')}.\n`);
  }
}

module.exports = { printReport };
