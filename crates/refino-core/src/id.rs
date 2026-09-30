//! Node id rule, defined and validated here; every consumer checks ids
//! against [`is_valid_id`] instead of redefining the rule. Ids are 3-16
//! characters of uppercase letters, digits and underscores; hyphens, dots,
//! spaces and lowercase are invalid. Ids contain neither `-` nor `.`; the
//! storage layer's path scheme relies on this.

use crate::types::RandomSource;

/// Character class matching a single id character, for building segment
/// matchers.
pub const ID_CHARSET: &str = "A-Z0-9_";

/// Whether `id` satisfies the engine id rule (the `ID_RE` counterpart of the
/// TypeScript engine: `^[A-Z0-9_]{3,16}$`).
pub fn is_valid_id(id: &str) -> bool {
    (3..=16).contains(&id.chars().count())
        && id
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

/// Random generation uses Crockford base32 (8 characters) — an internal
/// detail, not part of the exposed id rule: the Crockford alphabet is a
/// subset of the id charset, so generated ids are valid by construction.
const CROCKFORD_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Generate a random 8-character Crockford base32 id from the injected
/// random source.
pub fn generate_id(random: &dyn RandomSource) -> String {
    let mut bytes = [0u8; 8];
    random.fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| CROCKFORD_ALPHABET[(b & 0x1f) as usize] as char)
        .collect()
}
