import type { Environment, EnvironmentCapabilities, EnvironmentLease, EnvironmentProbeResult } from "@paperclipai/shared";
import { api } from "./client";

export interface EnvironmentCustomImageOverview {
  activeTemplate: EnvironmentCustomImageTemplate | null;
  /**
   * `false` means the environment config changed since capture and runs fall
   * back to the base image until a new image is captured. `null` when unknown.
   */
  activeTemplateMatchesConfig?: boolean | null;
  activeSession: EnvironmentCustomImageSetupSession | null;
  latestSession: EnvironmentCustomImageSetupSession | null;
}

export type EnvironmentCustomImageReconciliation =
  | { action: "relinked"; template: EnvironmentCustomImageTemplate }
  | { action: "detached"; template: EnvironmentCustomImageTemplate };

export type EnvironmentUpdateResult = Environment & {
  customImageReconciliation?: EnvironmentCustomImageReconciliation;
};

export interface EnvironmentCustomImageConnectionPayload {
  type: string;
  command?: string | null;
  token?: string | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface EnvironmentCustomImageSetupSessionResult {
  session: EnvironmentCustomImageSetupSession;
  connectionPayload: EnvironmentCustomImageConnectionPayload | null;
}

export interface EnvironmentCustomImageFinishResult extends EnvironmentCustomImageSetupSessionResult {
  template: EnvironmentCustomImageTemplate;
}

export interface EnvironmentCustomImageRollbackResult {
  activeTemplate: EnvironmentCustomImageTemplate;
  supersededTemplate: EnvironmentCustomImageTemplate;
}

function customImageCompanyQuery(companyId: string): string {
  return `companyId=${encodeURIComponent(companyId)}`;
}

export const environmentsApi = {
  list: (companyId: string) => api.get<Environment[]>(`/companies/${companyId}/environments`),
  capabilities: (companyId: string) =>
    api.get<EnvironmentCapabilities>(`/companies/${companyId}/environments/capabilities`),
  lease: (leaseId: string) => api.get<EnvironmentLease>(`/environment-leases/${leaseId}`),
  create: (companyId: string, body: {
    name: string;
    description?: string | null;
    driver: "local" | "ssh" | "sandbox" | "plugin";
    config?: Record<string, unknown>;
    metadata?: Record<string, unknown> | null;
  }) => api.post<Environment>(`/companies/${companyId}/environments`, body),
  update: (environmentId: string, body: {
    name?: string;
    description?: string | null;
    driver?: "local" | "ssh" | "sandbox" | "plugin";
    status?: "active" | "archived";
    config?: Record<string, unknown>;
    metadata?: Record<string, unknown> | null;
  }) => api.patch<EnvironmentUpdateResult>(`/environments/${environmentId}`, body),
  probe: (environmentId: string, companyId?: string | null) =>
    api.post<EnvironmentProbeResult>(
      companyId
        ? `/environments/${environmentId}/probe?${customImageCompanyQuery(companyId)}`
        : `/environments/${environmentId}/probe`,
      {},
    ),
  probeConfig: (companyId: string, body: {
    name?: string;
    driver: "local" | "ssh" | "sandbox" | "plugin";
    description?: string | null;
    config?: Record<string, unknown>;
    metadata?: Record<string, unknown> | null;
  }) => api.post<EnvironmentProbeResult>(`/companies/${companyId}/environments/probe-config`, body),
};
