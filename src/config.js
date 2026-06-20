'use strict';

/**
 * Central configuration.
 * Loads the .env file, validates credentials, constructs the Alpaca client,
 * and exports the strategy constants + file paths used across the project.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const Alpaca = require('@alpacahq/alpaca-trade-api');

const { ALPACA_API_KEY, ALPACA_SECRET_KEY, ALPACA_PAPER_URL } = process.env;

if (!ALPACA_API_KEY || !ALPACA_SECRET_KEY) {
  throw new Error(
    'Missing credentials. Set ALPACA_API_KEY and ALPACA_SECRET_KEY in your .env file.'
  );
}

const baseUrl = ALPACA_PAPER_URL || 'https://paper-api.alpaca.markets';

if (!/paper/i.test(baseUrl)) {
  // Safety guard: this bot is intended for paper trading.
  console.warn(
    `[WARN] ALPACA_PAPER_URL ("${baseUrl}") does not look like a paper endpoint. ` +
    'Double-check before running against real money.'
  );
}

const alpaca = new Alpaca({
  keyId: ALPACA_API_KEY,
  secretKey: ALPACA_SECRET_KEY,
  paper: true,
  baseUrl,
});

module.exports = {
  alpaca,

  // Instruments traded simultaneously. This is the SINGLE source of truth —
  // both the live bot and the backtest read this list. Add/remove freely;
  // position sizing auto-adjusts to (DEPLOY_FRACTION / TICKERS.length) each.
  TICKERS: [
    'MU', 'SNDK', 'SOXL', 'INTC', 'MRVL',
  ],

  // 75% of total account equity is deployed; the remaining 50% stays in cash.
  DEPLOY_FRACTION: 0.75,

  // Buy this many minutes before the official close.
  MINUTES_BEFORE_CLOSE: 15,

  // All scheduling is anchored to US market time.
  TIMEZONE: 'America/New_York',

  // Output / state file locations (project root).
  TRADES_CSV: path.resolve(__dirname, '..', 'trades.csv'),
  PNL_CSV: path.resolve(__dirname, '..', 'daily_pnl.csv'),
  STATE_FILE: path.resolve(__dirname, '..', 'state.json'),
};
