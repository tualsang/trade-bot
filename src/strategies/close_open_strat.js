'use strict';

/**
 * Market Close / Open Arbitrage strategy.
 *
 *   BUY  : ~15 minutes before the close, deploy 50% of account equity,
 *          split equally across the tradable tickers (16.67% each).
 *          If a ticker is restricted/unavailable, its slice stays in cash
 *          (it is NOT redistributed to the other tickers).
 *   SELL : at the next market open, close every position we hold.
 *
 * Position state is persisted to state.json so a restart between the
 * buy and the sell does not lose the round-trip P&L basis.
 */

const fs = require('fs');
const { alpaca, TICKERS, DEPLOY_FRACTION, STATE_FILE } = require('../config');
const log = require('../utils/logger');
const { withRetry, getLatestPrice, waitForFill, statusOf } = require('../utils/alpaca');

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { openPositions: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function utcDate(iso = new Date().toISOString()) {
  return iso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// BUY: 15 minutes before close
// ---------------------------------------------------------------------------
async function runBuy() {
  log.info('=== CLOSE buy routine starting ===');

  const account = await withRetry(() => alpaca.getAccount(), { label: 'account' });
  const equity = Number(account.equity);
  log.info(
    `Equity: $${equity.toFixed(2)} | Cash: $${Number(account.cash).toFixed(2)}`
  );

  // (equity * 50%) / 3  ==  equity / 6  ==  16.67% of equity per ticker.
  const perTicker = Number(((equity * DEPLOY_FRACTION) / TICKERS.length).toFixed(2));
  const pctEach = ((DEPLOY_FRACTION / TICKERS.length) * 100).toFixed(2);
  log.info(`Target per ticker: $${perTicker.toFixed(2)} (${pctEach}% of equity each).`);

  const state = loadState();
  state.openPositions = {};

  for (const symbol of TICKERS) {
    try {
      // --- Tradability check: skip (leave slice in cash) if unavailable. ---
      const asset = await withRetry(() => alpaca.getAsset(symbol), { label: `asset:${symbol}` });
      if (!asset.tradable || asset.status !== 'active') {
        log.warn(
          `${symbol} is not tradable/active — its $${perTicker.toFixed(2)} stays in cash.`
        );
        continue;
      }

      // --- Place the buy. Prefer a notional (dollar) order for exact sizing. ---
      let order;
      if (asset.fractionable) {
        order = await withRetry(
          () =>
            alpaca.createOrder({
              symbol,
              notional: perTicker,
              side: 'buy',
              type: 'market',
              time_in_force: 'day',
            }),
          { label: `buy:${symbol}` }
        );
      } else {
        // Non-fractionable: buy whole shares we can afford with the slice.
        const price = await getLatestPrice(symbol);
        const qty = Math.floor(perTicker / price);
        if (qty < 1) {
          log.warn(
            `${symbol}: $${perTicker.toFixed(2)} < 1 share ($${price.toFixed(2)}) — staying in cash.`
          );
          continue;
        }
        order = await withRetry(
          () =>
            alpaca.createOrder({
              symbol,
              qty,
              side: 'buy',
              type: 'market',
              time_in_force: 'day',
            }),
          { label: `buy:${symbol}` }
        );
      }

      // --- Wait for the fill and record it. ---
      const filled = await waitForFill(order.id);
      const price = Number(filled.filled_avg_price);
      const qty = Number(filled.filled_qty);

      if (!price || !qty) {
        log.warn(`${symbol}: order ${order.id} did not fill cleanly; skipping log.`);
        continue;
      }

      const totalValue = Number((price * qty).toFixed(2));

      log.logTrade({
        timestamp: new Date().toISOString(),
        instrument: symbol,
        direction: 'BUY',
        price: price.toFixed(4),
        quantity: qty,
        totalValue: totalValue.toFixed(2),
      });

      state.openPositions[symbol] = {
        buyPrice: price,
        qty,
        buyValue: totalValue,
        buyTime: new Date().toISOString(),
      };

      log.info(`BUY  ${symbol}: ${qty} @ $${price.toFixed(2)} = $${totalValue.toFixed(2)}`);
    } catch (err) {
      // One failure should not over-allocate to the others or abort the batch.
      log.error(`Buy failed for ${symbol}:`, err?.message || err);
    }
  }

  saveState(state);
  log.info('=== CLOSE buy routine complete ===');
}

// ---------------------------------------------------------------------------
// SELL: at market open
// ---------------------------------------------------------------------------
/**
 * @param {object} [opts]
 * @param {boolean} [opts.onlyOvernight=false]
 *        When true (used for restart catch-up), only sells positions whose buy
 *        happened on a prior day, so a mid-session restart never closes a
 *        position we just opened the same afternoon.
 */
async function runSell({ onlyOvernight = false } = {}) {
  log.info('=== OPEN sell routine starting ===');

  const state = loadState();
  const today = utcDate();
  let totalBuy = 0;
  let totalSell = 0;
  let totalPnl = 0;
  let pnlRows = 0;

  for (const symbol of TICKERS) {
    try {
      if (onlyOvernight) {
        const buyTime = state.openPositions?.[symbol]?.buyTime;
        if (!buyTime || utcDate(buyTime) === today) {
          continue; // unknown or same-day position — don't touch on catch-up
        }
      }

      // Only act if a position actually exists.
      let hasPosition = true;
      try {
        await withRetry(() => alpaca.getPosition(symbol), { label: `position:${symbol}` });
      } catch (e) {
        const status = statusOf(e);
        const msg = (e?.message || '').toLowerCase();
        if (status === 404 || msg.includes('position does not exist') || msg.includes('not found')) {
          hasPosition = false;
        } else {
          throw e;
        }
      }
      if (!hasPosition) {
        log.info(`No open position in ${symbol} — skipping.`);
        continue;
      }

      // Close the entire position (cleanly handles fractional share quantities).
      const order = await withRetry(() => alpaca.closePosition(symbol), { label: `close:${symbol}` });
      const filled = await waitForFill(order.id);
      const price = Number(filled.filled_avg_price);
      const qty = Number(filled.filled_qty);
      const sellValue = Number((price * qty).toFixed(2));

      log.logTrade({
        timestamp: new Date().toISOString(),
        instrument: symbol,
        direction: 'SELL',
        price: price.toFixed(4),
        quantity: qty,
        totalValue: sellValue.toFixed(2),
      });

      const buyValue = state.openPositions?.[symbol]?.buyValue ?? null;
      const pnl = buyValue != null ? Number((sellValue - buyValue).toFixed(2)) : null;
      const pnlPct =
        buyValue ? Number((((sellValue - buyValue) / buyValue) * 100).toFixed(2)) : null;

      log.logDailyPnl({
        date: today,
        instrument: symbol,
        buyValue: buyValue != null ? buyValue.toFixed(2) : '',
        sellValue: sellValue.toFixed(2),
        pnl: pnl != null ? pnl.toFixed(2) : '',
        pnlPct: pnlPct != null ? pnlPct.toFixed(2) : '',
      });

      if (pnl != null) {
        totalBuy += buyValue;
        totalSell += sellValue;
        totalPnl += pnl;
        pnlRows += 1;
      }

      log.info(
        `SELL ${symbol}: ${qty} @ $${price.toFixed(2)} = $${sellValue.toFixed(2)} | ` +
        `P&L: ${pnl != null ? '$' + pnl.toFixed(2) : 'n/a'}`
      );

      // Clear this position from state once closed.
      if (state.openPositions) delete state.openPositions[symbol];
    } catch (err) {
      log.error(`Sell failed for ${symbol}:`, err?.message || err);
    }
  }

  // Daily aggregate row.
  if (pnlRows > 0) {
    log.logDailyPnl({
      date: today,
      instrument: 'TOTAL',
      buyValue: totalBuy.toFixed(2),
      sellValue: totalSell.toFixed(2),
      pnl: totalPnl.toFixed(2),
      pnlPct: totalBuy ? ((totalPnl / totalBuy) * 100).toFixed(2) : '',
    });
  }

  saveState(state);
  log.info(`=== OPEN sell routine complete | Daily P&L: $${totalPnl.toFixed(2)} ===`);
}

module.exports = { runBuy, runSell };
