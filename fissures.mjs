#!/usr/bin/env node
// Planet-targeted Steel Path fissure poller with a reaction board.
// Serves Discord channel: 🪐fissures-perplanet-sp
// Stateless by design: the board is found via its marker text in channel
// history, and already-pinged fissure IDs are recovered from past embeds,
// so nothing needs to survive between (ephemeral) Actions runs.

const API = 'https://api.warframestat.us/pc/fissures';
const DISCORD = 'https://discord.com/api/v10';

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.PLANET_FISSURES_CHANNEL_ID;
const WEBHOOK_URL = (process.env.PLANET_FISSURES_WEBHOOK_URL || '').replace(/\/+$/, '');

if (!BOT_TOKEN || !CHANNEL_ID || !WEBHOOK_URL) {
  console.error('Missing env vars: DISCORD_BOT_TOKEN, PLANET_FISSURES_CHANNEL_ID, PLANET_FISSURES_WEBHOOK_URL');
  process.exit(1);
}

const BOARD_MARKER = '🪙 Planet Fissure board';

// Endless mission types (normalized: lowercase letters only).
const ENDLESS = new Set([
  'survival', 'defense', 'excavation', 'interception',
  'disruption', 'voidcascade', 'alchemy', 'kuvasurvival', 'infestedsalvage',
]);

const MISSION_EMOJI = {
  survival: '⏳', defense: '🛡️', excavation: '⛏️', interception: '📡',
  disruption: '⚡', voidcascade: '🌪️', alchemy: '⚗️', kuvasurvival: '🩸',
  infestedsalvage: '🧬',
};

const PLANETS = [
  ['Eris', 'Eris', '🦠'],
  ['Deimos', 'Deimos', '🧫'],
  ['Sedna', 'Sedna', '🥊'],
  ['Kuva Fortress', 'Kuva Fortress', '🩸'],
  ['Lua', 'Lua', '🌙'],
  ['Zariman', 'Zariman', '🌀'],
  ['Void', 'Void', '🕳️'],
  ['Jupiter', 'Jupiter', '⚡'],
  ['Saturn', 'Saturn', '🪐'],
  ['Ceres', 'Ceres', '🏗️'],
  ['Pluto', 'Pluto', '❄️'],
  ['Neptune', 'Neptune', '🌊'],
  ['Uranus', 'Uranus', '🛸'],
  ['Europa', 'Europa', '🧊'],
  ['Mars', 'Mars', '🔴'],
  ['Venus', 'Venus', '🌫️'],
  ['Earth', 'Earth', '🌍'],
];

const ERAS = {
  lith: { name: 'Lith', color: 0x9C7A54, icon: 'https://wiki.warframe.com/images/LithRelicIntact.png' },
  meso: { name: 'Meso', color: 0x4E9A51, icon: 'https://wiki.warframe.com/images/MesoRelicIntact.png' },
  neo: { name: 'Neo', color: 0xD9B829, icon: 'https://wiki.warframe.com/images/NeoRelicIntact.png' },
  axi: { name: 'Axi', color: 0xC0392B, icon: 'https://wiki.warframe.com/images/AxiRelicIntact.png' },
  requiem: { name: 'Requiem', color: 0x7E3FA4, icon: 'https://wiki.warframe.com/images/RequiemRelicIntact.png' },
  omnia: { name: 'Omnia', color: 0x2FA8C5, icon: null },
};

const INFESTED_GLYPH = 'https://raw.githubusercontent.com/Hikuro-93/duviri-pings/main/assets/infested-emblem.png';

const FACTION_GLYPHS = {
  Grineer: { name: 'Grineer', icon: 'https://wiki.warframe.com/images/GrineerGlyph.png' },
  Corpus: { name: 'Corpus', icon: 'https://wiki.warframe.com/images/CorpusGlyph.png' },
  Infestation: { name: 'Infestation', icon: INFESTED_GLYPH },
  Infested: { name: 'Infested', icon: INFESTED_GLYPH },
  Orokin: { name: 'Orokin', icon: 'https://wiki.warframe.com/images/IconOrokinOn%28xWhite%29.png' },
  Corrupted: { name: 'Corrupted', icon: 'https://wiki.warframe.com/images/IconOrokinOn%28xWhite%29.png' },
  Murmur: { name: 'The Murmur', icon: 'https://wiki.warframe.com/images/TheMurmurIconColor.png' },
  'The Murmur': { name: 'The Murmur', icon: 'https://wiki.warframe.com/images/TheMurmurIconColor.png' },
};

function factionOf(f) {
  if (/Kuva Fortress|Zariman/.test(f.node || '')) {
    return { name: 'Kuva Grineer', icon: 'https://wiki.warframe.com/images/KuvaGlyph.png' };
  }
  return FACTION_GLYPHS[f.enemy] || { name: f.enemy, icon: null };
}

// ---------- discord helpers ----------

async function req(url, { method = 'GET', body, bot = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (bot) headers.Authorization = `Bot ${BOT_TOKEN}`;
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

// ---------- board (stateless: found by marker, pinned, duplicates removed) ----------

function boardContent(enabled) {
  const lines = PLANETS.map(([key, label, emoji]) => `${emoji} ${label} — ${enabled.has(key) ? 'ON' : 'OFF'}`);
  return [
    `${BOARD_MARKER} (🪐fissures-perplanet-sp) — click a planet's reaction to get pinged for every newly spawned ENDLESS SP fissure there`,
    'Only endless missions. Remove your reaction = silent again. Toggles apply to fissures spawning after you click.',
    '',
    ...lines,
  ].join('\n');
}

async function ensureBoard() {
  const messages = await req(`${DISCORD}/channels/${CHANNEL_ID}/messages?limit=100`, { bot: true });
  const boards = (messages || []).filter((m) => (m.content || '').includes(BOARD_MARKER));

  if (boards.length === 0) {
    const msg = await req(`${WEBHOOK_URL}?wait=true`, { method: 'POST', body: { content: boardContent(new Set()) } });
    boards.push(msg);
    console.log(`Created board message ${msg.id}`);
  }

  // Remove duplicate boards left by earlier runs (keep the newest).
  for (const stale of boards.slice(1)) {
    await req(`${DISCORD}/channels/${CHANNEL_ID}/messages/${stale.id}`, { method: 'DELETE', bot: true }).catch(() => {});
    console.log(`Deleted stale board ${stale.id}`);
  }

  const boardId = boards[0].id;

  // Pin the board so the janitor never sweeps it.
  await req(`${DISCORD}/channels/${CHANNEL_ID}/pins/${boardId}`, { method: 'PUT', bot: true }).catch(() => {});

  // Seed one reaction per planet (idempotent). Pace for Discord's rate limits.
  for (const [, , emoji] of PLANETS) {
    await req(`${DISCORD}/channels/${CHANNEL_ID}/messages/${boardId}/reactions/${encodeURIComponent(emoji)}/@me`, { method: 'PUT', bot: true });
    await new Promise((r) => setTimeout(r, 350));
  }

  const enabled = new Set();
  for (const [key, , emoji] of PLANETS) {
    const users = await req(`${DISCORD}/channels/${CHANNEL_ID}/messages/${boardId}/reactions/${encodeURIComponent(emoji)}?limit=100`, { bot: true });
    if (users.some((u) => !u.bot)) enabled.add(key);
  }

  await req(`${WEBHOOK_URL}/messages/${boardId}`, { method: 'PATCH', body: { content: boardContent(enabled) } });
  return enabled;
}

// ---------- seen IDs recovered from our own past pings ----------

async function seenFromHistory() {
  const messages = await req(`${DISCORD}/channels/${CHANNEL_ID}/messages?limit=50`, { bot: true });
  const ids = new Set();
  for (const m of messages || []) {
    for (const e of m.embeds || []) {
      const match = ((e.footer && e.footer.text) || '').match(/id:([A-Za-z0-9]+)/);
      if (match) ids.add(match[1]);
    }
  }
  return ids;
}

// ---------- fissures ----------

function normalizeMission(s) {
  return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
}

function planetOf(f) {
  const m = String(f.node || '').match(/\(([^()]+)\)\s*$/);
  return m ? m[1] : null;
}

function eraOf(f) {
  const key = normalizeMission(f.tier);
  if (ERAS[key]) return ERAS[key];
  const byNum = { 1: 'lith', 2: 'meso', 3: 'neo', 4: 'axi', 5: 'requiem' }[Number(f.tierNum)];
  return ERAS[byNum] || { name: String(f.tier || 'Unknown'), color: 0x99AAB5, icon: null };
}

function toUnix(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function fissureEmbed(f, planet) {
  const era = eraOf(f);
  const emoji = MISSION_EMOJI[normalizeMission(f.missionType)] || '🪙';
  const expiry = toUnix(f.expiry);
  const faction = factionOf(f);
  return {
    title: `${emoji} ${f.missionType} — ${f.node}`,
    color: era.color,
    description: `${era.name} relic era`,
    thumbnail: era.icon ? { url: era.icon } : undefined,
    author: faction.icon ? { name: faction.name, icon_url: faction.icon } : undefined,
    fields: [
      { name: 'Expires', value: expiry ? `<t:${expiry}:R> (<t:${expiry}:t>)` : 'unknown', inline: true },
      { name: 'Planet', value: planet, inline: true },
    ],
    footer: { text: `Steel Path Endless Fissure • id:${f.id}` },
    timestamp: f.activation || new Date().toISOString(),
  };
}

// ---------- main ----------

async function main() {
  const enabled = await ensureBoard();
  const seenSet = await seenFromHistory();

  const fissures = await req(API);
  if (!Array.isArray(fissures)) throw new Error('Unexpected API response');

  const relevant = fissures.filter((f) =>
    f.isHard && !f.isStorm && ENDLESS.has(normalizeMission(f.missionType)),
  );

  const fresh = relevant.filter((f) => !seenSet.has(f.id));

  for (const f of fresh) {
    const planet = planetOf(f);
    if (planet && enabled.has(planet)) {
      await req(WEBHOOK_URL, { method: 'POST', body: { embeds: [fissureEmbed(f, planet)] } });
      console.log(`Posted: ${f.missionType} — ${f.node} (${eraOf(f).name})`);
    }
  }

  console.log(`${relevant.length} active endless SP fissures, ${enabled.size}/${PLANETS.length} planets enabled, ${fresh.length} new this run.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
