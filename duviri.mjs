// SANC Duviri mood poller — embed edition.
// Posts a rich embed to #duviri when the Duviri mood changes into one of the
// tracked moods. Mood data comes from the warframestat.us API.

import { promises as fs } from 'node:fs';

const CYCLE_URL = 'https://api.warframestat.us/pc/duviriCycle';
const STATE_DIR = './.duviri-state';
const STATE_PATH = `${STATE_DIR}/state.json`;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Moods that trigger a ping.
const TRACKED = new Set(['joy', 'sorrow', 'fear']);

// Fixed in-game mood order.
const NEXT_MOOD = { joy: 'anger', anger: 'envy', envy: 'sorrow', sorrow: 'fear', fear: 'joy' };

const MOODS = {
  joy:    { label: 'Joy',    color: 0xFFB6C1, emoji: '🌸',  image: 'https://wiki.warframe.com/images/DuviriJoySpiral.png' },
  sorrow: { label: 'Sorrow', color: 0x4F6D9E, emoji: '🌧️', image: 'https://wiki.warframe.com/images/DuviriSorrowSpiral.png' },
  fear:   { label: 'Fear',   color: 0x8E44AD, emoji: '🌀',  image: 'https://wiki.warframe.com/images/DuviriFearSpiral.png' },
  anger:  { label: 'Anger',  color: 0xC0392B, emoji: '🔥',  image: 'https://wiki.warframe.com/images/DuviriAngerSpiral.png' },
  envy:   { label: 'Envy',   color: 0x27AE60, emoji: '🌿',  image: 'https://wiki.warframe.com/images/DuviriEnvySpiral.png' },
};

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

async function postEmbed(embed) {
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (res.status !== 204) throw new Error(`Webhook responded with HTTP ${res.status}`);
}

async function main() {
  if (!WEBHOOK_URL) throw new Error('WEBHOOK_URL is not set');

  const cycle = await fetchJson(CYCLE_URL);
  const mood = String(cycle.state || '').toLowerCase();
  if (!MOODS[mood]) throw new Error(`Unknown mood returned by API: ${cycle.state}`);

  const state = await readState();
  const last = state && typeof state === 'object' ? state.lastActivation ?? state.activation : null;

  if (typeof last !== 'string') {
    await writeState({ lastActivation: cycle.activation });
    console.log(`First run: baseline recorded for ${mood}. No ping sent.`);
    return;
  }
  if (last === cycle.activation) {
    console.log('Mood unchanged. Nothing to do.');
    return;
  }

  if (TRACKED.has(mood)) {
    const m = MOODS[mood];
    const next = MOODS[NEXT_MOOD[mood]];
    const embed = {
      title: `${m.emoji} Duviri has entered ${m.label}`,
      color: m.color,
      description: `This mood holds until <t:${Math.floor(Date.parse(cycle.expiry) / 1000)}:t> (<t:${Math.floor(Date.parse(cycle.expiry) / 1000)}:R>).`,
      fields: [
        { name: 'Next mood', value: `${next.emoji} ${next.label} — <t:${Math.floor(Date.parse(cycle.expiry) / 1000)}:t>` },
      ],
      thumbnail: { url: m.image },
      timestamp: new Date().toISOString(),
      footer: { text: 'Mood data: warframestat.us' },
    };
    await postEmbed(embed);
    console.log(`Posted embed: ${mood}`);
  } else {
    console.log(`${mood} is not tracked. No ping.`);
  }

  await writeState({ lastActivation: cycle.activation });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
