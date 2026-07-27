//! FP64: 64-bit polynomial fingerprints over GF(2^64), a faithful port of
//! `tlc2/util/FP64.java` (Heydon & Najork).
//!
//! A fingerprint is the string's associated polynomial reduced modulo an
//! irreducible polynomial of degree 64. We always use `Polys[0]` as the
//! modulus (the Java default, `FP64.Init(0)`; TLC's `-fp 0`). The 256-entry
//! byte-mod table is generated exactly as `FP64.Init` does.
//!
//! Extension-step bit-compatibility with Java is verified by golden values in
//! the tests below (obtained by running Java TLC's `FP64` directly).

/// `FP64.Polys[0]`, the default irreducible polynomial (and the fingerprint
/// of the empty string, `FP64.New()`).
pub const IRRED_POLY: u64 = 0x911498AE0E66BAD6;

/// Java `FP64.One`: the polynomial "1" (bit 63 is the x^0 coefficient).
const ONE: u64 = 0x8000000000000000;
/// Java `FP64.X63`: the x^63 coefficient mask.
const X63: u64 = 0x1;

/// The byte-mod table (`FP64.ByteModTable_7`), built once per engine.
pub struct Fp64Table {
    by: [u64; 256],
}

impl Fp64Table {
    /// Port of `FP64.Init(Polys[0])`.
    pub fn new() -> Self {
        // Maximum power needed == 127 - 7*8 == 71.
        let mut power = [0u64; 72];
        let mut t = ONE;
        for p in power.iter_mut() {
            *p = t;
            // t = t * x  (mod IrredPoly)
            let mask = if t & X63 != 0 { IRRED_POLY } else { 0 };
            t = (t >> 1) ^ mask;
        }
        let mut by = [0u64; 256];
        for (j, slot) in by.iter_mut().enumerate() {
            let mut v = 0u64;
            for k in 0..=7usize {
                if j & (1 << k) != 0 {
                    v ^= power[127 - 7 * 8 - k];
                }
            }
            *slot = v;
        }
        Fp64Table { by }
    }

    /// The fingerprint of the empty string (`FP64.New()`).
    pub fn new_fp(&self) -> u64 {
        IRRED_POLY
    }

    /// Extend `fp` by one byte (`FP64.Extend(long, byte)`).
    #[inline]
    pub fn extend(&self, fp: u64, byte: u8) -> u64 {
        (fp >> 8) ^ self.by[((u64::from(byte) ^ fp) & 0xFF) as usize]
    }

    /// Extend `fp` by a 32-bit integer, low byte first
    /// (`FP64.Extend(long, int)`).
    pub fn extend_u32(&self, fp: u64, x: u32) -> u64 {
        let mut fp = fp;
        let mut x = x;
        for _ in 0..4 {
            fp = self.extend(fp, (x & 0xFF) as u8);
            x >>= 8;
        }
        fp
    }

    /// Extend `fp` by a 64-bit integer, low byte first
    /// (`FP64.Extend(long, long)`; two's complement, so `i64` casts match
    /// Java exactly).
    pub fn extend_i64(&self, fp: u64, x: i64) -> u64 {
        let mut fp = fp;
        let mut x = x as u64;
        for _ in 0..8 {
            fp = self.extend(fp, (x & 0xFF) as u8);
            x >>= 8;
        }
        fp
    }

    /// Extend `fp` by the characters of `s` (`FP64.Extend(long, String)`).
    ///
    /// Java extends by each UTF-16 char's low byte; we extend by each UTF-8
    /// byte. Identical for ASCII (the overwhelmingly common case for TLA+
    /// strings); for non-ASCII the schemes differ but ours remains
    /// deterministic and collision-resistant.
    pub fn extend_str(&self, fp: u64, s: &str) -> u64 {
        let mut fp = fp;
        for &b in s.as_bytes() {
            fp = self.extend(fp, b);
        }
        fp
    }
}

impl Default for Fp64Table {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Golden values produced by Java TLC (`FP64.Init(0)` then the listed
    /// calls), guaranteeing the port is bit-compatible per extension step.
    #[test]
    fn matches_java_golden_values() {
        let t = Fp64Table::new();
        assert_eq!(t.new_fp(), 10454148508367108822); // FP64.New()
        assert_eq!(t.extend_str(t.new_fp(), ""), 10454148508367108822);
        assert_eq!(t.extend_str(t.new_fp(), "hello"), 7052718744087791934);
        assert_eq!(t.extend_str(t.new_fp(), "abc"), 4282401791201382651);
        // FP64.Extend(New(), (byte) 9) then Extend(fp, (int) 2)
        let fp = t.extend(t.new_fp(), 9);
        assert_eq!(t.extend_u32(fp, 2), 945168522320122332);
        // FP64.Extend(New(), 0x1234567890abcdefL)
        assert_eq!(
            t.extend_i64(t.new_fp(), 0x1234567890abcdef),
            10181901549743983796
        );
        // FP64.Extend(New(), (int) -42)
        assert_eq!(t.extend_u32(t.new_fp(), (-42i32) as u32), 10175805332772988741);
        // FP64.Extend(New(), 't')
        assert_eq!(t.extend(t.new_fp(), b't'), 5867293328532184525);
    }

    #[test]
    fn deterministic_and_distinct() {
        let a = Fp64Table::new();
        let b = Fp64Table::new();
        for s in ["", "x", "hello", "Init", "TypeOK", "a slightly longer string"] {
            assert_eq!(a.extend_str(a.new_fp(), s), b.extend_str(b.new_fp(), s));
        }
        assert_ne!(
            a.extend_str(a.new_fp(), "hello"),
            a.extend_str(a.new_fp(), "world")
        );
        assert_ne!(
            a.extend_str(a.new_fp(), "ab"),
            a.extend_str(a.new_fp(), "ba")
        );
    }
}
