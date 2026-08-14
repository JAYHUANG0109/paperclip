import { describe, expect, it } from "vitest";
import { isForwardableComment, looksLikeInternalNote } from "../src/mirror.js";

// The filter decides what reaches a person's Google Chat DM. Too loose and
// agents spam their own housekeeping at staff; too tight and a real answer is
// silently swallowed. Both directions are pinned here.
describe("looksLikeInternalNote — English self-talk", () => {
  const internal = [
    "Exiting heartbeat, no action needed.",
    "Duplicate wake — nothing to report.",
    "Task stays blocked on the Asana token.",
    "No further reply needed.",
  ];
  for (const body of internal) {
    it(`filters: ${body}`, () => expect(looksLikeInternalNote(body)).toBe(true));
  }
});

describe("looksLikeInternalNote — 中文 self-talk", () => {
  // The message that actually reached a DM: a memory-audit routine reporting
  // that it changed nothing.
  const realMemoryAudit = [
    "記憶盤點完成。",
    "",
    "兩者都是一次性操作任務，沒有出現任何新的、持久的偏好、身分、工作流或修正需要記錄。",
    "既有 100+ 條記憶已涵蓋本人的基本身分、語言、工作習慣與偏好，無需增修。",
    "",
    "依規則「若沒學到持久的事就不寫」——本次不新增、不改寫、不刪除任何 memory。",
  ].join("\n");

  it("filters the memory-audit report that leaked to a DM", () => {
    expect(looksLikeInternalNote(realMemoryAudit)).toBe(true);
    expect(isForwardableComment({ body: realMemoryAudit })).toBe(false);
  });

  const internal = [
    "本次無異動。",
    "沒有任何新的變更，維持原狀。",
    "無需處理，等待對方回覆。",
    "此次未更新任何資料。",
    "重複喚醒，略過。",
    "仍然封鎖中，等待權杖。",
    "無事可報。",
  ];
  for (const body of internal) {
    it(`filters: ${body}`, () => expect(looksLikeInternalNote(body)).toBe(true));
  }
});

// The expensive failure mode: a genuine answer never arriving. These are real
// shapes of messages staff must keep receiving.
describe("looksLikeInternalNote — real answers must survive", () => {
  const answers = [
    "🗓️ 今日年度計畫提醒（08/14・星期五）\n\n• 🚩 里程碑（截止日）｜【趨勢分析定稿】三單位今天完成並彙整。",
    "我已經新增三筆資料到 Asana，請確認。",
    "已完成佩潔週誌的回覆草稿，請過目後我再送出。",
    "報告已更新，變更包含第二季的數據與圖表。",
    "這份計畫需要處理的項目有三個，我先從第一項開始。",
    "Here is the summary you asked for: three tasks are due this week.",
  ];
  for (const body of answers) {
    it(`forwards: ${body.slice(0, 28)}…`, () => {
      expect(looksLikeInternalNote(body)).toBe(false);
      expect(isForwardableComment({ body })).toBe(true);
    });
  }
});

describe("isForwardableComment", () => {
  it("drops empty bodies and system notices", () => {
    expect(isForwardableComment({ body: "   " })).toBe(false);
    expect(isForwardableComment({ body: "已完成", presentation: { kind: "system_notice" } })).toBe(false);
  });
});
