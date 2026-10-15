import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // Each test file spawns real server processes; keep generous timeouts.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
