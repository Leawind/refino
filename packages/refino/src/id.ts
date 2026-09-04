/**
 * Node id rule, defined and validated here; every package checks ids against
 * `ID_RE` instead of redefining the rule (see this package's README, "ID
 * 规则"). Ids are 3-16 characters of uppercase letters, digits and
 * underscores; hyphens, dots, spaces and lowercase are invalid. Storage paths
 * rely on ids containing neither `-` (the id/type separator) nor `.` (the
 * file extension).
 */
export const ID_RE = /^[A-Z0-9_]{3,16}$/;

/** Character class matching a single id character, for building segment regexes. */
export const ID_CHARSET = "A-Z0-9_";

/**
 * Random generation uses Crockford base32 (8 characters) — an internal
 * detail, not part of the exposed id rule: the Crockford alphabet is a
 * subset of the id charset, so generated ids are valid by construction.
 */
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Generate a random 8-character Crockford base32 id via Web Crypto. */
export function generateId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += CROCKFORD_ALPHABET[bytes[i]! & 0x1f];
  }
  return id;
}
