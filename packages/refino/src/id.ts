/**
 * Node ids are 8-character Crockford base32 strings derived from the node
 * file name (without the `.md` suffix). The alphabet excludes I, L, O and U.
 */
export const ID_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** Crockford base32 alphabet: digits and A-Z minus I, L, O, U. */
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
