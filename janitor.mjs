#!/usr/bin/env node
// SANC channel janitor — prunes stale ping messages.
// Deletes only webhook/bot messages older than N hours. Pinned messages are
// never touched (fissure boards are safe), and neither are user messages.
// No state needed: age is computed from each message's own timestamp.

const DISCORD = 'https://discord.com/api/v10';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNELS = (process.env.JANITOR_CHANNEL_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const MAX_AGE_HOURS = Number(process.env.JANITOR_MAX_AGE_HOURS || 12);
const MAX_PAGES = 20; // safety cap per channel

if (!BOT_TOKEN || CHANNELS.length === 0) {
  console.error('Missing env vars: DISCORD_BOT_TOKEN, JANITOR_CHANNEL_IDS (comma-separated channel IDs)');
  process.exit(1);
}

async function req(url, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bot ${BOT_TOKEN}` };
  const payload = body === undefined ? undefined : JSON.stringify(body);
  let res = await fetch(url, { method, headers, body: payload });
  for (let attempt = 0; res.status === 429 && attempt < 5; attempt++) {
    const data = await res.json().catch(() => ({}));
    const wait = (data.retry_after ?? 0.5) * 1000 + 50;
    await new Promise((r) => setTimeout(r, wait));
    res = await fetch(url, { method, headers, body: payload });
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`${method} ${url} -> ${res.status} ${detail}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function sweepChannel(channelId) {
  const cutoff = Date.now() - MAX_AGE_HOURS * 3600 * 1000;
  let before = null;
  let deleted = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = before
      ? `${DISCORD}/channels/${channelId}/messages?limit=100&before=${before}`
      : `${DISCORD}/channels/${channelId}/messages?limit=100`;
    const messages = await req(url);
    if (!Array.isArray(messages) || messages.length === 0) break;

    const stale = messages.filter((m) => {
      if (m.pinned) return false;
      if (!(m.webhook_id || m.author?.bot)) return false; // keep user messages
      return Date.parse(m.timestamp) < cutoff;
    });

    if (stale.length > 0) {
      await req(`${DISCORD}/channels/${channelId}/messages/bulk-delete`, {
        method: 'POST',
        body: { messages: stale.map((m) => m.id) },
      });
      deleted += stale.length;
    }

    const oldest = messages[messages.length - 1];
    if (messages.length < 100 || Date.parse(oldest.timestamp) >= cutoff) break;
    before = oldest.id;
  }
  return deleted;
}

async function main() {
  let total = 0;
  for (const channelId of CHANNELS) {
    const deleted = await sweepChannel(channelId);
    total += deleted;
    console.log(`Channel ${channelId}: ${deleted} message(s) pruned.`);
  }
  console.log(`Janitor done: ${total} message(s) deleted (older than ${MAX_AGE_HOURS}h; pins and user messages untouched).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
