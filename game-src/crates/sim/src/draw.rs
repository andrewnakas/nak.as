//! Packed draw-list format handed to the JS renderer each frame.
//!
//! The list is a flat Vec<u16> of fixed-size records (RECORD_WORDS each):
//!   [kind, a, b, c, d, e]
//!
//! kind TILE:   a = tile index in tileset, b = x+COORD_BIAS, c = y+COORD_BIAS,
//!              d = palette id, e = flags
//! kind SPRITE: a = tile index in sprite sheet, b/c = biased x/y,
//!              d = palette id, e = flags (bit0 flip-x, bit1 flip-y)
//! kind RECT:   a = shade 0-3, b/c = biased x/y, d = width, e = height
//! kind GLYPH:  a = glyph index in font sheet (8x8), b/c = biased x/y,
//!              d = variant (0 dark, 1 light), e = unused
//!
//! Coordinates are biased by COORD_BIAS so partially off-screen records
//! (screen-scroll transitions) stay unsigned.

pub const RECORD_WORDS: usize = 6;
pub const COORD_BIAS: i32 = 512;

pub const KIND_TILE: u16 = 1;
pub const KIND_SPRITE: u16 = 2;
pub const KIND_RECT: u16 = 3;
pub const KIND_GLYPH: u16 = 4;
/// kind HPBAR: a = fill permille (0..=1000), b/c = biased x/y, d = width,
/// e = height. JS draws a green->amber->red gradient fill by ratio over a dark
/// track, so the player's health reads as a continuous bar instead of hearts.
pub const KIND_HPBAR: u16 = 5;

pub const FLAG_FLIP_X: u16 = 1;
pub const FLAG_FLIP_Y: u16 = 2;

pub const SCREEN_W: i32 = 160;
pub const SCREEN_H: i32 = 144;
pub const HUD_H: i32 = 16;
pub const TILE: i32 = 16;
/// Playfield is 10x8 tiles below the 16px HUD bar, like Link's Awakening.
pub const PLAYFIELD_W_TILES: i32 = 10;
pub const PLAYFIELD_H_TILES: i32 = 8;

pub struct DrawList(pub Vec<u16>);

impl DrawList {
    pub fn new() -> Self {
        DrawList(Vec::with_capacity(256 * RECORD_WORDS))
    }

    fn push(&mut self, kind: u16, a: u16, x: i32, y: i32, d: u16, e: u16) {
        let b = (x + COORD_BIAS) as u16;
        let c = (y + COORD_BIAS) as u16;
        self.0.extend_from_slice(&[kind, a, b, c, d, e]);
    }

    pub fn tile(&mut self, index: u16, x: i32, y: i32, palette: u16) {
        self.push(KIND_TILE, index, x, y, palette, 0);
    }

    pub fn sprite(&mut self, index: u16, x: i32, y: i32, palette: u16, flags: u16) {
        self.push(KIND_SPRITE, index, x, y, palette, flags);
    }

    pub fn rect(&mut self, shade: u16, x: i32, y: i32, w: u16, h: u16) {
        self.push(KIND_RECT, shade, x, y, w, h);
    }

    pub fn glyph(&mut self, index: u16, x: i32, y: i32, variant: u16) {
        self.push(KIND_GLYPH, index, x, y, variant, 0);
    }

    /// Health bar: `permille` (0..=1000) is the fill ratio; JS colors it by
    /// health state (green when high, red when low).
    pub fn hpbar(&mut self, permille: u16, x: i32, y: i32, w: u16, h: u16) {
        self.push(KIND_HPBAR, permille.min(1000), x, y, w, h);
    }
}
