// Boot: load wasm + content + sprites, then enter the shared MMO world.
// No solo/host/join choices — you always join a peer-hosted world. New
// characters play the tutorial beach locally first, then auto-join.

import init, { Game } from '../pkg/naks_awakening.js';
import { CONFIG } from './config.js';
import { Input } from './input.js';
import { Renderer } from './renderer.js';
import { Audio } from './audio.js';
import { HostSession } from './session.js';
import { loadStartingSave } from './saves.js';
import { World } from './world.js';
import { showEnter, setStatus, InventoryUI, toggleInventory } from './ui.js';
import { TouchControls, isTouchDevice } from './touch.js';

const ROLE_HOST = 0;

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
  // Debug spawn override: ?at=sx,sy,px,py (local play only — changes the
  // content hash, so it can't join shared worlds; used for testing).
  const at = new URLSearchParams(location.search).get('at');
  if (CONFIG.debug && at) {
    const [sx, sy, x, y] = at.split(',').map(Number);
    bundle.world.spawn = { sx, sy, x, y };
  }
  const worldJson = JSON.stringify(bundle);

  const input = new Input();
  const renderer = new Renderer(document.getElementById('screen'));
  await renderer.loadSheets(['tiles0', 'sprites0', 'font0']);
  const audio = new Audio();

  // On-screen Game Boy controls for touch devices (D-pad + A/B + pack).
  if (isTouchDevice() || CONFIG.debug) {
    new TouchControls(input, { onPack: () => toggleInventory() });
    renderer.resize(); // recompute scale now that controls reserve space
  }

  const debugEl = document.getElementById('debug');
  if (CONFIG.debug) debugEl.style.display = 'block';

  const deps = { worldJson, input, renderer, audio, debugEl };

  while (true) {
    const { name, forceLocal } = await showEnter();
    audio.unlock(); // the click is the gesture Web Audio needs
    try {
      await enter({ ...deps, name, forceLocal });
      return;
    } catch (err) {
      console.error(err);
      setStatus(err.message, true);
      // fall through: title reopens with the error showing
    }
  }
}

async function enter(opts) {
  const { worldJson, name } = opts;
  setStatus('loading character…');
  const save = await loadStartingSave(name);
  const introDone = save ? safeIntroDone(save) : false;

  // Debug ?at= forces local single-player (bypasses the world server).
  const debugLocal = CONFIG.debug && new URLSearchParams(location.search).has('at');

  if (!introDone || debugLocal || opts.forceLocal) {
    await playTutorial({ ...opts, save, skipToWorld: !debugLocal && !opts.forceLocal });
  } else {
    await joinWorld(opts);
  }
}

/// Local solo session for the tutorial beach. When the player finishes the
/// intro (intro_done flips), hand off to the shared world.
async function playTutorial(opts) {
  const { worldJson, input, renderer, audio, debugEl, save, skipToWorld } = opts;
  setStatus('');
  const game = new Game(worldJson, ROLE_HOST, randomSeed());
  const session = new HostSession({ game, input, renderer, audio, debugEl }, { save });
  session.start();
  new InventoryUI(session);
  window.__naks = { session, mode: 'tutorial' };

  if (!skipToWorld) return; // debug ?at= stays local forever

  // Poll for intro completion, then transition into the shared world.
  const watch = setInterval(() => {
    try {
      const st = JSON.parse(game.export_save(0));
      if (st && st.intro_done) {
        clearInterval(watch);
        // Persist the finished tutorial save, then join a world.
        import('./saves.js').then(({ persist }) => persist(game.export_save(0)));
        session.stop();
        joinWorld(opts).catch((err) => setStatus(err.message, true));
      }
    } catch {
      /* save not ready */
    }
  }, 500);
}

async function joinWorld(opts) {
  const world = new World({
    worldJson: opts.worldJson,
    input: opts.input,
    renderer: opts.renderer,
    audio: opts.audio,
    debugEl: opts.debugEl,
    name: opts.name,
  });
  window.__naks = { world, mode: 'mmo' };
  await world.join();
}

function safeIntroDone(saveJson) {
  try {
    return !!JSON.parse(saveJson).intro_done;
  } catch {
    return false;
  }
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
