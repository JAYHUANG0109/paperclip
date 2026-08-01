/**
 * Who may read and write a user's personal memory — the PURE decision
 * primitive. Mirrors the shape of plugin-llm-wiki's `spaceScopeVisible` and
 * `agent-ownership-policy`: no I/O, exhaustively unit-tested, and the only
 * place the rule is stated.
 *
 * ─── The rule ───
 *
 * Personal memory belongs to ONE user. It is reachable by that user, and by the
 * agents MAPPED to that user — their `agent_memberships` rows. Admins may read
 * it. Nobody else, ever.
 *
 * ─── The part that is easy to get wrong ───
 *
 * An agent's access follows the agent's OWN mapped user, never whoever
 * triggered the run. If a campus head opens a campus member's agent, that agent
 * still reads the MEMBER's memory — not the campus head's, and not a union of
 * the two. The acting user is not an input to this decision at all, which is
 * why `MemoryRequester` has no field for it: the type makes the mistake
 * unrepresentable rather than merely discouraged.
 *
 * Concretely: do not pass `req.actor.userId` here for an agent-authenticated
 * request. Resolve the agent's mapped user from `agent_memberships` and pass
 * that. An admin with full access driving someone else's agent must not leak
 * their own memory into it, and must not read the agent's owner's memory
 * *through* the agent either — they read it as an admin, auditably, or not at
 * all.
 *
 * ─── Ambiguity fails closed ───
 *
 * `agent_memberships` is many-to-many, so an agent CAN be mapped to several
 * users. There is then no unambiguous "its user", and picking one would quietly
 * expose one person's memory to another person's agent. Such an agent gets no
 * personal memory at all. On the live instance every agent maps to exactly one
 * user, so this costs nothing today and closes the leak if that ever changes.
 *
 * ─── Admins read, they do not write ───
 *
 * The stated requirement is that an admin can SEE personal memory. Writing was
 * never asked for, and an admin editing someone's memory would silently change
 * how that person's agent behaves. So admin access stops at read.
 */

export type MemoryRequester =
  | {
      kind: "user";
      /** The signed-in user. */
      userId: string;
      /** Company owner/admin or instance admin. */
      isAdmin?: boolean;
    }
  | {
      kind: "agent";
      agentId: string;
      /**
       * The user this agent is mapped to, resolved from `agent_memberships`.
       *
       * `null` when the agent has no mapping OR maps to more than one user —
       * both are "no unambiguous owner", and both fail closed. Deliberately
       * NOT the user who triggered the run.
       */
      mappedUserId: string | null;
    };

export type MemoryOwner = {
  /** The user whose memory this is. */
  ownerUserId: string;
};

/**
 * Resolve an agent's mapped user from its membership rows, failing closed when
 * the answer is not unique.
 *
 * Kept here, beside the rule it feeds, so callers cannot accidentally
 * substitute "the acting user" for "the agent's user".
 */
export function resolveAgentMappedUserId(
  memberships: ReadonlyArray<{ agentId: string; userId: string; state?: string }>,
  agentId: string,
): string | null {
  const joined = memberships.filter(
    (row) => row.agentId === agentId && (row.state === undefined || row.state === "joined"),
  );
  const distinct = new Set(joined.map((row) => row.userId));
  if (distinct.size !== 1) return null; // none, or ambiguous → no memory
  return [...distinct][0];
}

/** May this requester READ the owner's personal memory? */
export function canReadPersonalMemory(owner: MemoryOwner, requester: MemoryRequester): boolean {
  if (!owner.ownerUserId) return false;
  if (requester.kind === "user") {
    if (requester.userId === owner.ownerUserId) return true;
    return requester.isAdmin === true;
  }
  // Agent: its own mapped user only. No admin escape hatch — an agent is not
  // an admin, and an admin driving it does not make it one.
  return !!requester.mappedUserId && requester.mappedUserId === owner.ownerUserId;
}

/** May this requester WRITE (create/update/delete) the owner's memory? */
export function canWritePersonalMemory(owner: MemoryOwner, requester: MemoryRequester): boolean {
  if (!owner.ownerUserId) return false;
  if (requester.kind === "user") {
    // Owner only. An admin may read but not rewrite how someone's agent thinks.
    return requester.userId === owner.ownerUserId;
  }
  return !!requester.mappedUserId && requester.mappedUserId === owner.ownerUserId;
}

/**
 * The set of owners whose memory this requester may read — the list form, for
 * building queries without re-implementing the rule in SQL.
 *
 * Returns `null` to mean "no restriction" (an admin), which callers must handle
 * explicitly rather than treating an empty array as unrestricted.
 */
export function readableMemoryOwnerIds(requester: MemoryRequester): string[] | null {
  if (requester.kind === "user") {
    return requester.isAdmin === true ? null : [requester.userId];
  }
  return requester.mappedUserId ? [requester.mappedUserId] : [];
}
