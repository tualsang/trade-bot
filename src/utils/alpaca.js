'use strict';

/**
 * Thin helpers around the Alpaca SDK:
 *  - withRetry:      retries on rate limits (429), 5xx, and transient network errors.
 *  - getLatestPrice: resolves the latest trade price (defensive against SDK shape changes).
 *  - waitForFill:    polls an order until it is filled (or terminally fails).
 */

const { alpaca } = require('../config');
const log = require('./logger');

const NETWORK_ERROR_CODES = [
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusOf(err) {
  return err?.statusCode || err?.response?.status || err?.status || null;
}

function isNetworkError(err) {
  return NETWORK_ERROR_CODES.includes(err?.code);
}

/**
 * Run an async API call with exponential backoff on retriable failures.
 * @param {() => Promise<any>} fn
 * @param {object} [opts]
 * @param {number} [opts.retries=5]
 * @param {number} [opts.baseDelay=1000] ms
 * @param {string} [opts.label='api']
 */
async function withRetry(fn, { retries = 5, baseDelay = 1000, label = 'api' } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      const status = statusOf(err);
      const retriable =
        status === 429 || (status && status >= 500) || isNetworkError(err);

      if (!retriable || attempt > retries) {
        log.error(`[${label}] failed after ${attempt} attempt(s):`, err?.message || err);
        throw err;
      }

      const delay = baseDelay * 2 ** (attempt - 1);
      log.warn(
        `[${label}] retriable error (${status || err?.code || 'network'}). ` +
        `Retry ${attempt}/${retries} in ${delay}ms.`
      );
      await sleep(delay);
    }
  }
}

/**
 * Latest trade price for a symbol. Handles the various shapes the SDK has used
 * across versions ({ Price }, { price }, { p }, { trade: { p } }).
 */
async function getLatestPrice(symbol) {
  const t = await withRetry(() => alpaca.getLatestTrade(symbol), { label: `price:${symbol}` });
  const price = t?.Price ?? t?.price ?? t?.trade?.p ?? t?.p;
  const num = Number(price);
  if (!num || Number.isNaN(num)) {
    throw new Error(`Could not resolve latest price for ${symbol}`);
  }
  return num;
}

/**
 * Poll an order until it is filled. Returns the final order object.
 * Throws if the order is canceled/expired/rejected.
 */
async function waitForFill(orderId, { timeoutMs = 60000, pollMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await withRetry(() => alpaca.getOrder(orderId), { label: `order:${orderId}` });
    if (last.status === 'filled') return last;
    if (['canceled', 'expired', 'rejected', 'done_for_day'].includes(last.status)) {
      throw new Error(`Order ${orderId} ended with status "${last.status}"`);
    }
    await sleep(pollMs);
  }
  log.warn(`Order ${orderId} not filled within ${timeoutMs}ms (status: ${last?.status}).`);
  return last;
}

module.exports = { withRetry, getLatestPrice, waitForFill, sleep, isNetworkError, statusOf };
