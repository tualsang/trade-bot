'use strict';

/**
 * Historical data retrieval for the backtest.
 *
 * Pulls 15-minute bars (default) so we can target the two execution points the
 * strategy actually uses:
 *   - BUY  reference = open of the 15:45 ET bar (~15 min before the 16:00 close)
 *   - SELL reference = open of the 09:30 ET bar (the official next-day open)
 *
 * Alpaca bar timestamps are UTC, so each bar is converted to America/New_York
 * to match the wall-clock minutes regardless of DST.
 */

const { alpaca, TICKERS } = require('../config');
const log = require('../utils/logger');
const { withRetry } = require('../utils/alpaca');

const DATA_FEED = process.env.ALPACA_DATA_FEED || 'iex'; // 'iex' (free) or 'sip' (paid)
const TIMEFRAME = '15Min';
const BUY_HOUR = 15;
const BUY_MIN = 45;
const OPEN_HOUR = 9;
const OPEN_MIN = 30;

// Defensive accessors (SDK has used both { OpenPrice } and { o } shapes).
const barTime = (b) => b.Timestamp ?? b.t;
const barOpen = (b) => Number(b.OpenPrice ?? b.o);

const _etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function toEt(iso) {
  const parts = _etFmt.formatToParts(new Date(iso)).reduce((a, p) => {
    a[p.type] = p.value;
    return a;
  }, {});
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // some runtimes emit '24' for midnight
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute: Number(parts.minute),
  };
}

async function collectBars(symbol, params) {
  return withRetry(
    async () => {
      const bars = [];
      const iter = alpaca.getBarsV2(symbol, params);
      for await (const bar of iter) bars.push(bar);
      return bars;
    },
    { label: `bars:${symbol}`, retries: 4 }
  );
}

/**
 * @returns {Promise<{ dayMaps: Object<string, Map<string,{buy:number,open:number}>>,
 *                     commonDates: string[],
 *                     meta: { start: string, end: string, feed: string } }>}
 */
async function loadData({ months = 6 } = {}) {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - months);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  log.info(`Fetching ${TIMEFRAME} bars ${startStr} → ${endStr} (feed: ${DATA_FEED})`);

  const dayMaps = {};

  for (const symbol of TICKERS) {
    const bars = await collectBars(symbol, {
      start: startStr,
      end: endStr,
      timeframe: TIMEFRAME,
      adjustment: 'all', // split & dividend adjusted
      feed: DATA_FEED,
      limit: 10000,
    });

    const dayMap = new Map();
    for (const bar of bars) {
      const price = barOpen(bar);
      if (!price || Number.isNaN(price)) continue;
      const et = toEt(barTime(bar));
      if (!dayMap.has(et.date)) dayMap.set(et.date, { buy: null, open: null });
      const slot = dayMap.get(et.date);
      if (et.hour === BUY_HOUR && et.minute === BUY_MIN) slot.buy = price;
      else if (et.hour === OPEN_HOUR && et.minute === OPEN_MIN) slot.open = price;
    }

    // Keep only days that have BOTH reference prices.
    for (const [date, slot] of dayMap) {
      if (slot.buy == null || slot.open == null) dayMap.delete(date);
    }

    dayMaps[symbol] = dayMap;
    log.info(`${symbol}: ${bars.length} bars → ${dayMap.size} complete trading days`);
  }

  // A date is tradable only if every ticker has complete data that day
  // (keeps the portfolio synchronized across all three instruments).
  const counts = new Map();
  for (const symbol of TICKERS) {
    for (const date of dayMaps[symbol].keys()) {
      counts.set(date, (counts.get(date) || 0) + 1);
    }
  }
  const commonDates = [...counts.entries()]
    .filter(([, c]) => c === TICKERS.length)
    .map(([d]) => d)
    .sort();

  if (commonDates.length < 2) {
    throw new Error(
      `Not enough overlapping trading days (${commonDates.length}). ` +
      `Try the 'sip' data feed (set ALPACA_DATA_FEED=sip) for complete bars.`
    );
  }

  log.info(`Common tradable days across all tickers: ${commonDates.length}`);
  return { dayMaps, commonDates, meta: { start: startStr, end: endStr, feed: DATA_FEED } };
}

module.exports = { loadData };
