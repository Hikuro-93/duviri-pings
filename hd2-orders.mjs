#!/usr/bin/env node
// Helldivers 2 orders: ping new Major Orders + daily 9AM Azores digest.
// Stateless: seen MO IDs and today's digest are recovered from past embed footers.

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
    const names = (t.values || [])
      .map((v) => ctx.planetNames.get(Number(v)) || `Sector #${v}`);
    const verb = Number(t.type) === 11 ? 'Defend' : 'Liberate';
    if (names.length > 0) {
      lines.push(`${verb} **${names.join('**, **')}**`);
    } else if (t.count) {
      lines.push(`Complete **${t.count}** operations`);
    }
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

// ---------- channel history ----------

async function seenFooters() {
  const messages = await discordReq(`${DISCORD}/channels/${CHANNEL_ID}/messages?limit=50`, { bot: true });
  const moIds = new Set();
  let digestDate = null;
  for (const m of messages || []) {
    for (const e of m.embeds || []) {
      const f = ((e.footer && e.footer.text) || '');
      const mo = f.match(/Major Order • id:(\d+)/);
      if (mo) moIds.add(mo[1]);
      const dg = f.match(/HD2 daily orders • date:(\d{4}-\d{2}-\d{2})/);
      if (dg) digestDate = dg[1];
    }
  }
  return { moIds, digestDate };
}

// ---------- embeds ----------

function moEmbed(mo, ctx) {
  const objectives = describeTasks(mo, ctx);
  const body = objectives.length
    ? objectives.join('\n')
    : String(mo.description || mo.briefing || '').slice(0, 300);
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

function digestEmbed(mo, ctx, dateStr) {
  const fields = [];
  if (mo) {
    const exp = toUnix(mo.expiresAt);
    const prog = progressLines(mo);
    if (prog.length) fields.push({ name: 'Progress', value: prog.join(' / '), inline: true });
    if (exp) fields.push({ name: 'Expires', value: `<t:${exp}:R> (<t:${exp}:f>)`, inline: true });
  }
  return {
    title: '📋 Daily Orders Briefing',
    description: mo
      ? `Active Major Order: **${mo.title}**\n${describeTasks(mo, ctx).join('\n')}`
      : 'No active Major Order at this time.',
    color: FACTION_DEFS.superearth.color,
    thumbnail: { url: FACTION_DEFS.superearth.emblem },
    fields,
    footer: { text: `HD2 daily orders • date:${dateStr}` },
    timestamp: new Date().toISOString(),
  };
}

// ---------- main ----------

async function main() {
  const now = new Date();
  const azores = (fmt, opts) => new Intl.DateTimeFormat(fmt, { timeZone: 'Atlantic/Azores', ...opts }).format(now);
  const dateStr = azores('en-CA'); // YYYY-MM-DD
  const azoresHour = Number(azores('en-GB', { hour: 'numeric', hour12: false }));

  const assignments = await getJSON(`${API}/assignments`, HD2_HEADERS);
  if (!assignments) throw new Error('Assignments feed unavailable.');
  const mo = pickCurrentMO(assignments);

  const ctx = await buildContext();
  const { moIds, digestDate } = await seenFooters();
  let posted = 0;

  if (mo && !moIds.has(String(mo.id32))) {
    await discordReq(WEBHOOK_URL, { method: 'POST', body: { embeds: [moEmbed(mo, ctx)] } });
    console.log(`Posted Major Order: ${mo.title}`);
    posted++;
  }

  if (azoresHour >= 9 && digestDate !== dateStr) {
    await discordReq(WEBHOOK_URL, { method: 'POST', body: { embeds: [digestEmbed(mo, ctx, dateStr)] } });
    console.log(`Posted daily digest for ${dateStr}.`);
    posted++;
  }

  console.log(`HD2 orders done: ${mo ? `MO "${mo.title}" active` : 'no active MO'}, digest ${digestDate === dateStr ? 'already sent' : 'pending'}, ${posted} message(s) posted.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
