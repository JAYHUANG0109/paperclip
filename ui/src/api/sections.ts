import { api } from "./client";

export interface ProjectSection {
  id: string;
  companyId: string;
  projectId: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export const sectionsApi = {
  list: (projectId: string, companyId: string) =>
    api.get<ProjectSection[]>(`/projects/${projectId}/sections?companyId=${encodeURIComponent(companyId)}`),
  listForCompany: (companyId: string) =>
    api.get<ProjectSection[]>(`/companies/${companyId}/sections`),
  create: (companyId: string, data: { projectId: string; name: string; position?: number }) =>
    api.post<ProjectSection>(`/companies/${companyId}/sections`, data),
  update: (sectionId: string, data: { name?: string; position?: number }) =>
    api.patch<ProjectSection>(`/sections/${sectionId}`, data),
  remove: (sectionId: string) => api.delete<ProjectSection>(`/sections/${sectionId}`),
};
