import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Compiled copies under dist/ go stale the moment a source test changes, and the
    // default glob collects them — so every count doubles and the run reports failures
    // that no longer exist in src/. Not hypothetical: three fixes to these tests passed
    // in src/ while the suite still showed five failures, every one from dist/. Matches
    // the exclusion hermes and hermes-gateway already use.
    exclude: ["dist/**", "node_modules/**"],
  },
});
