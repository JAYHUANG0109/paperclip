import { useEffect, useRef, useState } from "react";
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  type PluginPageProps,
  type PluginWidgetProps
} from "@paperclipai/plugin-sdk/ui";

// Follow the host app's selected language. Paperclip stores the chosen locale
// in localStorage (set by ui/src/i18n); fall back to the browser language only
// if the app hasn't set one. This makes the plugin UI switch with the app's
// language toggle, not just the browser's default.
function resolveAppLocale(): string {
  try {
    const ls = typeof localStorage !== "undefined" ? localStorage : null;
    const picked = ls?.getItem("paperclip.locale.override") || ls?.getItem("paperclip.locale.resolved");
    if (picked) return picked;
  } catch {
    /* localStorage may be unavailable */
  }
  return typeof navigator !== "undefined" ? navigator.language : "en";
}
const isChinese = resolveAppLocale().toLowerCase().startsWith("zh");
function tx(en: string, zh: string): string { return isChinese ? zh : en; }

// Inline-style pages can't use CSS media queries, so detect a narrow viewport in
// JS and switch layout (side-by-side → stacked) accordingly.
function useNarrow(breakpoint = 900): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < breakpoint
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [breakpoint]);
  return narrow;
}

// Shared team filter, persisted in the SAME localStorage key the core app's
// Agents/Office pages use (see ui/src/lib/agent-teams.ts), so a selection made
// on any of the three views moves all of them together. Both sides dispatch a
// custom event for same-window sync; the storage event covers other tabs.
// NOTE: these two constants must mirror agent-teams.ts. Both files are local-
// only (not upstream), so keeping them in sync is the only maintenance cost.
const TEAM_FILTER_KEY_PREFIX = "paperclip.agentTeamFilter.";
const TEAM_FILTER_EVENT = "paperclip:agent-team-filter";

function teamFilterKey(companyId?: string): string {
  return `${TEAM_FILTER_KEY_PREFIX}${companyId ?? "none"}`;
}

function readTeamFilter(companyId?: string): string[] {
  try {
    const raw = localStorage.getItem(teamFilterKey(companyId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function useSharedTeamFilter(companyId?: string): {
  selected: string[];
  setSelected: (next: string[]) => void;
} {
  const [selected, setSel] = useState<string[]>(() => readTeamFilter(companyId));
  useEffect(() => {
    setSel(readTeamFilter(companyId));
  }, [companyId]);
  useEffect(() => {
    const key = teamFilterKey(companyId);
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) setSel(readTeamFilter(companyId));
    };
    const onCustom = () => setSel(readTeamFilter(companyId));
    window.addEventListener("storage", onStorage);
    window.addEventListener(TEAM_FILTER_EVENT, onCustom);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(TEAM_FILTER_EVENT, onCustom);
    };
  }, [companyId]);
  const setSelected = (next: string[]) => {
    setSel(next);
    try {
      localStorage.setItem(teamFilterKey(companyId), JSON.stringify(next));
    } catch {
      /* storage may be unavailable */
    }
    window.dispatchEvent(new CustomEvent(TEAM_FILTER_EVENT, { detail: { companyId: companyId ?? null } }));
  };
  return { selected, setSelected };
}

type HealthData = {
  status: "ok" | "degraded" | "error";
  checkedAt: string;
};

export function DashboardWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<HealthData>("health");
  const ping = usePluginAction("ping");

  if (loading) return <div>Loading plugin health...</div>;
  if (error) return <div>Plugin error: {error.message}</div>;

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <strong>Google Chat</strong>
      <div>Health: {data?.status ?? "unknown"}</div>
      <div>Checked: {data?.checkedAt ?? "never"}</div>
      <button onClick={() => void ping()}>Ping Worker</button>
    </div>
  );
}

type Assignment = {
  email: string;
  agentId: string;
  agentName?: string;
  companyId: string;
  updatedAt: string;
};

type AgentOption = { id: string; name: string; urlKey?: string; teams?: string[] };

type AssignmentsData = {
  companyId: string;
  gateUnassigned: boolean;
  assignments: Assignment[];
  agents: AgentOption[];
};

const cell: React.CSSProperties = { padding: "8px 10px", textAlign: "left" };
// Custom dropdown chevron — the native <select> arrow ignores padding (the
// browser pins it to the border), so we hide it and draw our own where we want.
const SELECT_CHEVRON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#a3a3a3" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
  );

const selectControl: React.CSSProperties = {
  cursor: "pointer",
  width: "100%",
  boxSizing: "border-box",
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  backgroundImage: `url("${SELECT_CHEVRON}")`,
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 12px center",
  backgroundSize: "12px",
  paddingRight: 34
};

function teamChip(active: boolean): React.CSSProperties {
  return {
    borderRadius: 999,
    border: "1px solid var(--border, #3a3a3a)",
    padding: "4px 11px",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    background: active ? "var(--accent, #3b82f6)" : "transparent",
    color: active ? "#fff" : "inherit"
  };
}
const button: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--border, #3a3a3a)",
  background: "transparent",
  cursor: "pointer"
};

export function AssignmentsSettingsPage(_props: PluginPageProps) {
  const host = useHostContext();
  const companyId = host.companyId ?? undefined;
  const { data, loading, error, refresh } = usePluginData<AssignmentsData>(
    "assignments",
    companyId ? { companyId } : {}
  );
  const setAssignment = usePluginAction("assignments.set");
  const removeAssignment = usePluginAction("assignments.remove");

  const [email, setEmail] = useState("");
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Shared with the Agents page + Virtual Office, so the team filter is the same
  // selection everywhere.
  const { selected: teamFilter, setSelected: setTeamFilter } = useSharedTeamFilter(companyId);
  const narrow = useNarrow(900);

  if (loading) return <div>{tx("Loading assignments…", "載入指派中…")}</div>;
  if (error) return <div>{tx("Failed to load:", "載入失敗：")} {error.message}</div>;

  const agents = data?.agents ?? [];
  const assignments = data?.assignments ?? [];

  // Team lookup per agent + the full team list, so the admin can filter a long
  // assignment roster by team instead of scanning one big pile.
  const teamsByAgent = new Map<string, string[]>(agents.map((a) => [a.id, a.teams ?? []]));
  const allTeams = Array.from(new Set(agents.flatMap((a) => a.teams ?? []))).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
  const toggleTeam = (team: string) =>
    setTeamFilter(teamFilter.includes(team) ? teamFilter.filter((t) => t !== team) : [...teamFilter, team]);
  const visibleAssignments =
    teamFilter.length === 0
      ? assignments
      : assignments.filter((a) => (teamsByAgent.get(a.agentId) ?? []).some((t) => teamFilter.includes(t)));

  async function add() {
    setFormError(null);
    if (!email.trim() || !agentId) {
      setFormError(tx("Enter an email and pick an agent.", "請輸入電子郵件並選擇代理。"));
      return;
    }
    setBusy(true);
    try {
      const res = (await setAssignment({ email: email.trim(), agentId, companyId })) as {
        ok?: boolean;
        error?: string;
      };
      if (res?.ok === false) {
        setFormError(res.error ?? tx("Could not save.", "儲存失敗。"));
        return;
      }
      setEmail("");
      setAgentId("");
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: string) {
    setBusy(true);
    try {
      await removeAssignment({ email: target });
      refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 18, maxWidth: 1160 }}>
      <div style={{ display: "grid", gap: 6 }}>
        <strong style={{ fontSize: 16 }}>{tx("Google Chat — agent assignments", "Google Chat — 代理指派")}</strong>
        <div style={{ fontSize: 13, opacity: 0.8, lineHeight: 1.5 }}>
          {tx(
            "Only people listed here get a response from the bot. Everyone else is told to contact 資訊部 (IT).",
            "只有此列表中的成員會收到機器人回應；其他人會被告知聯絡資訊部（IT）。"
          )}{" "}
          {data?.gateUnassigned === false && (
            <em>
              {tx(
                "Gating is currently OFF (everyone reaches the default agent) — turn on “Restrict to assigned users” in Configuration.",
                "目前未啟用限制（所有人都會連到預設代理）—— 請在「設定」中開啟「限定已指派的使用者」。"
              )}
            </em>
          )}
        </div>
      </div>

      {/* Team filter chips — keep a long assignment roster navigable. "All
          teams" clears the filter; multiple teams can be active at once. */}
      {allTeams.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <button type="button" onClick={() => setTeamFilter([])} style={teamChip(teamFilter.length === 0)}>
            {tx("All teams", "所有團隊")}
          </button>
          {allTeams.map((team) => (
            <button
              key={team}
              type="button"
              onClick={() => toggleTeam(team)}
              aria-pressed={teamFilter.includes(team)}
              style={teamChip(teamFilter.includes(team))}
            >
              {team}
            </button>
          ))}
        </div>
      )}

      {/* Two-pane: assignments list (left) + add form (right). The form is
          sticky so it stays in view no matter how long the list grows — no more
          scrolling to the bottom to add someone. On narrow screens the form
          drops below the list. */}
      <div
        style={{
          display: "flex",
          flexDirection: narrow ? "column" : "row",
          gap: 18,
          alignItems: "flex-start"
        }}
      >
        <div style={{ flex: 1, minWidth: 0, width: narrow ? "100%" : undefined }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border, #3a3a3a)" }}>
                <th style={cell}>{tx("Email", "電子郵件")}</th>
                <th style={cell}>{tx("Agent", "代理")}</th>
                <th style={cell} />
              </tr>
            </thead>
            <tbody>
              {visibleAssignments.length === 0 && (
                <tr>
                  <td style={{ ...cell, opacity: 0.6 }} colSpan={3}>
                    {assignments.length === 0
                      ? tx("No assignments yet.", "尚無指派。")
                      : tx("No assignments in the selected team(s).", "所選團隊沒有指派。")}
                  </td>
                </tr>
              )}
              {visibleAssignments.map((a) => (
                <tr key={a.email} style={{ borderBottom: "1px solid var(--border, #2a2a2a)" }}>
                  <td style={cell}>{a.email}</td>
                  <td style={cell}>{a.agentName ?? a.agentId}</td>
                  <td style={{ ...cell, textAlign: "right" }}>
                    <button style={button} disabled={busy} onClick={() => void remove(a.email)}>
                      {tx("Remove", "移除")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div
          style={{
            width: narrow ? "100%" : 320,
            flexShrink: 0,
            position: narrow ? "static" : "sticky",
            top: 12,
            display: "grid",
            gap: 10,
            border: "1px solid var(--border, #3a3a3a)",
            borderRadius: 10,
            padding: 16,
            boxSizing: "border-box"
          }}
        >
          <strong style={{ fontSize: 13 }}>{tx("Add assignment", "新增指派")}</strong>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              type="email"
              placeholder="person@seasonart.org"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ ...button, cursor: "text", width: "100%", boxSizing: "border-box" }}
            />
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              style={{ ...button, ...selectControl }}
            >
              <option value="">{tx("Select agent…", "選擇代理…")}</option>
              {agents.map((ag) => (
                <option key={ag.id} value={ag.id}>
                  {ag.name}
                  {ag.urlKey ? ` (${ag.urlKey})` : ""}
                </option>
              ))}
            </select>
            <button
              style={{ ...button, fontWeight: 600, width: "100%", boxSizing: "border-box" }}
              disabled={busy}
              onClick={() => void add()}
            >
              {busy ? tx("Saving…", "儲存中…") : tx("Add", "新增")}
            </button>
          </div>
          {formError && <div style={{ color: "#e06c6c", fontSize: 12 }}>{formError}</div>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat Logs — a read-only, messaging-app-style viewer of each person's
// conversation with their agent. Left: roster of people (name + role + last
// activity). Right: that person's transcript as chat bubbles. Refreshes on an
// interval for near-real-time monitoring. No reply box — viewing only.
// ---------------------------------------------------------------------------

type ChatPerson = {
  email: string;
  displayName?: string;
  agentId?: string;
  agentName?: string;
  role?: string;
  lastAt: string | null;
  assigned: boolean;
};

type ChatMessage = { role: "user" | "agent"; text: string; at: string };

type PeopleData = { people?: ChatPerson[]; gateUnassigned?: boolean };
type TranscriptData = { messages?: ChatMessage[] };

function personName(p: { displayName?: string; email: string }): string {
  return p.displayName?.trim() || p.email.split("@")[0] || p.email;
}

function avatarInitial(p: { displayName?: string; email: string }): string {
  return (personName(p)[0] ?? "?").toUpperCase();
}

function formatWhen(at: string | null): string {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export function ChatLogsPage(_props: PluginPageProps) {
  const host = useHostContext();
  const companyId = host.companyId ?? undefined;
  const [selected, setSelected] = useState<string | null>(null);

  const peopleQ = usePluginData<PeopleData>("chat-logs", companyId ? { companyId } : {});
  const txQ = usePluginData<TranscriptData>(
    "chat-logs",
    companyId && selected
      ? { companyId, email: selected }
      : { companyId: companyId ?? "", email: "" }
  );

  // Poll for near-real-time updates without re-subscribing every render.
  const txRefresh = useRef(txQ.refresh);
  txRefresh.current = txQ.refresh;
  const peopleRefresh = useRef(peopleQ.refresh);
  peopleRefresh.current = peopleQ.refresh;
  useEffect(() => {
    if (!selected) return;
    const id = setInterval(() => txRefresh.current(), 5000);
    return () => clearInterval(id);
  }, [selected]);
  useEffect(() => {
    const id = setInterval(() => peopleRefresh.current(), 20000);
    return () => clearInterval(id);
  }, []);

  const people = peopleQ.data?.people ?? [];
  const messages = selected ? txQ.data?.messages ?? [] : [];
  const selectedPerson = people.find((p) => p.email === selected) ?? null;

  // Keep the transcript pinned to the newest message.
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, selected]);

  const border = "1px solid var(--border, #3a3a3a)";
  const wrap: React.CSSProperties = {
    display: "flex",
    border,
    borderRadius: 8,
    overflow: "hidden",
    // Fill the available page: nearly full viewport height (minus header/chrome)
    // and full width, instead of the previous small 1000px / 70vh box.
    height: "calc(100vh - 210px)",
    minHeight: 520,
    width: "100%"
  };
  const avatarStyle: React.CSSProperties = {
    width: 34,
    height: 34,
    borderRadius: "50%",
    background: "var(--accent, #3b82f6)",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 600,
    fontSize: 14,
    flexShrink: 0
  };

  function bubble(role: ChatMessage["role"]): React.CSSProperties {
    const isUser = role === "user";
    return {
      maxWidth: "74%",
      background: isUser ? "var(--accent, #3b82f6)" : "var(--surface, #2b2b2b)",
      color: isUser ? "#fff" : "inherit",
      padding: "8px 12px",
      borderRadius: 12,
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      fontSize: 13,
      lineHeight: 1.55,
      border: isUser ? "none" : border
    };
  }

  if (peopleQ.loading && !peopleQ.data) return <div>Loading chat logs…</div>;
  if (peopleQ.error) return <div>Failed to load: {peopleQ.error.message}</div>;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gap: 6 }}>
        <strong style={{ fontSize: 16 }}>Google Chat — 聊天紀錄 (Chat Logs)</strong>
        <div style={{ fontSize: 13, opacity: 0.8, lineHeight: 1.5 }}>
          唯讀檢視每位同仁與其 AI 代理在 Google Chat 上的對話。點左側人員即可查看。
          {peopleQ.data?.gateUnassigned === false && (
            <em> （目前未開啟「限指派用戶」，所有人都會落到預設代理。）</em>
          )}
        </div>
      </div>

      <div style={wrap}>
        {/* Left: people roster */}
        <div
          style={{
            width: 300,
            borderRight: border,
            display: "flex",
            flexDirection: "column",
            minWidth: 0
          }}
        >
          <div style={{ padding: "10px 12px", borderBottom: border, fontSize: 12, opacity: 0.7 }}>
            {people.length} 人
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {people.length === 0 && (
              <div style={{ padding: 14, fontSize: 13, opacity: 0.6 }}>目前還沒有任何對話紀錄。</div>
            )}
            {people.map((p) => {
              const isSel = p.email === selected;
              return (
                <div
                  key={p.email}
                  onClick={() => setSelected(p.email)}
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    padding: "10px 12px",
                    cursor: "pointer",
                    borderBottom: "1px solid var(--border, #232323)",
                    background: isSel ? "var(--hover, rgba(127,127,127,0.14))" : "transparent"
                  }}
                >
                  <div style={avatarStyle}>{avatarInitial(p)}</div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                    >
                      {personName(p)}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        opacity: 0.7,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                    >
                      {p.role ? p.role : p.assigned ? p.agentName ?? "已指派" : "未指派"}
                    </div>
                  </div>
                  {p.lastAt && (
                    <div style={{ fontSize: 10, opacity: 0.5, flexShrink: 0 }}>
                      {new Date(p.lastAt).toLocaleDateString()}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: transcript */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {!selectedPerson ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                opacity: 0.55,
                fontSize: 13,
                padding: 20,
                textAlign: "center"
              }}
            >
              ← 從左側選擇一位同仁來檢視對話
            </div>
          ) : (
            <>
              <div style={{ padding: "10px 14px", borderBottom: border }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {personName(selectedPerson)}
                  {selectedPerson.role ? (
                    <span style={{ fontSize: 12, opacity: 0.7, fontWeight: 400 }}>
                      {"  ·  "}
                      {selectedPerson.role}
                    </span>
                  ) : null}
                </div>
                <div style={{ fontSize: 11, opacity: 0.65 }}>
                  {selectedPerson.email}
                  {selectedPerson.agentName ? `　→　代理：${selectedPerson.agentName}` : ""}
                </div>
              </div>

              <div
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: 14,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  background: "var(--surface-muted, rgba(127,127,127,0.06))"
                }}
              >
                {messages.length === 0 && (
                  <div style={{ opacity: 0.55, fontSize: 13 }}>（尚無對話內容）</div>
                )}
                {messages.map((m, i) => {
                  const isUser = m.role === "user";
                  return (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: isUser ? "flex-end" : "flex-start",
                        gap: 2
                      }}
                    >
                      <div style={bubble(m.role)}>{m.text}</div>
                      <span style={{ fontSize: 10, opacity: 0.5 }}>
                        {(isUser ? "👤 " : "🤖 ") + formatWhen(m.at)}
                      </span>
                    </div>
                  );
                })}
                <div ref={endRef} />
              </div>

              <div
                style={{
                  padding: "8px 12px",
                  borderTop: border,
                  fontSize: 12,
                  opacity: 0.7,
                  textAlign: "center"
                }}
              >
                🔒 唯讀監看 — 僅供檢視對話，無法回覆 · Read-only
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
