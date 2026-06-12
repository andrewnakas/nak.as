// Boot + fixed-timestep game loop. In Phase 2 this splits into host/client
// orchestration; for now it runs the host path solo (party of 1).

import init, { Game } from '../pkg/naks_awakening.js';
import { CONFIG, TICK_MS, MAX_CATCHUP_TICKS } from './config.js';
import { Input } from './input.js';
import { Renderer } from './renderer.js';

async function main() {
  const [, worldJson] = await Promise.all([
    init(),
    fetch('assets/content/world.json').then((r) => {
      if (!r.ok) throw new Error(`world.json: HTTP ${r.status}`);
      return r.text();
    }),
  ]);

  const seed = BigInt(Math.floor(Math.random() * 2 ** 32));
  const game = new Game(worldJson, seed);
  game.add_player(0);

  const input = new Input();
  const renderer = new Renderer(document.getElementById('screen'));
  await renderer.loadSheets(['tiles0', 'sprites0']);
  const debugEl = document.getElementById('debug');
  if (CONFIG.debug) debugEl.style.display = 'block';

  let last = performance.now();
  let acc = 0;

  function frame(now) {
    acc += now - last;
    last = now;

    let ticks = 0;
    while (acc >= TICK_MS && ticks < MAX_CATCHUP_TICKS) {
      game.set_input(0, input.buttons);
      game.tick();
      acc -= TICK_MS;
      ticks++;
    }
    if (acc >= TICK_MS) acc = 0; // dropped behind; don't spiral

    renderer.draw(game.render_frame(0));

    if (CONFIG.debug && game.tick_count() % 30 === 0) {
      debugEl.textContent =
        `tick ${game.tick_count()}\n` +
        `hash ${game.state_hash().toString(16)}`;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((err) => {
  document.getElementById('hud-text').textContent = `Failed to start: ${err.message}`;
  console.error(err);
});
