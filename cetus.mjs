// SANC Cetus night poller.
// Posts an embed to #eidolonhuntping when night starts on the Plains of
// Eidolon. Cycle data comes from the warframestat.us API.

import { promises as fs } from 'node:fs';

const CYCLE_URL = 'https://api.warframestat.us/pc/cetusCycle';
const STATE_DIR = './.cetus-state';
const STATE_PATH = `${STATE_DIR}/state.json`;
const WEBHOOK_URL = process.env.CETUS_WEBHOOK_URL;

const EMBED_STYLE = {
  title: '🌙 Night has fallen on the Plains of Eidolon',
  color: 0x2B3D66, // twilight blue
  thumbnail: { url: 'https://wiki.warframe.com/images/CherryTreeGlyph.png' },
  footer: { text: 'Cycle data: warframestat.us' },
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
  if (!WEBHOOK_URL) throw new Error('CETUS_WEBHOOK_URL is not set');

  const cycle = await fetchJson(CYCLE_URL);

  const state = await readState();
  const last = state && typeof state === 'object' ? state.lastActivation ?? state.activation : null;

  if (typeof last !== 'string') {
    await writeState({ lastActivation: cycle.activation });
    console.log(`First run: baseline recorded (${cycle.state}). No ping sent.`);
    return;
  }
  if (last === cycle.activation) {
    console.log('Cycle unchanged. Nothing to do.');
    return;
  }

  if (cycle.state === 'night') {
    const endUnix = Math.floor(Date.parse(cycle.expiry) / 1000);
    const embed = {
      ...EMBED_STYLE,
      description: `Daybreak at <t:${endUnix}:t> (<t:${endUnix}:R>).`,
      timestamp: new Date().toISOString(),
    };
    await postEmbed(embed);
    console.log('Posted embed: night has started.');
  } else {
    console.log('Day has started. No ping.');
  }

  await writeState({ lastActivation: cycle.activation });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
