// Boot: load wasm + content + sprites, show the menu, start the chosen
// session. Solo and hosting share the authoritative host path; joining
// runs the snapshot-interpolation client path.

import init, { Game } from '../pkg/naks_awakening.js';
import { CONFIG } from './config.js';
import { Input } from './input.js';
import { Renderer } from './renderer.js';
import { HostSession, ClientSession } from './session.js';
import { Signaling } from './net/signaling.js';
import { createParty } from './api.js';
import { showMenu, setStatus, showPartyCode, showPartyList } from './ui.js';

const ROLE_HOST = 0;
const ROLE_CLIENT = 1;

async function boot() {
  const [, worldJson] = await Promise.all([
    init(),
    fetch('assets/content/world.json').then((r) => {
      if (!r.ok) throw new Error(`world.json: HTTP ${r.status}`);
      return r.text();
    }),
  ]);

  const input = new Input();
  const renderer = new Renderer(document.getElementById('screen'));
  await renderer.loadSheets(['tiles0', 'sprites0']);

  const debugEl = document.getElementById('debug');
  if (CONFIG.debug) debugEl.style.display = 'block';

  while (true) {
    const choice = await showMenu();
    try {
      await startSession(choice, { worldJson, input, renderer, debugEl });
      return;
    } catch (err) {
      console.error(err);
      setStatus(err.message, true);
      // fall through: menu reopens with the error showing
    }
  }
}

async function startSession({ mode, code, name }, { worldJson, input, renderer, debugEl }) {
  if (mode === 'solo') {
    const game = new Game(worldJson, ROLE_HOST, randomSeed());
    const session = new HostSession({ game, input, renderer, debugEl });
    session.start();
    window.__naks = { session, mode };
    return;
  }

  if (mode === 'host') {
    setStatus('creating party…');
    const partyCode = await createParty();
    const signaling = new Signaling(partyCode);
    await signaling.connect();
    await signaling.request({ t: 'create', name }, 'created');

    const game = new Game(worldJson, ROLE_HOST, randomSeed());
    const session = new HostSession(
      { game, input, renderer, debugEl },
      { onPartyChange: showPartyList },
    );
    session.attachSignaling(signaling);
    session.start();
    showPartyCode(partyCode);
    setStatus('');
    window.__naks = { session, mode };
    return;
  }

  // join
  setStatus(`joining ${code}…`);
  const signaling = new Signaling(code);
  await signaling.connect();
  const joined = await signaling.request({ t: 'join', name }, 'joined');

  const game = new Game(worldJson, ROLE_CLIENT, 0n);
  const session = new ClientSession(
    { game, input, renderer, debugEl },
    {
      onDisconnect: () => {
        showPartyCode('');
        setStatus('Host disconnected. Reload to play again.', true);
        document.getElementById('menu').style.display = 'flex';
      },
    },
  );
  setStatus('connecting to host…');
  await session.connect(signaling, joined.host_id, name);
  session.start();
  showPartyCode(code);
  setStatus('');
  window.__naks = { session, mode };
}

function randomSeed() {
  const buf = new BigUint64Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}

boot().catch((err) => {
  document.getElementById('hud-text').textContent = `Failed to start: ${err.message}`;
  console.error(err);
});
