import { api } from "./client";

/**
 * Personal ("board") API keys. A board key authenticates HTTP calls AS the
 * signed-in user across all their companies — the same authorization they have
 * in the UI, including editing an agent's harness (skills, instructions).
 *
 * It is a BEARER credential: whoever holds the string acts as that user, so the
 * plaintext token is returned exactly once, at creation, and the server only
 * ever stores its hash. Revoke to cut off a holder.
 */
export type BoardApiKey = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
};

/** Creation response — the ONLY time the plaintext `token` is ever returned. */
export type BoardApiKeyWithToken = BoardApiKey & { token: string };

export const boardKeysApi = {
  list: (includeInactive = false) =>
    api.get<BoardApiKey[]>(`/board-api-keys${includeInactive ? "?includeInactive=true" : ""}`),

  create: (input: { name: string; expiresAt?: string | null }) =>
    api.post<BoardApiKeyWithToken>("/board-api-keys", input),

  revoke: (keyId: string) => api.delete<unknown>(`/board-api-keys/${keyId}`),
};
