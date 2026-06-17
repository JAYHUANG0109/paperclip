import { useEffect, useRef, useState } from "react";
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  type PluginPageProps,
  type PluginWidgetProps
} from "@paperclipai/plugin-sdk/ui";

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

type AgentOption = { id: string; name: string; urlKey?: string };

type AssignmentsData = {
  companyId: string;
  gateUnassigned: boolean;
  assignments: Assignment[];
  agents: AgentOption[];
};

const cell: React.CSSProperties = { padding: "8px 10px", textAlign: "left" };
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

  if (loading) return <div>Loading assignments…</div>;
  if (error) return <div>Failed to load: {error.message}</div>;

  const agents = data?.agents ?? [];
  const assignments = data?.assignments ?? [];

  async function add() {
    setFormError(null);
    if (!email.trim() || !agentId) {
      setFormError("Enter an email and pick an agent.");
      return;
    }
    setBusy(true);
    try {
      const res = (await setAssignment({ email: email.trim(), agentId, companyId })) as {
        ok?: boolean;
        error?: string;
      };
      if (res?.ok === false) {
        setFormError(res.error ?? "Could not save.");
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
    <div style={{ display: "grid", gap: 18, maxWidth: 760 }}>
      <div style={{ display: "grid", gap: 6 }}>
        <strong style={{ fontSize: 16 }}>Google Chat — agent assignments</strong>
        <div style={{ fontSize: 13, opacity: 0.8, lineHeight: 1.5 }}>
          Only people listed here get a response from the bot. Everyone else is
          told to contact 資訊部 (IT).{" "}
          {data?.gateUnassigned === false && (
            <em>
              Gating is currently OFF (everyone reaches the default agent) — turn
              on “Restrict to assigned users” in Configuration.
            </em>
          )}
        </div>
      </div>

      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border, #3a3a3a)" }}>
            <th style={cell}>Email</th>
            <th style={cell}>Agent</th>
            <th style={cell} />
          </tr>
        </thead>
        <tbody>
          {assignments.length === 0 && (
            <tr>
              <td style={{ ...cell, opacity: 0.6 }} colSpan={3}>
                No assignments yet.
              </td>
            </tr>
          )}
          {assignments.map((a) => (
            <tr key={a.email} style={{ borderBottom: "1px solid var(--border, #2a2a2a)" }}>
              <td style={cell}>{a.email}</td>
              <td style={cell}>{a.agentName ?? a.agentId}</td>
              <td style={{ ...cell, textAlign: "right" }}>
                <button style={button} disabled={busy} onClick={() => void remove(a.email)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: "grid", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>Add assignment</strong>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="email"
            placeholder="person@seasonart.org"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ ...button, cursor: "text", minWidth: 240 }}
          />
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            style={{ ...button, cursor: "pointer", minWidth: 200 }}
          >
            <option value="">Select agent…</option>
            {agents.map((ag) => (
              <option key={ag.id} value={ag.id}>
                {ag.name}
                {ag.urlKey ? ` (${ag.urlKey})` : ""}
              </option>
            ))}
          </select>
          <button
            style={{ ...button, fontWeight: 600 }}
            disabled={busy}
            onClick={() => void add()}
          >
            {busy ? "Saving…" : "Add"}
          </button>
        </div>
        {formError && <div style={{ color: "#e06c6c", fontSize: 12 }}>{formError}</div>}
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
    height: "70vh",
    minHeight: 440,
    maxWidth: 1000
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
      <div style={{ display: "grid", gap: 6, maxWidth: 1000 }}>
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
