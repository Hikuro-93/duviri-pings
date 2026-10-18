#!/usr/bin/env node
// Helldivers 2 Major Order tracker.
// One message per MO: new orders post fresh, existing ones live-patch progress.

const DISCORD = 'https://discord.com/api/v10';
const HD2_API = 'https://api.helldivers2.dev/api/v1';
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
  const campaigns = (await getJSON(`${TM}/war/campaign`)) || [];
  const byIndex = new Map(campaigns.map((c) => [Number(c.planetIndex), c]));
  const campaignAt = (i) => byIndex.get(Number(i)) || null;
  const factionAt = (i) => { const c = campaignAt(i); return c ? String(c.faction || '') : ''; };
  return { planetNames, campaignAt, factionAt };
}

// ---------- assignment parsing (verified against the live raw feed) ----------

function normalizeAssignments(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.assignments)) return raw.assignments;
    return Object.values(raw);
  }
  return [];
}

function expiryOf(a) {
  const cand = a.expiration ?? a.expiresAt ?? a.expiredAt ?? a.expiry ?? a.expires
    ?? (a.settings && (a.settings.expiresAt ?? a.settings.expiredAt));
  if (typeof cand === 'number') {
    if (cand > 6e17) return (cand - 621355968000000000) / 1e4; // .NET ticks
    if (cand > 1e12) return cand;                             // milliseconds
    return cand * 1000;                                       // unix seconds
  }
  if (typeof cand === 'string') {
    const t = Date.parse(cand);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

const idOf = (a) => a.id32 ?? a.id ?? 'unknown';
const tasksOf = (a) => a.tasks || (a.settings && a.settings.tasks) || [];

// In the raw feed, values[i] pairs with valueTypes[i]:
//  - valueTypes 3 marks the "primary" slot: planet index for control tasks,
//    the target count for counter tasks (operations, kills).
function primaryValue(t) {
  const vals = t.values || [];
  const types = t.valueTypes || [];
  const i = types.indexOf(3);
  if (i !== -1 && vals[i] !== undefined) return { value: Number(vals[i]), slot: i };
  return { value: NaN, slot: -1 };
}

function planetsOfTask(t, ctx) {
  const vals = (t.values || []).map(Number);
  // Candidates: every value that is a plausible planet index.
  const candidates = vals.filter((v) => Number.isInteger(v) && v >= 0 && v < 300 && ctx.planetNames.has(v));
  // Prefer ones with an active campaign (MO target planets are always at war).
  const atWar = candidates.filter((v) => ctx.campaignAt(v));
  const pool = atWar.length > 0 ? atWar : candidates;
  return [...new Set(pool)];
}

function countOfTask(t) {
  const { value } = primaryValue(t);
  // The count slot holds large numbers; planet indices live elsewhere for counter tasks.
  return Number.isFinite(value) && value > 300 ? value : 0;
}

function pickCurrentMO(raw) {
  const now = Date.now();
  return normalizeAssignments(raw)
    .filter((a) => a && (a.title || a.settings) && expiryOf(a) > now)
    .sort((a, b) => expiryOf(b) - expiryOf(a))[0] || null;
}

// ---------- formatting ----------

function describeTasks(mo, ctx) {
  const lines = [];
  for (const t of tasksOf(mo)) {
    const planets = planetsOfTask(t, ctx);
    const count = countOfTask(t);
    const type = Number(t.type) || 0;
    if (planets.length > 0) {
      const camp = ctx.campaignAt(planets[0]);
      const verb = (camp && camp.defense) ? 'Defend' : 'Liberate';
      lines.push(`${verb} **${planets.map((p) => ctx.planetNames.get(p)).join('**, **')}**`);
    } else if (count > 0) {
      if (type === 3) lines.push(`Terminate **${count.toLocaleString('en-US')}** hostiles`);
      else lines.push(`Complete **${count.toLocaleString('en-US')}** operations`);
    } else if (type === 12 || type === 3) {
      lines.push('Terminate hostiles');
    }
  }
  return lines;
}

function progressLines(mo, ctx) {
  return tasksOf(mo).map((t, i) => {
    const p = Number((mo.progress || [])[i] ?? NaN);
    const count = countOfTask(t);
    if (count > 0) {
      const shown = Number.isFinite(p) ? Math.min(p, count) : 0;
      return `${shown.toLocaleString('en-US')}/${count.toLocaleString('en-US')}`;
    }
    const planets = planetsOfTask(t, ctx);
    const camp = planets.length ? ctx.campaignAt(planets[0]) : null;
    if (camp && camp.percentage != null) return `${Math.round(camp.percentage)}%`;
    if (Number.isFinite(p) && p >= 0 && p <= 100) return `${Math.round(p)}%`;
    return '—';
  }).filter((x) => x !== '—' || true);
}

function rewardOf(mo) {
  const r = mo.reward || (Array.isArray(mo.rewards) && mo.rewards[0]);
  if (r && r.amount) return `${r.amount} medals`;
  return null;
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
      const mo = f.match(/Major Order • id:(\S+)/);
      if (mo) {
        if (moMsgId === null) { moMsgId = m.id; postedId = mo[1]; }
        else stale.add(m.id);
      }
    }
  }
  return { moMsgId, postedId, stale };
}

// ---------- embed ----------

function moEmbed(mo, ctx) {
  const objectives = describeTasks(mo, ctx);
  const rawTitle = String(mo.title || (mo.settings && mo.settings.overrideTitle) || 'MAJOR ORDER');
  const displayTitle = /^major order$/i.test(rawTitle.trim()) ? 'MAJOR ORDER' : `MAJOR ORDER: ${rawTitle}`;
  const body = objectives.length ? objectives.join('\n')
    : String(mo.description || mo.briefing || '').slice(0, 300);

  const factions = new Set();
  for (const t of tasksOf(mo)) for (const p of planetsOfTask(t, ctx)) {
    const f = ctx.factionAt(p);
    if (f) factions.add(factionFor(f).label);
  }
  if (factions.size === 0 && /illuminate/i.test(String(mo.briefing || '') + ' ' + body)) factions.add('Illuminate');
  const emojis = [...factions].map((l) => Object.values(FACTION_DEFS).find((d) => d.label === l).emoji);
  const primary = factions.size ? factionFor([...factions][0]) : FACTION_DEFS.superearth;

  const exp = expiryOf(mo);
  const prog = progressLines(mo, ctx).filter((x) => x !== '—');
  const reward = rewardOf(mo);
  return {
    title: `${emojis.length ? emojis.join('') + ' ' : ''}${displayTitle}`,
    description: body,
    color: primary.color,
    thumbnail: { url: primary.emblem },
    fields: [
      ...(prog.length ? [{ name: 'Progress', value: prog.join(' / '), inline: true }] : []),
      ...(reward ? [{ name: 'Reward', value: reward, inline: true }] : []),
      ...(exp ? [{ name: 'Expires', value: `<t:${Math.floor(exp / 1000)}:R> (<t:${Math.floor(exp / 1000)}:f>)`, inline: true }] : []),
    ],
    footer: { text: `Major Order • id:${idOf(mo)}` },
    timestamp: new Date().toISOString(),
  };
}

// ---------- main ----------

async function main() {
  const raw = await getJSON(`${HD2_API}/assignments`, HD2_HEADERS);
  if (!raw) throw new Error('Assignments feed unavailable.');
  const mo = pickCurrentMO(raw);

  if (!mo) {
    const all = normalizeAssignments(raw);
    console.log(`No active Major Order found (${all.length} assignment(s) in feed).`);
    if (all.length > 0) console.log(`Full first entry: ${JSON.stringify(all[0]).slice(0, 2000)}`);
    return;
  }

  const ctx = await buildContext();
  const { moMsgId, postedId, stale } = await scanChannel();

  for (const id of stale) {
    await discordReq(`${DISCORD}/channels/${CHANNEL_ID}/messages/${id}`, { method: 'DELETE', bot: true }).catch(() => {});
  }

  if (moMsgId && postedId === String(idOf(mo))) {
    await discordReq(`${WEBHOOK_URL}/messages/${moMsgId}`, { method: 'PATCH', body: { embeds: [moEmbed(mo, ctx)] } });
    console.log(`Patched progress for order ${idOf(mo)}: ${progressLines(mo, ctx).join(' / ')}`);
  } else {
    if (moMsgId) {
      await discordReq(`${DISCORD}/channels/${CHANNEL_ID}/messages/${moMsgId}`, { method: 'DELETE', bot: true }).catch(() => {});
    }
    await discordReq(WEBHOOK_URL, { method: 'POST', body: { embeds: [moEmbed(mo, ctx)] } });
    console.log(`Posted Major Order id ${idOf(mo)}, expires ${new Date(expiryOf(mo)).toISOString()}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
