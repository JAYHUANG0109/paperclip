export {};

import type { AgentApiKeyScope } from "@paperclipai/shared";

declare global {
  namespace Express {
    interface Request {
      actor: {
        type: "board" | "agent" | "none";
        userId?: string;
        userName?: string | null;
        userEmail?: string | null;
        agentId?: string;
        companyId?: string;
        companyIds?: string[];
        sessionId?: string | null;
        memberships?: Array<{
          companyId: string;
          membershipRole?: string | null;
          status?: string;
        }>;
        onBehalfOfMemberships?: Array<{
          companyId: string;
          membershipRole?: string | null;
          status?: string;
        }>;
        isInstanceAdmin?: boolean;
        keyId?: string;
        keyScope?: AgentApiKeyScope;
        runId?: string;
        onBehalfOfUserId?: string | null;
        source?: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "cloud_tenant" | "none";
        /**
         * Set only on a permitted "view as" request: every other field above
         * describes the VIEWED user, and this names who is really acting.
         *
         * It is provenance for the audit log, never authority — do not grant
         * anything on the strength of `realUserId`. See
         * server/src/services/view-as-policy.ts.
         */
        viewAs?: {
          realUserId: string;
          realUserEmail: string | null;
          viewingUserId: string;
        };
      };
    }
  }
}
