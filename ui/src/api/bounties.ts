import { api } from "./client";

export type BountyStatus = "open" | "claimed" | "done" | "cancelled";

export interface Bounty {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  estimatedMinutes: number;
  status: BountyStatus;
  postedByUserId: string | null;
  postedByName: string | null;
  claimedByUserId: string | null;
  claimedByName: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  linkedSkillId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const bountiesApi = {
  list: (companyId: string) => api.get<Bounty[]>(`/companies/${companyId}/bounties`),
  create: (companyId: string, data: { title: string; description?: string; estimatedMinutes?: number }) =>
    api.post<Bounty>(`/companies/${companyId}/bounties`, data),
  claim: (companyId: string, bountyId: string) =>
    api.post<Bounty>(`/companies/${companyId}/bounties/${bountyId}/claim`, {}),
  complete: (companyId: string, bountyId: string, linkedSkillId?: string) =>
    api.post<Bounty>(`/companies/${companyId}/bounties/${bountyId}/complete`, { linkedSkillId }),
  remove: (companyId: string, bountyId: string) =>
    api.delete<Bounty>(`/companies/${companyId}/bounties/${bountyId}`),
};
