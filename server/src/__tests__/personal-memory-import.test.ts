import { describe, expect, it } from "vitest";
import { MEMORY_CATEGORY_IDS } from "@paperclipai/shared";
import {
  MAX_MEMORY_FILE_BYTES,
  decodeUploadPath,
  memoryNameFromPath,
  parseFrontmatter,
  parseMemoryUpload,
  parseMemoryUploads,
  safeUploadPath,
} from "../services/personal-memory-import.js";

const upload = (relativePath: string, content = "hello") => ({
  relativePath,
  content: Buffer.from(content, "utf8"),
});

// Import is where filesystem-shaped input is most directly attacker
// controlled: a folder upload sends a relative path per file, chosen by
// whoever is uploading.
describe("safeUploadPath", () => {
  it("accepts a nested path", () => {
    expect(safeUploadPath("notes/reading.md")).toBe("notes/reading.md");
  });

  it("normalizes backslashes and drops '.' segments", () => {
    expect(safeUploadPath("notes\\./reading.md")).toBe("notes/reading.md");
  });

  it.each([
    ["parent traversal", "../escape.md"],
    ["nested traversal", "notes/../../escape.md"],
    ["absolute", "/etc/passwd"],
    ["windows drive", "C:/Windows/system32"],
    ["NUL byte", "notes/read\0.md"],
    ["empty", "   "],
    ["only separators", "///"],
  ])("rejects %s", (_label, candidate) => {
    expect(safeUploadPath(candidate)).toBeNull();
  });

  // .git/ in particular would drag a repository's internals into a personal
  // store, including anything staged in it.
  it("rejects dotfiles and dot-directories", () => {
    expect(safeUploadPath(".env")).toBeNull();
    expect(safeUploadPath(".git/config")).toBeNull();
    expect(safeUploadPath("notes/.ssh/id_rsa")).toBeNull();
  });

  it("rejects rather than sanitizing a climbing path", () => {
    expect(safeUploadPath("../../../../x.md")).toBeNull();
  });
});

describe("decodeUploadPath", () => {
  // This deployment's filenames are largely Chinese, and multer decodes
  // Content-Disposition as latin1.
  it("repairs a UTF-8 name that arrived as latin1 mojibake", () => {
    const mojibake = Buffer.from("筆記.md", "utf8").toString("latin1");

    expect(decodeUploadPath(mojibake)).toBe("筆記.md");
  });

  it("leaves ASCII untouched", () => {
    expect(decodeUploadPath("notes.md")).toBe("notes.md");
  });

  it("keeps the original when re-decoding would produce replacement chars", () => {
    expect(decodeUploadPath("caf\u00e9.md")).toBe("caf\u00e9.md");
  });
});

describe("memoryNameFromPath", () => {
  it("slugs a nested path", () => {
    expect(memoryNameFromPath("notes/Deep Thoughts.md")).toBe("notes-deep-thoughts");
  });

  it("drops the extension", () => {
    expect(memoryNameFromPath("reading.md")).toBe("reading");
  });

  it("keeps non-latin characters rather than emptying the slug", () => {
    expect(memoryNameFromPath("筆記.md")).toBe("筆記");
  });

  it("never returns an empty name", () => {
    expect(memoryNameFromPath("---.md")).toBe("memory");
  });
});

describe("parseFrontmatter", () => {
  it("reads a Paperclip-exported memory back", () => {
    const { frontmatter, body } = parseFrontmatter(
      ["---", "name: likes-dark-mode", "description: Prefers dark mode", "metadata:", "  type: user", "---", "", "Body text."].join("\n"),
    );

    expect(frontmatter).toMatchObject({
      name: "likes-dark-mode",
      description: "Prefers dark mode",
      type: "user",
    });
    expect(body.trim()).toBe("Body text.");
  });

  it("returns the whole text when there is no frontmatter", () => {
    expect(parseFrontmatter("Just prose.")).toEqual({ frontmatter: {}, body: "Just prose." });
  });

  it("returns the whole text when the block is never closed", () => {
    const text = "---\nname: x\nstill going";

    expect(parseFrontmatter(text).body).toBe(text);
  });
});

describe("parseMemoryUpload", () => {
  it("parses a markdown file", () => {
    expect(parseMemoryUpload(upload("notes/reading.md", "Read more."))).toMatchObject({
      name: "notes-reading",
      content: "Read more.",
      isBinary: false,
      filePath: "notes/reading.md",
      memoryType: "project",
    });
  });

  it("prefers frontmatter over the filename", () => {
    const parsed = parseMemoryUpload(
      upload("whatever.md", ["---", "name: real-name", "description: d", "metadata:", "  type: feedback", "---", "", "Body"].join("\n")),
    );

    expect(parsed).toMatchObject({ name: "real-name", description: "d", memoryType: "feedback" });
  });

  it("falls back to a known type when frontmatter declares an unknown one", () => {
    const parsed = parseMemoryUpload(upload("x.md", ["---", "metadata:", "  type: nonsense", "---", "", "B"].join("\n")));

    expect(parsed).toMatchObject({ memoryType: "project" });
  });

  it("stores a non-text file as base64", () => {
    const parsed = parseMemoryUpload({ relativePath: "assets/logo.png", content: Buffer.from([1, 2, 3]) });

    expect(parsed).toMatchObject({ isBinary: true, content: Buffer.from([1, 2, 3]).toString("base64") });
  });

  // Skips are returned so the caller can report them. Silently dropping files
  // reads as "imported everything" when it did not.
  it("skips an unsafe path with a reason", () => {
    expect(parseMemoryUpload(upload("../escape.md"))).toEqual({
      relativePath: "../escape.md",
      reason: "unsafe or unusable path",
    });
  });

  it("skips an empty file", () => {
    expect(parseMemoryUpload({ relativePath: "x.md", content: Buffer.alloc(0) })).toMatchObject({
      reason: "empty file",
    });
  });

  it("skips a file over the size ceiling", () => {
    const big = { relativePath: "x.md", content: Buffer.alloc(MAX_MEMORY_FILE_BYTES + 1, 0x61) };

    expect(parseMemoryUpload(big)).toMatchObject({ reason: expect.stringContaining("larger than") });
  });

  it("accepts a file exactly at the ceiling", () => {
    const atLimit = { relativePath: "x.md", content: Buffer.alloc(MAX_MEMORY_FILE_BYTES, 0x61) };

    expect(parseMemoryUpload(atLimit)).not.toHaveProperty("reason");
  });
});

describe("parseMemoryUploads", () => {
  it("parses a batch and reports what it skipped", () => {
    const result = parseMemoryUploads([upload("a.md"), upload("../bad.md"), upload("b.md")]);

    expect(result.memories.map((m) => m.name)).toEqual(["a", "b"]);
    expect(result.skipped).toEqual([{ relativePath: "../bad.md", reason: "unsafe or unusable path" }]);
  });

  // Two files named notes.md in different folders are two memories, not one.
  // Names are unique per owner in the DB, so a collision must not let one file
  // silently overwrite another.
  it("de-duplicates colliding names instead of dropping a file", () => {
    const result = parseMemoryUploads([upload("notes.md"), upload("notes.md"), upload("notes.md")]);

    expect(result.memories.map((m) => m.name)).toEqual(["notes", "notes-2", "notes-3"]);
    expect(result.memories.every((m) => m.content === "hello")).toBe(true);
  });

  it("keeps distinct paths for de-duplicated names", () => {
    const result = parseMemoryUploads([upload("a/notes.md"), upload("b/notes.md")]);

    expect(result.memories.map((m) => m.filePath)).toEqual(["a/notes.md", "b/notes.md"]);
  });

  it("returns empty results for an empty batch", () => {
    expect(parseMemoryUploads([])).toEqual({ memories: [], skipped: [] });
  });
});

describe("what the importer accepts", () => {
  const parse = (relativePath: string, content: string) =>
    parseMemoryUpload({ relativePath, content: Buffer.from(content, "utf8") });

  /**
   * The importer used to carry its own hardcoded category set, which went stale
   * the moment the taxonomy grew: a file declaring `type: preference` imported
   * as `project`, silently. It now defers to the shared normalizer, so the two
   * cannot drift again.
   */
  it("honours every category the write gate accepts", () => {
    for (const id of MEMORY_CATEGORY_IDS) {
      const parsed = parse("note.md", ["---", `type: ${id}`, "---", "", "body"].join("\n"));
      expect("memoryType" in parsed && parsed.memoryType).toBe(id);
    }
  });

  it("maps a legacy declared type forward rather than dropping it", () => {
    const parsed = parse("note.md", ["---", "type: user", "---", "", "body"].join("\n"));

    expect("memoryType" in parsed && parsed.memoryType).toBe("profile");
  });

  // Markdown with frontmatter — the same shape as a memory file, and the most
  // likely thing dragged in from a skill folder. Stored as binary it would
  // never reach the MEMORY.md index and no agent would learn it exists.
  it("treats a .skill file as text", () => {
    const parsed = parse("writing.skill", ["---", "name: writing", "---", "", "How to write."].join("\n"));

    expect("isBinary" in parsed && parsed.isBinary).toBe(false);
    expect("content" in parsed && parsed.content).toContain("How to write.");
  });

  /**
   * Nothing here unpacks an archive, so storing one produces a base64 blob that
   * is counted as imported and is unreadable to the agent it was uploaded for.
   * A refusal naming the working alternative beats a success that is not one.
   */
  it("refuses an archive and says what to do instead", () => {
    const parsed = parse("memories.zip", "PK-binary-ish");

    expect("reason" in parsed && parsed.reason).toContain("Import folder");
  });

  it("still stores a real binary, so a PDF or an image round-trips", () => {
    const parsed = parseMemoryUpload({
      relativePath: "diagram.png",
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });

    expect("isBinary" in parsed && parsed.isBinary).toBe(true);
    expect("filePath" in parsed && parsed.filePath).toBe("diagram.png");
  });
});
