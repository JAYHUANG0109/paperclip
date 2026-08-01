/**
 * Parsing uploaded files into memory rows — PURE.
 *
 * Import is where the filesystem-shaped inputs are most directly attacker
 * controlled: a folder upload sends a relative path per file, chosen by
 * whoever is uploading. `safeMemoryRelativePath` already refuses anything that
 * escapes the owner's directory; this module refuses at the door too, so a bad
 * path never becomes a row in the first place and cannot sit in the DB waiting
 * for a future materializer to be less careful.
 *
 * Skips are RETURNED, never swallowed. An importer that silently drops files
 * reads as "imported everything" when it did not.
 */

/** Extensions stored as UTF-8 text. Everything else is base64 (`is_binary`). */
const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".text", ".json", ".yaml", ".yml", ".csv", ".tsv",
  ".log", ".html", ".htm", ".xml", ".rst", ".org", ".ini", ".toml", ".env",
]);

/** Per-file ceiling. Memory is prose, not a media library. */
export const MAX_MEMORY_FILE_BYTES = 1024 * 1024;

export type MemoryUpload = {
  /** Path within the uploaded folder, or a bare filename. */
  relativePath: string;
  content: Buffer;
};

export type ParsedMemory = {
  name: string;
  description: string;
  memoryType: string;
  content: string;
  isBinary: boolean;
  filePath: string;
};

export type SkippedMemory = { relativePath: string; reason: string };

export type ImportParseResult = {
  memories: ParsedMemory[];
  skipped: SkippedMemory[];
};

/**
 * Repair a multipart filename. multer/busboy decode Content-Disposition as
 * latin1, so a UTF-8 name (Chinese, in this deployment) arrives as mojibake.
 * Re-reading the same bytes as UTF-8 restores it; on any decode failure, or if
 * the re-decode introduces U+FFFD, the original is kept.
 *
 * Mirrors `decodeMultipartFilename` in routes/issues.ts — same bug, same fix.
 */
export function decodeUploadPath(name: string): string {
  try {
    const repaired = Buffer.from(name, "latin1").toString("utf8");
    return repaired.includes("�") ? name : repaired;
  } catch {
    return name;
  }
}

/**
 * Confine an uploaded relative path. Rejects rather than sanitizes: a path that
 * tried to climb is not one whose corrected form should be trusted.
 *
 * Kept separate from the materializer's copy on purpose — this one also drops
 * the leading folder segment browsers prepend, and rejects dotfiles, neither of
 * which the materializer should do to already-stored rows.
 */
export function safeUploadPath(rawPath: string): string | null {
  const candidate = decodeUploadPath(rawPath).trim().replace(/\\/g, "/");
  if (!candidate) return null;
  if (candidate.includes("\0")) return null;
  if (candidate.startsWith("/")) return null;
  if (/^[a-zA-Z]:/.test(candidate)) return null;

  const segments = candidate.split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "..")) return null;
  // Dotfiles are config, not memory, and .git/ in particular would drag a
  // repository's internals into someone's personal store.
  if (segments.some((segment) => segment.startsWith("."))) return null;

  return segments.join("/");
}

/** Stable kebab-case slug from a path, unique-ish and filesystem-safe. */
export function memoryNameFromPath(relativePath: string): string {
  const withoutExtension = relativePath.replace(/\.[^./]+$/, "");
  const slug = withoutExtension
    .split("/")
    .join("-")
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "memory";
}

function isTextPath(relativePath: string): boolean {
  const match = /\.[^./]+$/.exec(relativePath);
  return match ? TEXT_EXTENSIONS.has(match[0].toLowerCase()) : false;
}

/**
 * Read the frontmatter block a memory file may carry, so a store exported from
 * Paperclip round-trips with its name, description and type intact.
 *
 * Deliberately minimal — `key: value` at one level plus `metadata.type`. A full
 * YAML parser on uploaded input is a dependency and an attack surface this does
 * not need.
 */
export function parseFrontmatter(text: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  if (!text.startsWith("---")) return { frontmatter: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: text };

  const block = text.slice(text.indexOf("\n") + 1, end);
  const frontmatter: Record<string, string> = {};
  let inMetadata = false;

  for (const line of block.split("\n")) {
    if (!line.trim()) continue;
    const indented = /^\s+/.test(line);
    const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim();

    if (!indented) {
      inMetadata = key === "metadata" && value === "";
      if (!inMetadata) frontmatter[key] = value;
      continue;
    }
    if (inMetadata && key === "type") frontmatter.type = value;
  }

  const bodyStart = text.indexOf("\n", end + 1);
  return { frontmatter, body: bodyStart === -1 ? "" : text.slice(bodyStart + 1) };
}

const KNOWN_TYPES = new Set(["user", "feedback", "project", "reference"]);

/** Parse one upload. Returns null with a reason when it must not be stored. */
export function parseMemoryUpload(upload: MemoryUpload): ParsedMemory | SkippedMemory {
  const filePath = safeUploadPath(upload.relativePath);
  if (!filePath) {
    return { relativePath: upload.relativePath, reason: "unsafe or unusable path" };
  }
  if (upload.content.byteLength === 0) {
    return { relativePath: filePath, reason: "empty file" };
  }
  if (upload.content.byteLength > MAX_MEMORY_FILE_BYTES) {
    return {
      relativePath: filePath,
      reason: `larger than ${Math.round(MAX_MEMORY_FILE_BYTES / 1024)}KB`,
    };
  }

  if (!isTextPath(filePath)) {
    return {
      name: memoryNameFromPath(filePath),
      description: "",
      memoryType: "reference",
      content: upload.content.toString("base64"),
      isBinary: true,
      filePath,
    };
  }

  const text = upload.content.toString("utf8");
  const { frontmatter, body } = parseFrontmatter(text);
  const declaredType = frontmatter.type?.trim().toLowerCase();

  return {
    name: frontmatter.name?.trim() || memoryNameFromPath(filePath),
    description: frontmatter.description?.trim() ?? "",
    memoryType: declaredType && KNOWN_TYPES.has(declaredType) ? declaredType : "project",
    content: body,
    isBinary: false,
    filePath,
  };
}

function isSkipped(value: ParsedMemory | SkippedMemory): value is SkippedMemory {
  return "reason" in value;
}

/**
 * Parse a whole upload batch.
 *
 * Names must be unique per owner (the DB enforces it), so a collision is
 * de-duplicated by appending a counter rather than letting one file silently
 * overwrite another — two files named `notes.md` in different folders are two
 * memories, not one.
 */
export function parseMemoryUploads(uploads: readonly MemoryUpload[]): ImportParseResult {
  const memories: ParsedMemory[] = [];
  const skipped: SkippedMemory[] = [];
  const usedNames = new Set<string>();

  for (const upload of uploads) {
    const parsed = parseMemoryUpload(upload);
    if (isSkipped(parsed)) {
      skipped.push(parsed);
      continue;
    }

    let name = parsed.name;
    let counter = 2;
    while (usedNames.has(name)) name = `${parsed.name}-${counter++}`;
    usedNames.add(name);

    memories.push({ ...parsed, name });
  }

  return { memories, skipped };
}
