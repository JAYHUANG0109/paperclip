/**
 * Building a `Content-Disposition` header that cannot 500 the response — PURE.
 *
 * ─── Why this is a shared helper and not three inline template strings ───
 *
 * HTTP header values are latin1. A filename is arbitrary user text, and on this
 * deployment it is usually Chinese ("截圖 2026-06-16 晚上11.15.34.png"). Handing
 * that straight to `res.setHeader` makes Node throw ERR_INVALID_CHAR, which
 * surfaces as a 500 on the download — or, when the response is an `<img src>`, as
 * a silently broken thumbnail with no clue anywhere in the UI.
 *
 * That bug existed at three separate call sites while a fourth had the correct
 * fix written out inline beside it. That is the argument for this file: the
 * knowledge was in the codebase and still could not be reused, so every new route
 * serving a file re-derived it and two of them got it wrong.
 *
 * ─── The encoding ───
 *
 * RFC 6266 with an RFC 5987 extension: an ASCII-only `filename` that every client
 * understands, plus `filename*=UTF-8''<percent-encoded>` which modern clients
 * prefer and which round-trips the real name. Sending only the ASCII fallback
 * would mean every CJK filename downloads as "________.png".
 */

/** Disposition types this helper supports; anything else is not a file response. */
export type ContentDisposition = "inline" | "attachment";

/**
 * Non-ASCII becomes `_` in the fallback, and quotes are dropped rather than
 * escaped: a quote inside a quoted-string is how a header gets split, and no
 * filename needs one badly enough to risk that.
 */
function asciiFallbackFilename(filename: string): string {
  const cleaned = filename
    .replace(/[^\x20-\x7E]/g, "_")
    .replaceAll('"', "")
    // CR/LF would end the header and start a new one.
    .replace(/[\r\n]/g, "_")
    .trim();
  return cleaned || "file";
}

/**
 * Build the header value for a file response.
 *
 * Never throws and never returns a value `setHeader` will reject, so a caller
 * cannot turn an unusual filename into a failed download.
 */
export function contentDispositionHeader(
  disposition: ContentDisposition,
  filename: string | null | undefined,
): string {
  const name = (filename ?? "").trim() || "file";
  const fallback = asciiFallbackFilename(name);

  /**
   * `filename*` is added ONLY when the plain parameter cannot carry the name.
   *
   * An ASCII filename needs no extension: the fallback already is the real name,
   * and appending a redundant `filename*` would change the header on every
   * existing download to fix a case those downloads never had. Keeping the
   * common path byte-identical means this only alters responses that were
   * already broken.
   */
  if (fallback === name) return `${disposition}; filename="${name}"`;

  // encodeURIComponent leaves ! ' ( ) * unescaped, and `'` in particular would
  // be read as the end of the ext-value, so those are encoded explicitly.
  const encoded = encodeURIComponent(name).replace(
    /['()!*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
