'use strict';

/**
 * Entry point + scheduler.
 *
 * A daily "planner" runs at 08:00 ET (and once on startup). Each run queries
 * Alpaca's clock endpoint and, for trading days, schedules:
 *   - SELL at today's open  (closes positions held overnight)
 *   - BUY  at today's close minus MINUTES_BEFORE_CLOSE
 *
 * Anchoring on the clock's next_open / next_close ISO timestamps means DST
 * shifts and early-close holidays are handled automatically — no hard-coded
 * 3:45 PM offset that would silently break in summer or on half-days.
 */

const schedule = require('node-schedule');
const { alpaca, TIMEZONE, MINUTES_BEFORE_CLOSE } = require('./config');
const log = require('./utils/logger');
const { withRetry } = require('./utils/alpaca');
const { runBuy, runSell } = require('./strategies/close_open_strat');

let buyJob = null;
let sellJob = null;

// The date portion of an Alpaca ISO timestamp is already in ET (it carries the
// -04:00 / -05:00 offset), so slicing gives the ET calendar date directly.
function etDate(iso) {
  return String(iso).slice(0, 10);
}

// Wrap a routine so a thrown error can never kill the scheduler process.
function safe(fn, label) {
  return async () => {
    try {
      await fn();
    } catch (err) {
      log.error(`[${label}] routine error:`, err?.message || err);
    }
  };
}

async function plan() {
  try {
    const clock = await withRetry(() => alpaca.getClock(), { label: 'clock' });
    const today = etDate(clock.timestamp);
    log.info(`Planner run | ET date ${today} | market open now: ${clock.is_open}`);

    const closeIsToday = etDate(clock.next_close) === today;
    const openIsToday = etDate(clock.next_open) === today;

    // Weekend / holiday: clock points to a future session and we're not open.
    if (!clock.is_open && !openIsToday && !closeIsToday) {
      log.info('Non-trading day (weekend/holiday). Nothing scheduled today.');
      return;
    }

    // --- SELL at today's open (positions held overnight). ---
    if (sellJob) {
      sellJob.cancel();
      sellJob = null;
    }
    const openTime = new Date(clock.next_open);
    if (openIsToday && openTime.getTime() > Date.now()) {
      sellJob = schedule.scheduleJob(openTime, safe(() => runSell(), 'sell'));
      log.info(`Scheduled SELL at open: ${openTime.toISOString()}`);
    } else if (clock.is_open) {
      // Restarted mid-session: close only positions opened on a prior day.
      log.info('Market already open — running catch-up sell for overnight positions.');
      await safe(() => runSell({ onlyOvernight: true }), 'sell')();
    }

    // --- BUY at (today's close - MINUTES_BEFORE_CLOSE). ---
    if (buyJob) {
      buyJob.cancel();
      buyJob = null;
    }
    if (closeIsToday) {
      const buyTime = new Date(
        new Date(clock.next_close).getTime() - MINUTES_BEFORE_CLOSE * 60_000
      );
      if (buyTime.getTime() > Date.now()) {
        buyJob = schedule.scheduleJob(buyTime, safe(() => runBuy(), 'buy'));
        log.info(
          `Scheduled BUY ${MINUTES_BEFORE_CLOSE} min before close: ${buyTime.toISOString()}`
        );
      } else {
        log.warn(`Buy window (${buyTime.toISOString()}) already passed today.`);
      }
    }
  } catch (err) {
    log.error('Planner failed:', err?.message || err);
  }
}

function main() {
  log.info('Close/Open Arbitrage bot starting (paper trading).');

  // Daily planner at 08:00 America/New_York.
  const rule = new schedule.RecurrenceRule();
  rule.hour = 8;
  rule.minute = 0;
  rule.tz = TIMEZONE;
  schedule.scheduleJob(rule, plan);
  log.info('Daily planner armed for 08:00 America/New_York.');

  // Plan immediately so the bot reacts on the day it is launched.
  plan();

  const shutdown = (sig) => {
    log.info(`Received ${sig}. Shutting down...`);
    schedule.gracefulShutdown().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('Unhandled rejection:', reason));
  process.on('uncaughtException', (err) => log.error('Uncaught exception:', err?.message || err));
}

main();
