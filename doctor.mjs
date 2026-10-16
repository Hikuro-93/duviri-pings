#!/usr/bin/env node
// Diagnostic v2: dump the exact content of recent messages, escaped for hidden characters.
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
  const chan = await req(`${DISCORD}/channels/${CHANNEL_ID}`);
  console.log(`Channel: #${chan.name} (${CHANNEL_ID})`);

  const messages = await req(`${DISCORD}/channels/${CHANNEL_ID}/messages?limit=15`);
  console.log(`Messages found: ${messages.length}\n`);

  for (const m of messages) {
    const author = m.webhook_id ? `webhook:${m.webhook_id}` : `${m.author?.username}`;
    console.log(`--- ${m.timestamp} | ${author} | pinned:${m.pinned}`);
    // First 200 chars, JSON-escaped so invisible characters (variation selectors etc.) become visible
    console.log(JSON.stringify((m.content || '').slice(0, 200)));
    console.log(`   reactions: ${(m.reactions || []).length} | embeds: ${(m.embeds || []).length}`);
  }

  // Cross-check: what does the deployed script's marker look like, escaped?
  const script = await (await fetch('https://raw.githubusercontent.com/Hikuro-93/duviri-pings/main/planet-fissures.mjs')).text();
  const markerLine = script.match(/BOARD_MARKER = '([^']*)'/);
  console.log(`\nDeployed script BOARD_MARKER escaped: ${JSON.stringify(markerLine ? markerLine[1] : 'NOT FOUND')}`);
}
