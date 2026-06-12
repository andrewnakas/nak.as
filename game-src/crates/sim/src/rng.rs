//! PCG32: small, fast, deterministic PRNG. Seeded from the world seed;
//! every random decision in the sim flows through this so identical
//! input streams replay identically on any platform.

#[derive(Clone, Debug)]
pub struct Pcg32 {
    state: u64,
    inc: u64,
}

impl Pcg32 {
    pub fn new(seed: u64, stream: u64) -> Self {
        let mut rng = Pcg32 {
            state: 0,
            inc: (stream << 1) | 1,
        };
        rng.next_u32();
        rng.state = rng.state.wrapping_add(seed);
        rng.next_u32();
        rng
    }

    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old
            .wrapping_mul(6364136223846793005)
            .wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// Uniform in [0, bound) without modulo bias (Lemire).
    pub fn below(&mut self, bound: u32) -> u32 {
        ((self.next_u32() as u64 * bound as u64) >> 32) as u32
    }

    /// Roll against a permille chance (0..=1000).
    pub fn chance_permille(&mut self, permille: u32) -> bool {
        self.below(1000) < permille
    }

    pub fn state_bits(&self) -> u64 {
        self.state
    }
}
