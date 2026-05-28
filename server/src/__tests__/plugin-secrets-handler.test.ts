import { describe, expect, it } from "vitest";
import { createPluginSecretsHandler } from "../services/plugin-secrets-handler.js";

describe("createPluginSecretsHandler", () => {
  it("rejects malformed secret refs", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });

    await expect(
      handler.resolve({ secretRef: "not-a-uuid" }),
    ).rejects.toThrow(/invalid secret reference/i);
  });
});
