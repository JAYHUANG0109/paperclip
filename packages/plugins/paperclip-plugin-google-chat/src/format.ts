/**
 * Convert an agent's markdown comment into something Google Chat renders well.
 *
 * Google Chat's text format supports only a small markdown subset — bold with
 * single `*`, bulleted lists, links as `<url|text>`, and monospace via triple
 * backticks. It does NOT render markdown tables or `#` headers, and caps a
 * message at 4096 characters. So we:
 *   - rewrite bold / links / headers / bullets to Chat's dialect,
 *   - turn markdown tables into fixed-width monospace blocks (CJK-aware so
 *     Chinese columns line up), and
 *   - split the result into <4096-char messages without breaking a code block.
 */

/** Google Chat's hard per-message limit is 4096 chars; leave headroom. */
export const CHAT_MESSAGE_LIMIT = 3900;

const CJK_WIDE =
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

/** Display width of a string in a monospace font (CJK/full-width glyphs = 2). */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += CJK_WIDE.test(ch) ? 2 : 1;
  return w;
}

function padRight(s: string, width: number): string {
  const pad = width - displayWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

const SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function isTableHeader(line: string, next: string | undefined): boolean {
  return line.includes("|") && next !== undefined && SEPARATOR_RE.test(next);
}

/** Render a parsed markdown table as an aligned monospace code block. */
function renderTable(rows: string[][]): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    widths[c] = Math.max(...rows.map((r) => displayWidth(r[c] ?? "")));
  }
  const lines = rows.map((r) =>
    Array.from({ length: cols }, (_, c) => padRight(r[c] ?? "", widths[c])).join("  ").trimEnd()
  );
  // A dashed rule under the header aids readability.
  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  if (lines.length > 1) lines.splice(1, 0, rule);
  return "```\n" + lines.join("\n") + "\n```";
}

function convertInline(text: string): string {
  return text
    // Links [text](url) -> <url|text>
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
    // Bold **text** or __text__ -> *text*  (Chat bold is a single asterisk)
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/__([^_]+)__/g, "*$1*");
}

/** Convert a markdown string to Google Chat text. */
export function toChatText(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Table block?
    if (isTableHeader(line, lines[i + 1])) {
      const rows: string[][] = [splitRow(line)];
      i += 2; // skip header + separator
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push(renderTable(rows));
      continue;
    }

    // Header line (#, ##, …) -> bold line.
    const header = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (header) {
      out.push(`*${convertInline(header[1].trim())}*`);
      i += 1;
      continue;
    }

    // Bullet (- / *) -> • , preserving indentation.
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      out.push(`${bullet[1]}• ${convertInline(bullet[2])}`);
      i += 1;
      continue;
    }

    out.push(convertInline(line));
    i += 1;
  }
  return out.join("\n");
}

/**
 * Split text into <=limit-char chunks, breaking on line boundaries and never
 * inside a ``` code block. If a single code block is itself too large, it's
 * split by rows with the fences re-applied to each piece.
 */
export function splitForChat(text: string, limit: number = CHAT_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.length) chunks.push(buf.replace(/\n+$/, ""));
    buf = "";
  };
  const pushLine = (line: string) => {
    if (buf.length + line.length + 1 > limit) flush();
    buf += (buf.length ? "\n" : "") + line;
  };

  const blocks = text.split(/(```[\s\S]*?```)/g);
  for (const block of blocks) {
    if (!block) continue;
    if (block.startsWith("```") && block.length > limit) {
      // Oversized code block: split its rows, re-fencing each piece.
      flush();
      const inner = block.replace(/^```\n?/, "").replace(/\n?```$/, "");
      let piece = "";
      for (const row of inner.split("\n")) {
        if (("```\n" + piece + "\n" + row + "\n```").length > limit && piece) {
          chunks.push("```\n" + piece + "\n```");
          piece = "";
        }
        piece += (piece ? "\n" : "") + row;
      }
      if (piece) chunks.push("```\n" + piece + "\n```");
    } else if (block.startsWith("```")) {
      if (buf.length + block.length + 1 > limit) flush();
      buf += (buf.length ? "\n" : "") + block;
    } else {
      for (const line of block.split("\n")) pushLine(line);
    }
  }
  flush();
  return chunks.filter((c) => c.length > 0);
}

/** Full pipeline: markdown comment -> ordered Chat-ready message chunks. */
export function formatForChat(markdown: string, limit: number = CHAT_MESSAGE_LIMIT): string[] {
  return splitForChat(toChatText(markdown), limit);
}
