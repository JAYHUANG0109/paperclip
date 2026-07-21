/**
 * @fileoverview Validates plugin instance configuration against its JSON Schema.
 *
 * Uses Ajv to validate `configJson` values against the `instanceConfigSchema`
 * declared in a plugin's manifest. This ensures that invalid configuration is
 * rejected at the API boundary, not discovered later at worker startup.
 *
 * @module server/services/plugin-config-validator
 */

import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import type { JsonSchema } from "@paperclipai/shared";

export interface ConfigValidationResult {
  valid: boolean;
  errors?: { field: string; message: string }[];
}

/**
 * Relax `type` for `format: "secret-ref"` fields so a bound secret's object
 * shape is accepted.
 *
 * Plugin manifests historically declare secret-ref fields as `type: "string"`
 * (a raw/pasted value or legacy UUID). The host secret picker now stores a
 * bound secret as the object `{ type: "secret_ref", secretId, version? }`, so a
 * strict `type: "string"` check rejects a saved binding ("must be string"). The
 * `secret-ref` format is only a UI hint; the real secret validation happens in
 * the secrets handler at resolve time. Accept either shape here.
 *
 * Mutates the (already-cloned) schema in place.
 */
function relaxSecretRefTypes(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) relaxSecretRefTypes(item);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (obj.format === "secret-ref" && (obj.type === "string" || obj.type === undefined)) {
    obj.type = ["string", "object"];
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") relaxSecretRefTypes(value);
  }
}

/**
 * Validate a config object against a JSON Schema.
 *
 * @param configJson - The configuration values to validate.
 * @param schema - The JSON Schema from the plugin manifest's `instanceConfigSchema`.
 * @returns Validation result with structured field errors on failure.
 */
export function validateInstanceConfig(
  configJson: Record<string, unknown>,
  schema: JsonSchema,
): ConfigValidationResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AjvCtor = (Ajv as any).default ?? Ajv;
  // allowUnionTypes: secret-ref fields are relaxed to type ["string","object"]
  // below so a bound secret's object shape validates alongside a raw string.
  const ajv = new AjvCtor({ allErrors: true, allowUnionTypes: true });
  // ajv-formats v3 default export is a FormatsPlugin object; call it as a plugin.
  const applyFormats = (addFormats as any).default ?? addFormats;
  applyFormats(ajv);
  // Register the secret-ref format used by plugin manifests to mark fields that
  // hold a Paperclip secret UUID rather than a raw value. The format is a UI
  // hint only — UUID validation happens in the secrets handler at resolve time.
  ajv.addFormat("secret-ref", { validate: () => true });
  // Clone so we never mutate the plugin's cached manifest schema, then relax
  // secret-ref field types to accept a bound secret's object shape.
  const relaxedSchema = JSON.parse(JSON.stringify(schema));
  relaxSecretRefTypes(relaxedSchema);
  const validate = ajv.compile(relaxedSchema);
  const valid = validate(configJson);

  if (valid) {
    return { valid: true };
  }

  const errors = (validate.errors ?? []).map((err: ErrorObject) => ({
    field: err.instancePath || "/",
    message: err.message ?? "validation failed",
  }));

  return { valid: false, errors };
}
