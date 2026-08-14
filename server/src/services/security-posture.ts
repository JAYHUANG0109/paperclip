/**
 * Security postures (#3) — one named switch that sets a coherent BUNDLE of
 * security levers, instead of remembering to flip each env flag by hand.
 *
 *   trusted  — local/single-tenant dev: nothing extra on.
 *   standard — multi-user: restrict agent visibility + redact transcript secrets,
 *              egress still log-only.
 *   strict   — locked down: the above PLUS egress enforcement.
 *
 * Backward-compatible by construction. When PAPERCLIP_SECURITY_POSTURE is unset,
 * `getConfiguredPosture()` is null and EVERY lever falls back to its own legacy
 * default — so simply shipping this changes no behaviour. A posture only supplies
 * bundle DEFAULTS, and an explicit per-lever env var always wins over the bundle.
 * That precedence (explicit env > posture bundle > legacy default) is the whole
 * contract, and it is what the tests pin.
 */

export type SecurityPosture = "trusted" | "standard" | "strict";
export type EgressEnforcement = "log" | "enforce";

export interface PostureLevers {
  egressEnforcement: EgressEnforcement;
  agentVisibilityRestricted: boolean;
  transcriptSecretRedaction: boolean;
}

export interface ResolvedPosture extends PostureLevers {
  /** null when no posture is configured (pure legacy-default mode). */
  posture: SecurityPosture | null;
}

const POSTURE_BUNDLES: Record<SecurityPosture, PostureLevers> = {
  trusted: { egressEnforcement: "log", agentVisibilityRestricted: false, transcriptSecretRedaction: false },
  standard: { egressEnforcement: "log", agentVisibilityRestricted: true, transcriptSecretRedaction: true },
  strict: { egressEnforcement: "enforce", agentVisibilityRestricted: true, transcriptSecretRedaction: true },
};

// Legacy per-lever defaults used when neither an explicit env flag nor a posture
// speaks. These MUST equal the behaviour before postures existed.
const LEGACY_DEFAULTS: PostureLevers = {
  egressEnforcement: "log", // egress audit has always been log-only (Step 1)
  agentVisibilityRestricted: false, // PAPERCLIP_RESTRICT_AGENT_VISIBILITY default-off
  transcriptSecretRedaction: false, // #2 default-off
};

function parseBoolEnv(raw: string | undefined): boolean | null {
  if (raw == null) return null;
  const v = raw.trim().toLowerCase();
  if (v === "") return null;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return null;
}

export function getConfiguredPosture(): SecurityPosture | null {
  const v = (process.env.PAPERCLIP_SECURITY_POSTURE ?? "").trim().toLowerCase();
  return v === "trusted" || v === "standard" || v === "strict" ? v : null;
}

/**
 * Resolve one boolean lever with the precedence contract:
 *   explicit per-lever env  >  posture bundle  >  legacy default.
 */
function resolveBool(
  explicit: boolean | null,
  pick: (b: PostureLevers) => boolean,
  posture: SecurityPosture | null,
): boolean {
  if (explicit !== null) return explicit;
  if (posture) return pick(POSTURE_BUNDLES[posture]);
  return pick(LEGACY_DEFAULTS);
}

export function resolveSecurityPosture(): ResolvedPosture {
  const posture = getConfiguredPosture();

  const agentVisibilityRestricted = resolveBool(
    parseBoolEnv(process.env.PAPERCLIP_RESTRICT_AGENT_VISIBILITY),
    (b) => b.agentVisibilityRestricted,
    posture,
  );
  const transcriptSecretRedaction = resolveBool(
    parseBoolEnv(process.env.PAPERCLIP_TRANSCRIPT_SECRET_REDACTION),
    (b) => b.transcriptSecretRedaction,
    posture,
  );

  // Egress enforcement is tri-state-ish but only "enforce" matters; an explicit
  // PAPERCLIP_EGRESS_ENFORCE=true forces enforce, else posture, else legacy log.
  const explicitEnforce = parseBoolEnv(process.env.PAPERCLIP_EGRESS_ENFORCE);
  const egressEnforcement: EgressEnforcement =
    explicitEnforce === true
      ? "enforce"
      : explicitEnforce === false
        ? "log"
        : posture
          ? POSTURE_BUNDLES[posture].egressEnforcement
          : LEGACY_DEFAULTS.egressEnforcement;

  return { posture, egressEnforcement, agentVisibilityRestricted, transcriptSecretRedaction };
}

/** Convenience lever readers (each honours the precedence contract). */
export function transcriptSecretRedactionEnabled(): boolean {
  return resolveSecurityPosture().transcriptSecretRedaction;
}
export function agentVisibilityRestricted(): boolean {
  return resolveSecurityPosture().agentVisibilityRestricted;
}
export function egressEnforcementMode(): EgressEnforcement {
  return resolveSecurityPosture().egressEnforcement;
}
