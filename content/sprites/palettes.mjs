// 4-shade palettes in GBC spirit: each tile/sprite picks one ramp, index 0-3
// maps dark -> light. '.' in sprite grids = transparent.

export const PALETTES = {
  grass: ['#0a1a0a', '#1f5c33', '#4eb04e', '#a8e068'],
  water: ['#0a1a33', '#1f4c8c', '#3f8cd9', '#a8d8f0'],
  sand: ['#3d2c12', '#8c6d33', '#d9b566', '#f0e0a8'],
  wood: ['#2a160a', '#6d3f1f', '#b07033', '#e0b070'],
  stone: ['#1a1a22', '#4c4c5c', '#8c8ca0', '#d0d0e0'],
  hero: ['#101010', '#1f7a3d', '#e0a878', '#f8f0e0'],
};
