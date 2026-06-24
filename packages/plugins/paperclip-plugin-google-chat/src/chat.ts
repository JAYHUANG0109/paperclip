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
  /** File attachments on the message (uploaded files and/or Drive links). */
  attachments?: InboundAttachment[];
}

/** Normalised attachment reference from a Chat message. */
export interface InboundAttachment {
  contentName?: string;
  contentType?: string;
  /** For uploaded files: the media resource name to download via the Chat API. */
  resourceName?: string;
  /** For Drive-shared files: the Drive file id (not downloaded here). */
  driveFileId?: string;
}

interface ChatMessage {
  name?: string;
  text?: string;
  thread?: { name?: string };
  sender?: { displayName?: string; name?: string; email?: string };
  attachment?: unknown;
  attachments?: unknown;
}

/** Normalise the Chat message `attachment`/`attachments` list into our shape. */
function parseAttachments(message: ChatMessage): InboundAttachment[] {
  const raw = message.attachment ?? message.attachments;
  if (!Array.isArray(raw)) return [];
  const out: InboundAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, any>;
    out.push({
      contentName: typeof a.contentName === "string" ? a.contentName : undefined,
      contentType: typeof a.contentType === "string" ? a.contentType : undefined,
      resourceName:
        typeof a.attachmentDataRef?.resourceName === "string"
          ? a.attachmentDataRef.resourceName
          : undefined,
      driveFileId:
        typeof a.driveDataRef?.driveFileId === "string" ? a.driveDataRef.driveFileId : undefined
    });
  }
  return out;
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

  // Workspace add-on event format. Accept the message if it has text OR an
  // attachment (an attachment-only upload has no text and must not be dropped).
  const mp = root.chat?.messagePayload;
  if (mp?.space?.name && mp?.message) {
    const message = mp.message as ChatMessage;
    const attachments = parseAttachments(message);
    if (typeof message.text === "string" || attachments.length > 0) {
      return {
        spaceName: mp.space.name,
        spaceType: mp.space.type,
        threadName: message.thread?.name,
        text: message.text ?? "",
        senderDisplayName: message.sender?.displayName ?? root.chat?.user?.displayName,
        senderEmail: message.sender?.email ?? root.chat?.user?.email,
        senderUserName: message.sender?.name ?? root.chat?.user?.name,
        messageName: message.name,
        attachments
      };
    }
  }

  // Classic Chat event format.
  if (root.type === "MESSAGE" && root.space?.name && root.message) {
    const message = root.message as ChatMessage;
    const attachments = parseAttachments(message);
    if (typeof message.text === "string" || attachments.length > 0) {
      return {
        spaceName: root.space.name,
        spaceType: root.space.type,
        threadName: message.thread?.name,
        text: message.text ?? "",
        senderDisplayName: message.sender?.displayName ?? root.user?.displayName,
        senderEmail: message.sender?.email ?? root.user?.email,
        senderUserName: message.sender?.name ?? root.user?.name,
        messageName: message.name,
        attachments
      };
    }
  }

  return null;
}

/**
 * Download an uploaded Chat attachment's bytes via the media endpoint.
 * `resourceName` comes from `attachment.attachmentDataRef.resourceName`.
 */
export async function downloadChatAttachment(
  fetchImpl: FetchLike,
  accessToken: string,
  resourceName: string
): Promise<Buffer> {
  const url = `https://chat.googleapis.com/v1/media/${encodeURI(resourceName)}?alt=media`;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Chat media download failed (${res.status}): ${detail}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Pull markdown image syntax (`![alt](https://…)`) out of a reply. Google Chat
 * can't render markdown images in text, so we surface the FIRST image as a
 * cardsV2 image widget and strip all image markdown from the remaining text.
 * Google fetches the imageUrl server-side, so it must be a public https URL.
 */
export function splitFirstImage(markdown: string): {
  text: string;
  imageUrl?: string;
  imageAltText?: string;
} {
  const re = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
  let first: { url: string; alt: string } | undefined;
  const stripped = markdown.replace(re, (_m, alt: string, url: string) => {
    if (!first) first = { url, alt };
    return "";
  });
  if (!first) return { text: markdown };
  const text = stripped.replace(/\n{3,}/g, "\n\n").trim();
  return { text, imageUrl: first.url, imageAltText: first.alt || "image" };
}

/**
 * Post a message to a Google Chat space via the REST API. Sends `text` and/or a
 * single `imageUrl` (rendered as a cardsV2 image widget — Google fetches the URL
 * server-side, so it must be publicly reachable).
 * `spaceName` is the resource name from the inbound event, e.g. "spaces/AAAA".
 */
export async function sendMessage(
  fetchImpl: FetchLike,
  accessToken: string,
  params: {
    spaceName: string;
    text?: string;
    threadName?: string;
    imageUrl?: string;
    imageAltText?: string;
  }
): Promise<void> {
  const url = `https://chat.googleapis.com/v1/${params.spaceName}/messages`;
  const body: Record<string, unknown> = {};
  if (params.text && params.text.length > 0) {
    body.text = params.text;
  }
  if (params.imageUrl) {
    body.cardsV2 = [
      {
        cardId: "image",
        card: {
          sections: [
            {
              widgets: [
                {
                  image: {
                    imageUrl: params.imageUrl,
                    altText: params.imageAltText ?? "image",
                    // Click opens the full-resolution image in a new tab — Chat
                    // image widgets have no built-in lightbox, so this is how a
                    // user gets a bigger view.
                    onClick: { openLink: { url: params.imageUrl } }
                  }
                }
              ]
            }
          ]
        }
      }
    ];
  }
  // A Chat message must carry content; fall back to (possibly empty) text.
  if (body.text === undefined && body.cardsV2 === undefined) {
    body.text = params.text ?? "";
  }
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
