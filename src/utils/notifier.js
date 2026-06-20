'use strict';

/**
 * Alert delivery. Telegram is the default (free, no per-message cost). Twilio
 * SMS is optional and only used when all four TWILIO_* vars are set.
 *
 * notify() never throws — a failed alert must never break trading. If no channel
 * is configured it just logs to the console.
 *
 * Telegram setup:
 *   1. In Telegram, message @BotFather -> /newbot -> copy the token.
 *   2. Message your new bot once (say "hi"), then open
 *      https://api.telegram.org/bot<TOKEN>/getUpdates and copy the chat id.
 *   3. Put TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.
 */

const log = require('./logger');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

const TW_SID = process.env.TWILIO_ACCOUNT_SID;
const TW_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TW_FROM = process.env.TWILIO_FROM;
const TW_TO = process.env.TWILIO_TO;

const telegramOn = Boolean(TG_TOKEN && TG_CHAT);
const smsOn = Boolean(TW_SID && TW_TOKEN && TW_FROM && TW_TO);

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

async function sendSms(text) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Messages.json`;
  const auth = Buffer.from(`${TW_SID}:${TW_TOKEN}`).toString('base64');
  const body = new URLSearchParams({ From: TW_FROM, To: TW_TO, Body: text });
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${await res.text()}`);
}

/** Send an alert to every configured channel. Always logs. Never throws. */
async function notify(message) {
  log.info(`[ALERT] ${message.replace(/\n/g, ' | ')}`);
  const tasks = [];
  if (telegramOn) tasks.push(sendTelegram(message).catch((e) => log.warn('Telegram failed:', e.message)));
  if (smsOn) tasks.push(sendSms(message).catch((e) => log.warn('SMS failed:', e.message)));
  if (tasks.length) await Promise.allSettled(tasks);
}

function configured() {
  return telegramOn || smsOn;
}

module.exports = { notify, configured, telegramOn, smsOn };
