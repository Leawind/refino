import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    // Cap file parallelism: every forked worker holds one inotify instance
    // for its whole lifetime (libuv shares one per process), and the
    // machine-wide per-user instance budget is shared with long-lived
    // residents (browsers, editors, running dsh sessions). With enough
    // concurrent workers, watcher-dependent tests lose the arming race for
    // their entire file duration. Eight workers keep the suite fast while
    // leaving headroom for arming retries.
    maxWorkers: 8,
  },
});
