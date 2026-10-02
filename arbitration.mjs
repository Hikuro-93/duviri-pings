// SANC arbitration poller — embed edition.
// Posts a rich embed to #arbitrations when the current arbitration's mission
// type is tracked. DE does not publish arbitrations in the worldstate, so the
// rotation comes from browse.wf's datamined schedule. Node names come from
// WFCD's worldstate data; tier ratings are credited to the Arbitration Goons.

import { promises as fs } from 'node:fs';

const ARBYS_URL =
  'https://raw.githubusercontent.com/calamity-inc/browse.wf/senpai/arbys.txt';
const SOLNODES_URL =
  'https://raw.githubusercontent.com/WFCD/warframe-worldstate-data/master/data/solNodes.json';
const REGIONS_URL =
  'https://raw.githubusercontent.com/Calamity-inc/warframe-public-export-plus/master/ExportRegions.json';
const ASSETS_URL =
  'https://raw.githubusercontent.com/Hikuro-93/duviri-pings/main/assets';
const STATE_DIR = './.arbitration-state';
const STATE_PATH = `${STATE_DIR}/state.json`;
const WEBHOOK_URL = process.env.ARBITRATION_WEBHOOK_URL;

// Mission types that trigger a ping. Mirror Defense is deliberately excluded.
const TRACKED = new Set([
  'survival',            // also covers Conjunction Survival
  'defense',
  'interception',
  'disruption',
  'infested-salvage',
  'void-cascade',
]);

// Node tiers (Arbitration Goons data, mirrored by browse.wf).
const TIERS = {
  SolNode450: 'S', SolNode106: 'S', SolNode25: 'S', SolNode719: 'S', SolNode64: 'S',
  SolNode147: 'A', SolNode23: 'A', SolNode172: 'A',
  SolNode167: 'B', ClanNode24: 'B', SolNode149: 'B', ClanNode22: 'B', ClanNode18: 'B',
  SolNode164: 'B', SolNode707: 'B', SolNode211: 'B', SolNode42: 'B', SolNode195: 'B',
  SolNode408: 'B', SolNode402: 'B',
  SolNode412: 'C', ClanNode2: 'C', SolNode46: 'C', ClanNode8: 'C', SolNode212: 'C',
  SolNode22: 'C', SolNode224: 'C', SolNode26: 'C', ClanNode6: 'C', SolNode122: 'C',
  SolNode72: 'C',
  SolNode130: 'D', ClanNode15: 'D', SolNode85: 'D', SolNode18: 'D', SolNode305: 'D',
  ClanNode4: 'D', SolNode125: 'D',
};

// Embed styling per tier. S gold, A silver, B bronze; C, D, F are all a muted
// slate blue so low ranks read as unremarkable rather than alarming.
const TIER_COLORS = {
  S: 0xD4AF37, // gold
  A: 0xC0C0C0, // silver
  B: 0xCD7F32, // bronze
  C: 0x546E7A, // slate blue
  D: 0x546E7A, // slate blue
  F: 0x546E7A, // slate blue
};

// Rank badge thumbnails (self-hosted in this repo's assets folder).
const BADGE_URLS = {
  S: `${ASSETS_URL}/rank-s.png`,
  A: `${ASSETS_URL}/rank-a.png`,
  B: `${ASSETS_URL}/rank-b.png`,
  C: `${ASSETS_URL}/rank-c.png`,
  D: `${ASSETS_URL}/rank-d.png`,
  F: `${ASSETS_URL}/rank-f.png`,
};

// Mission type emoji, matching the fissure pings for a consistent look.
const MISSION_EMOJI = {
  survival: '⏳',
  defense: '🛡️',
  interception: '📡',
  disruption: '⚡',
  'infested-salvage': '🧬',
  'void-cascade': '🌪️',
};

// Faction glyphs. Infested uses the green emblem recreation hosted in assets;
// swap for 'https://wiki.warframe.com/images/IconInfested%28xWhite%29.png'
// (official white version) if you ever prefer it.
const FACTION_GLYPHS = {
  FC_GRINEER: 'https://wiki.warframe.com/images/GrineerGlyph.png',
  FC_CORPUS: 'https://wiki.warframe.com/images/CorpusGlyph.png',
  FC_INFESTATION: `${ASSETS_URL}/infested-emblem.png`,
  FC_OROKIN: 'https://wiki.warframe.com/images/IconOrokinOn%28xWhite%29.png',
  FC_MITW: 'https://wiki.warframe.com/images/TheMurmurIconColor.png',
};
const KUVA_GLYPH = 'https://wiki.warframe.com/images/KuvaGlyph.png';

const FACTION_NAMES = {
  FC_GRINEER: 'Grineer',
  FC_CORPUS: 'Corpus',
  FC_INFESTATION: 'Infested',
  FC_OROKIN: 'Corrupted',
  FC_MITW: 'The Murmur',
  FC_SENTIENT: 'Sentients',
};

// Fallback name cleanup if solNodes ever misses an entry.
const NAME_FIXES = {
  VPrime: 'V Prime',
  'Kala Azar': 'Kala-azar',
  Kalaazar: 'Kala-azar',
  Stofler: 'Stöfler',
};
function fallbackName(languageKey) {
  const raw = String(languageKey || '').split('/').pop() || '???';
  const spaced = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return NAME_FIXES[spaced] || spaced;
}

function slugFor(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('conjunction')) return 'survival';
  return t.replace(/[^a-z]/g, '-').replace(/-+/g, '-');
}

function nodeInfo(nodeId, solNodes, regions) {
  const s = solNodes[nodeId] || {};
  const r = regions[nodeId] || {};
  const type = s.type || fallbackName(r.missionName) || 'Unknown';
  const name = s.value || `${fallbackName(r.name)} (${fallbackName(r.systemName)})`;
  const enemy = s.enemy || FACTION_NAMES[r.faction] || 'Unknown';
  const bonus =
    r.darkSectorData && r.darkSectorData.resourceBonus
      ? Math.round(r.darkSectorData.resourceBonus * 100)
      : null;
  return { type, name, enemy, faction: r.faction, bonus };
}

// Display name + author glyph for a node. Kuva Fortress and Zariman report
// plain Grineer in the data, so those get the Kuva glyph by node name.
function factionInfo(info) {
  if (/Kuva Fortress|Zariman/i.test(info.name)) {
    return { name: 'Kuva Grineer', icon: KUVA_GLYPH };
  }
  const icon = info.faction ? FACTION_GLYPHS[info.faction] : null;
  const name =
    info.enemy && info.enemy !== 'Unknown'
      ? info.enemy
      : FACTION_NAMES[info.faction] || 'Unknown';
  return { name, icon };
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed with HTTP ${res.status}`);
  return res.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
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

async function postEmbed(embed) {
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (res.status !== 204) throw new Error(`Webhook responded with HTTP ${res.status}`);
}

async function main() {
  if (!WEBHOOK_URL) throw new Error('ARBITRATION_WEBHOOK_URL is not set');

  const [arbysText, solNodes, regions] = await Promise.all([
    fetchText(ARBYS_URL),
    fetchJson(SOLNODES_URL),
    fetchJson(REGIONS_URL),
  ]);

  const entries = arbysText
    .split('\n')
    .map((line) => line.split(','))
    .filter((parts) => parts.length === 2)
    .map(([ts, nodeId]) => [parseInt(ts, 10), nodeId.trim()]);

  if (entries.length === 0) throw new Error('arbys.txt is empty or unreadable');

  const epoch = entries[0][0];
  const currentHour = Math.floor(Date.now() / 1000 / 3600) * 3600;
  const index = (currentHour - epoch) / 3600;

  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    console.log('Published schedule does not cover the current hour. Skipping.');
    return;
  }
  if (entries[index][0] !== currentHour) {
    console.log('Schedule entry mismatch; the data file may have changed. Skipping.');
    return;
  }

  const nodeId = entries[index][1];
  const info = nodeInfo(nodeId, solNodes, regions);

  const state = await readState();
  if (!state) {
    await writeState({ lastHour: currentHour });
    console.log(`First run: baseline recorded for ${info.type} @ ${info.name}. No ping sent.`);
    return;
  }
  if (currentHour <= state.lastHour) {
    console.log('This hour is already processed. Nothing to do.');
    return;
  }

  const slug = slugFor(info.type);
  if (TRACKED.has(slug)) {
    const tier = TIERS[nodeId] || 'F';
    const endUnix = currentHour + 3600;
    const faction = factionInfo(info);

    const fields = [
      { name: 'Tier', value: tier, inline: true },
      { name: 'Enemy', value: faction.name, inline: true },
    ];
    if (info.bonus) {
      fields.push({ name: 'Resource bonus', value: `+${info.bonus}%`, inline: true });
    }
    const next = entries[index + 1];
    if (next) {
      const ni = nodeInfo(next[1], solNodes, regions);
      const nt = TIERS[next[1]] || 'F';
      fields.push({ name: 'Next up', value: `${nt} · ${ni.name} — ${ni.type}` });
    }

    const embed = {
      title: `${MISSION_EMOJI[slug] || '🔥'} ${info.name} — ${info.type}`,
      color: TIER_COLORS[tier],
      description: `Ends <t:${endUnix}:t> (<t:${endUnix}:R>).`,
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text:
          'Rotation data: browse.wf · Tier ratings: [Arbitration Tierlist](https://discord.com/channels/1100168231207059456/1112352988955160657)',
      },
      author: faction.icon ? { name: faction.name, icon_url: faction.icon } : undefined,
      thumbnail: { url: BADGE_URLS[tier] },
    };

    await postEmbed(embed);
    console.log(`Posted embed: ${info.type} @ ${info.name} (${tier} tier)`);
  } else {
    console.log(`${info.type} @ ${info.name} is not tracked. No ping.`);
  }

  await writeState({ lastHour: currentHour });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
