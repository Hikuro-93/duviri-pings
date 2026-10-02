// SANC world-state alerts poller.
// Watches alerts (including Gift of the Lotus and Tenno United), invasions,
// and Razorback/Fomorian events, and posts an embed to #alerts whenever a
// wanted reward becomes available. Data: warframestat.us worldstate.

import { promises as fs } from 'node:fs';

const BASE = 'https://api.warframestat.us/pc';
const STATE_DIR = './.alerts-state';
const STATE_PATH = `${STATE_DIR}/state.json`;
const WEBHOOK_URL = process.env.ALERTS_WEBHOOK_URL;

// Wanted rewards. Edit this list to change what triggers a ping.
const WANTED = [
  { label: 'Forma',                   test: /forma/i, skip: null },
  { label: 'Orokin Reactor/Catalyst', test: /orokin (reactor|catalyst)/i, skip: /blueprint/i },
  { label: 'Exilus Adapter',          test: /exilus/i, skip: /blueprint/i },
  { label: 'Riven Cipher',            test: /riven (cipher|splicer)/i, skip: null },
  { label: 'Special/limited reward',  test: /floof|plush|ornament|noggle|glyph|sigil|emblem/i, skip: null },
];

// Events that always warrant a ping.
const BIG_EVENTS = /razorback|fomorian/i;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed with HTTP ${res.status}`);
  return res.json();
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function writeState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state));
}

async function postEmbeds(embeds) {
  // Discord accepts at most 10 embeds per message; send in batches.
  for (let i = 0; i < embeds.length; i += 10) {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: embeds.slice(i, i + 10) }),
    });
    if (res.status !== 204) throw new Error(`Webhook responded with HTTP ${res.status}`);
  }
}

function rewardEntries(reward) {
  const entries = [];
  for (const item of (reward && reward.items) || []) {
    entries.push({ name: item, uniqueName: '' });
  }
  for (const ci of (reward && reward.countedItems) || []) {
    entries.push({
      name: ci.count > 1 ? `${ci.type} x${ci.count}` : ci.type,
      uniqueName: ci.uniqueName || '',
    });
  }
  return entries;
}

function matchWanted(reward) {
  for (const { name, uniqueName } of rewardEntries(reward)) {
    for (const w of WANTED) {
      if (w.skip && w.skip.test(name)) continue;
      if (w.test.test(name) || (uniqueName && w.test.test(uniqueName))) {
        return { label: w.label, item: name };
      }
    }
  }
  return null;
}

function alertKind(alert) {
  const d = (alert.mission && alert.mission.description) || '';
  if (/tenno united/i.test(d)) return 'Tenno United alert';
  if (alert.tag === 'LotusGift' || /gift/i.test(d)) return 'Gift of the Lotus';
  return 'Alert';
}

function alertEmbed(alert, match) {
  const m = alert.mission || {};
  const reward = m.reward || {};
  const fields = [];
  if (alert.expiry) {
    const endUnix = Math.floor(Date.parse(alert.expiry) / 1000);
    fields.push({ name: 'Expires', value: `<t:${endUnix}:t> (<t:${endUnix}:R>)` });
  }
  const creditLine = reward.credits ? ` +${reward.credits.toLocaleString('en-US')} credits` : '';
  fields.push({ name: 'Reward', value: `${match.item}${creditLine}` });

  const embed = {
    title: `⚠️ ${match.item} — ${alertKind(alert)}`,
    color: 0xE67E22,
    description: `${m.node || 'Unknown node'} · ${m.type || '?'} · ${m.faction || '?'}`,
    fields,
    footer: { text: 'Worldstate data: warframestat.us' },
    timestamp: new Date().toISOString(),
  };
  if (reward.thumbnail) embed.thumbnail = { url: reward.thumbnail };
  return embed;
}

function sideReward(side) {
  const entries = rewardEntries(side && side.reward);
  if (entries.length) return entries.map((e) => e.name).join(', ');
  if (side && side.reward && side.reward.credits) return `${side.reward.credits.toLocaleString('en-US')} credits`;
  return '—';
}

function invasionEmbed(inv, match) {
  const thumb =
    (inv.attacker && inv.attacker.reward && inv.attacker.reward.thumbnail) ||
    (inv.defender && inv.defender.reward && inv.defender.reward.thumbnail);
  const embed = {
    title: `⚔️ ${match.item} — Invasion reward`,
    color: 0x3498DB,
    description: `${inv.node || '?'} · ${inv.desc || 'Invasion'}`,
    fields: [
      { name: (inv.attacker && inv.attacker.faction) || 'Attacker', value: sideReward(inv.attacker), inline: true },
      { name: (inv.defender && inv.defender.faction) || 'Defender', value: sideReward(inv.defender), inline: true },
      { name: 'Progress', value: `${Number(inv.completion ?? 0).toFixed(1)}%` },
    ],
    footer: { text: 'Worldstate data: warframestat.us' },
    timestamp: new Date().toISOString(),
  };
  if (thumb) embed.thumbnail = { url: thumb };
  return embed;
}

function eventEmbed(ev) {
  const isFomorian = /fomorian/i.test(ev.description || '');
  const fields = [];
  if (ev.expiry) {
    const endUnix = Math.floor(Date.parse(ev.expiry) / 1000);
    fields.push({ name: 'Ends', value: `<t:${endUnix}:t> (<t:${endUnix}:R>)` });
  }
  const rewards = (ev.rewards || [])
    .map((r) => rewardEntries(r).map((e) => e.name).join(', ') + (r.credits ? ` +${r.credits.toLocaleString('en-US')} credits` : ''))
    .filter(Boolean)
    .join('; ');
  if (rewards) fields.push({ name: 'Reward', value: rewards });

  const embed = {
    title: isFomorian ? '🔥 Balor Fomorian detected' : '⚔️ Razorback Armada detected',
    color: isFomorian ? 0xC0392B : 0x9B59B6,
    description: `Target: ${ev.victimNode || 'unknown'}`,
    fields,
    footer: { text: 'Worldstate data: warframestat.us' },
    timestamp: new Date().toISOString(),
  };
  const thumb = ev.rewards && ev.rewards[0] && ev.rewards[0].thumbnail;
  if (thumb) embed.thumbnail = { url: thumb };
  return embed;
}

async function main() {
  if (!WEBHOOK_URL) throw new Error('ALERTS_WEBHOOK_URL is not set');

  const [alerts, invasions, events] = await Promise.all([
    fetchJson(`${BASE}/alerts`),
    fetchJson(`${BASE}/invasions`),
    fetchJson(`${BASE}/events`),
  ]);
  if (!Array.isArray(alerts) || !Array.isArray(invasions) || !Array.isArray(events)) {
    throw new Error('Unexpected worldstate response shape');
  }

  const state = await readState();
  const seen = new Set(state && Array.isArray(state.seen) ? state.seen : []);
  const activeIds = new Set();
  const embeds = [];

  for (const alert of alerts) {
    activeIds.add(alert.id);
    if (seen.has(alert.id)) continue;
    const match = matchWanted(alert.mission && alert.mission.reward);
    if (match) embeds.push(alertEmbed(alert, match));
  }

  for (const inv of invasions) {
    activeIds.add(inv.id);
    if (seen.has(inv.id) || inv.completed) continue;
    const match =
      matchWanted(inv.attacker && inv.attacker.reward) ||
      matchWanted(inv.defender && inv.defender.reward);
    if (match) embeds.push(invasionEmbed(inv, match));
  }

  for (const ev of events) {
    activeIds.add(ev.id);
    if (seen.has(ev.id)) continue;
    if (BIG_EVENTS.test(ev.description || '')) embeds.push(eventEmbed(ev));
  }

  if (!state) {
    await writeState({ seen: [...activeIds] });
    console.log(`First run: baseline recorded (${activeIds.size} active worldstate items). No pings sent.`);
    return;
  }

  if (embeds.length > 0) {
    await postEmbeds(embeds);
    console.log(`Posted ${embeds.length} embed(s).`);
  } else {
    console.log('No new wanted rewards.');
  }

  await writeState({ seen: [...activeIds] });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
