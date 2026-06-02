import { useState } from "react";
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  type PluginCompanySettingsPageProps,
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

export function AssignmentsSettingsPage(_props: PluginCompanySettingsPageProps) {
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
