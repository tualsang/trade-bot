'use strict';

/**
 * Backtest entry point.
 *   node src/backtest/index.js
 * or
 *   npm run backtest
 *
 * Pipeline: load data → simulate → compute metrics → print table → render chart.
 */

const path = require('path');
const { TICKERS } = require('../config');
const log = require('../utils/logger');
const { loadData } = require('./data');
const { runSimulation } = require('./simulate');
const { buildReport } = require('./metrics');
const { printReport } = require('./report');
const { renderEquityChart } = require('./chart');

const STARTING_EQUITY = Number(process.env.BACKTEST_EQUITY || 100000);
const SLIPPAGE = 0.0005; // 0.05% per execution
const MONTHS = 6;
const CHART_PATH = path.resolve(__dirname, '..', '..', 'backtest_results.png');

async function main() {
  log.info('Starting 6-month backtest of Close/Open Arbitrage strategy...');
  log.info(
    `Starting equity: $${STARTING_EQUITY.toLocaleString('en-US')} | ` +
    `Slippage: ${(SLIPPAGE * 100).toFixed(3)}% per execution | Commission: $0`
  );

  // 1. Data
  const { dayMaps, commonDates, meta } = await loadData({ months: MONTHS });

  // 2. Simulate
  const sim = runSimulation({
    dayMaps,
    tickers: TICKERS,
    dates: commonDates,
    startEquity: STARTING_EQUITY,
    slippage: SLIPPAGE,
  });

  // 3. Metrics
  const report = buildReport(sim, TICKERS);

  // 4. Console summary + parameter flagging
  printReport(report, meta);

  // 5. Equity curve chart
  try {
    const out = await renderEquityChart(sim.equityCurve, CHART_PATH);
    log.info(`Equity curve chart saved to ${out}`);
  } catch (err) {
    log.error('Chart generation failed (metrics above are still valid):', err?.message || err);
    log.error(
      "If this is a native 'canvas' build error on macOS, run:\n" +
      '  brew install pkg-config cairo pango libpng jpeg giflib librsvg\n' +
      '  npm rebuild canvas'
    );
  }

  log.info('Backtest complete.');
}

main().catch((err) => {
  log.error('Backtest failed:', err?.message || err);
  process.exit(1);
});
