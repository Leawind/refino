import { inject, type InjectionKey } from "vue";

/**
 * Inject a value provided by the embedding root (main.ts provides the
 * default composition: HTTP client, workspace, store). Failing fast keeps a
 * mis-wired mount from surfacing as `undefined` errors deep in a component.
 */
export function injectRequired<T>(key: InjectionKey<T>, name: string): T {
  const value = inject(key);
  if (value === undefined) {
    throw new Error(`"${name}" was not provided; mount the shell through the composition root`);
  }
  return value;
}
