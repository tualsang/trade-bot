'use strict';

/**
 * Logging utilities.
 *  - info/warn/error: timestamped console output.
 *  - logTrade:        appends a row to trades.csv.
 *  - logDailyPnl:     appends a row to daily_pnl.csv.
 *
 * Headers are written automatically the first time each file is touched.
 */

const fs = require('fs');
const { TRADES_CSV, PNL_CSV } = require('../config');

function ts() {
  return new Date().toISOString();
}

function info(...args) {
  console.log(`[${ts()}] [INFO] `, ...args);
}
function warn(...args) {
  console.warn(`[${ts()}] [WARN] `, ...args);
}
function error(...args) {
  console.error(`[${ts()}] [ERROR]`, ...args);
}

function ensureHeader(file, header) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    fs.writeFileSync(file, header + '\n');
  }
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {object} t
 * @param {string} t.timestamp   ISO timestamp of the fill
 * @param {string} t.instrument  ticker symbol
 * @param {string} t.direction   'BUY' | 'SELL'
 * @param {number|string} t.price       execution price
 * @param {number|string} t.quantity    filled quantity
 * @param {number|string} t.totalValue  price * quantity
 */
function logTrade(t) {
  ensureHeader(
    TRADES_CSV,
    'timestamp,instrument,direction,execution_price,quantity,total_value'
  );
  const row = [t.timestamp, t.instrument, t.direction, t.price, t.quantity, t.totalValue]
    .map(csvEscape)
    .join(',');
  fs.appendFileSync(TRADES_CSV, row + '\n');
}

/**
 * @param {object} p
 * @param {string} p.date        trading date (YYYY-MM-DD)
 * @param {string} p.instrument  ticker symbol, or 'TOTAL' for the daily aggregate
 * @param {number|string} p.buyValue
 * @param {number|string} p.sellValue
 * @param {number|string} p.pnl
 * @param {number|string} p.pnlPct
 */
function logDailyPnl(p) {
  ensureHeader(PNL_CSV, 'date,instrument,buy_value,sell_value,pnl,pnl_pct');
  const row = [p.date, p.instrument, p.buyValue, p.sellValue, p.pnl, p.pnlPct]
    .map(csvEscape)
    .join(',');
  fs.appendFileSync(PNL_CSV, row + '\n');
}

module.exports = { info, warn, error, logTrade, logDailyPnl };
