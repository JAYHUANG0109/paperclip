/**
 * Option lists for the "new colleague agent" form, transcribed from
 * `doc/sa-org-chart.md` — the org chart is the single source of truth for
 * reporting lines, titles and `metadata.teams` (校區＋組).
 *
 * Kept as plain data (not fetched) because the org chart changes on the order of
 * months and a stale dropdown is worse than an obviously-editable constant: the
 * request these feed is read by an agent that re-checks the chart anyway.
 *
 * When the chart changes, update it there first, then mirror it here.
 */

/** L1 校區. 總管理處 is a campus-level peer, not a school. */
export const CAMPUSES = [
  "仁美",
  "市政",
  "西屯",
  "黎明",
  "北屯",
  "總管理處",
] as const;

/** L3 組 — schools. 跨校巡輔 exists only at 仁美. */
export const SCHOOL_GROUPS = [
  "幼教學組",
  "外師教學組",
  "ESL教學組",
  "註冊組",
  "總務管理組",
  "跨校巡輔",
] as const;

/**
 * L3 部門 — 總管理處 only.
 *
 * 人發／行銷／視覺／採購 are the four the founder called out as missing: they are
 * the working groups people actually sit in, one level below the department they
 * belong to (人發 ⊂ 人才發展部, 行銷 and 視覺 ⊂ 品牌發展部, 採購 ⊂ 採購工程部).
 * Both levels are offered because an agent may be filed at either.
 */
export const HQ_DEPARTMENTS = [
  "人發",
  "行銷",
  "視覺",
  "採購",
  "數位資訊部",
  "人才發展部",
  "品牌發展部",
  "基金會",
  "採購工程部",
  "財務部",
  "餐飲部",
] as const;

/**
 * L2/L4/L5 職稱.
 *
 * The 總管理處 block was missing entirely — 人發 (talent development), 行銷
 * (marketing), 視覺 (visual design) and 採購 (procurement) had no selectable
 * position, so an HQ hire could only be filed under a campus-shaped role. The
 * names and their ladders come from 五B of the sa-agent-onboarding skill and
 * doc/sa-org-chart.md.
 */
export const POSITIONS = [
  // L2
  "統籌總園長",
  "園長",
  "副園長",
  "處長",
  // L4
  "教學主管",
  "活動主管",
  "幼教行政",
  "跨校巡輔組長",
  "外師組長",
  "ESL教學主管",
  "ESL行政",
  "註冊組長",
  "總務組長",
  "部門主管",
  // L5
  "教師",
  "外師",
  "ESL組員",
  "註冊組員",
  "行政組員",
  // 總管理處 — 人發／行銷／視覺／採購／財務／基金會／秘書, each 副理→主任→組長→專員
  "人發副理",
  "人發主任",
  "人發組長",
  "人發專員",
  "行銷主任",
  "行銷組長",
  "行銷專員",
  "視覺設計組長",
  "視覺設計專員",
  "採購主任",
  "採購組長",
  "採購專員",
  "修繕組長",
  "財務組長",
  "財務副組長",
  "財務專員",
  "基金會專員",
  "創辦人秘書",
] as const;

/** Groups selectable for a campus: 總管理處 gets departments, schools get 組. */
export function groupsForCampuses(campuses: readonly string[]): string[] {
  const hq = campuses.includes("總管理處");
  const school = campuses.some((c) => c !== "總管理處");
  const out: string[] = [];
  if (school) out.push(...SCHOOL_GROUPS.filter((g) => g !== "跨校巡輔" || campuses.includes("仁美")));
  if (hq) out.push(...HQ_DEPARTMENTS);
  return out;
}
