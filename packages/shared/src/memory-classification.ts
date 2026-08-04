/**
 * What may be remembered, and under what heading — PURE.
 *
 * Personal memory started as free-form text with a free-text `memory_type`, and
 * a line in the agent prompt asking for restraint. A prompt is a request, not a
 * rule: it explains what *should* happen and enforces nothing. This module is
 * the rule. Every write goes through it, whoever is writing.
 *
 * Two jobs:
 *
 *  1. CATEGORY — a closed set, so memory is filterable rather than a pile.
 *  2. SCREENING — what may not be stored at all.
 *
 * ─── Why the screen is asymmetric ───
 *
 * The classes below split by WHO IS WRITING, and the split is the whole design:
 *
 *   • Credentials are refused from everyone. A memory is materialized to disk
 *     in a workspace an agent reads, so a stored secret is a leaked secret. That
 *     is a security property and nobody gets to opt out of it.
 *
 *   • Health, finances and government identifiers are refused from AGENTS and
 *     allowed from the OWNER. The difference is consent. When you type a fact
 *     about yourself you have chosen to record it; when an agent infers one from
 *     something you said in passing, you have not. Admins can read personal
 *     memory, so an agent filing "seems to be going through a divorce" discloses
 *     to your management something you never offered.
 *
 * That is deliberately stricter than the person themselves, and deliberately
 * looser than a blanket ban. Perplexity draws the same line and drops these
 * categories however often they come up.
 *
 * ─── Why patterns and not a classifier ───
 *
 * A model asked "is this sensitive?" is another prompt, and would inherit the
 * exact failure this module exists to fix. Patterns are dumb and miss things —
 * they are a floor, not a guarantee — but they are the same on every run and
 * can be tested. The prompt still asks for judgement; this catches what slips.
 *
 * When it is wrong it should be wrong in the safe direction: a refused write
 * costs a fact, an accepted one can cost a confidence.
 */

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * The closed set.
 *
 * Deliberately shaped around WORK, because that is what this memory is for.
 * Perplexity's own buckets — dietary restrictions, hobbies, shopping interests —
 * are tailored just as tightly to consumer search; copying their labels would
 * give us a taxonomy where almost everything a colleague needs to remember lands
 * in "personal details". These are the seven kinds of thing that actually recur
 * in a run, each phrased so an agent can tell in one read whether a fact belongs
 * to it.
 *
 * Still small enough to hold in your head. A taxonomy nobody can recite gets
 * used as a dumping ground, and every entry lands in whichever bucket was listed
 * first — which is why `preference` leads. How a person wants things done is
 * what an agent would otherwise re-learn every single run, so it is both the
 * most valuable bucket and the safest default to bias toward.
 */
export const MEMORY_CATEGORIES = [
  {
    id: "preference",
    /** How this person wants things done. */
    label: "Preference",
    hint: "Working style, formats, tone, language, hours — how they like things done.",
  },
  {
    id: "profile",
    /** Durable facts about who they are. */
    label: "About me",
    hint: "Role, campus, team, languages spoken — stable facts about them.",
  },
  {
    id: "expertise",
    /** What they know well, and what they are the go-to for. */
    label: "Expertise",
    hint: "What they know deeply, what they own, and what they are asked for by name.",
  },
  {
    id: "project",
    /** Ongoing work and its constraints. */
    label: "Project",
    hint: "Ongoing work, goals, deadlines and constraints not derivable from the tools.",
  },
  {
    id: "workflow",
    /** The machinery around the work: cadence, tools, the route a thing takes. */
    label: "How we work",
    hint: "Recurring cadences, the tools and systems they use, and the steps a piece of work goes through.",
  },
  {
    id: "feedback",
    /** Corrections and confirmed approaches, with the reason. */
    label: "Feedback",
    hint: "Corrections they gave, and approaches they confirmed — include why.",
  },
  {
    id: "reference",
    /** Pointers outward. */
    label: "Reference",
    hint: "Links, dashboards, documents and tickets worth coming back to.",
  },
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]["id"];

export const MEMORY_CATEGORY_IDS: readonly MemoryCategory[] = MEMORY_CATEGORIES.map((c) => c.id);

/**
 * English fallbacks. The UI translates these, but a default that reads as a
 * label rather than as an identifier means an untranslated key degrades to
 * "Preference" instead of "preference".
 */
export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = Object.fromEntries(
  MEMORY_CATEGORIES.map((category) => [category.id, category.label]),
) as Record<MemoryCategory, string>;

/**
 * Where anything unrecognised lands.
 *
 * `project` rather than `preference`: an unlabelled fact is far more often a
 * note about the work than a standing instruction, and mis-filing something as
 * a preference makes an agent act on it.
 */
export const DEFAULT_MEMORY_CATEGORY: MemoryCategory = "project";

/**
 * Older values and near-misses, mapped forward.
 *
 * `user` is here because it was the original name for `profile` and rows
 * written before this module exists still carry it. The rest are what a model
 * or a person reaches for when guessing at the set.
 */
const CATEGORY_ALIASES: Record<string, MemoryCategory> = {
  user: "profile",
  person: "profile",
  personal: "profile",
  identity: "profile",
  about: "profile",
  preferences: "preference",
  pref: "preference",
  prefs: "preference",
  style: "preference",
  setting: "preference",
  settings: "preference",
  correction: "feedback",
  corrections: "feedback",
  guidance: "feedback",
  instruction: "feedback",
  instructions: "feedback",
  projects: "project",
  work: "project",
  task: "project",
  context: "project",
  note: "project",
  notes: "project",
  references: "reference",
  resource: "reference",
  resources: "reference",
  link: "reference",
  links: "reference",
  doc: "reference",
  docs: "reference",
  // `expertise` and `workflow` were carved out of `profile` and `preference`
  // respectively, so the words people previously used for them point at the new
  // bucket rather than the one they used to be filed under.
  skill: "expertise",
  skills: "expertise",
  domain: "expertise",
  specialty: "expertise",
  speciality: "expertise",
  strength: "expertise",
  ownership: "expertise",
  process: "workflow",
  procedure: "workflow",
  routine: "workflow",
  cadence: "workflow",
  ritual: "workflow",
  tool: "workflow",
  tools: "workflow",
  stack: "workflow",
  system: "workflow",
  systems: "workflow",
};

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === "string" && (MEMORY_CATEGORY_IDS as readonly string[]).includes(value);
}

/**
 * Coerce anything to a category. Never throws — an unusable label is not a
 * reason to lose the memory, only a reason to file it under the default.
 */
export function normalizeMemoryCategory(raw: unknown): MemoryCategory {
  if (typeof raw !== "string") return DEFAULT_MEMORY_CATEGORY;
  const key = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (isMemoryCategory(key)) return key;
  const singular = key.endsWith("s") ? key.slice(0, -1) : key;
  return CATEGORY_ALIASES[key] ?? CATEGORY_ALIASES[singular] ?? (isMemoryCategory(singular) ? singular : DEFAULT_MEMORY_CATEGORY);
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Ceilings on agent-authored writes. These bound the "fills up with noise"
 * failure directly: a memory that will not fit in a paragraph is a transcript,
 * and an agent that files ten things in an hour is logging, not remembering.
 *
 * Deliberately not applied to what a person writes about themselves. Their
 * memory, their call.
 */
export const AGENT_MEMORY_MAX_CONTENT_CHARS = 1500;
export const AGENT_MEMORY_MAX_DESCRIPTION_CHARS = 240;
/** Rolling-hour cap on how many memories one agent may file for its user. */
export const AGENT_MEMORY_WRITES_PER_HOUR = 10;

// ---------------------------------------------------------------------------
// Strength — repetition made visible
// ---------------------------------------------------------------------------

/**
 * How settled a memory is, derived from how many times an agent has arrived at
 * it independently.
 *
 * This is the one idea from Perplexity worth copying wholesale: repetition is
 * the signal. Something said once is a remark; something an agent has now
 * concluded three separate times is how this person works. Making that visible
 * changes what the owner does with the page — a `noted` entry invites a glance,
 * a `core` one does not.
 *
 * Only agent observations count. The owner editing their own words is a
 * correction, not a confirmation, so a hand-written memory sits at `noted`
 * forever and that is correct: nobody has independently confirmed it, and
 * pretending otherwise would make the signal meaningless.
 */
export type MemoryStrength = "noted" | "confirmed" | "core";

/** Observations needed to reach each step. */
export const MEMORY_STRENGTH_THRESHOLDS = { confirmed: 2, core: 4 } as const;

export function memoryStrength(timesObserved: number): MemoryStrength {
  if (timesObserved >= MEMORY_STRENGTH_THRESHOLDS.core) return "core";
  if (timesObserved >= MEMORY_STRENGTH_THRESHOLDS.confirmed) return "confirmed";
  return "noted";
}

// ---------------------------------------------------------------------------
// Recency tier (hot / warm / cold)
// ---------------------------------------------------------------------------

/** A recency signal orthogonal to strength: how recently the fact was seen. */
export type MemoryRecency = "hot" | "warm" | "cold";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Age (days since last seen) at which a memory cools. */
export const MEMORY_RECENCY_THRESHOLDS = { hot: 30, warm: 120 } as const;

/** hot (≤30d) → warm (≤120d) → cold. `nowMs` is passed in to stay pure. */
export function memoryRecency(lastSeenIso: string | null | undefined, nowMs: number): MemoryRecency {
  if (!lastSeenIso) return "cold";
  const seen = Date.parse(lastSeenIso);
  if (!Number.isFinite(seen)) return "cold";
  const ageDays = (nowMs - seen) / DAY_MS;
  if (ageDays <= MEMORY_RECENCY_THRESHOLDS.hot) return "hot";
  if (ageDays <= MEMORY_RECENCY_THRESHOLDS.warm) return "warm";
  return "cold";
}

// ---------------------------------------------------------------------------
// Heuristic content classification + dump parsing (import auto-categorization)
// ---------------------------------------------------------------------------

/**
 * Map a pasted section header ("## Identity", "Preferences", …) to a category.
 * Section headers are the strongest signal when importing an AI-platform export,
 * so this takes precedence over content keywords.
 */
function categoryFromSectionHint(hint: string | null | undefined): MemoryCategory | null {
  if (!hint) return null;
  const h = hint.toLowerCase().replace(/[^a-z一-鿿]+/g, " ").trim();
  const has = (...words: string[]) => words.some((w) => h.includes(w));
  // Operating rules ("Instructions") aren't a memory category; they read as
  // preferences (how the person wants things done) — the same call the source
  // exports already make.
  if (has("instruction", "rule", "guardrail", "指示", "規則")) return "preference";
  if (has("preference", "偏好", "style", "格式", "工作方式")) return "preference";
  if (has("identity", "about", "profile", "who", "個人資料", "身份", "背景")) return "profile";
  if (has("career", "experience", "work history", "employment", "職涯", "經歷", "工作")) return "expertise";
  if (has("expertise", "skill", "專長", "技能")) return "expertise";
  if (has("project", "專案", "作品")) return "project";
  if (has("workflow", "process", "cadence", "how we work", "流程", "工作流程")) return "workflow";
  if (has("feedback", "correction", "回饋", "修正")) return "feedback";
  if (has("reference", "link", "resource", "參考", "連結", "資源")) return "reference";
  return null;
}

const CATEGORY_KEYWORDS: Record<MemoryCategory, string[]> = {
  preference: ["prefer", "wants ", "want ", "likes ", "avoid", "don't", "do not", "concise", "verbose", "tone", "format", "reply in", "default to", "should be", "keep responses", "no ai", "偏好", "希望", "喜歡", "避免"],
  profile: ["name:", "born", "raised", "grew up", "based in", "lives in", "family", "mother", "father", "studied", "degree", "university", "cornell", "language", "netid", "role:", "founder", "married", "身份", "出生", "家庭", "就讀"],
  expertise: ["skill", "expertise", "experience with", "proficient", "specializ", "go-to", "built with", "knows ", "python", "sql", "machine learning", "deep learning", "figma", "專長", "技能", "擅長"],
  project: ["project", "built a", "developed", "homework", "final project", "report", "app", "model", "portfolio", "delivered", "completed", "prototype", "專案", "作品", "報告"],
  workflow: ["workflow", "process", "cadence", "each week", "weekly", "routine", "pipeline", "the steps", "deploy", "publish", "storage code path", "流程", "每週", "步驟"],
  feedback: ["corrected", "pushed back", "was wrong", "caught an error", "redo", "re-show", "verify before", "should not have", "回饋", "修正", "指正"],
  reference: ["http://", "https://", "www.", "dashboard", "ticket", "github.com", "docs.google", "drive.google", "連結", "參考資料"],
};

/** Priority when scores tie — more specific categories win over generic ones. */
const CATEGORY_PRIORITY: MemoryCategory[] = ["feedback", "preference", "project", "expertise", "workflow", "profile", "reference"];

/**
 * Best-effort category for a single memory's text. Section hint wins; otherwise
 * keyword scoring; otherwise the most generic bucket. Deterministic and free —
 * an LLM pass can replace this later without changing callers.
 */
export function classifyMemoryContent(content: string, sectionHint?: string | null): MemoryCategory {
  const fromHint = categoryFromSectionHint(sectionHint);
  if (fromHint) return fromHint;
  const text = ` ${content.toLowerCase()} `;
  let best: MemoryCategory = "reference";
  let bestScore = 0;
  for (const category of CATEGORY_PRIORITY) {
    let score = 0;
    for (const kw of CATEGORY_KEYWORDS[category]) if (text.includes(kw)) score += 1;
    if (score > bestScore) { bestScore = score; best = category; }
  }
  return bestScore === 0 ? "reference" : best;
}

export type ParsedDumpEntry = {
  /** The fact text, with any leading "[date] -" stripped. */
  content: string;
  /** Auto-assigned category (section hint or content heuristic). */
  category: MemoryCategory;
  /** ISO date parsed from a leading "[YYYY-MM-DD]", when present. */
  observedAt: string | null;
  /** The section header this fell under, if any (for display/grouping). */
  section: string | null;
};

const SECTION_HEADER = /^\s*#{1,6}\s*(.+?)\s*#*\s*$/;
const DATE_PREFIX = /^\s*(?:[-*]\s*)?\[(\d{4}-\d{2}-\d{2}|unknown)\]\s*[-–—]\s*(.*)$/i;
const BULLET_PREFIX = /^\s*[-*]\s+(.*)$/;

/**
 * Split a pasted memory dump (ChatGPT / Claude / Gemini export, or freeform
 * notes) into individual, auto-categorized entries.
 *
 * Handles the common export shape: "## Section" headers with "[date] - fact"
 * bullets under them. Falls back to one entry per non-empty line/paragraph, and
 * to a single classified entry when there's no structure at all.
 */
export function parseMemoryDump(raw: string): ParsedDumpEntry[] {
  const text = (raw ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const lines = text.split("\n");
  const entries: ParsedDumpEntry[] = [];
  let section: string | null = null;

  const push = (body: string, observedAt: string | null) => {
    const content = body.trim();
    if (!content) return;
    // Drop meta lines the exporters inject (e.g. "No persistent stored-memory…").
    if (/^no\b.*\b(found|instructions were found)/i.test(content) && content.length < 200) return;
    entries.push({ content, category: classifyMemoryContent(content, section), observedAt, section });
  };

  let buffer = "";
  let bufferDate: string | null = null;
  const flush = () => { if (buffer) push(buffer, bufferDate); buffer = ""; bufferDate = null; };

  for (const line of lines) {
    const header = SECTION_HEADER.exec(line);
    if (header && !DATE_PREFIX.test(line)) {
      flush();
      section = header[1];
      continue;
    }
    const dated = DATE_PREFIX.exec(line);
    if (dated) {
      flush();
      bufferDate = dated[1].toLowerCase() === "unknown" ? null : `${dated[1]}T00:00:00.000Z`;
      buffer = dated[2] ?? "";
      continue;
    }
    const bullet = BULLET_PREFIX.exec(line);
    if (bullet) {
      flush();
      buffer = bullet[1] ?? "";
      continue;
    }
    if (line.trim() === "") { flush(); continue; }
    // Continuation of the current entry (wrapped line).
    buffer = buffer ? `${buffer} ${line.trim()}` : line.trim();
  }
  flush();
  return entries;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * How long a deleted memory stays recoverable.
 *
 * Deleting is the action people take when memory gets something wrong, and it
 * is the action they take fastest — usually while annoyed, often about an entry
 * they will decide next week was right after all. A recovery window makes
 * deletion cheap enough to use freely, which is what keeps the page trustworthy;
 * a permanent delete makes people hesitate over every row.
 *
 * Thirty days matches what Perplexity offers, and is long enough that "I want
 * that back" and "purge it now" are both served — the owner can always purge
 * immediately, which is the case that actually matters for a bad entry.
 */
export const MEMORY_RECOVERY_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// Reserved names
// ---------------------------------------------------------------------------

/**
 * Slugs a memory may not be called, because the API already uses them.
 *
 * Memories are addressed as `/memories/{name}`, and the collection has sibling
 * endpoints — `/memories/stats`, `/memories/settings` and so on. A memory named
 * `settings` would either shadow that endpoint or be shadowed by it, depending
 * on registration order, and the symptom would be a confusing failure on one
 * verb only.
 *
 * Refusing the name at the write gate is the fix that keeps working: adding a
 * route means adding a word here, in the same commit, and the conflict is
 * impossible rather than merely unlikely. A test asserts this list covers every
 * registered sub-path, so forgetting is caught rather than shipped.
 */
export const RESERVED_MEMORY_NAMES: readonly string[] = [
  "stats",
  "seed",
  "settings",
  "deleted",
  "import",
  "restore",
];

export function isReservedMemoryName(name: string): boolean {
  return RESERVED_MEMORY_NAMES.includes(name.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

export type MemoryScreenClass = "credential" | "health" | "financial" | "government_id";

export type MemoryScreenVerdict =
  | { allowed: true }
  | { allowed: false; screenClass: MemoryScreenClass; reason: string };

/**
 * Secrets. Refused from everyone, because storing one writes it to disk in a
 * workspace an agent reads.
 *
 * The labelled-value pattern wants at least eight non-space characters after
 * the label so that prose ("password: they forgot theirs") mostly passes while
 * an actual value does not. It will still occasionally refuse a sentence that
 * merely talks about a password — the right trade, given what the other outcome
 * costs.
 */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:password|passwd|pwd|api[\s_-]?key|secret|access[\s_-]?token|client[\s_-]?secret|private[\s_-]?key)\s*[:=：]\s*\S{8,}/i,
  // Kept separate from the line above: `\b` is defined against ASCII word
  // characters, so a boundary before a CJK label never matches and folding
  // these into that alternation would silently disable them.
  /(?:密碼|金鑰|私鑰|存取權杖)\s*[:=：]?\s*\S{8,}/,
];

/**
 * Personal health status. Clinical markers only — not the word "health", and
 * not dietary restrictions, which are a genuine working preference an agent
 * should be able to remember ("orders vegetarian for team lunches").
 */
const HEALTH_PATTERNS: RegExp[] = [
  /\bdiagnos(?:ed|is)\b/i,
  /\bprescri(?:bed|ption)\b/i,
  /\bmedications?\b/i,
  /\bchemotherapy\b/i,
  /\bhospitali[sz]ed\b/i,
  /\bpregnan(?:t|cy)\b/i,
  /\bmiscarriage\b/i,
  /\bpsychiatric\b/i,
  /\bmental (?:health condition|illness)\b/i,
  /\btherap(?:ist|y) (?:appointment|session)/i,
  /診斷|處方|服藥|懷孕|住院|化療|精神科|身心科|憂鬱症|焦慮症/,
];

/**
 * Money. The card-number rule is a Luhn check rather than a bare digit run, so
 * order numbers and phone numbers do not trip it.
 */
const FINANCIAL_PATTERNS: RegExp[] = [
  /\bsalar(?:y|ies)\b/i,
  /\b(?:annual|monthly) income\b/i,
  /\bnet worth\b/i,
  /\bbank account\b/i,
  /\brouting number\b/i,
  /\bIBAN\b/,
  /\bcredit (?:card|score)\b/i,
  /薪水|薪資|年薪|月薪|銀行帳戶|信用卡|存款餘額/,
];

const GOVERNMENT_ID_PATTERNS: RegExp[] = [
  /\b[A-Z][12]\d{8}\b/, // Taiwan national ID
  /\b\d{3}-\d{2}-\d{4}\b/, // US SSN
  /\bpassport(?:\s*(?:number|no\.?))?\s*[:：]?\s*[A-Z0-9]{6,}/i,
  // Separate for the same reason as the CJK credential label: no `\b` on CJK.
  /(?:身分證|身份證|護照)(?:\s*(?:號碼|字號))?\s*[:：]?\s*[A-Z0-9]{6,}/,
];

/** Digit runs that pass Luhn — a payment card, not an order number. */
function containsPaymentCardNumber(text: string): boolean {
  for (const match of text.matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)) {
    const digits = match[0].replace(/[^\d]/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (luhnValid(digits)) return true;
  }
  return false;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

const REASONS: Record<MemoryScreenClass, string> = {
  credential:
    "looks like a secret (key, token or password). Memory is written to disk in the agent's workspace, so credentials are never stored — put it in the company's secret store instead.",
  health:
    "looks like personal health information. An agent may not file this; the person can record it themselves on their Memory page if they want it kept.",
  financial:
    "looks like personal financial information. An agent may not file this; the person can record it themselves on their Memory page if they want it kept.",
  government_id:
    "looks like a government identifier. An agent may not file this; the person can record it themselves on their Memory page if they want it kept.",
};

/**
 * Decide whether a write may be stored.
 *
 * `authoredBy` is the actor that is really writing — derived from the request's
 * credentials, never from anything in the body. An agent that could claim to be
 * the user would walk straight through the asymmetry this rests on.
 *
 * Binary entries are not screened: they are the owner uploading their own
 * files, and base64 of a PNG has no prose to read.
 */
export function screenMemoryWrite(input: {
  content: string;
  description?: string;
  name?: string;
  authoredBy: "agent" | "user";
  isBinary?: boolean;
}): MemoryScreenVerdict {
  if (input.isBinary) return { allowed: true };

  const text = [input.name ?? "", input.description ?? "", input.content].join("\n");

  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) {
    return { allowed: false, screenClass: "credential", reason: REASONS.credential };
  }

  // Everything below is about consent, and the owner has already given it.
  if (input.authoredBy !== "agent") return { allowed: true };

  if (HEALTH_PATTERNS.some((pattern) => pattern.test(text))) {
    return { allowed: false, screenClass: "health", reason: REASONS.health };
  }
  if (FINANCIAL_PATTERNS.some((pattern) => pattern.test(text)) || containsPaymentCardNumber(text)) {
    return { allowed: false, screenClass: "financial", reason: REASONS.financial };
  }
  if (GOVERNMENT_ID_PATTERNS.some((pattern) => pattern.test(text))) {
    return { allowed: false, screenClass: "government_id", reason: REASONS.government_id };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/**
 * The form two memories are compared in.
 *
 * Case, spacing and trailing punctuation are noise; a re-run that phrases the
 * same fact with a full stop this time should not become a second row. This is
 * exact-after-normalization on purpose — fuzzy similarity would silently merge
 * two facts that differ in one important word.
 */
export function normalizeMemoryForComparison(content: string): string {
  return content
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?。，、；：！？]+$/g, "")
    .trim();
}
