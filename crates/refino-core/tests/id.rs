use refino_core::{RandomSource, generate_id, is_valid_id};
use std::collections::HashSet;

/// Deterministic random source for tests: repeating 8-byte pattern.
struct FakeRandom(u8);

impl RandomSource for FakeRandom {
    fn fill_bytes(&self, buf: &mut [u8]) {
        for (i, b) in buf.iter_mut().enumerate() {
            *b = self.0.wrapping_add(i as u8);
        }
    }
}

#[test]
fn id_rule_is_3_to_16_chars_of_uppercase_digits_underscore() {
    assert!(is_valid_id("ABC")); // minimum length 3
    assert!(is_valid_id("01234567"));
    assert!(is_valid_id("A1_B2_C3")); // underscores allowed
    assert!(is_valid_id("ABCDEFGHIJKLMNOP")); // maximum length 16
    assert!(!is_valid_id("AB")); // too short
    assert!(!is_valid_id("ABCDEFGHIJKLMNOPQ")); // too long
    assert!(!is_valid_id("A-B-CD")); // hyphen (path separator)
    assert!(!is_valid_id("A.B.CD")); // dot (extension separator)
    assert!(!is_valid_id("ABCDE FG")); // space
    assert!(!is_valid_id("abcde")); // lowercase
}

#[test]
fn generate_id_produces_distinct_valid_ids() {
    /// xorshift64: enough state space for 100 distinct draws.
    struct Xorshift64(std::cell::Cell<u64>);
    impl RandomSource for Xorshift64 {
        fn fill_bytes(&self, buf: &mut [u8]) {
            let mut x = self.0.get().max(1);
            for b in buf.iter_mut() {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                *b = (x >> 24) as u8;
            }
            self.0.set(x);
        }
    }
    let random = Xorshift64(std::cell::Cell::new(0x9E3779B97F4A7C15));
    let ids: HashSet<String> = (0..100).map(|_| generate_id(&random)).collect();
    for id in &ids {
        assert!(
            is_valid_id(id),
            "generated id {id} must satisfy the id rule"
        );
    }
    assert_eq!(ids.len(), 100);
}

#[test]
fn generate_id_uses_the_crockford_alphabet_shape() {
    // The fake source yields known bytes; the mapping is deterministic.
    let id = generate_id(&FakeRandom(0));
    assert_eq!(id.len(), 8);
    assert!(
        id.bytes()
            .all(|b| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&b))
    );
}
