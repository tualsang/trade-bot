'use strict';

/**
 * Pure backtest simulation (no I/O).
 *
 * Each trading day:
 *   - Deploy 50% of CURRENT equity, split equally across the 3 tickers (equity/6 each).
 *   - Buy at the 15:45 price (+ slippage), sell next open (- slippage).
 *   - Realize P&L next morning, compound it into equity, repeat.
 *
 * Returns both sizing-independent overnight returns (for %/Sharpe/drawdown) and
 * actual dollar P&L reflecting compounding (for $ win/loss and profit factor).
 */

/**
 * @param {object} args
 * @param {Object<string, Map<string,{buy:number,open:number}>>} args.dayMaps
 * @param {string[]} args.tickers
 * @param {string[]} args.dates       sorted common tradable dates
 * @param {number} args.startEquity
 * @param {number} args.slippage      e.g. 0.0005 for 0.05%
 */
function runSimulation({ dayMaps, tickers, dates, startEquity, slippage }) {
  let equity = startEquity;

  const equityCurve = [{ date: dates[0], equity }];
  const portfolioDailyReturns = [];
  const perTicker = {};
  for (const t of tickers) perTicker[t] = { returns: [], pnl: [] };

  // Trade from dates[i] (buy at 15:45) to dates[i+1] (sell at 09:30 open).
  for (let i = 0; i < dates.length - 1; i++) {
    const entryDate = dates[i];
    const exitDate = dates[i + 1];
    const allocPerTicker = equity / (tickers.length * 2); // 50% / N  == equity/6 for N=3
    let dayPnl = 0;

    for (const t of tickers) {
      const rawBuy = dayMaps[t].get(entryDate).buy;
      const rawSell = dayMaps[t].get(exitDate).open;

      const buy = rawBuy * (1 + slippage); // adverse slippage on entry
      const sell = rawSell * (1 - slippage); // adverse slippage on exit

      const ret = sell / buy - 1; // sizing-independent overnight return
      const pnl = allocPerTicker * ret; // dollar P&L at current sizing
      // commission is $0 (Alpaca commission-free) — nothing to subtract.

      perTicker[t].returns.push(ret);
      perTicker[t].pnl.push(pnl);
      dayPnl += pnl;
    }

    const newEquity = equity + dayPnl;
    portfolioDailyReturns.push(newEquity / equity - 1);
    equity = newEquity;
    equityCurve.push({ date: exitDate, equity });
  }

  return { equityCurve, portfolioDailyReturns, perTicker, startEquity };
}

module.exports = { runSimulation };
