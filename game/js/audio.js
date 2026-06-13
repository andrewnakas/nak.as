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

// ---- music: chill synthwave / vaporwave ----
//
// Each track is a set of layers played through warm detuned-saw voices and a
// soft low-pass filter. Layers:
//   pad    — sustained chord stacks (each note is a list of midi numbers)
//   bass   — single notes (triangle-ish), the groove anchor
//   lead   — sparse melody plucks with long release, slightly behind the beat
//   arp    — optional fast shimmer for motion
// Note form per layer: [value, beats] where value is a midi number (lead/bass/
// arp) or an array of midi numbers (pad chord); 0 = rest. Loops on the bar.
//
// Tempos are moderate (the "fast chill" feel comes from the 1/8 arp + soft
// pulse, not a frantic BPM).

// roman-numeral-ish chord helper: root midi -> stacked 9th voicing
const maj9 = (r) => [r, r + 4, r + 7, r + 11, r + 14];
const min9 = (r) => [r, r + 3, r + 7, r + 10, r + 14];
const min7 = (r) => [r, r + 3, r + 7, r + 10];
const maj7 = (r) => [r, r + 4, r + 7, r + 11];

const TRACKS = {
  // Dreamy, gently propulsive — the open-world theme. Cmaj9 / Amin9 / Fmaj9 / Gsus.
  overworld: {
    bpm: 84,
    filter: 1600,
    pad: [
      [maj9(48), 4], [min9(45), 4], [maj9(53), 4], [min7(43).concat(50), 4],
    ],
    bass: [
      [36, 2], [43, 1], [48, 1], [33, 2], [40, 1], [45, 1],
      [41, 2], [48, 1], [53, 1], [31, 2], [38, 1], [43, 1],
    ],
    lead: [
      [0, 2], [76, 1], [79, 1], [81, 3], [0, 1], [76, 2], [74, 2],
      [0, 2], [72, 1], [74, 1], [77, 3], [0, 1], [72, 4],
    ],
    arp: [
      [72, 0.5], [76, 0.5], [79, 0.5], [83, 0.5], [79, 0.5], [76, 0.5], [72, 0.5], [76, 0.5],
      [69, 0.5], [72, 0.5], [76, 0.5], [81, 0.5], [76, 0.5], [72, 0.5], [69, 0.5], [72, 0.5],
      [77, 0.5], [81, 0.5], [84, 0.5], [88, 0.5], [84, 0.5], [81, 0.5], [77, 0.5], [81, 0.5],
      [74, 0.5], [79, 0.5], [83, 0.5], [86, 0.5], [83, 0.5], [79, 0.5], [74, 0.5], [79, 0.5],
    ],
  },
  // Hazier, lower, slower-feeling — caves. Amin9 / Fmaj7 / Dmin9 / Emin7.
  dungeon: {
    bpm: 72,
    filter: 1000,
    pad: [
      [min9(45), 4], [maj7(41), 4], [min9(38), 4], [min7(40), 4],
    ],
    bass: [
      [33, 4], [29, 4], [26, 4], [28, 4],
    ],
    lead: [
      [0, 4], [69, 2], [72, 2], [0, 2], [68, 1], [69, 1], [0, 4],
      [0, 2], [65, 2], [69, 4], [0, 4], [64, 4],
    ],
    arp: null,
  },
  // Tense but still synthy/cool — boss. Driving 1/8 bass, darker chords.
  boss: {
    bpm: 96,
    filter: 2000,
    pad: [
      [min9(45), 2], [min9(45), 2], [maj9(44), 2], [maj9(44), 2],
      [min7(41).concat(48), 2], [min7(41).concat(48), 2], [min9(43), 2], [min9(43), 2],
    ],
    bass: [
      [33, 0.5], [33, 0.5], [45, 0.5], [33, 0.5], [33, 0.5], [33, 0.5], [45, 0.5], [33, 0.5],
      [32, 0.5], [32, 0.5], [44, 0.5], [32, 0.5], [32, 0.5], [32, 0.5], [44, 0.5], [32, 0.5],
      [29, 0.5], [29, 0.5], [41, 0.5], [29, 0.5], [31, 0.5], [31, 0.5], [43, 0.5], [31, 0.5],
    ],
    lead: [
      [0, 2], [81, 1], [84, 1], [88, 2], [86, 1], [84, 1],
      [80, 2], [83, 1], [80, 1], [77, 4],
    ],
    arp: [
      [69, 0.25], [72, 0.25], [76, 0.25], [81, 0.25], [76, 0.25], [72, 0.25], [69, 0.25], [76, 0.25],
      [68, 0.25], [71, 0.25], [76, 0.25], [80, 0.25], [76, 0.25], [71, 0.25], [68, 0.25], [76, 0.25],
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
    this.cursors = {};
  }

  /// Call from a user-gesture handler.
  unlock() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext ?? window.webkitAudioContext)();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0.18;
    this.gain.connect(this.ctx.destination);

    // Music runs through a warm low-pass + gentle stereo-ish chorus delay
    // for the washed vaporwave sheen, then a master music gain.
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.16;
    this.musicGain.connect(this.ctx.destination);

    this.musicFilter = this.ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 1600;
    this.musicFilter.Q.value = 0.6;
    this.musicFilter.connect(this.musicGain);

    // Lush feedback delay (the "haze").
    const delay = this.ctx.createDelay();
    delay.delayTime.value = 0.28;
    const fb = this.ctx.createGain();
    fb.gain.value = 0.32;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.4;
    this.musicFilter.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(wet);
    wet.connect(this.musicGain);
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

    this.musicFilter.frequency.setTargetAtTime(
      this.track.filter ?? 1600,
      this.ctx.currentTime,
      0.5,
    );

    // One independent cursor per layer (they have different bar lengths).
    const layers = ['pad', 'bass', 'lead', 'arp'];
    const start = this.ctx.currentTime + 0.15;
    this.cursors = {};
    for (const l of layers) {
      if (this.track[l]) this.cursors[l] = { pos: 0, next: start };
    }
    // Lookahead scheduling on AudioContext time (survives hidden tabs).
    this.scheduler = setInterval(() => this._schedule(), 140);
    this._schedule();
  }

  _schedule() {
    const track = this.track;
    if (!track || this.ctx.state !== 'running') return;
    const beat = 60 / track.bpm;
    const horizon = this.ctx.currentTime + 0.6;

    for (const [layer, cur] of Object.entries(this.cursors)) {
      const seq = track[layer];
      while (cur.next < horizon) {
        const [value, beats] = seq[cur.pos % seq.length];
        const dur = beats * beat;
        const t0 = cur.next;
        if (value !== 0) {
          if (Array.isArray(value)) {
            // chord pad: spread the voicing, very soft + slow attack
            value.forEach((m, k) =>
              this._voice(m, t0, dur, {
                vol: 0.07,
                type: 'sawtooth',
                attack: 0.4,
                release: dur * 0.5,
                detune: 6,
                delay: k * 0.012,
              }),
            );
          } else if (layer === 'bass') {
            this._voice(value, t0, dur, {
              vol: 0.22,
              type: 'triangle',
              attack: 0.01,
              release: 0.18,
              detune: 0,
            });
          } else if (layer === 'lead') {
            // plucky, a touch behind the beat, long shimmery tail
            this._voice(value, t0 + 0.03, dur, {
              vol: 0.13,
              type: 'sawtooth',
              attack: 0.02,
              release: dur * 0.7,
              detune: 8,
            });
          } else {
            // arp shimmer
            this._voice(value, t0, dur, {
              vol: 0.05,
              type: 'square',
              attack: 0.005,
              release: dur * 0.9,
              detune: 4,
            });
          }
        }
        cur.next += dur;
        cur.pos++;
      }
    }
  }

  /// One detuned-saw voice (two oscillators slightly apart for width).
  _voice(midi, t0, dur, { vol, type, attack, release, detune, delay = 0 }) {
    const start = t0 + delay;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(vol, start + attack);
    g.gain.setValueAtTime(vol, Math.max(start + attack, start + dur - release));
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    g.connect(this.musicFilter);

    const hz = midiHz(midi);
    for (const d of detune ? [-detune, detune] : [0]) {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = hz;
      osc.detune.value = d;
      osc.connect(g);
      osc.start(start);
      osc.stop(start + dur + 0.05);
    }
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
