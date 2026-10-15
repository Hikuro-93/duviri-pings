#!/usr/bin/env node
// Planet-targeted Steel Path fissure poller with a reaction board.
// Serves Discord channel: 🪐 fissures-perplanet-sp
// Pings when an ENDLESS SP fissure spawns on a planet you reacted to.
// Built for Epoch Operation: Taubound (Moonflesh on Eris), works for any planet.
// Star chart only: isHard && !isStorm. No dependencies. Node 20+ (global fetch).

import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.warframestat.us/pc/fissures';
const DISCORD = 'https://discord.com/api/v10';

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.PLANET_FISSURES_CHANNEL_ID;
const WEBHOOK_URL = (process.env.PLANET_FISSURES_WEBHOOK_URL || '').replace(/\/+$/, '');

if (!BOT_TOKEN || !CHANNEL_ID || !WEBHOOK_URL) {
  console.error('Missing env vars: DISCORD_BOT_TOKEN, PLANET_FISSURES_CHANNEL_ID, PLANET_FISSURES_WEBHOOK_URL');
  process.exit(1);
}

// Endless mission types (normalized: lowercase letters only). The API reports
// Conjunction Survival as plain Survival, so it is covered by 'survival'.
// Add types here (e.g. 'voidflood', 'mirrordefense') to widen later.
const ENDLESS = new Set([
  'survival',
  'defense',
  'excavation',
  'interception',
  'disruption',
  'voidcascade',
  'alchemy',
  'kuvasurvival',
  'infestedsalvage',
]);

const MISSION_EMOJI = {
  survival: '⏳',
  defense: '🛡️',
  excavation: '⛏️',
  interception: '📡',
  disruption: '⚡',
  voidcascade: '🌪️',
  alchemy: '⚗️',
  kuvasurvival: '🩸',
  infestedsalvage: '🧬',
};

// Planet board. Keys must match the "(Planet)" suffix in API node names.
// Discord caps a message at 20 reactions, so keep this list at 20 or fewer.
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

// Bump when the planet list changes: the old board is deleted and re-created.
const BOARD_VERSION = 1;

// ---------- eras (color bar + relic icon thumbnail) ----------

const ERAS = {
  lith: { name: 'Lith', color: 0x9C7A54, icon: 'https://wiki.warframe.com/images/LithRelicIntact.png' },
  meso: { name: 'Meso', color: 0x4E9A51, icon: 'https://wiki.warframe.com/images/MesoRelicIntact.png' },
  neo: { name: 'Neo', color: 0xD9B829, icon: 'https://wiki.warframe.com/images/NeoRelicIntact.png' },
  axi: { name: 'Axi', color: 0xC0392B, icon: 'https://wiki.warframe.com/images/AxiRelicIntact.png' },
  requiem: { name: 'Requiem', color: 0x7E3FA4, icon: 'https://wiki.warframe.com/images/RequiemRelicIntact.png' },
  omnia: { name: 'Omnia', color: 0x2FA8C5, icon: null }, // no standalone Omnia relic icon exists
};

// ---------- factions (author glyph per ping) ----------

// Green recreation of the in-game emblem, self-hosted in this repo's assets.
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
  // Kuva Fortress and Zariman report plain "Grineer"; show the Kuva glyph there.
  if (/Kuva Fortress|Zariman/.test(f.node || '')) {
    return { name: 'Kuva Grineer', icon: 'https://wiki.warframe.com/images/KuvaGlyph.png' };
  }
  return FACTION_GLYPHS[f.enemy] || { name: f.enemy, icon: null };
}

// ---------- state ----------

const stateDir = '.planet-fissures-state';
const boardFile = path.join(stateDir, 'board.json');
const seenFile = path.join(stateDir, 'seen.json');

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, data) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
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

async function messageExists(messageId) {
  const res = await fetch(`${DISCORD}/channels/${CHANNEL_ID}/messages/${messageId}`, {
    headers: { Authorization: `Bot ${BOT_TOKEN}` },
  });
  if (res.ok) return true;
  if (res.status === 404) return false;
  throw new Error(`GET board message -> ${res.status}`);
}

// ---------- board ----------

function boardContent(enabled) {
  const lines = PLANETS.map(([key, label, emoji]) => `${emoji} ${label} — ${enabled.has(key) ? 'ON' : 'OFF'}`);
  return [
    `🪙 Planet Fissure board (🪐fissures-perplanet-sp) — click a planet's reaction to get pinged for every newly spawned ENDLESS SP fissure there`,
    'Only endless missions (Survival, Defense, Excavation, Interception, Disruption, Cascade, Alchemy, Salvage). Remove your reaction = silent again.',
    'Toggles only apply to fissures that spawn after you click. Nothing retroactive.',
    '',
    ...lines,
  ].join('\n');
}

async function ensureBoard() {
  const boardState = loadJson(boardFile, {});
  let messageId = boardState.messageId;

  if (messageId && boardState.version !== BOARD_VERSION) {
    await req(`${WEBHOOK_URL}/messages/${messageId}`, { method: 'DELETE' }).catch(() => {});
    messageId = null;
  }
  if (messageId && !(await messageExists(messageId))) messageId = null;

  if (!messageId) {
    const msg = await req(`${WEBHOOK_URL}?wait=true`, { method: 'POST', body: { content: boardContent(new Set()) } });
    messageId = msg.id;
    saveJson(boardFile, { messageId, version: BOARD_VERSION });
    console.log(`Created board message ${messageId} (version ${BOARD_VERSION})`);
  }

  // Seed one reaction per planet (idempotent). Pace for Discord's rate limits.
  for (const [, , emoji] of PLANETS) {
    await req(`${DISCORD}/channels/${CHANNEL_ID}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, { method: 'PUT', bot: true });
    await new Promise((r) => setTimeout(r, 350));
  }

  const enabled = new Set();
  for (const [key, , emoji] of PLANETS) {
    const users = await req(`${DISCORD}/channels/${CHANNEL_ID}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?limit=100`, { bot: true });
    if (users.some((u) => !u.bot)) enabled.add(key);
  }

  await req(`${WEBHOOK_URL}/messages/${messageId}`, { method: 'PATCH', body: { content: boardContent(enabled) } });
  return enabled;
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
    footer: { text: 'Steel Path Endless Fissure' },
    timestamp: f.activation || new Date().toISOString(),
  };
}

// ---------- main ----------

async function main() {
  const enabled = await ensureBoard();
  const fissures = await req(API);
  if (!Array.isArray(fissures)) throw new Error('Unexpected API response');

  const relevant = fissures.filter((f) =>
    f.isHard && !f.isStorm && ENDLESS.has(normalizeMission(f.missionType)),
  );

  const activeIds = new Set(relevant.map((f) => f.id));
  const seenSet = new Set(loadJson(seenFile, []).filter((id) => activeIds.has(id)));

  const fresh = relevant.filter((f) => {
    if (seenSet.has(f.id)) return false;
    const planet = planetOf(f);
    return planet && enabled.has(planet);
  });

  for (const f of fresh) {
    await req(WEBHOOK_URL, { method: 'POST', body: { embeds: [fissureEmbed(f, planetOf(f))] } });
    console.log(`Posted: ${f.missionType} — ${f.node} (${eraOf(f).name})`);
  }

  saveJson(seenFile, relevant.map((f) => f.id));
  console.log(`${relevant.length} active endless SP fissures, ${enabled.size}/${PLANETS.length} planets enabled, ${fresh.length} posted this run.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
