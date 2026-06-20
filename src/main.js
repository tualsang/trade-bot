'use strict';

/**
 * Entry point + scheduler.
 *
 * On startup: reconcile local state against live Alpaca positions, then plan.
 * Daily planner (08:00 ET + on launch): for trading days, capture the day's
 * equity baseline and schedule SELL at the open and BUY 15 min before close.
 * If the kill switch is enabled, an intraday monitor checks the daily-loss limit
 * every 10 minutes during the session.
 */

const schedule = require('node-schedule');
const { alpaca, TIMEZONE, MINUTES_BEFORE_CLOSE } = require('./config');
const log = require('./utils/logger');
const { withRetry } = require('./utils/alpaca');
const { notify } = require('./utils/notifier');
const { runBuy, runSell, reconcileFromAlpaca } = require('./strategies/close_open_strat');
const risk = require('./strategies/risk');
const commander = require('./utils/commander');

let buyJob = null;
let sellJob = null;

function etDate(iso) {
  return String(iso).slice(0, 10);
}

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

    if (!clock.is_open && !openIsToday && !closeIsToday) {
      log.info('Non-trading day (weekend/holiday). Nothing scheduled today.');
      return;
    }

    // Capture the day's equity baseline for the kill switch.
    if (risk.isEnabled()) {
      try {
        await risk.captureDayStart(today);
      } catch (err) {
        log.error('Could not capture day-start equity:', err?.message || err);
      }
    }

    // SELL at today's open (positions held overnight).
    if (sellJob) { sellJob.cancel(); sellJob = null; }
    const openTime = new Date(clock.next_open);
    if (openIsToday && openTime.getTime() > Date.now()) {
      sellJob = schedule.scheduleJob(openTime, safe(() => runSell(), 'sell'));
      log.info(`Scheduled SELL at open: ${openTime.toISOString()}`);
    } else if (clock.is_open) {
      log.info('Market already open — running catch-up sell for overnight positions.');
      await safe(() => runSell({ onlyOvernight: true }), 'sell')();
    }

    // BUY at (today's close - MINUTES_BEFORE_CLOSE).
    if (buyJob) { buyJob.cancel(); buyJob = null; }
    if (closeIsToday) {
      const buyTime = new Date(new Date(clock.next_close).getTime() - MINUTES_BEFORE_CLOSE * 60_000);
      if (buyTime.getTime() > Date.now()) {
        buyJob = schedule.scheduleJob(buyTime, safe(() => runBuy(), 'buy'));
        log.info(`Scheduled BUY ${MINUTES_BEFORE_CLOSE} min before close: ${buyTime.toISOString()}`);
      } else {
        log.warn(`Buy window (${buyTime.toISOString()}) already passed today.`);
      }
    }
  } catch (err) {
    log.error('Planner failed:', err?.message || err);
  }
}

async function main() {
  log.info('Close/Open Arbitrage bot starting (paper trading).');

  // Reconcile against live positions before doing anything else.
  await safe(() => reconcileFromAlpaca(), 'reconcile')();

  // Daily planner at 08:00 ET.
  const rule = new schedule.RecurrenceRule();
  rule.hour = 8;
  rule.minute = 0;
  rule.tz = TIMEZONE;
  schedule.scheduleJob(rule, plan);
  log.info('Daily planner armed for 08:00 America/New_York.');

  // Intraday kill-switch monitor: every 10 min during the session (ET).
  if (risk.isEnabled()) {
    const mon = new schedule.RecurrenceRule();
    mon.dayOfWeek = [1, 2, 3, 4, 5];
    mon.hour = [9, 10, 11, 12, 13, 14, 15];
    mon.minute = [0, 10, 20, 30, 40, 50];
    mon.tz = TIMEZONE;
    schedule.scheduleJob(mon, safe(() => risk.checkDailyLoss(), 'risk-monitor'));
    log.info(`Kill switch ARMED: max daily loss ${(risk.MAX_DAILY_LOSS_PCT * 100).toFixed(2)}%.`);
  } else {
    log.info('Kill switch disabled (set MAX_DAILY_LOSS_PCT in .env to enable).');
  }

  // Plan immediately on launch.
  await plan();

  // Start the Telegram command listener (owner-only; no-op if not configured).
  commander.startPolling();

  await notify('🤖 Trading bot started.');

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