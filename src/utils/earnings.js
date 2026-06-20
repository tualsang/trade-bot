'use strict';

/**
 * Earnings blackout filter (Finnhub free tier).
 *
 * The strategy holds from ~15:45 ET today to 09:30 ET the next trading day, so a
 * position is exposed to an earnings report that lands:
 *   - AFTER today's close   (hour = "amc"), or
 *   - BEFORE the next open   (hour = "bmo" on the next trading day).
 * A "bmo" report on TODAY already happened this morning and is irrelevant to
 * tonight's hold; an "amc" report on the NEXT day happens after we've sold.
 * Unknown hour ("") is treated as risky and blacked out.
 *
 * Enabled only when FINNHUB_API_KEY is set. getBlackoutSymbols throws on API
 * error so the caller can apply its fail-open / fail-closed policy.
 */

const log = require('./logger');

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const FAIL_CLOSED = String(process.env.EARNINGS_FAIL_CLOSED || '').toLowerCase() === 'true';

function isEnabled() {
  return Boolean(FINNHUB_KEY);
}

async function fetchEarnings(fromDate, toDate) {
  const url =
    `https://finnhub.io/api/v1/calendar/earnings?from=${fromDate}&to=${toDate}&token=${FINNHUB_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : [];
}

/**
 * @param {string[]} symbols   tickers we care about
 * @param {string} today       ET date "YYYY-MM-DD" (buy day)
 * @param {string} nextDay     ET date of the next trading day (sell day)
 * @returns {Promise<Set<string>>} symbols to skip buying tonight
 */
async function getBlackoutSymbols(symbols, today, nextDay) {
  if (!isEnabled()) return new Set();

  const rows = await fetchEarnings(today, nextDay);
  const want = new Set(symbols);
  const blackout = new Set();

  for (const e of rows) {
    const sym = e?.symbol;
    if (!want.has(sym)) continue;
    const hour = String(e?.hour || '').toLowerCase();
    const onToday = e?.date === today && (hour === 'amc' || hour === 'dmh' || hour === '');
    const onNext = e?.date === nextDay && (hour === 'bmo' || hour === 'dmh' || hour === '');
    if (onToday || onNext) blackout.add(sym);
  }
  return blackout;
}

module.exports = { isEnabled, getBlackoutSymbols, FAIL_CLOSED };
