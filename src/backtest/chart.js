'use strict';

/**
 * Renders the combined-portfolio equity curve to backtest_results.png.
 *
 * Uses chartjs-node-canvas, which depends on the native `canvas` module.
 * On macOS you may first need:  brew install pkg-config cairo pango libpng jpeg giflib librsvg
 * The orchestrator wraps this call in try/catch so a missing native build does
 * not prevent the metrics table from printing.
 */

const fs = require('fs');

async function renderEquityChart(equityCurve, outPath) {
  // Lazy require so the rest of the backtest still runs if canvas isn't built.
  const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

  const width = 1200;
  const height = 600;
  const chart = new ChartJSNodeCanvas({
    width,
    height,
    backgroundColour: 'white',
  });

  const labels = equityCurve.map((p) => p.date);
  const data = equityCurve.map((p) => Number(p.equity.toFixed(2)));

  const configuration = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Combined Portfolio Equity',
          data,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37, 99, 235, 0.12)',
          borderWidth: 2,
          fill: true,
          pointRadius: 0,
          tension: 0.15,
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        legend: { display: true, position: 'top' },
        title: {
          display: true,
          text: 'Close/Open Arbitrage — 6 Month Equity Curve',
          font: { size: 18 },
        },
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 12, autoSkip: true },
          grid: { display: false },
          title: { display: true, text: 'Date' },
        },
        y: {
          title: { display: true, text: 'Equity ($)' },
          ticks: {
            callback: (v) => '$' + Number(v).toLocaleString('en-US'),
          },
        },
      },
    },
  };

  const buffer = await chart.renderToBuffer(configuration);
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

module.exports = { renderEquityChart };
