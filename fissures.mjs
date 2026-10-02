#!/usr/bin/env node
// Steel Path fissure poller with reaction-menu boards.
// Modes:
//   FISSURE_MODE=sp    -> Steel Path starchart fissures (isHard && !isStorm)
//   FISSURE_MODE=storm -> Steel Path Void Storms (isHard && isStorm)
// No dependencies. Node 20+ (global fetch).

import fs from 'node:fs';
import path from 'node:path';

const MODE = process.env.FISSURE_MODE === 'storm' ? 'storm' : 'sp';
const API = 'https://api.warframestat.us/pc/fissures';
const DISCORD = 'https://discord.com/api/v10';

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = MODE === 'storm' ? process.env.FISSURE_RJ_CHANNEL_ID : process.env.FISSURE_CHANNEL_ID;
const WEBHOOK_URL = (MODE === 'storm' ? process.env.FISSURE_RJ_WEBHOOK_URL : process.env.FISSURE_WEBHOOK_URL || '').replace(/\/+$/, '');

if (!BOT_TOKEN || !CHANNEL_ID || !WEBHOOK_URL) {
  console.error(`Missing env vars for mode "${MODE}": DISCORD_BOT_TOKEN + ${MODE === 'storm' ? 'FISSURE_RJ_CHANNEL_ID, FISSURE_RJ_WEBHOOK_URL' : 'FISSURE_CHANNEL_ID, FISSURE_WEBHOOK_URL'}`);
  process.exit(1);
}

// ---------- categories (reaction board) ----------

const BASE_CATEGORIES = [
  ['capture', 'Capture', '🎯'],
  ['extermination', 'Extermination', '💀'],
  ['rescue', 'Rescue', '🛟'],
  ['sabotage', 'Sabotage', '💣'],
  ['survival', 'Survival', '⏳'],
  ['defense', 'Defense', '🛡️'],
  ['excavation', 'Excavation', '⛏️'],
  ['interception', 'Interception', '📡'],
  ['spy', 'Spy', '👁️'],
  ['mobile-defense', 'Mobile Defense', '🖥️'],
  ['disruption', 'Disruption', '⚡'],
  ['void-cascade', 'Void Cascade', '🌪️'],
  ['void-flood', 'Void Flood', '🌊'],
  ['void-armageddon', 'Void Armageddon', '☄️'],
  ['alchemy', 'Alchemy', '⚗️'],
  ['kuva-survival', 'Kuva Survival', '🩸'],
];
const STORM_CATEGORIES = [
  ['skirmish', 'Skirmish', '🚀'],
  ['volatile', 'Volatile', '☢️'],
];
const CATEGORIES = MODE === 'storm' ? [...BASE_CATEGORIES, ...STORM_CATEGORIES] : BASE_CATEGORIES;

// ---------- eras (color bar + relic icon thumbnail) ----------

const ERAS = {
  lith: { name: 'Lith', color: 0x9C7A54, icon: 'https://wiki.warframe.com/images/LithRelicIntact.png' },
  meso: { name: 'Meso', color: 0x4E9A51, icon: 'https://wiki.warframe.com/images/MesoRelicIntact.png' },
  neo: { name: 'Neo', color: 0xD9B829, icon: 'https://wiki.warframe.com/images/NeoRelicIntact.png' },
  axi: { name: 'Axi', color: 0xC0392B, icon: 'https://wiki.warframe.com/images/AxiRelicIntact.png' },
  requiem: { name: 'Requiem', color: 0x7E3FA4, icon: 'https://wiki.warframe.com/images/RequiemRelicIntact.png' },
  omnia: { name: 'Omnia', color: 0x2FA8C5, icon: null }, // no standalone Omnia relic icon exists
};

const FACTION_LOGOS = {
  Grineer: 'https://wiki.warframe.com/images/Grineer.png',
  Corpus: 'https://wiki.warframe.com/images/Corpus.png',
  Infestation: 'https://wiki.warframe.com/images/Infestation.png',
  Infested: 'https://wiki.warframe.com/images/Infestation.png',
  Orokin: 'https://wiki.warframe.com/images/OrokinEmblem.png',
  Corrupted: 'https://wiki.warframe.com/images/OrokinEmblem.png',
  Murmur: 'https://wiki.warframe.com/images/Murmur.png',
  'The Murmur': 'https://wiki.warframe.com/images/Murmur.png',
};

// ---------- state ----------

const stateDir = `.fissures-${MODE}-state`;
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
  const lines = CATEGORIES.map(([key, label, emoji]) => `${emoji} ${label} — ${enabled.has(key) ? 'ON' : 'OFF'}`);
  return [
    `🪙 Steel Path ${MODE === 'storm' ? 'Void Storm' : 'Fissure'} board — click a reaction below to toggle that mission type`,
    'React = pinged for every newly spawned matching fissure. Remove your reaction = silent again.',
    'Toggles only apply to fissures that spawn after you click. Nothing retroactive.',
    '',
    ...lines,
  ].join('\n');
}

async function ensureBoard() {
  const boardState = loadJson(boardFile, {});
  let messageId = boardState.messageId;
  if (messageId && !(await messageExists(messageId))) messageId = null;

  if (!messageId) {
    const msg = await req(`${WEBHOOK_URL}?wait=true`, { method: 'POST', body: { content: boardContent(new Set()) } });
    messageId = msg.id;
    saveJson(boardFile, { messageId });
    console.log(`Created board message ${messageId}`);
  }

  // Seed one reaction per category (idempotent), so users just click.
  // Discord caps reaction adds at 1 per 0.25s per channel, so pace them.
  for (const [, , emoji] of CATEGORIES) {
    await req(`${DISCORD}/channels/${CHANNEL_ID}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, { method: 'PUT', bot: true });
    await new Promise((r) => setTimeout(r, 350));
  }

  // A category is enabled if any non-bot user reacted.
  const enabled = new Set();
  for (const [key, , emoji] of CATEGORIES) {
    const users = await req(`${DISCORD}/channels/${CHANNEL_ID}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?limit=100`, { bot: true });
    if (users.some((u) => !u.bot)) enabled.add(key);
  }

  // Reflect current toggles on the board.
  await req(`${WEBHOOK_URL}/messages/${messageId}`, { method: 'PATCH', body: { content: boardContent(enabled) } });
  return enabled;
}

// ---------- fissures ----------

function normalizeMission(s) {
  return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
}

function categoryOf(f) {
  const norm = normalizeMission(f.missionType);
  if (norm.startsWith('kuva') && norm !== 'kuvasurvival') return null; // other Kuva missions untracked
  return CATEGORIES.find(([key]) => normalizeMission(key) === norm)?.[0] ?? null;
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

function fissureEmbed(f) {
  const era = eraOf(f);
  const cat = categoryOf(f);
  const emoji = CATEGORIES.find(([key]) => key === cat)?.[2] || '🪙';
  const expiry = toUnix(f.expiry);
  const logo = FACTION_LOGOS[f.enemy];
  return {
    title: `${emoji} ${f.missionType} — ${f.node}`,
    color: era.color,
    description: `${era.name} relic era`,
    thumbnail: era.icon ? { url: era.icon } : undefined,
    author: logo ? { name: f.enemy, icon_url: logo } : undefined,
    fields: [
      { name: 'Expires', value: expiry ? `<t:${expiry}:R> (<t:${expiry}:t>)` : 'unknown', inline: true },
      ...(f.enemy ? [{ name: 'Faction', value: f.enemy, inline: true }] : []),
    ],
    footer: { text: MODE === 'storm' ? 'Steel Path Void Storm' : 'Steel Path Fissure' },
    timestamp: f.activation || new Date().toISOString(),
  };
}

// ---------- main ----------

async function main() {
  const enabled = await ensureBoard();
  const fissures = await req(API);
  if (!Array.isArray(fissures)) throw new Error('Unexpected API response');

  const relevant = fissures.filter((f) =>
    MODE === 'storm' ? (f.isStorm && f.isHard) : (f.isHard && !f.isStorm),
  );

  const activeIds = new Set(relevant.map((f) => f.id));
  const seenSet = new Set(loadJson(seenFile, []).filter((id) => activeIds.has(id)));

  // Ping only fissures that are new since last run AND whose category is enabled.
  const fresh = relevant.filter((f) => !seenSet.has(f.id) && enabled.has(categoryOf(f)));

  for (const f of fresh) {
    await req(WEBHOOK_URL, { method: 'POST', body: { embeds: [fissureEmbed(f)] } });
    console.log(`Posted: ${f.missionType} — ${f.node} (${eraOf(f).name})`);
  }

  // Snapshot every currently active fissure as known, so toggling a category
  // never retroactively pings fissures that were already up when you clicked.
  saveJson(seenFile, relevant.map((f) => f.id));
  console.log(`Mode ${MODE}: ${relevant.length} active SP ${MODE === 'storm' ? 'storms' : 'fissures'}, ${enabled.size}/${CATEGORIES.length} categories enabled, ${fresh.length} posted this run.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
