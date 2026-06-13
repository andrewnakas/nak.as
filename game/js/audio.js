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

// ---- music tracks ----
// Three channels (square melody, square harmony, triangle bass); notes are
// [midi (0 = rest), beats]. Loops forever until the track changes.

const TRACKS = {
  overworld: {
    bpm: 132,
    channels: [
      {
        type: 'square',
        vol: 0.45,
        notes: [
          [76, 1], [79, 1], [81, 2], [79, 1], [76, 1], [72, 2],
          [74, 1], [76, 1], [79, 2], [76, 2], [74, 2],
          [76, 1], [79, 1], [81, 2], [84, 2], [81, 1], [79, 1],
          [76, 2], [74, 2], [72, 4],
        ],
      },
      {
        type: 'square',
        vol: 0.18,
        notes: [
          [60, 2], [64, 2], [60, 2], [64, 2],
          [62, 2], [65, 2], [62, 2], [65, 2],
          [60, 2], [64, 2], [60, 2], [64, 2],
          [62, 2], [65, 2], [60, 4],
        ],
      },
      {
        type: 'triangle',
        vol: 0.6,
        notes: [
          [48, 2], [43, 2], [48, 2], [43, 2],
          [50, 2], [45, 2], [50, 2], [45, 2],
          [48, 2], [43, 2], [48, 2], [43, 2],
          [50, 2], [45, 2], [48, 4],
        ],
      },
    ],
  },
  dungeon: {
    bpm: 96,
    channels: [
      {
        type: 'square',
        vol: 0.35,
        notes: [
          [69, 2], [72, 2], [71, 2], [68, 2],
          [69, 2], [76, 2], [74, 4],
          [72, 2], [71, 2], [69, 2], [68, 2], [69, 6], [0, 2],
        ],
      },
      {
        type: 'square',
        vol: 0.12,
        notes: [
          [57, 4], [56, 4], [57, 4], [62, 4],
          [60, 4], [56, 4], [57, 8],
        ],
      },
      {
        type: 'triangle',
        vol: 0.6,
        notes: [
          [45, 4], [44, 4], [45, 4], [50, 4],
          [48, 4], [44, 4], [45, 8],
        ],
      },
    ],
  },
  boss: {
    bpm: 160,
    channels: [
      {
        type: 'square',
        vol: 0.45,
        notes: [
          [69, 1], [72, 1], [75, 1], [72, 1], [69, 1], [72, 1], [75, 1], [78, 1],
          [77, 1], [74, 1], [71, 1], [74, 1], [77, 2], [74, 2],
          [69, 1], [72, 1], [75, 1], [72, 1], [80, 2], [78, 2],
          [77, 1], [75, 1], [74, 1], [72, 1], [69, 4],
        ],
      },
      {
        type: 'square',
        vol: 0.16,
        notes: [
          [57, 2], [57, 2], [57, 2], [57, 2],
          [59, 2], [59, 2], [59, 2], [59, 2],
          [57, 2], [57, 2], [62, 2], [62, 2],
          [60, 2], [60, 2], [57, 4],
        ],
      },
      {
        type: 'triangle',
        vol: 0.65,
        notes: [
          [45, 1], [45, 1], [52, 1], [45, 1], [45, 1], [45, 1], [52, 1], [45, 1],
          [47, 1], [47, 1], [54, 1], [47, 1], [47, 1], [47, 1], [54, 1], [47, 1],
          [45, 1], [45, 1], [52, 1], [45, 1], [50, 2], [48, 2],
          [47, 2], [48, 2], [45, 4],
        ],
      },
    ],
  },
};

const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

export class Audio {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.musicGain = null;
    this.track = null;
    this.positions = [];
    this.nextTimes = [];
    this.scheduler = null;
  }

  /// Call from a user-gesture handler.
  unlock() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext ?? window.webkitAudioContext)();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0.18;
    this.gain.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.05;
    this.musicGain.connect(this.ctx.destination);
  }

  play(cue) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    CUES[cue]?.(this.ctx, this.gain);
  }

  playAll(cues) {
    for (const c of cues) this.play(c);
  }

  /// Switch background music ('overworld' | 'dungeon' | 'boss' | null).
  setTrack(name) {
    if (this.trackName === name || !this.ctx) return;
    this.trackName = name;
    clearInterval(this.scheduler);
    this.scheduler = null;
    this.track = name ? TRACKS[name] : null;
    if (!this.track) return;

    const start = this.ctx.currentTime + 0.1;
    this.positions = this.track.channels.map(() => 0);
    this.nextTimes = this.track.channels.map(() => start);
    // Lookahead scheduling: AudioContext time, not rAF (which stalls in
    // hidden tabs and would garble the loop).
    this.scheduler = setInterval(() => this._schedule(), 120);
    this._schedule();
  }

  _schedule() {
    const track = this.track;
    if (!track || this.ctx.state !== 'running') return;
    const beat = 60 / track.bpm;
    const horizon = this.ctx.currentTime + 0.4;
    track.channels.forEach((ch, i) => {
      while (this.nextTimes[i] < horizon) {
        const [midi, beats] = ch.notes[this.positions[i] % ch.notes.length];
        const dur = beats * beat;
        if (midi > 0) {
          const osc = this.ctx.createOscillator();
          const g = this.ctx.createGain();
          osc.type = ch.type;
          osc.frequency.value = midiHz(midi);
          const t0 = this.nextTimes[i];
          g.gain.setValueAtTime(ch.vol, t0);
          g.gain.setValueAtTime(ch.vol, t0 + dur * 0.8);
          g.gain.linearRampToValueAtTime(0.001, t0 + dur * 0.95);
          osc.connect(g).connect(this.musicGain);
          osc.start(t0);
          osc.stop(t0 + dur);
        }
        this.nextTimes[i] += dur;
        this.positions[i]++;
      }
    });
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
