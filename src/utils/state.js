'use strict';

/**
 * Single owner of state.json. Shared by the strategy and the risk manager so
 * positions, the pause flag, and the day-start equity baseline all live in one
 * place and never drift apart.
 */

const fs = require('fs');
const { STATE_FILE } = require('../config');

const DEFAULT = {
  openPositions: {}, // symbol -> { buyPrice, qty, buyValue, buyTime, reconciled? }
  paused: false, // kill-switch flag; blocks new buys until resumed
  pauseReason: null,
  dayStartEquity: null, // baseline for the daily-loss check
  dayStartDate: null, // ET date the baseline was captured for
};

function load() {
  try {
    return { ...DEFAULT, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT };
  }
}

function save(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Shallow-merge a patch into current state and persist it. Returns the new state. */
function update(patch) {
  const next = { ...load(), ...patch };
  save(next);
  return next;
}

module.exports = { load, save, update, DEFAULT };
