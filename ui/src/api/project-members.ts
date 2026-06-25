import { api } from "./client";

export type ProjectMemberRole = "admin" | "editor" | "commenter" | "viewer";

export interface ProjectMember {
  id: string;
  companyId: string;
  projectId: string;
  principalType: "user" | "agent";
  principalId: string;
  projectRole: ProjectMemberRole;
  createdAt: string;
  updatedAt: string;
}

export const projectMembersApi = {
  list: (projectId: string) =>
    api.get<ProjectMember[]>(`/projects/${projectId}/members`),
  add: (
    projectId: string,
    data: { principalType: "user" | "agent"; principalId: string; projectRole?: ProjectMemberRole },
  ) => api.post<ProjectMember>(`/projects/${projectId}/members`, data),
  update: (projectId: string, principalType: string, principalId: string, projectRole: ProjectMemberRole) =>
    api.patch<ProjectMember>(`/projects/${projectId}/members/${principalType}/${principalId}`, { projectRole }),
  remove: (projectId: string, principalType: string, principalId: string) =>
    api.delete<ProjectMember>(`/projects/${projectId}/members/${principalType}/${principalId}`),
};
