#!/usr/bin/env node
// Diagnostic: what channel are we actually looking at?
const DISCORD = 'https://discord.com/api/v10';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.PLANET_FISSURES_CHANNEL_ID;
const WEBHOOK_URL = (process.env.PLANET_FISSURES_WEBHOOK_URL || '').replace(/\/+$/, '');

if (!BOT_TOKEN || !CHANNEL_ID || !WEBHOOK_URL) {
  console.error('Missing env vars.');
  process.exit(1);
}

async function req(url, bot = true) {
  const headers = bot ? { Authorization: `Bot ${BOT_TOKEN}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function main() {
  // 1. Where does the webhook actually post?
  const hook = await req(WEBHOOK_URL, false);
  console.log(`Webhook "${hook.name}" posts to channel ${hook.channel_id}`);

  // 2. What channel does the script search?
  const chan = await req(`${DISCORD}/channels/${CHANNEL_ID}`);
  console.log(`CHANNEL_ID secret points to #${chan.name} (${CHANNEL_ID})`);

  if (hook.channel_id !== CHANNEL_ID) {
    console.log('>>> MISMATCH FOUND: webhook and channel ID point at different channels!');
  }

  // 3. What does the bot see in the last 100 messages?
  const messages = await req(`${DISCORD}/channels/${CHANNEL_ID}/messages?limit=100`);
  console.log(`Last 100 messages in #${chan.name}: ${messages.length} total`);
  const boards = messages.filter((m) => (m.content || '').includes('🪙 Planet Fissure board'));
  console.log(`Board-marker matches: ${boards.length}`);
  for (const b of boards) {
    const eris = (b.reactions || []).find((r) => r.emoji.name === '🦠');
    console.log(`- ${b.id} | ${b.timestamp} | pinned:${b.pinned} | 🦠 count:${eris ? eris.count : 0} | edited:${b.edited_timestamp ? 'yes' : 'no'}`);
  }
  const newest = messages[0];
  console.log(`Newest message in channel: ${newest.id} at ${newest.timestamp}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
