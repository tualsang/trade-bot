'use strict';

/**
 * Two-way Telegram control. Long-polls getUpdates (outbound only — no inbound
 * ports needed) and executes commands ONLY from the configured TELEGRAM_CHAT_ID.
 * Any message from any other chat is ignored.
 *
 * Commands: /status /positions /pnl /pause /resume /flatten (/flatten_yes) /help
 *
 * Read-only and risk-control commands only. Manual buy/sell are intentionally NOT
 * exposed, to avoid colliding with the scheduler and double-placing orders.
 */

const fs = require('fs');
const { alpaca, TICKERS, PNL_CSV } = require('../config');
const log = require('./logger');
const state = require('./state');
const { withRetry, sleep } = require('./alpaca');
const risk = require('../strategies/risk');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let offset = 0;
let polling = false;
let pendingFlatten = 0; // timestamp of an unconfirmed /flatten

const HELP = [
    'Commands:',
    '/status — mode, equity, day P&L, open positions',
    '/positions — current positions only',
    '/pnl — last few daily P&L totals',
    '/pause — block new buys',
    '/resume — allow buys again',
    '/flatten — close ALL positions (asks to confirm)',
    '/help — this list',
].join('\n');

function authorized(msg) {
    return msg?.chat?.id != null && String(msg.chat.id) === String(CHAT_ID);
}

async function tgSend(text) {
    try {
        const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true }),
        });
        if (!res.ok) log.warn(`tgSend ${res.status}: ${await res.text()}`);
    } catch (err) {
        log.warn('tgSend failed:', err?.message || err);
    }
}

// ---- command handlers ----

async function cmdStatus() {
    const s = state.load();
    const acct = await withRetry(() => alpaca.getAccount(), { label: 'account' });
    const equity = Number(acct.equity);
    const cash = Number(acct.cash);

    let positions = [];
    try {
        positions = await withRetry(() => alpaca.getPositions(), { label: 'positions' });
    } catch (e) {
        log.warn('status: positions fetch failed:', e?.message || e);
    }
    const mine = positions.filter((p) => TICKERS.includes(p.symbol));

    const lines = [];
    lines.push(s.paused ? `Mode: ⛔ PAUSED — ${s.pauseReason || 'manual'}` : 'Mode: ✅ ACTIVE');
    lines.push(`Equity: $${equity.toFixed(2)} | Cash: $${cash.toFixed(2)}`);
    if (s.dayStartEquity != null) {
        const chg = ((equity - s.dayStartEquity) / s.dayStartEquity) * 100;
        lines.push(`Day start: $${s.dayStartEquity.toFixed(2)} (today ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%)`);
    }
    if (mine.length) {
        lines.push(`Positions (${mine.length}):`);
        for (const p of mine) {
            const mv = Number(p.market_value);
            const upl = Number(p.unrealized_pl);
            const pc = Number(p.unrealized_plpc) * 100;
            lines.push(`  ${p.symbol} ${Number(p.qty)}sh $${mv.toFixed(0)} (${upl >= 0 ? '+' : ''}$${upl.toFixed(2)}, ${pc >= 0 ? '+' : ''}${pc.toFixed(2)}%)`);
        }
    } else {
        lines.push('Positions: none');
    }
    await tgSend('📊 Status\n' + lines.join('\n'));
}

async function cmdPositions() {
    let positions = [];
    try {
        positions = await withRetry(() => alpaca.getPositions(), { label: 'positions' });
    } catch (e) {
        return tgSend(`Could not fetch positions: ${e?.message || e}`);
    }
    const mine = positions.filter((p) => TICKERS.includes(p.symbol));
    if (!mine.length) return tgSend('No open positions.');
    const lines = mine.map((p) => {
        const upl = Number(p.unrealized_pl);
        return `${p.symbol}: ${Number(p.qty)}sh @ $${Number(p.avg_entry_price).toFixed(2)} → $${Number(p.current_price).toFixed(2)} (${upl >= 0 ? '+' : ''}$${upl.toFixed(2)})`;
    });
    await tgSend('📦 Positions\n' + lines.join('\n'));
}

async function cmdPnl() {
    let rows = [];
    try {
        rows = fs.readFileSync(PNL_CSV, 'utf8').trim().split('\n').filter((l) => l.includes(',TOTAL,')).slice(-5);
    } catch {
        /* file may not exist yet */
    }
    await tgSend(rows.length ? '📈 Recent daily P&L (date, TOTAL, buy, sell, pnl, %):\n' + rows.join('\n') : 'No P&L recorded yet.');
}

async function cmdFlattenYes() {
    if (!pendingFlatten || Date.now() - pendingFlatten > 60_000) {
        pendingFlatten = 0;
        return tgSend('No pending flatten (expired). Send /flatten first.');
    }
    pendingFlatten = 0;
    try {
        await risk.flattenAll();
        await tgSend('🧨 All positions flattened. (Use /pause if you also want to stop new buys.)');
    } catch (err) {
        await tgSend(`Flatten failed: ${err?.message || err}`);
    }
}

async function handle(text) {
    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
    try {
        switch (cmd) {
            case '/status': return await cmdStatus();
            case '/positions': return await cmdPositions();
            case '/pnl': return await cmdPnl();
            case '/pause': return await risk.pause('Manual pause via Telegram');
            case '/resume': return await risk.resume();
            case '/flatten':
                pendingFlatten = Date.now();
                return await tgSend('⚠️ This CLOSES ALL POSITIONS immediately.\nReply /flatten_yes within 60s to confirm.');
            case '/flatten_yes': return await cmdFlattenYes();
            case '/help':
            case '/start': return await tgSend(HELP);
            default: return await tgSend(`Unknown command.\n${HELP}`);
        }
    } catch (err) {
        log.error('Command error:', err?.message || err);
        await tgSend(`Error running ${cmd}: ${err?.message || err}`);
    }
}

async function pollOnce() {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=30&offset=${offset}`);
    if (!res.ok) throw new Error(`getUpdates ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error('getUpdates returned ok=false');
    for (const u of data.result || []) {
        offset = u.update_id + 1;
        const msg = u.message || u.edited_message;
        if (!msg || !msg.text) continue;
        if (!authorized(msg)) {
            log.warn(`Ignoring Telegram message from unauthorized chat ${msg.chat?.id}`);
            continue;
        }
        if (msg.text.trim().startsWith('/')) await handle(msg.text.trim());
    }
}

async function loop() {
    while (polling) {
        try {
            await pollOnce();
        } catch (err) {
            log.warn('Telegram poll error:', err?.message || err);
            await sleep(5000);
        }
    }
}

function startPolling() {
    if (!TOKEN || !CHAT_ID) {
        log.info('Telegram commands disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set).');
        return;
    }
    if (polling) return;
    polling = true;
    log.info('Telegram command listener started (owner-only).');
    loop();
}

function stopPolling() {
    polling = false;
}

module.exports = { startPolling, stopPolling, handle, authorized };