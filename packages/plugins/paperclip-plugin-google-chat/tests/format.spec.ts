import { describe, expect, it } from "vitest";
import {
  CHAT_MESSAGE_LIMIT,
  displayWidth,
  formatForChat,
  splitForChat,
  toChatText
} from "../src/format.js";

describe("displayWidth", () => {
  it("counts CJK/full-width glyphs as 2 and ASCII as 1", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("四季")).toBe(4);
    expect(displayWidth("四季arts")).toBe(8);
  });
});

describe("toChatText inline + block conversions", () => {
  it("rewrites bold, headers, bullets and links to Chat's dialect", () => {
    const md = [
      "# 標題",
      "**重點** 與 [連結](https://example.org)",
      "- 第一項",
      "- 第二項"
    ].join("\n");
    const out = toChatText(md);
    expect(out).toContain("*標題*"); // header -> bold, # stripped
    expect(out).toContain("*重點*"); // ** -> *
    expect(out).toContain("<https://example.org|連結>"); // link form
    expect(out).toContain("• 第一項");
    expect(out).not.toContain("**");
    expect(out).not.toMatch(/^#/m);
  });

  it("turns a markdown table into an aligned monospace code block", () => {
    const md = [
      "| 單號 | 狀態 | 金額 |",
      "| --- | --- | --- |",
      "| GC/00002 | purchased | 14888 |",
      "| GC/00018 | planning | 7600 |"
    ].join("\n");
    const out = toChatText(md);
    expect(out.startsWith("```")).toBe(true);
    expect(out.endsWith("```")).toBe(true);
    const body = out.replace(/```/g, "").trim().split("\n");
    // Header row, dashed rule, then two data rows.
    expect(body[0]).toContain("單號");
    expect(body[1]).toMatch(/^-+/);
    // Each data column starts at the same display column as the header.
    const headerCol2 = displayWidth(body[0].slice(0, body[0].indexOf("狀態")));
    const rowCol2 = displayWidth(body[2].slice(0, body[2].indexOf("purchased")));
    expect(rowCol2).toBe(headerCol2);
  });
});

describe("splitForChat", () => {
  it("returns a single chunk when under the limit", () => {
    expect(splitForChat("short")).toEqual(["short"]);
  });

  it("splits long text into chunks all within the limit", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const chunks = splitForChat(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHAT_MESSAGE_LIMIT);
    // No content lost (ignoring the join newlines).
    expect(chunks.join("\n").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  });

  it("keeps fences balanced when splitting an oversized code block", () => {
    const rows = Array.from({ length: 400 }, (_, i) => `GC/${i}  purchased  ${i * 10}`).join("\n");
    const big = "```\n" + rows + "\n```";
    const chunks = splitForChat(big, 800);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(800);
      // Every chunk is a self-contained code block (even number of fences).
      expect((c.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });
});

describe("formatForChat pipeline", () => {
  it("converts then chunks a long table-bearing answer", () => {
    const rows = Array.from({ length: 60 }, (_, i) => `| GR/${i} | consolidated | 四季北屯 | ${i} |`).join("\n");
    const md = ["# 結果", "| 單號 | 狀態 | 校區 | 量 |", "| --- | --- | --- | --- |", rows].join("\n");
    const chunks = formatForChat(md, 600);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(600);
      expect((c.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });
});
