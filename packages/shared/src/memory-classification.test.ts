import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_CATEGORY,
  MEMORY_CATEGORY_IDS,
  MEMORY_CATEGORY_LABELS,
  isMemoryCategory,
  isReservedMemoryName,
  memoryStrength,
  normalizeMemoryCategory,
  normalizeMemoryForComparison,
  screenMemoryWrite,
} from "./memory-classification.js";

describe("memory categories", () => {
  it("keeps a value that is already a category", () => {
    for (const id of MEMORY_CATEGORY_IDS) {
      expect(normalizeMemoryCategory(id)).toBe(id);
    }
  });

  // Rows written before the set was closed still carry `user`. Losing them to
  // the default would silently re-file everyone's existing profile facts.
  it("maps the pre-taxonomy `user` type to profile", () => {
    expect(normalizeMemoryCategory("user")).toBe("profile");
  });

  it("absorbs the near-misses a writer actually produces", () => {
    expect(normalizeMemoryCategory("Preferences")).toBe("preference");
    expect(normalizeMemoryCategory("PREFERENCE")).toBe("preference");
    expect(normalizeMemoryCategory("  notes ")).toBe("project");
    expect(normalizeMemoryCategory("resources")).toBe("reference");
    expect(normalizeMemoryCategory("corrections")).toBe("feedback");
    expect(normalizeMemoryCategory("memory_type")).toBe(DEFAULT_MEMORY_CATEGORY);
  });

  // A bad label is not a reason to lose the memory.
  it("never throws on junk", () => {
    expect(normalizeMemoryCategory(undefined)).toBe(DEFAULT_MEMORY_CATEGORY);
    expect(normalizeMemoryCategory(null)).toBe(DEFAULT_MEMORY_CATEGORY);
    expect(normalizeMemoryCategory(42)).toBe(DEFAULT_MEMORY_CATEGORY);
    expect(normalizeMemoryCategory("")).toBe(DEFAULT_MEMORY_CATEGORY);
  });

  it("defaults to project rather than preference", () => {
    // An unlabelled fact is usually a note about the work. Filing it as a
    // preference would make an agent act on it.
    expect(DEFAULT_MEMORY_CATEGORY).toBe("project");
    expect(isMemoryCategory("preference")).toBe(true);
    expect(isMemoryCategory("nonsense")).toBe(false);
  });
});

describe("screening credentials", () => {
  const cases: Array<[string, string]> = [
    ["an OpenAI-style key", "their key is sk-abcdefghijklmnop0123"],
    ["a GitHub token", "token ghp_abcdefghijklmnopqrstuvwxyz0123"],
    ["an AWS access key", "AKIAIOSFODNN7EXAMPLE is the id"],
    ["a private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK"],
    ["a JWT", "bearer eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q"],
    ["a labelled password", "password: hunter2hunter2"],
    ["a labelled key in Chinese", "金鑰：abcdefgh12345678"],
  ];

  it.each(cases)("refuses %s from an agent", (_label, content) => {
    const verdict = screenMemoryWrite({ content, authoredBy: "agent" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.screenClass).toBe("credential");
  });

  // The asymmetry stops here. A stored secret is written to disk in a workspace
  // an agent reads, so it is a leak no matter who typed it.
  it.each(cases)("refuses %s from the owner too", (_label, content) => {
    expect(screenMemoryWrite({ content, authoredBy: "user" }).allowed).toBe(false);
  });

  it("lets prose about passwords through", () => {
    const verdict = screenMemoryWrite({
      content: "Prefers to reset a password rather than ask IT.",
      authoredBy: "agent",
    });
    expect(verdict.allowed).toBe(true);
  });
});

describe("screening personal categories", () => {
  const sensitive: Array<[string, string, string]> = [
    ["health", "health", "She was diagnosed with something last spring."],
    ["health in Chinese", "health", "他上週住院，需要調整排程"],
    ["financial", "financial", "Their salary is up for review in March."],
    ["financial in Chinese", "financial", "他的年薪需要保密"],
    ["a payment card", "financial", "card 4111 1111 1111 1111 on file"],
    ["a Taiwan ID", "government_id", "身分證 A123456789 for the form"],
    ["a US SSN", "government_id", "SSN 123-45-6789"],
  ];

  it.each(sensitive)("refuses %s from an agent", (_label, screenClass, content) => {
    const verdict = screenMemoryWrite({ content, authoredBy: "agent" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.screenClass).toBe(screenClass);
  });

  // The whole point of the split: an agent inferring a health detail about you
  // is not the same act as you choosing to record one, and admins can read this.
  it.each(sensitive)("lets the owner record %s about themselves", (_label, _class, content) => {
    expect(screenMemoryWrite({ content, authoredBy: "user" }).allowed).toBe(true);
  });

  it("does not treat a dietary preference as health", () => {
    // Perplexity stores exactly this, and it is a real working preference an
    // agent should be able to act on.
    const verdict = screenMemoryWrite({
      content: "Orders vegetarian for team lunches; allergic to peanuts.",
      authoredBy: "agent",
    });
    expect(verdict.allowed).toBe(true);
  });

  it("does not trip on an order number that is not a card", () => {
    expect(
      screenMemoryWrite({ content: "Order 1234 5678 9012 3456 shipped", authoredBy: "agent" }).allowed,
    ).toBe(true);
  });

  it("screens the name and description, not just the body", () => {
    const verdict = screenMemoryWrite({
      name: "her-diagnosis",
      description: "notes",
      content: "keeps mornings free",
      authoredBy: "agent",
    });
    expect(verdict.allowed).toBe(false);
  });

  // Base64 of a PNG has no prose to read, and imports are the owner's own files.
  it("skips binary entries", () => {
    expect(
      screenMemoryWrite({ content: "sk-aaaaaaaaaaaaaaaaaaaa", authoredBy: "agent", isBinary: true }).allowed,
    ).toBe(true);
  });
});

describe("duplicate comparison", () => {
  it("ignores case, spacing and trailing punctuation", () => {
    const a = normalizeMemoryForComparison("Prefers  Traditional Chinese.");
    const b = normalizeMemoryForComparison("prefers traditional chinese");
    expect(a).toBe(b);
  });

  it("ignores a trailing full-width stop", () => {
    expect(normalizeMemoryForComparison("偏好繁體中文。")).toBe(
      normalizeMemoryForComparison("偏好繁體中文"),
    );
  });

  // Exact-after-normalization on purpose: fuzzy matching would merge two facts
  // that differ in one important word.
  it("keeps genuinely different facts apart", () => {
    expect(normalizeMemoryForComparison("prefers zh-TW")).not.toBe(
      normalizeMemoryForComparison("prefers zh-CN"),
    );
  });
});

describe("the categories work memory actually needs", () => {
  // These two were carved out of `profile` and `preference`. If the words people
  // reach for still land in the old bucket, the split bought nothing.
  it("files what someone knows under expertise, not profile", () => {
    expect(normalizeMemoryCategory("skills")).toBe("expertise");
    expect(normalizeMemoryCategory("domain")).toBe("expertise");
    expect(normalizeMemoryCategory("ownership")).toBe("expertise");
  });

  it("files how work flows under workflow, not preference", () => {
    expect(normalizeMemoryCategory("process")).toBe("workflow");
    expect(normalizeMemoryCategory("cadence")).toBe("workflow");
    expect(normalizeMemoryCategory("tools")).toBe("workflow");
  });

  it("still files an unrecognised label under the default", () => {
    expect(normalizeMemoryCategory("something-nobody-defined")).toBe(DEFAULT_MEMORY_CATEGORY);
  });

  it("gives every category a label, so an untranslated key never shows an id", () => {
    for (const id of MEMORY_CATEGORY_IDS) {
      expect(MEMORY_CATEGORY_LABELS[id]).toBeTruthy();
      expect(MEMORY_CATEGORY_LABELS[id]).not.toBe(id);
    }
  });
});

describe("strength", () => {
  /**
   * Repetition is the signal, so this is the function that decides which facts
   * the owner is invited to look twice at.
   */
  it("starts at noted", () => {
    expect(memoryStrength(1)).toBe("noted");
  });

  it("reaches confirmed on a second, independent observation", () => {
    expect(memoryStrength(2)).toBe("confirmed");
    expect(memoryStrength(3)).toBe("confirmed");
  });

  it("reaches core once it keeps happening", () => {
    expect(memoryStrength(4)).toBe("core");
    expect(memoryStrength(40)).toBe("core");
  });

  // Rows predating the column, or any other oddity, must not throw.
  it("survives a nonsense count", () => {
    expect(memoryStrength(0)).toBe("noted");
    expect(memoryStrength(-1)).toBe("noted");
  });
});

describe("reserved names", () => {
  it("refuses the API's own sub-paths", () => {
    expect(isReservedMemoryName("stats")).toBe(true);
    expect(isReservedMemoryName("settings")).toBe(true);
    expect(isReservedMemoryName("deleted")).toBe(true);
  });

  it("is case- and whitespace-insensitive, since a name is a slug", () => {
    expect(isReservedMemoryName(" Settings ")).toBe(true);
  });

  // Reserving a word must not reserve every word containing it.
  it("allows a name that merely contains one", () => {
    expect(isReservedMemoryName("stats-dashboard")).toBe(false);
    expect(isReservedMemoryName("import-checklist")).toBe(false);
  });
});
