import { api } from "./client";

export type CustomFieldType =
  | "text"
  | "number"
  | "single_select"
  | "multi_select"
  | "date"
  | "people";

export interface CustomFieldOption {
  id: string;
  label: string;
  color?: string;
}

export interface CustomFieldOptions {
  options?: CustomFieldOption[];
}

export interface CustomField {
  id: string;
  companyId: string;
  name: string;
  type: CustomFieldType;
  options: CustomFieldOptions | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

// A field attached to a project (definition joined with the setting).
export interface ProjectCustomField {
  settingId: string;
  fieldId: string;
  name: string;
  type: CustomFieldType;
  options: CustomFieldOptions | null;
  position: number;
}

// A field's value on an issue (definition joined with the value).
export interface IssueCustomFieldValue {
  fieldId: string;
  name: string;
  type: CustomFieldType;
  options: CustomFieldOptions | null;
  value: Record<string, unknown> | null;
}

export const customFieldsApi = {
  // Company field library
  list: (companyId: string) => api.get<CustomField[]>(`/companies/${companyId}/custom-fields`),
  create: (
    companyId: string,
    data: { name: string; type: CustomFieldType; options?: CustomFieldOptions | null; position?: number },
  ) => api.post<CustomField>(`/companies/${companyId}/custom-fields`, data),
  update: (
    fieldId: string,
    data: { name?: string; options?: CustomFieldOptions | null; position?: number },
  ) => api.patch<CustomField>(`/custom-fields/${fieldId}`, data),
  remove: (fieldId: string) => api.delete<CustomField>(`/custom-fields/${fieldId}`),

  // Project attachment
  listForProject: (projectId: string, companyId: string) =>
    api.get<ProjectCustomField[]>(
      `/projects/${projectId}/custom-fields?companyId=${encodeURIComponent(companyId)}`,
    ),
  attach: (projectId: string, companyId: string, fieldId: string) =>
    api.post(`/projects/${projectId}/custom-fields?companyId=${encodeURIComponent(companyId)}`, { fieldId }),
  detach: (projectId: string, fieldId: string) =>
    api.delete(`/projects/${projectId}/custom-fields/${fieldId}`),

  // Per-issue values
  listForIssue: (issueId: string) =>
    api.get<IssueCustomFieldValue[]>(`/issues/${issueId}/custom-fields`),
  setValue: (issueId: string, fieldId: string, value: Record<string, unknown> | null) =>
    api.put(`/issues/${issueId}/custom-fields/${fieldId}`, { value }),
};
