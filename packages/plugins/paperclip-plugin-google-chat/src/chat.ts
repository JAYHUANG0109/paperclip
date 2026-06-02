import type { FetchLike } from "./google-auth.js";

/** Normalised view of an inbound message event used by the worker. */
export interface InboundMessage {
  spaceName: string;
  /** Space type from the event ("DM", "ROOM", …) when present. Used to learn
   *  email→DM-space mappings only from genuine direct messages. */
  spaceType?: string;
  threadName?: string;
  text: string;
  senderDisplayName?: string;
  /** Sender's email — the routing key to a Paperclip user/agent. */
  senderEmail?: string;
  /** Sender's user resource name (e.g. "users/123456789"). Lets us re-discover
   *  the DM space later via spaces.findDirectMessage. */
  senderUserName?: string;
  /** Resource name of the message (e.g. spaces/X/messages/Y) — idempotency key. */
  messageName?: string;
}

interface ChatMessage {
  name?: string;
  text?: string;
  thread?: { name?: string };
  sender?: { displayName?: string; name?: string; email?: string };
}

/**
 * Extract the fields needed to reply, from either Chat event shape:
 *  - Workspace add-on format: `{ chat: { messagePayload: { space, message } } }`
 *  - Classic Chat format:     `{ type: "MESSAGE", space, message }`
 * Returns null when the event isn't a usable text message.
 */
export function extractInboundMessage(body: unknown): InboundMessage | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, any>;

  // Workspace add-on event format.
  const mp = root.chat?.messagePayload;
  if (mp?.space?.name && typeof mp?.message?.text === "string") {
    const message = mp.message as ChatMessage;
    return {
      spaceName: mp.space.name,
      spaceType: mp.space.type,
      threadName: message.thread?.name,
      text: message.text ?? "",
      senderDisplayName: message.sender?.displayName ?? root.chat?.user?.displayName,
      senderEmail: message.sender?.email ?? root.chat?.user?.email,
      senderUserName: message.sender?.name ?? root.chat?.user?.name,
      messageName: message.name
    };
  }

  // Classic Chat event format.
  if (root.type === "MESSAGE" && root.space?.name && typeof root.message?.text === "string") {
    const message = root.message as ChatMessage;
    return {
      spaceName: root.space.name,
      spaceType: root.space.type,
      threadName: message.thread?.name,
      text: message.text ?? "",
      senderDisplayName: message.sender?.displayName ?? root.user?.displayName,
      senderEmail: message.sender?.email ?? root.user?.email,
      senderUserName: message.sender?.name ?? root.user?.name,
      messageName: message.name
    };
  }

  return null;
}

/**
 * Post a text message to a Google Chat space via the REST API.
 * `spaceName` is the resource name from the inbound event, e.g. "spaces/AAAA".
 */
export async function sendMessage(
  fetchImpl: FetchLike,
  accessToken: string,
  params: { spaceName: string; text: string; threadName?: string }
): Promise<void> {
  const url = `https://chat.googleapis.com/v1/${params.spaceName}/messages`;
  const body: Record<string, unknown> = { text: params.text };
  if (params.threadName) {
    body.thread = { name: params.threadName };
  }
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Chat sendMessage failed (${res.status}): ${detail}`);
  }
}

/**
 * Find the existing direct-message space between the calling app and a user,
 * via `spaces.findDirectMessage`. `userName` is the user resource name
 * ("users/{id}"); with app auth the {id} must be numeric — an email alias only
 * works under user auth, so callers resolve emails to a learned space first.
 *
 * Returns the space resource name ("spaces/AAAA") if a DM exists, or null when
 * Google reports none yet (HTTP 404). An app cannot create the DM itself
 * (`spaces.setup` requires user auth), so a null means the user must message
 * the app first.
 */
export async function findDirectMessageSpace(
  fetchImpl: FetchLike,
  accessToken: string,
  userName: string
): Promise<string | null> {
  const url = `https://chat.googleapis.com/v1/spaces:findDirectMessage?name=${encodeURIComponent(userName)}`;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Chat findDirectMessage failed (${res.status}): ${detail}`);
  }
  const body = (await res.json()) as { name?: string };
  return body.name ?? null;
}
