import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // Pin the zone so date-bucketing tests are reproducible across machines.
    // Helpers like attentionDateBucket derive local midnight via
    // setHours(0,0,0,0) while fixtures are written as UTC instants, so an
    // unpinned zone makes the same commit pass in UTC and fail in CST+0800.
    env: { TZ: "UTC" },
  },
});
