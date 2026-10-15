#!/usr/bin/env node
// Criteria-based Steel Path arbitration ping with reaction boards.
// Serves Discord channel: 🔥arbitrations
// Two pinned boards: mission types + planets. A ping fires only when the
// current arbitration matches BOTH boards' selections (AND across, OR within).
// Stateless: seen-ID recovered from past embed footers; boards found by marker.
// Rankings omitted by design (meta calls belong to the clanmates).

const API = 'https://api.warframestat.us/pc/arbitration';
const DISCORD = 'https://discord.com/api/v10';

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.ARBITRATION_CHANNEL_ID;
const WEBHOOK_URL = (process.env.ARBITRATION_WEBHOOK_URL || '').replace(/\/+$/, '');

if (!BOT_TOKEN || !CHANNEL_ID || !WEBHOOK_URL) {
  console.error('Missing env vars: DISCORD_BOT_TOKEN, ARBITRATION_CHANNEL_ID, ARBITRATION_WEBHOOK_URL');
  process.exit(1);
}

const MISSION_BOARD_MARKER = '🔥 Arbitration Mission board';
const PLANET_BOARD_MARKER = '🌍 Arbitration Planet board';

// Mission types arbitrations can roll. Add here if DE introduces new ones.
const MISSIONS = [
  ['survival', 'Survival', '⏳'],
  ['interception', 'Interception', '📡'],
  ['defense', 'Defense', '🛡️'],
  ['excavation', 'Excavation', '⛏️'],
  ['disruption', 'Disruption', '⚡'],
  ['infestedsalvage', 'Infested Salvage', '🧬'],
  ['deflection', 'Deflection', '🎯'],
];

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

const INFESTED_GLYPH = 'https://raw.githubusercontent.com/Hikuro-93/duviri-pings/main/assets/infested-emblem.png';

const FACTION_GLYPHS = {
  Grineer: { name: 'Grineer', icon: 'https://wiki.warframe.com/images/GrineerGlyph.png' },
  Corpus: { name: 'Corpus', icon: 'https://wiki.warframe.com/images/CorpusGlyph.png' },
  Infestation: { name: 'Infestation', icon: INFESTED_GLYPH },
  Infested: { name: 'Infested', icon: INFESTED_GLYPH },
  Corrupted: { name: 'Corrupted', icon: 'https://wiki.warframe.com/images/IconOrokinOn%28xWhite%29.png' },
  Orokin: { name: 'Orokin', icon: 'https://wiki.warframe.com/images/IconOrokinOn%28xWhite%29.png' },
};

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

// ---------- boards ----------

function boardText(marker, entries, enabled) {
  const lines = entries.map(([key, label, emoji]) => `${emoji} ${label} — ${enabled.has(key) ? 'ON' : 'OFF'}`);
  return [`${marker} — react to select. Ping only when the current arbitration matches your mission AND planet picks.`, '', ...lines].join('\n');
}

async function ensureBoards() {
  const messages = await req(`${DISCORD}/channels/${CHANNEL_ID}/messages?limit=100`, { bot: true });
  const markers = [MISSION_BOARD_MARKER, PLANET_BOARD_MARKER];
  const found = Object.fromEntries(markers.map((mk) => [mk, []]));
  for (const m of messages || []) {
    for (const mk of markers) {
      if ((m.content || '').includes(mk)) found[mk].push(m);
    }
  }

  const defs = [
    [MISSION_BOARD_MARKER, MISSIONS],
    [PLANET_BOARD_MARKER, PLANETS],
  ];
  const enabledSets = {};

  for (const [marker, entries] of defs) {
    let boards = found[marker];
    if (boards.length === 0) {
      const msg = await req(`${WEBHOOK_URL}?wait=true`, { method: 'POST', body: { content: boardText(marker, entries, new Set()) } });
      boards = [msg];
      console.log(`Created ${marker} ${msg.id}`);
    }
    // Delete duplicates, keep newest.
    for (const stale of boards.slice(1)) {
      await req(`${DISCORD}/channels/${CHANNEL_ID}/messages/${stale.id}`, { method: 'DELETE', bot: true }).catch(() => {});
      console.log(`Deleted stale ${marker} ${stale.id}`);
    }
    const boardId = boards[0].id;
    await req(`${DISCORD}/channels/${CHANNEL_ID}/pins/${boardId}`, { method: 'PUT', bot: true }).catch(() => {});

    for (const [, , emoji] of entries) {
      await req(`${DISCORD}/channels/${CHANNEL_ID}/messages/${boardId}/reactions/${encodeURIComponent(emoji)}/@me`, { method: 'PUT', bot: true });
      await new Promise((r) => setTimeout(r, 350));
    }
    const enabled = new Set();
    for (const [key, , emoji] of entries) {
      const users = await req(`${DISCORD}/channels/${CHANNEL_ID}/messages/${boardId}/reactions/${encodeURIComponent(emoji)}?limit=100`, { bot: true });
      if (users.some((u) => !u.bot)) enabled.add(key);
    }
    await req(`${WEBHOOK_URL}/messages/${boardId}`, { method: 'PATCH', body: { content: boardText(marker, entries, enabled) } });
    enabledSets[marker] = enabled;
  }

  return { missions: enabledSets[MISSION_BOARD_MARKER], planets: enabledSets[PLANET_BOARD_MARKER] };
}

// ---------- seen ----------

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

// ---------- helpers ----------

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
}

function planetOf(node) {
  const m = String(node || '').match(/\(([^()]+)\)\s*$/);
  return m ? m[1] : null;
}

function toUnix(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function arbEmbed(a) {
  const faction = FACTION_GLYPHS[a.enemy] || { name: a.enemy, icon: null };
  const start = toUnix(a.activation);
  const end = toUnix(a.expiry);
  return {
    title: `🔥 Arbitration — ${a.type}`,
    description: `${a.node}`,
    color: 0xE67E22,
    author: faction.icon ? { name: faction.name, icon_url: faction.icon } : undefined,
    fields: [
      { name: 'Starts', value: start ? `<t:${start}:R> (<t:${start}:t>)` : 'unknown', inline: true },
      { name: 'Ends', value: end ? `<t:${end}:R> (<t:${end}:t>)` : 'unknown', inline: true },
    ],
    footer: { text: `Steel Path Arbitration • id:${a.id}` },
    timestamp: a.activation || new Date().toISOString(),
  };
}

// ---------- main ----------

async function main() {
  const { missions, planets } = await ensureBoards();
  const seen = await seenFromHistory();

  const arb = await req(API);
  // Placeholder guard: when no data is up, the API returns SolNode000/Unknown/expired.
  if (!arb || !arb.node || arb.expired || norm(arb.type) === 'unknown' || arb.node.startsWith('SolNode000')) {
    console.log('No valid arbitration data this run.');
    return;
  }

  const missionKey = norm(arb.type);
  const planet = planetOf(arb.node);

  if (seen.has(arb.id)) {
    console.log(`Arbitration ${arb.node} already announced.`);
    return;
  }

  const missionOk = missions.size === 0 || missions.has(missionKey);
  const planetOk = planets.size === 0 || (planet && planets.has(planet));

  if (missionOk && planetOk) {
    await req(WEBHOOK_URL, { method: 'POST', body: { embeds: [arbEmbed(arb)] } });
    console.log(`Posted arbitration: ${arb.type} — ${arb.node}`);
  } else {
    console.log(`Skipped arbitration ${arb.type} — ${arb.node} (criteria not met).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
