'use strict';

/**
 * Market Close / Open Arbitrage strategy.
 *
 *   BUY  : ~15 min before close, deploy DEPLOY_FRACTION of equity split equally
 *          across tradable tickers. A ticker is skipped (its slice stays cash) if
 *          it is restricted, OR reporting earnings tonight, OR trading is paused.
 *   SELL : at the next open, close every position we hold.
 *
 * Integrations: shared state (utils/state), earnings blackout (utils/earnings),
 * the kill switch (strategies/risk), and alerts (utils/notifier).
 */

const { alpaca, TICKERS, DEPLOY_FRACTION } = require('../config');
const log = require('../utils/logger');
const state = require('../utils/state');
const earnings = require('../utils/earnings');
const { notify } = require('../utils/notifier');
const risk = require('./risk');
const { withRetry, getLatestPrice, waitForFill, statusOf } = require('../utils/alpaca');

function utcDate(iso = new Date().toISOString()) {
  return iso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Reconcile local state with live Alpaca positions (run on startup).
// ---------------------------------------------------------------------------
async function reconcileFromAlpaca() {
  log.info('Reconciling local state with live Alpaca positions...');
  let positions = [];
  try {
    positions = await withRetry(() => alpaca.getPositions(), { label: 'positions' });
  } catch (err) {
    log.error('Reconcile could not fetch positions (keeping existing state):', err?.message || err);
    return;
  }

  const prev = state.load();
  const rebuilt = {};
  for (const p of positions) {
    if (!TICKERS.includes(p.symbol)) continue; // ignore holdings outside our strategy
    const qty = Number(p.qty);
    const avg = Number(p.avg_entry_price);
    rebuilt[p.symbol] = {
      buyPrice: avg,
      qty,
      buyValue: Number((avg * qty).toFixed(2)),
      // Keep an existing buyTime if we have one; otherwise mark as overnight so
      // the catch-up sell will close it. (epoch => definitely "not today".)
      buyTime: prev.openPositions?.[p.symbol]?.buyTime || '1970-01-01T00:00:00.000Z',
      reconciled: true,
    };
  }

  state.update({ openPositions: rebuilt });
  const syms = Object.keys(rebuilt);
  log.info(`Reconcile complete. Live positions in our tickers: ${syms.length ? syms.join(', ') : 'none'}`);
  if (syms.length) {
    await notify(`🔄 Startup reconcile: found open positions ${syms.join(', ')} — will be sold at next open.`);
  }
}

// ---------------------------------------------------------------------------
// BUY
// ---------------------------------------------------------------------------
async function runBuy() {
  log.info('=== CLOSE buy routine starting ===');

  // Kill switch: do not open new positions while paused.
  if (risk.isPaused()) {
    const reason = state.load().pauseReason || 'unknown';
    log.warn(`Trading is PAUSED (${reason}) — skipping buy.`);
    await notify(`⏸️ Buy skipped — trading paused: ${reason}`);
    return;
  }

  const account = await withRetry(() => alpaca.getAccount(), { label: 'account' });
  const equity = Number(account.equity);
  log.info(`Equity: $${equity.toFixed(2)} | Cash: $${Number(account.cash).toFixed(2)}`);

  const perTicker = Number(((equity * DEPLOY_FRACTION) / TICKERS.length).toFixed(2));
  const pctEach = ((DEPLOY_FRACTION / TICKERS.length) * 100).toFixed(2);
  log.info(`Target per ticker: $${perTicker.toFixed(2)} (${pctEach}% of equity each).`);

  // Earnings blackout for tonight's hold (today..next trading day).
  let blackout = new Set();
  if (earnings.isEnabled()) {
    try {
      const clock = await withRetry(() => alpaca.getClock(), { label: 'clock' });
      const today = utcDate(clock.timestamp);
      const nextDay = utcDate(clock.next_open);
      blackout = await earnings.getBlackoutSymbols(TICKERS, today, nextDay);
      if (blackout.size) {
        log.warn(`Earnings blackout tonight: ${[...blackout].join(', ')}`);
        await notify(`📅 Earnings blackout tonight (staying in cash): ${[...blackout].join(', ')}`);
      }
    } catch (err) {
      log.error('Earnings check failed:', err?.message || err);
      if (earnings.FAIL_CLOSED) {
        await notify('⚠️ Earnings data unavailable & EARNINGS_FAIL_CLOSED=true — skipping ALL buys tonight.');
        return;
      }
      await notify('⚠️ Earnings data unavailable — proceeding without blackout (fail-open).');
    }
  }

  const s = state.load();
  s.openPositions = {};
  const bought = [];

  for (const symbol of TICKERS) {
    try {
      if (blackout.has(symbol)) {
        log.warn(`${symbol}: earnings blackout — staying in cash.`);
        continue;
      }

      const asset = await withRetry(() => alpaca.getAsset(symbol), { label: `asset:${symbol}` });
      if (!asset.tradable || asset.status !== 'active') {
        log.warn(`${symbol} not tradable/active — its $${perTicker.toFixed(2)} stays in cash.`);
        continue;
      }

      let order;
      if (asset.fractionable) {
        order = await withRetry(
          () => alpaca.createOrder({ symbol, notional: perTicker, side: 'buy', type: 'market', time_in_force: 'day' }),
          { label: `buy:${symbol}` }
        );
      } else {
        const price = await getLatestPrice(symbol);
        const qty = Math.floor(perTicker / price);
        if (qty < 1) {
          log.warn(`${symbol}: $${perTicker.toFixed(2)} < 1 share ($${price.toFixed(2)}) — staying in cash.`);
          continue;
        }
        order = await withRetry(
          () => alpaca.createOrder({ symbol, qty, side: 'buy', type: 'market', time_in_force: 'day' }),
          { label: `buy:${symbol}` }
        );
      }

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

      s.openPositions[symbol] = { buyPrice: price, qty, buyValue: totalValue, buyTime: new Date().toISOString() };
      bought.push(`${symbol} $${totalValue.toFixed(0)}`);
      log.info(`BUY  ${symbol}: ${qty} @ $${price.toFixed(2)} = $${totalValue.toFixed(2)}`);
    } catch (err) {
      log.error(`Buy failed for ${symbol}:`, err?.message || err);
      await notify(`❌ Buy failed for ${symbol}: ${err?.message || err}`);
    }
  }

  state.update({ openPositions: s.openPositions });
  log.info('=== CLOSE buy routine complete ===');
  await notify(
    bought.length
      ? `🟢 BUY complete (${bought.length}/${TICKERS.length}): ${bought.join(', ')}`
      : '🟢 BUY routine ran but opened no positions.'
  );
}

// ---------------------------------------------------------------------------
// SELL
// ---------------------------------------------------------------------------
async function runSell({ onlyOvernight = false } = {}) {
  log.info('=== OPEN sell routine starting ===');

  const s = state.load();
  const today = utcDate();
  let totalBuy = 0;
  let totalSell = 0;
  let totalPnl = 0;
  let pnlRows = 0;

  for (const symbol of TICKERS) {
    try {
      if (onlyOvernight) {
        const buyTime = s.openPositions?.[symbol]?.buyTime;
        if (!buyTime || utcDate(buyTime) === today) continue; // skip same-day / unknown on catch-up
      }

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

      const buyValue = s.openPositions?.[symbol]?.buyValue ?? null;
      const pnl = buyValue != null ? Number((sellValue - buyValue).toFixed(2)) : null;
      const pnlPct = buyValue ? Number((((sellValue - buyValue) / buyValue) * 100).toFixed(2)) : null;

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

      if (s.openPositions) delete s.openPositions[symbol];
    } catch (err) {
      log.error(`Sell failed for ${symbol}:`, err?.message || err);
      await notify(`❌ Sell failed for ${symbol}: ${err?.message || err}`);
    }
  }

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

  state.update({ openPositions: s.openPositions });
  log.info(`=== OPEN sell routine complete | Daily P&L: $${totalPnl.toFixed(2)} ===`);

  if (pnlRows > 0) {
    const emoji = totalPnl >= 0 ? '📈' : '📉';
    await notify(`${emoji} SELL complete. Daily P&L: $${totalPnl.toFixed(2)} (${totalBuy ? ((totalPnl / totalBuy) * 100).toFixed(2) : '0.00'}%)`);
  }

  // After realizing the morning P&L, let the kill switch evaluate the day.
  try {
    await risk.checkDailyLoss();
  } catch (err) {
    log.error('Daily-loss check failed after sell:', err?.message || err);
  }
}

module.exports = { runBuy, runSell, reconcileFromAlpaca };