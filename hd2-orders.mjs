#!/usr/bin/env node
// Helldivers 2 Major Order tracker.
// One message per MO: new orders post fresh (ping via channel "All messages"
// notifications), existing ones are live-patched with progress every run.

const DISCORD = 'https://discord.com/api/v10';
const API = 'https://api.helldivers2.dev/api/v1';
const TM = 'https://helldiverstrainingmanual.com/api/v1';
const HD2_HEADERS = {
  'X-Super-Client': 'github.com/Hikuro-93/duviri-pings',
  'X-Super-Contact': 'https://github.com/Hikuro-93',
};

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.HD2_ORDERS_CHANNEL_ID;
const WEBHOOK_URL = (process.env.HD2_ORDERS_WEBHOOK_URL || '').replace(/\/+$/, '');

if (!BOT_TOKEN || !CHANNEL_ID || !WEBHOOK_URL) {
  console.error('Missing env vars: DISCORD_BOT_TOKEN, HD2_ORDERS_CHANNEL_ID, HD2_ORDERS_WEBHOOK_URL');
  process.exit(1);
}

const ASSET = (name) => `https://raw.githubusercontent.com/Hikuro-93/duviri-pings/main/assets/${name}`;

const FACTION_DEFS = {
  terminid: { label: 'Terminids', emoji: '🪳', color: 0xE8A33D, emblem: ASSET('hd2-terminid.png') },
  automaton: { label: 'Automatons', emoji: '🤖', color: 0xC0392B, emblem: ASSET('hd2-automaton.png') },
  illuminate: { label: 'Illuminate', emoji: '🦑', color: 0x8E44AD, emblem: ASSET('hd2-illuminate.png') },
  superearth: { label: 'Super Earth High Command', emoji: '🌍', color: 0x1F6FB2, emblem: ASSET('hd2-superearth.png') },
};

function factionFor(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('terminid')) return FACTION_DEFS.terminid;
  if (n.includes('automaton')) return FACTION_DEFS.automaton;
  if (n.includes('illuminate')) return FACTION_DEFS.illuminate;
  return FACTION_DEFS.superearth;
}

const OWNER_FACTION = { 1: 'Terminids', 2: 'Automatons', 3: 'Illuminate' };

async function getJSON(url, headers) {
  try {
    const res = await fetch(url, { headers: headers || {} });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } catch (e) {
    console.log(`Fetch failed: ${url} (${e.message})`);
    return null;
  }
}

async function discordReq(url, { method = 'GET', body, bot = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (bot) headers.Authorization = `Bot ${BOT_TOKEN}`;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  let res = await fetch(url, { method, headers, body: payload });
  for (let i = 0; res.status === 429 && i < 5; i++) {
    const d = await res.json().catch(() => ({}));
    await new Promise((r) => setTimeout(r, (d.retry_after ?? 0.5) * 1000 + 50));
    res = await fetch(url, { method, headers, body: payload });
  }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

// ---------- war context ----------

async function buildContext() {
  const planetsRaw = await getJSON(`${TM}/planets`);
  const planetNames = new Map();
  if (planetsRaw && typeof planetsRaw === 'object') {
    for (const [idx, p] of Object.entries(planetsRaw)) {
      if (p && p.name) planetNames.set(Number(idx), p.name);
    }
  }

  const ws = await getJSON(`${API}/warstatus`, HD2_HEADERS);
  const campaigns = (ws && ws.campaigns) || [];
  const ownerByIndex = new Map();
  for (const p of (ws && ws.planetStatus) || []) ownerByIndex.set(Number(p.index), Number(p.owner));

  const factionAt = (planetIndex) => {
    for (const c of campaigns) {
      if (Number(c.planetIndex) === Number(planetIndex)) return String(c.faction || '');
    }
    return OWNER_FACTION[ownerByIndex.get(Number(planetIndex))] || '';
  };

  return { planetNames, factionAt };
}

function describeTasks(mo, ctx) {
  const lines = [];
  for (const t of mo.tasks || []) {
    const names = (t.values || []).map((v) => ctx.planetNames.get(Number(v)) || `Sector #${v}`);
    const verb = Number(t.type) === 11 ? 'Defend' : 'Liberate';
    if (names.length > 0) lines.push(`${verb} **${names.join('**, **')}**`);
    else if (t.count) lines.push(`Complete **${t.count}** operations`);
  }
  return lines;
}

function progressLines(mo) {
  return (mo.tasks || []).map((t, i) => {
    const p = Number((mo.progress || [])[i] ?? 0);
    if (Number(t.type) === 3) return `${p}%`;
    if (t.count) return `${Math.min(p, t.count)}/${t.count}`;
    return String(p);
  });
}

function toUnix(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function pickCurrentMO(assignments) {
  const list = Array.isArray(assignments) ? assignments : (assignments && assignments.assignments) || [];
  return list
    .filter((a) => a && a.title && a.expiresAt && Date.parse(a.expiresAt) > Date.now())
    .sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt))[0] || null;
}

// ---------- channel scan ----------

async function scanChannel() {
  const messages = await discordReq(`${DISCORD}/channels/${CHANNEL_ID}/messages?limit=50`, { bot: true });
  let moMsgId = null;
  let postedId = null;
  const stale = new Set();
  for (const m of messages || []) {
    for (const e of m.embeds || []) {
      const f = ((e.footer && e.footer.text) || '');
      const mo = f.match(/Major Order • id:(\d+)/);
      if (mo) {
        if (moMsgId === null) { moMsgId = m.id; postedId = mo[1]; }
        else stale.add(m.id); // duplicate MO messages
      } else if (/HD2 daily orders • date:/.test(f)) {
        stale.add(m.id); // obsolete briefing cleanup from the old design
      }
    }
  }
  return { moMsgId, postedId, stale };
}

// ---------- embed ----------

function moEmbed(mo, ctx) {
  const objectives = describeTasks(mo, ctx);
  const body = objectives.length ? objectives.join('\n') : String(mo.description || mo.briefing || '').slice(0, 300);
  const factions = new Set();
  for (const t of mo.tasks || []) for (const v of t.values || []) {
    const f = ctx.factionAt(v);
    if (f) factions.add(factionFor(f).label);
  }
  const emojis = [...factions].map((l) => Object.values(FACTION_DEFS).find((d) => d.label === l).emoji);
  const primary = factions.size ? factionFor([...factions][0]) : FACTION_DEFS.superearth;
  const exp = toUnix(mo.expiresAt);
  const prog = progressLines(mo);
  return {
    title: `${emojis.length ? emojis.join('') + ' ' : ''}MAJOR ORDER: ${mo.title}`,
    description: body,
    color: primary.color,
    thumbnail: { url: primary.emblem },
    fields: [
      ...(prog.length ? [{ name: 'Progress', value: prog.join(' / '), inline: true }] : []),
      ...(exp ? [{ name: 'Expires', value: `<t:${exp}:R> (<t:${exp}:f>)`, inline: true }] : []),
    ],
    footer: { text: `Major Order • id:${mo.id32}` },
    timestamp: new Date().toISOString(),
  };
}

// ---------- main ----------

async function main() {
  const assignments = await getJSON(`${API}/assignments`, HD2_HEADERS);
  if (!assignments) throw new Error('Assignments feed unavailable.');
  const mo = pickCurrentMO(assignments);
  const ctx = await buildContext();
  const { moMsgId, postedId, stale } = await scanChannel();

  // Clean up duplicates and any leftovers from the old briefing design.
  for (const id of stale) {
    await discordReq(`${DISCORD}/channels/${CHANNEL_ID}/messages/${id}`, { method: 'DELETE', bot: true }).catch(() => {});
  }

  if (mo && moMsgId && postedId === String(mo.id32)) {
    // Same order: live-patch progress and expiry. Edits don't trigger notifications.
    await discordReq(`${WEBHOOK_URL}/messages/${moMsgId}`, { method: 'PATCH', body: { embeds: [moEmbed(mo, ctx)] } });
    console.log(`Patched progress for "${mo.title}": ${progressLines(mo).join(' / ')}`);
  } else if (mo) {
    // New order: replace the old message with a fresh post (this is the ping).
    if (moMsgId) {
      await discordReq(`${DISCORD}/channels/${CHANNEL_ID}/messages/${moMsgId}`, { method: 'DELETE', bot: true }).catch(() => {});
    }
    await discordReq(WEBHOOK_URL, { method: 'POST', body: { embeds: [moEmbed(mo, ctx)] } });
    console.log(`Posted Major Order: ${mo.title}`);
  } else {
    console.log('No active Major Order; leaving previous message in place until the next one drops.');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
