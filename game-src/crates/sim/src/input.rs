//! Button bitmask shared between the JS shell and the sim.
//! One u16 per player per tick; last-write-wins over the network.

pub const BTN_UP: u16 = 1 << 0;
pub const BTN_DOWN: u16 = 1 << 1;
pub const BTN_LEFT: u16 = 1 << 2;
pub const BTN_RIGHT: u16 = 1 << 3;
pub const BTN_A: u16 = 1 << 4;
pub const BTN_B: u16 = 1 << 5;
pub const BTN_START: u16 = 1 << 6;
pub const BTN_SELECT: u16 = 1 << 7;
