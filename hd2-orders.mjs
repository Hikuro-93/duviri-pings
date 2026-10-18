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

// ---------- assignment normalization (handles raw + normalized shapes) ----------

function normalizeAssignments(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.assignments)) return raw.assignments;
    return Object.values(raw);
  }
  return [];
}

function expiryOf(a) {
  const cand = a.expiresAt ?? a.expiredAt ?? a.expiry ?? a.expires
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
const titleOf = (a) => a.title || (a.settings && a.settings.overrideTitle) || 'MAJOR ORDER';
const tasksOf = (a) => a.tasks || (a.settings && a.settings.tasks) || [];
const taskCount = (t) => Number(t.count ?? (t.counts || [])[0] ?? 0) || 0;
const taskValues = (t) => (t.values || []).map(Number);

function pickCurrentMO(raw) {
  const now = Date.now();
  return normalizeAssignments(raw)
    .filter((a) => a && (a.title || a.settings) && expiryOf(a) > now)
    .sort((a, b) => expiryOf(b) - expiryOf(a))[0] || null;
}

// ---------- formatting ----------

const TASK_VERB = { 3: 'Liberate', 11: 'Defend' };

function describeTasks(mo, ctx) {
  const lines = [];
  for (const t of tasksOf(mo)) {
    const vals = taskValues(t);
    const planets = vals.map((v) => ctx.planetNames.get(v)).filter(Boolean);
    const type = Number(t.type) || 0;
    const count = taskCount(t);
    if (planets.length > 0) {
      const camp = ctx.campaignAt(vals[0]);
      const verb = (camp && camp.defense) ? 'Defend' : (TASK_VERB[type] || 'Liberate');
      lines.push(`${verb} **${planets.join('**, **')}**`);
    } else if (type === 12) {
      lines.push(count ? `Terminate **${count.toLocaleString('en-US')}** hostiles` : 'Terminate hostiles');
    } else {
      lines.push(count ? `Complete **${count.toLocaleString('en-US')}** operations` : 'Objectives listed in game');
    }
  }
  return lines;
}

function progressLines(mo, ctx) {
  return tasksOf(mo).map((t, i) => {
    const p = Number((mo.progress || [])[i] ?? NaN);
    const count = taskCount(t);
    const vals = taskValues(t);
    const camp = vals.length ? ctx.campaignAt(vals[0]) : null;
    if (count > 0) {
      const shown = Number.isFinite(p) ? Math.min(p, count) : 0;
      return `${shown.toLocaleString('en-US')}/${count.toLocaleString('en-US')}`;
    }
    if (camp && camp.percentage != null) return `${Math.round(camp.percentage)}%`;
    if (Number.isFinite(p) && p >= 0 && p <= 100) return `${Math.round(p)}%`;
    return '—';
  });
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
  const body = objectives.length ? objectives.join('\n')
    : String(mo.description || mo.briefing || (mo.settings && mo.settings.overrideDescription) || '').slice(0, 300);
  const factions = new Set();
  for (const t of tasksOf(mo)) for (const v of taskValues(t)) {
    const f = ctx.factionAt(v);
    if (f) factions.add(factionFor(f).label);
  }
  const emojis = [...factions].map((l) => Object.values(FACTION_DEFS).find((d) => d.label === l).emoji);
  const primary = factions.size ? factionFor([...factions][0]) : FACTION_DEFS.superearth;
  const exp = expiryOf(mo);
  const prog = progressLines(mo, ctx);
  return {
    title: `${emojis.length ? emojis.join('') + ' ' : ''}MAJOR ORDER: ${titleOf(mo)}`,
    description: body,
    color: primary.color,
    thumbnail: { url: primary.emblem },
    fields: [
      ...(prog.length ? [{ name: 'Progress', value: prog.join(' / '), inline: true }] : []),
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
    console.log(`Patched progress for "${titleOf(mo)}": ${progressLines(mo, ctx).join(' / ')}`);
  } else {
    if (moMsgId) {
      await discordReq(`${DISCORD}/channels/${CHANNEL_ID}/messages/${moMsgId}`, { method: 'DELETE', bot: true }).catch(() => {});
    }
    await discordReq(WEBHOOK_URL, { method: 'POST', body: { embeds: [moEmbed(mo, ctx)] } });
    console.log(`Posted Major Order: ${titleOf(mo)} (id ${idOf(mo)}, expires ${new Date(expiryOf(mo)).toISOString()})`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
