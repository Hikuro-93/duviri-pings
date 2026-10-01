import { readFile, writeFile } from 'node:fs/promises';

const TRACKED_MOODS = ['joy', 'sorrow', 'fear'];

const readState = async () => {
  try {
    return JSON.parse(await readFile('duviri-state.json', 'utf8'));
  } catch {
    return {};
  }
};

const cycle = await (await fetch('https://api.warframestat.us/pc/duviriCycle')).json();
const state = await readState();

if (cycle.activation !== state.activation) {
  await writeFile(
    'duviri-state.json',
    JSON.stringify({ activation: cycle.activation, state: cycle.state })
  );

  if (TRACKED_MOODS.includes(cycle.state)) {
    const expiry = new Date(cycle.expiry).toISOString().slice(0, 16).replace('T', ' ');
    await fetch(process.env.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Duviri Moods',
        content: `Duviri has entered ${cycle.state} — until ${expiry} UTC.`,
      }),
    });
  }
  console.log(`Mood change processed: ${cycle.state}`);
} else {
  console.log(`No change: ${cycle.state}`);
}
