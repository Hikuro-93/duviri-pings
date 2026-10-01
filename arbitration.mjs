// SANC arbitration poller.
// Posts to #arbitrations when the current arbitration's mission type is
// tracked. DE does not publish arbitrations in the worldstate, so data
// comes from browse.wf's datamined arbitration schedule instead.
// Tier ratings are credited to the Arbitration Goons community.

import { promises as fs } from 'node:fs';

const ARBYS_URL =
  'https://raw.githubusercontent.com/calamity-inc/browse.wf/senpai/arbys.txt';
const REGIONS_URL =
  'https://raw.githubusercontent.com/Calamity-inc/warframe-public-export-plus/master/ExportRegions.json';
const STATE_DIR = './.arbitration-state';
const STATE_PATH = `${STATE_DIR}/state.json`;
const WEBHOOK_URL = process.env.ARBITRATION_WEBHOOK_URL;

// Mission types that trigger a ping.
const TRACKED = new Set([
  'survival',          // also covers Conjunction Survival on Lua
  'defense',
  'interception',
  'disruption',
  'infested-salvage',
  'void-cascade',
]);

// Node tiers (Arbitration Goons data, mirrored from browse.wf).
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

const FACTIONS = {
  FC_GRINEER: 'Grineer',
  FC_CORPUS: 'Corpus',
  FC_INFESTATION: 'Infestation',
  FC_OROKIN: 'Orokin',
  FC_MITW: 'The Murmur',
  FC_SENTIENT: 'Sentients',
};

const MISSION_LABELS = {
  MT_SURVIVAL: 'Survival',
  MT_DEFENSE: 'Defense',
  MT_TERRITORY: 'Interception',
  MT_EXCAVATE: 'Excavation',
  MT_PURIFY: 'Infested Salvage',
  MT_EVACUATION: 'Defection',
  MT_ARTIFACT: 'Disruption',
  MT_CORRUPTION: 'Void Flood',
  MT_VOID_CASCADE: 'Void Cascade',
  MT_ARMAGEDDON: 'Void Armageddon',
  MT_ALCHEMY: 'Alchemy',
};

// Cosmetic fixes for names the generic split cannot render exactly.
const NAME_FIXES = {
  VPrime: 'V Prime',
  'Kala Azar': 'Kala-azar',
  Kalaazar: 'Kala-azar',
  Stofler: 'Stöfler',
};

function cleanName(languageKey) {
  const raw = String(languageKey || '').split('/').pop() || '???';
  const spaced = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return NAME_FIXES[spaced] || spaced;
}

function classify(node) {
  const key = String(node.missionName || '').split('/').pop().toLowerCase();
  if (key.includes('mirror')) return { slug: 'mirror-defense', label: 'Mirror Defense' };
  if (key.includes('conjunction')) return { slug: 'survival', label: 'Conjunction Survival' };
  const label = MISSION_LABELS[node.missionType] || String(node.missionType || 'Unknown');
  return { slug: label.toLowerCase().replace(/\s+/g, '-'), label };
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed with HTTP ${res.status}`);
  return res.text();
}

async function fetchJson(url) {
  const text = await fetchText(url);
  return JSON.parse(text);
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

async function post(content) {
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (res.status !== 204) throw new Error(`Webhook responded with HTTP ${res.status}`);
}

async function main() {
  if (!WEBHOOK_URL) throw new Error('ARBITRATION_WEBHOOK_URL is not set');

  const [arbysText, regions] = await Promise.all([
    fetchText(ARBYS_URL),
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
  const node = regions[nodeId] || {};
  const mission = classify(node);
  const place = `${cleanName(node.name)}, ${cleanName(node.systemName)}`;
  const faction = FACTIONS[node.faction] || node.faction || 'Unknown';

  const extras = [`${TIERS[nodeId] || 'F'} tier`];
  if (node.darkSectorData && node.darkSectorData.resourceBonus) {
    extras.push(`${Math.round(node.darkSectorData.resourceBonus * 100)}% resource bonus`);
  }

  const state = await readState();
  if (!state) {
    await writeState({ lastHour: currentHour });
    console.log(`First run: baseline recorded for ${mission.label} @ ${place}. No ping sent.`);
    return;
  }
  if (currentHour <= state.lastHour) {
    console.log('This hour is already processed. Nothing to do.');
    return;
  }

  if (TRACKED.has(mission.slug)) {
    const ends = new Date((currentHour + 3600) * 1000);
    const endsAt = `${String(ends.getUTCHours()).padStart(2, '0')}:00 UTC`;
    let nextLine = '';
    const next = entries[index + 1];
    if (next) {
      const nextNode = regions[next[1]] || {};
      const nextMission = classify(nextNode);
      nextLine = ` Next: ${nextMission.label} @ ${cleanName(nextNode.name)}, ${cleanName(nextNode.systemName)}.`;
    }
    await post(
      `Arbitration now live: ${mission.label} — ${faction} @ ${place} (${extras.join(', ')}). Ends ${endsAt}.${nextLine}`
    );
    console.log(`Posted: ${mission.label} @ ${place}`);
  } else {
    console.log(`${mission.label} @ ${place} is not tracked. No ping.`);
  }

  await writeState({ lastHour: currentHour });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
