# Close/Open Arbitrage Bot (Alpaca)

A Node.js trading bot + backtester for a market **close/open arbitrage** strategy:

- **Buy** ~15 minutes before the official close.
- **Sell** at the next market open to flatten all positions.

Sizing: deploys **50%** of account equity (the other 50% stays cash), split **equally**
across all tickers. If a ticker is restricted/unavailable, its slice stays in cash
(it is not redistributed).

## Tickers — the one place to edit

`src/config.js` → `TICKERS` is the **single source of truth** for both the live bot
and the backtest. Add/remove symbols there; position sizing auto-adjusts to
`50% / number_of_tickers` each. No other file needs changing.

## Project structure

```
trade-bot/
├── src/
│   ├── strategies/close_open_strat.js   # buy-near-close / sell-at-open + P&L
│   ├── utils/
│   │   ├── logger.js                     # console + CSV writers
│   │   └── alpaca.js                     # retry/backoff, price, fill polling
│   ├── backtest/
│   │   ├── index.js                      # backtest entry point
│   │   ├── data.js                       # historical 15-min bar retrieval
│   │   ├── simulate.js                   # compounding simulation
│   │   ├── metrics.js                    # all performance metrics
│   │   ├── report.js                     # console summary table
│   │   └── chart.js                      # equity curve PNG (optional)
│   ├── config.js                         # env + Alpaca client + constants
│   └── main.js                           # scheduler / entry point
├── .env                                  # your keys (create from .env.example; gitignored)
├── .env.example
├── package.json
├── trades.csv
└── daily_pnl.csv
```

## Setup

```bash
npm install
cp .env.example .env
# edit .env with your Alpaca PAPER keys
```

## Run the live bot (paper)

```bash
npm start
```

Stays running. A planner at 08:00 ET (and on launch) checks Alpaca's clock, skips
weekends/holidays, and schedules that day's sell (at open) and buy (15 min before
close). Times are derived from the clock, so DST and early-close half-days are handled.

Manual one-offs for testing during market hours:

```bash
npm run buy-now
npm run sell-now
```

## Run the backtest

```bash
npm run backtest
```

Pulls 6 months of 15-minute bars, simulates the strategy with 0.05% slippage and
$0 commission, prints a per-ticker + portfolio metrics table, and (if the optional
chart packages are installed) writes `backtest_results.png`.

- Set `ALPACA_DATA_FEED=sip` in `.env` for complete bars (requires a paid market-data
  subscription). The free `iex` feed can be sparse for less-liquid names.
- The chart needs the native `canvas` module (now an optional dependency). If it
  can't build, the metrics table still prints; only the PNG is skipped.

## Output files

- `trades.csv` — timestamp, instrument, direction, execution price, quantity, total value.
- `daily_pnl.csv` — per-ticker rows plus a daily `TOTAL` row.
- `state.json` — round-trip basis, so a restart between buy and sell keeps P&L correct.

## Going live (real money)

No code changes. In `.env`, use your **live** Alpaca keys and set
`ALPACA_PAPER_URL=https://api.alpaca.markets`. `config.js` prints a warning whenever
the endpoint isn't a paper URL — treat it as your "this is real money" banner.

Note: live fills differ from paper (real slippage, partial fills). Several of the
default tickers (SOXL, TQQQ, TECL) are 3x leveraged ETFs held overnight — higher risk.
Start small. This is informational, not financial advice.
