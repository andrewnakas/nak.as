// Boot: load wasm + content + sprites, show the menu, start the chosen
// session. Solo and hosting share the authoritative host path; joining
// runs the snapshot-interpolation client path.

import init, { Game } from '../pkg/naks_awakening.js';
import { CONFIG } from './config.js';
import { Input } from './input.js';
import { Renderer } from './renderer.js';
import { Audio } from './audio.js';
import { HostSession, ClientSession } from './session.js';
import { Signaling } from './net/signaling.js';
import { createParty } from './api.js';
import { loadStartingSave } from './saves.js';
import { showMenu, setStatus, showPartyCode, showPartyList, InventoryUI } from './ui.js';

const ROLE_HOST = 0;
const ROLE_CLIENT = 1;

const CONTENT_FILES = ['world', 'items', 'enemies', 'drops', 'skills', 'recipes', 'npcs', 'quests'];

async function boot() {
  const [, ...parts] = await Promise.all([
    init(),
    ...CONTENT_FILES.map((name) =>
      fetch(`assets/content/${name}.json`).then((r) => {
        if (!r.ok) throw new Error(`${name}.json: HTTP ${r.status}`);
        return r.json();
      }),
    ),
  ]);
  const bundle = Object.fromEntries(CONTENT_FILES.map((name, i) => [name, parts[i]]));
  // Debug spawn override: ?at=sx,sy,px,py (solo testing only — changes the
  // content hash, so mismatched peers are rejected, which is what we want).
  const at = new URLSearchParams(location.search).get('at');
  if (CONFIG.debug && at) {
    const [sx, sy, x, y] = at.split(',').map(Number);
    bundle.world.spawn = { sx, sy, x, y };
  }
  // One canonical bundle string — its hash must match across all peers.
  const worldJson = JSON.stringify(bundle);

  const input = new Input();
  const renderer = new Renderer(document.getElementById('screen'));
  await renderer.loadSheets(['tiles0', 'sprites0', 'font0']);
  const audio = new Audio();

  const debugEl = document.getElementById('debug');
  if (CONFIG.debug) debugEl.style.display = 'block';

  while (true) {
    const choice = await showMenu();
    audio.unlock(); // menu click is the user gesture Web Audio needs
    try {
      await startSession(choice, { worldJson, input, renderer, audio, debugEl });
      return;
    } catch (err) {
      console.error(err);
      setStatus(err.message, true);
      // fall through: menu reopens with the error showing
    }
  }
}

async function startSession({ mode, code, name }, { worldJson, input, renderer, audio, debugEl }) {
  setStatus('loading character…');
  const save = await loadStartingSave(name);
  setStatus('');

  if (mode === 'solo') {
    const game = new Game(worldJson, ROLE_HOST, randomSeed());
    const session = new HostSession({ game, input, renderer, audio, debugEl }, { save });
    session.start();
    new InventoryUI(session);
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
      { game, input, renderer, audio, debugEl },
      { onPartyChange: showPartyList, save },
    );
    session.attachSignaling(signaling);
    session.start();
    new InventoryUI(session);
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
    { game, input, renderer, audio, debugEl },
    {
      save,
      onDisconnect: () => {
        showPartyCode('');
        setStatus('Host disconnected. Your progress was saved.', true);
        document.getElementById('menu').style.display = 'flex';
      },
    },
  );
  setStatus('connecting to host…');
  const slot = await session.connect(signaling, joined.host_id, name);
  game.set_local_slot(slot);
  session.start();
  new InventoryUI(session);
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
