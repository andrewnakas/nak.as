// Chiptune SFX synthesized with Web Audio — no audio files. Cue ids match
// sim::cues in game-src/crates/sim/src/lib.rs. The context unlocks on the
// first user gesture (menu click).

const CUES = {
  1: swing,
  2: hit,
  3: enemyDie,
  4: hurt,
  5: heart,
  6: shell,
  7: item,
  8: die,
  9: shoot,
};

export class Audio {
  constructor() {
    this.ctx = null;
    this.gain = null;
  }

  /// Call from a user-gesture handler.
  unlock() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext ?? window.webkitAudioContext)();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0.18;
    this.gain.connect(this.ctx.destination);
  }

  play(cue) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    CUES[cue]?.(this.ctx, this.gain);
  }

  playAll(cues) {
    for (const c of cues) this.play(c);
  }
}

// ---- voice helpers ----

function tone(ctx, out, { type = 'square', from, to = from, dur, vol = 1, delay = 0 }) {
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g).connect(out);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(ctx, out, { dur, from = 1200, to = 400, vol = 1, delay = 0 }) {
  const t0 = ctx.currentTime + delay;
  const len = Math.ceil(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(from, t0);
  filter.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(filter).connect(g).connect(out);
  src.start(t0);
}

// ---- cues ----

function swing(ctx, out) {
  noise(ctx, out, { dur: 0.12, from: 2400, to: 600, vol: 0.7 });
}

function hit(ctx, out) {
  tone(ctx, out, { type: 'square', from: 360, to: 90, dur: 0.08 });
  noise(ctx, out, { dur: 0.06, from: 900, to: 300, vol: 0.5 });
}

function enemyDie(ctx, out) {
  noise(ctx, out, { dur: 0.25, from: 1600, to: 120, vol: 0.9 });
  tone(ctx, out, { type: 'square', from: 220, to: 40, dur: 0.22, vol: 0.6 });
}

function hurt(ctx, out) {
  tone(ctx, out, { type: 'sawtooth', from: 180, to: 60, dur: 0.18, vol: 0.9 });
}

function die(ctx, out) {
  tone(ctx, out, { type: 'sawtooth', from: 300, to: 30, dur: 0.7, vol: 0.9 });
  noise(ctx, out, { dur: 0.5, from: 800, to: 80, vol: 0.6, delay: 0.1 });
}

function heart(ctx, out) {
  tone(ctx, out, { type: 'square', from: 660, dur: 0.07 });
  tone(ctx, out, { type: 'square', from: 990, dur: 0.1, delay: 0.07 });
}

function shell(ctx, out) {
  tone(ctx, out, { type: 'triangle', from: 1320, dur: 0.05 });
  tone(ctx, out, { type: 'triangle', from: 1760, dur: 0.08, delay: 0.05 });
}

function item(ctx, out) {
  tone(ctx, out, { type: 'square', from: 523, dur: 0.06 });
  tone(ctx, out, { type: 'square', from: 659, dur: 0.06, delay: 0.06 });
  tone(ctx, out, { type: 'square', from: 784, dur: 0.12, delay: 0.12 });
}

function shoot(ctx, out) {
  tone(ctx, out, { type: 'square', from: 880, to: 220, dur: 0.09, vol: 0.5 });
}
