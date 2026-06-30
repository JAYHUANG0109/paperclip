import { useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { FounderDigestSection } from "@/components/FounderDigestSection";
import type { FounderConsolesResponse } from "@/api/dashboard";

const companyId = "company-storybook";

// One founder console with two 待批閱 items: the first carries a discussion
// thread (2 agent comments + 1 pending founder reply) to exercise the collapsed
// comment-count chip and the expanded 討論串 + reply box; the second is a plain
// undecided item for contrast.
const consoles: FounderConsolesResponse = {
  consoles: [
    {
      key: "founder",
      title: "創辦人每日行事曆 (唐姐)",
      digest: {
        generatedAt: "2026-06-30T07:30:00Z",
        lastRunLabel: "15:30 午後彙整",
        categories: {
          urgent: [
            {
              gid: "1216027441249677",
              name: "【品牌】🔥扶輪月刊廣告修正（今日需確認修改方向）｜行銷・Una",
              permalinkUrl: "https://app.asana.com/x",
              notes: "依據 6/28 收到通知需再修改文字，再次送審。",
              triage: "now",
              summary: "行銷 Una 依 6/28 扶輪社通知，扶輪月刊廣告文字需再修改後再次送審，今日需確認修改方向才能趕上送審。",
              review:
                "文字修改方向同意。請依扶輪社通知重點調整後送審：\n① 確認刊登版位與截稿日；\n② 品牌標語、聯絡資訊與 logo 解析度正確；\n③ 完稿前回傳最終稿給我看一次再送。",
              prep: null,
              decision: null,
              decisionNote: null,
              comments: [
                { id: "s1", author: "Una", authorType: "agent", text: "扶輪社通知主要是標語與聯絡資訊要更新，已照建議改好，附上修改後版本連結。", createdAt: "2026-06-29T01:20:00Z" },
                { id: "s2", author: "Una", authorType: "agent", text: "截稿日是 7/3，今天若能確認方向就來得及。", createdAt: "2026-06-29T03:05:00Z" },
                { id: "pending-1", author: null, authorType: "founder", text: "標語第二句再口語一點，其餘 OK。", createdAt: "2026-06-30T07:35:00Z", pending: true },
              ],
              closed: false,
            },
            {
              gid: "1216093641550379",
              name: "【西屯】簽核飛騰單據 20260618000003｜西屯・糖糖",
              permalinkUrl: "https://app.asana.com/y",
              notes: "西屯送出飛騰單據 20260618000003 待簽核（附單據圖檔）。",
              triage: "now",
              summary: "西屯 糖糖 送出飛騰（ERP）單據 20260618000003 待創辦人簽核，附單據圖檔。",
              review: "單據內容、金額與用途確認無誤即可核准。",
              prep: null,
              decision: null,
              decisionNote: null,
              comments: [],
              closed: false,
            },
          ],
          meetings: [],
          nonUrgent: [],
          reminders: [],
        },
      },
    },
  ],
};

function Seeded() {
  const qc = useQueryClient();
  const seeded = useRef(false);
  if (!seeded.current) {
    qc.setQueryData(["founder-digest", companyId], consoles);
    seeded.current = true;
  }
  return (
    <div className="mx-auto max-w-5xl p-6">
      <FounderDigestSection companyId={companyId} />
    </div>
  );
}

const meta: Meta<typeof Seeded> = {
  title: "Dashboard/Founder Digest",
  component: Seeded,
};
export default meta;

type Story = StoryObj<typeof Seeded>;

export const ThreadAndCount: Story = {};
