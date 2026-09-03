/** localStorage-backed preference helpers; failures (private browsing) are
 * non-fatal and fall back to defaults. */

export function readPreference<T extends string>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : (value as T);
  } catch {
    return fallback;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences are best-effort; private browsing may deny access.
  }
}

export function readNumberPreference(key: string, fallback: number): number {
  const raw = readPreference(key, "");
  const value = Number(raw);
  return raw !== "" && Number.isFinite(value) ? value : fallback;
}
