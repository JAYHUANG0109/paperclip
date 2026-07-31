import type { CreateConfigValues } from "../components/AgentConfigForm";
import { buildNewAgentRuntimeConfig } from "./new-agent-runtime-config";
import type { AgentPermissions } from "@paperclipai/shared";

export function buildNewAgentHirePayload(input: {
  name: string;
  effectiveRole: string;
  title?: string;
  reportsTo?: string | null;
  selectedSkillKeys?: string[];
  configValues: CreateConfigValues;
  adapterConfig: Record<string, unknown>;
  permissions?: Partial<AgentPermissions>;
  /**
   * The person this agent belongs to. Persisted as
   * `adapterConfig.assignedUserEmail`, which is what sign-in matches to claim the
   * agent for that user — so filling this in at creation replaces having to map
   * the agent to a person by hand afterwards.
   */
  ownerEmail?: string | null;
}) {
  const {
    name,
    effectiveRole,
    title,
    reportsTo,
    selectedSkillKeys = [],
    configValues,
    adapterConfig,
    permissions,
    ownerEmail,
  } = input;

  // Match the way sign-in compares, so a re-cased address still claims the agent.
  const normalizedOwnerEmail = ownerEmail?.trim().toLowerCase() || null;
  // Deliberately no assignedUserRole: sign-in already defaults to "operator", and
  // the higher roles (notably "owner", which also confers instance_admin) should
  // stay a deliberate act rather than something a create form can hand out.
  const adapterConfigWithOwner = normalizedOwnerEmail
    ? { ...adapterConfig, assignedUserEmail: normalizedOwnerEmail }
    : adapterConfig;

  return {
    name: name.trim(),
    role: effectiveRole,
    ...(title?.trim() ? { title: title.trim() } : {}),
    ...(reportsTo ? { reportsTo } : {}),
    ...(selectedSkillKeys.length > 0 ? { desiredSkills: selectedSkillKeys } : {}),
    adapterType: configValues.adapterType,
    defaultEnvironmentId: configValues.defaultEnvironmentId ?? null,
    adapterConfig: adapterConfigWithOwner,
    runtimeConfig: buildNewAgentRuntimeConfig({
      heartbeatEnabled: configValues.heartbeatEnabled,
      intervalSec: configValues.intervalSec,
      cheapModel: configValues.cheapModel,
      cheapModelEnabled: configValues.cheapModelEnabled,
    }),
    budgetMonthlyCents: 0,
    ...(permissions ? { permissions } : {}),
  };
}
