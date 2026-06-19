'use strict';

/**
 * Metric calculations. All pure functions.
 *
 *   - Trade-level stats (count, win rate, avg win/loss $, profit factor) come from
 *     dollar P&L arrays.
 *   - Return-level stats (Sharpe, total return %) come from periodic return arrays.
 *   - Equity stats (max drawdown, total return %) come from the equity curve.
 *
 * Per-ticker %/Sharpe/drawdown use that ticker's sizing-independent overnight
 * returns; per-ticker $ figures reflect the actual compounded position sizing.
 * Combined trade stats pool every individual trade; combined Sharpe/drawdown/
 * return use the portfolio equity curve.
 */

const TRADING_DAYS_PER_YEAR = 252;

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function sampleStd(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/** Win rate, avg win/loss ($), profit factor from a dollar P&L array. */
function tradeStats(pnl) {
  const wins = pnl.filter((x) => x > 0);
  const losses = pnl.filter((x) => x < 0);
  const grossProfit = wins.reduce((s, x) => s + x, 0);
  const grossLoss = Math.abs(losses.reduce((s, x) => s + x, 0));

  return {
    trades: pnl.length,
    winRate: pnl.length ? (wins.length / pnl.length) * 100 : 0,
    avgWin: wins.length ? grossProfit / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0, // negative number
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
  };
}

/** Sharpe (annualized) + compounded total return from a periodic return array. */
function returnStats(returns) {
  const sd = sampleStd(returns);
  const sharpe = sd > 0 ? (mean(returns) / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR) : 0;
  const totalReturn = (returns.reduce((p, r) => p * (1 + r), 1) - 1) * 100;
  return { sharpe, totalReturn };
}

/** Max peak-to-trough drawdown of an equity series (array of numbers). */
function maxDrawdown(equitySeries) {
  let peak = equitySeries[0] ?? 0;
  let maxDDPct = 0;
  let maxDDDollar = 0;
  for (const eq of equitySeries) {
    if (eq > peak) peak = eq;
    const ddDollar = peak - eq;
    const ddPct = peak > 0 ? (ddDollar / peak) * 100 : 0;
    if (ddPct > maxDDPct) maxDDPct = ddPct;
    if (ddDollar > maxDDDollar) maxDDDollar = ddDollar;
  }
  return { maxDDPct, maxDDDollar };
}

/** Build the full set of metrics for every ticker plus the combined portfolio. */
function buildReport(sim, tickers) {
  const perTicker = {};

  for (const t of tickers) {
    const { returns, pnl } = sim.perTicker[t];
    const ts = tradeStats(pnl);
    const rs = returnStats(returns);

    // Synthetic standalone equity curve (start at 1) for a clean % drawdown.
    const curve = returns.reduce(
      (acc, r) => {
        acc.push(acc[acc.length - 1] * (1 + r));
        return acc;
      },
      [1]
    );
    const dd = maxDrawdown(curve);

    perTicker[t] = { ...ts, ...rs, maxDDPct: dd.maxDDPct };
  }

  // Combined: pool all individual trades for trade-level stats.
  const pooledPnl = tickers.flatMap((t) => sim.perTicker[t].pnl);
  const combinedTrades = tradeStats(pooledPnl);

  // Equity-curve stats for the portfolio.
  const equitySeries = sim.equityCurve.map((p) => p.equity);
  const dd = maxDrawdown(equitySeries);
  const combinedSharpe = returnStats(sim.portfolioDailyReturns).sharpe;
  const totalReturnPct =
    ((equitySeries[equitySeries.length - 1] - sim.startEquity) / sim.startEquity) * 100;

  const combined = {
    ...combinedTrades,
    sharpe: combinedSharpe,
    totalReturn: totalReturnPct,
    maxDDPct: dd.maxDDPct,
    maxDDDollar: dd.maxDDDollar,
    startEquity: sim.startEquity,
    endEquity: equitySeries[equitySeries.length - 1],
  };

  return { perTicker, combined };
}

module.exports = { tradeStats, returnStats, maxDrawdown, buildReport, mean, sampleStd };
