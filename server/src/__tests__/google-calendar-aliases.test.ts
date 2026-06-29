import { describe, expect, it } from "vitest";
import {
  deriveNameAliases,
  eventIsMine,
  type GoogleCalendarEvent,
} from "../services/google-calendar.js";

describe("deriveNameAliases", () => {
  it("derives the given name from a bare CJK full name", () => {
    const a = deriveNameAliases("黃睦傑");
    expect(a).toContain("黃睦傑");
    expect(a).toContain("睦傑"); // drop 1-char surname
  });

  it("strips a 部門_ prefix and extracts the CJK given name + Latin nickname", () => {
    // The team formats names as "部門_姓名 暱稱"; titles use only "偉誠"/"Frank".
    const a = deriveNameAliases("數位資訊部_陳偉誠 Frank");
    expect(a).toContain("偉誠"); // given name — the form titles actually use
    expect(a).toContain("Frank");
    expect(a).not.toContain("數位資訊部"); // prefix is dropped
  });

  it("handles a 部門_姓名 暱稱 with a CJK nickname", () => {
    const a = deriveNameAliases("仁美校園長_王姿雅 雅雅");
    expect(a).toContain("雅雅");
    expect(a).toContain("姿雅");
  });

  it("handles a prefix with a Latin-only name", () => {
    expect(deriveNameAliases("數位資訊部(外部)_Jessica")).toContain("Jessica");
  });

  it("never emits a single-character alias", () => {
    for (const a of deriveNameAliases("仁美校園長_王姿雅 雅雅")) {
      expect(a.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("returns nothing for an empty name", () => {
    expect(deriveNameAliases("")).toEqual([]);
    expect(deriveNameAliases(null)).toEqual([]);
  });
});

describe("eventIsMine", () => {
  const ev = (over: Partial<GoogleCalendarEvent>): GoogleCalendarEvent => ({
    id: "c::1",
    calendarId: "c",
    calendarName: null,
    calendarColor: null,
    title: "",
    start: "2026-07-01T10:00:00+08:00",
    end: null,
    dateKey: "2026-07-01",
    allDay: false,
    htmlLink: null,
    isInvitedAttendee: false,
    ...over,
  });

  it("matches when the title contains a CJK alias", () => {
    const e = ev({ title: "【會議】唐姐出席AI代理人專案會議-偉誠、睦傑、惠君、雅雅" });
    expect(eventIsMine(e, ["睦傑"])).toBe(true);
    expect(eventIsMine(e, ["怡伶"])).toBe(false);
  });

  it("does NOT match purely because the user owns/organizes the calendar", () => {
    // The shared calendar reports organizer.self=true for everything; that must
    // no longer count — only a real invite (isInvitedAttendee) or a title match.
    const e = ev({ title: "【ESL】校內課程分享徵選", isInvitedAttendee: false });
    expect(eventIsMine(e, ["睦傑"])).toBe(false);
  });

  it("matches a genuine invited attendee regardless of title", () => {
    const e = ev({ title: "某個與我無關標題的會議", isInvitedAttendee: true });
    expect(eventIsMine(e, ["睦傑"])).toBe(true);
  });
});
