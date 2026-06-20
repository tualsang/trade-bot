'use strict';

/**
 * Risk manager (max daily-loss kill switch).
 *
 * Enabled by MAX_DAILY_LOSS_PCT (e.g. 0.05 = 5%). When current equity falls that
 * far below the day's starting equity, it flattens ALL positions and sets a
 * persistent pause flag that blocks new buys until `npm run resume`.
 */

const { alpaca } = require('../config');
const log = require('../utils/logger');
const state = require('../utils/state');
const { notify } = require('../utils/notifier');
const { withRetry } = require('../utils/alpaca');

const MAX_DAILY_LOSS_PCT = Number(process.env.MAX_DAILY_LOSS_PCT || 0); // 0 disables

function isEnabled() {
  return MAX_DAILY_LOSS_PCT > 0;
}

async function getEquity() {
  const acct = await withRetry(() => alpaca.getAccount(), { label: 'account' });
  return Number(acct.equity);
}

/** Capture the day's baseline equity once per ET day. Returns the baseline. */
async function captureDayStart(etDate) {
  const s = state.load();
  if (s.dayStartDate === etDate && s.dayStartEquity != null) return s.dayStartEquity;
  const equity = await getEquity();
  state.update({ dayStartEquity: equity, dayStartDate: etDate });
  log.info(`Day-start equity for ${etDate}: $${equity.toFixed(2)}`);
  return equity;
}

function isPaused() {
  return state.load().paused === true;
}

async function pause(reason) {
  state.update({ paused: true, pauseReason: reason });
  log.warn(`TRADING PAUSED: ${reason}`);
  await notify(`⛔ TRADING PAUSED\n${reason}\nResume with: npm run resume`);
}

async function resume() {
  state.update({ paused: false, pauseReason: null });
  log.info('Trading resumed.');
  await notify('✅ Trading resumed.');
}

/** Close every open position in the account (panic). */
async function flattenAll() {
  log.warn('Flattening ALL positions (risk).');
  await withRetry(() => alpaca.closeAllPositions({ cancel_orders: true }), { label: 'closeAll' });
}

/**
 * Compare current equity to the day-start baseline. If the drawdown meets the
 * limit, flatten and pause. Returns true if the limit was tripped (or already paused).
 */
async function checkDailyLoss() {
  if (!isEnabled()) return false;
  const s = state.load();
  if (s.paused) return true;
  if (s.dayStartEquity == null) return false;

  const equity = await getEquity();
  const drawdown = (s.dayStartEquity - equity) / s.dayStartEquity;
  if (drawdown >= MAX_DAILY_LOSS_PCT) {
    try {
      await flattenAll();
    } catch (err) {
      log.error('flattenAll failed during kill switch:', err?.message || err);
    }
    await pause(
      `Daily loss limit hit: equity $${equity.toFixed(2)} is ${(drawdown * 100).toFixed(2)}% ` +
      `below day-start $${s.dayStartEquity.toFixed(2)} (limit ${(MAX_DAILY_LOSS_PCT * 100).toFixed(2)}%).`
    );
    return true;
  }
  return false;
}

module.exports = {
  isEnabled,
  getEquity,
  captureDayStart,
  isPaused,
  pause,
  resume,
  flattenAll,
  checkDailyLoss,
  MAX_DAILY_LOSS_PCT,
};
