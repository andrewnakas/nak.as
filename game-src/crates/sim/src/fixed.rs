//! Fixed-point math for the deterministic sim.
//! Positions and velocities are i32 with 8 fractional bits (1 px = 256 units).
//! No floats are permitted anywhere in the sim crate.

pub type Fx = i32;

pub const FX_SHIFT: u32 = 8;
pub const FX_ONE: Fx = 1 << FX_SHIFT; // one pixel

#[inline]
pub const fn fx(pixels: i32) -> Fx {
    pixels << FX_SHIFT
}

#[inline]
pub const fn to_px(v: Fx) -> i32 {
    v >> FX_SHIFT
}

/// Multiply two fixed-point values.
#[inline]
pub const fn fx_mul(a: Fx, b: Fx) -> Fx {
    ((a as i64 * b as i64) >> FX_SHIFT) as Fx
}

/// Squared distance in whole pixels (avoids sqrt; compare against r*r).
#[inline]
pub const fn dist2_px(ax: Fx, ay: Fx, bx: Fx, by: Fx) -> i64 {
    let dx = to_px(ax - bx) as i64;
    let dy = to_px(ay - by) as i64;
    dx * dx + dy * dy
}
