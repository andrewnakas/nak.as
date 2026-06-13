// 4-shade palettes in GBC spirit: each tile/sprite picks one ramp, index 0-3
// maps dark -> light. '.' in sprite grids = transparent.
//
// Muted Game Boy Color direction: desaturated, slightly warm/dusty ramps
// with closer mid-tones — the sophisticated look of a good GBC cart rather
// than bright NES-ish primaries. Lower saturation, gentler value steps.

export const PALETTES = {
  // soft sage/olive greens, never neon
  grass: ['#1c2b1e', '#3a4f37', '#6f8a5b', '#aebd8f'],
  // dusty teal water, low chroma
  water: ['#1b2a36', '#34566a', '#6a93a6', '#aecbd2'],
  // pale warm sand, muted ochre
  sand: ['#473a26', '#8a7350', '#c4ab7e', '#e7dcc0'],
  // weathered driftwood browns
  wood: ['#2c2018', '#5a4231', '#977049', '#c8a987'],
  // cool slate stone, faint lavender tint
  stone: ['#222530', '#454a5c', '#7c8295', '#bcc1cf'],
  // the hero: charcoal outline, deep teal cloak, warm skin, bone highlight
  hero: ['#16181d', '#2f6f6a', '#d49b74', '#efe6d2'],
  // accent ramp for cloth/flags/banners (dusty rose)
  cloth: ['#241820', '#5e3a44', '#9c6470', '#d3a3a8'],
};
