/**
 * Transcript secret redaction (read-time, universal).
 *
 * Run logs and workspace-operation logs are verbatim command output — they
 * routinely contain API keys, bearer tokens, and credential assignments that an
 * agent printed, echoed, or that leaked into an error message. This scrubs those
 * secret-shaped spans when a transcript is SERVED to a viewer. It is a
 * read-time transform only: the stored log is untouched, so nothing is lost for
 * forensics on the box itself.
 *
 * Precision over recall: every pattern here is either a vendor-specific token
 * shape (very low false-positive rate) or a `key: value` assignment where the
 * KEY names a secret. We deliberately do NOT redact bare 40-hex / base64 blobs,
 * because git SHAs, content hashes, and UUIDs are 40-hex/hex-ish and pervade
 * transcripts — over-redacting them would gut the log's usefulness. The Odoo /
 * Asana 40-hex keys are still caught, but via their `apiKey: <hex>` context.
 *
 * Flag-gated (PAPERCLIP_TRANSCRIPT_SECRET_REDACTION); default off so it is
 * enabled deliberately, and so a security posture (#3) can drive it.
 */

export function secretRedactionEnabled(): boolean {
  const v = (process.env.PAPERCLIP_TRANSCRIPT_SECRET_REDACTION ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

type SecretPattern = { name: string; regex: RegExp };

// Vendor-specific token shapes — high precision. `g` flag required (we call
// String.replace with a global regex). Order matters only for overlap; the more
// specific prefixes (sk-ant-) are listed before broader ones (sk-).
const VENDOR_PATTERNS: SecretPattern[] = [
  { name: "anthropic-key", regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-key", regex: /sk-(?!ant-)[A-Za-z0-9]{20,}/g },
  { name: "aws-access-key-id", regex: /AKIA[0-9A-Z]{16}/g },
  { name: "google-api-key", regex: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "github-token", regex: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "github-pat", regex: /github_pat_[A-Za-z0-9_]{22,}/g },
  { name: "slack-token", regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "jwt", regex: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "bearer", regex: /Bearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/g },
];

// `key: value` / `key=value` where the KEY names a secret. Captures the value
// (group 2) so we replace only the secret, not the label. Handles optional
// surrounding quotes on the value.
const ASSIGNMENT_PATTERN =
  /((?:api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd|auth[_-]?token|access[_-]?token|refresh[_-]?token|token)["']?\s*[:=]\s*)["']?([A-Za-z0-9._~+/-]{12,}={0,2})["']?/gi;

const REDACTED = (kind: string) => `[REDACTED:${kind}]`;

export function redactSecretsText(input: string): string {
  if (!input) return input;
  let out = input;
  for (const { name, regex } of VENDOR_PATTERNS) {
    out = out.replace(regex, REDACTED(name));
  }
  out = out.replace(ASSIGNMENT_PATTERN, (_m, label: string) => `${label}${REDACTED("secret")}`);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively scrub secrets from any JSON-ish value (strings, arrays, plain
 * objects). Non-plain objects and non-strings pass through untouched. Mirrors
 * the shape-preserving contract of redactCurrentUserValue.
 */
export function redactSecretsValue<T>(value: T, opts?: { enabled?: boolean }): T {
  if (opts?.enabled === false) return value;
  if (typeof value === "string") return redactSecretsText(value) as T;
  if (Array.isArray(value)) return value.map((entry) => redactSecretsValue(entry, opts)) as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = redactSecretsValue(entry, opts);
  }
  return out as T;
}
