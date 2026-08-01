/**
 * Turning a task description into a usable title.
 *
 * A title is required at the database level, but requiring a human to *invent*
 * one is friction on the most common workflow: type what you want, hit create.
 * So when the title is left blank we derive a provisional one here, the task is
 * created immediately, and the assigned agent replaces it with a real summary
 * on its first run.
 *
 * Deriving rather than calling a model keeps creation instant and free. The
 * result is a placeholder with a short shelf life, not a final title — which is
 * why it is allowed to be a blunt truncation.
 */

/** Longest provisional title we will produce. Well under the 200-char column. */
export const PROVISIONAL_TITLE_MAX_CHARS = 80;

/** Shown when a description carries no usable text (e.g. only an image). */
export const PROVISIONAL_TITLE_FALLBACK = "Untitled task";

/**
 * Strip the markdown that would read as noise in a title. Deliberately shallow:
 * this is a placeholder, so a stray character matters far less than mangling
 * CJK text or eating content.
 */
function stripMarkdownNoise(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "") // heading marker
    .replace(/^[-*+]\s+/, "") // bullet
    .replace(/^\d+[.)]\s+/, "") // ordered list marker
    .replace(/^>\s+/, "") // quote
    .replace(/^\[[ xX]\]\s+/, "") // task checkbox
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // image
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // link → its text
    .replace(/[*_`~]/g, "")
    .trim();
}

/**
 * Cut to the limit without splitting a word. CJK has no spaces, so when there
 * is no space to break on we take the hard cut rather than returning nothing.
 */
function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const hard = value.slice(0, limit);
  const lastSpace = hard.lastIndexOf(" ");
  const cut = lastSpace > limit * 0.6 ? hard.slice(0, lastSpace) : hard;
  return `${cut.trimEnd()}…`;
}

/**
 * Derive a provisional title from a task description.
 *
 * Returns the fallback rather than an empty string, because the column is NOT
 * NULL and an empty title would surface as a blank row in every list.
 */
export function deriveProvisionalIssueTitle(
  description: string | null | undefined,
): string {
  const text = (description ?? "").replace(/\r\n/g, "\n");

  for (const rawLine of text.split("\n")) {
    const line = stripMarkdownNoise(rawLine);
    if (!line) continue;
    // Prefer the first sentence when the opening line runs long, so a rambling
    // paragraph still yields a title-shaped placeholder.
    const sentence = line.split(/(?<=[.!?。！？])\s+/)[0]?.trim() || line;
    const candidate = sentence.length > PROVISIONAL_TITLE_MAX_CHARS ? line : sentence;
    return truncate(candidate, PROVISIONAL_TITLE_MAX_CHARS);
  }

  return PROVISIONAL_TITLE_FALLBACK;
}
