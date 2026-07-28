// Explicit allowlist of Claude Code tools we permit when running on a remote
// target. We use this instead of `--dangerously-skip-permissions` for remote
// targets because the permission-approval prompts can't be answered by a
// human inside a non-interactive run, but blanket-allowing every tool would
// defeat the point of having a separate hosted/sandbox code path.
//
// Maintenance: this list must be reviewed when Claude Code releases a new
// tool. The canonical list of built-in tools is documented at
// https://docs.claude.com/en/docs/claude-code/built-in-tools — when a tool
// is added there, decide whether it should be allowed in remote runs and
// either add it here or document the deliberate exclusion. Omitting a tool
// silently disables it inside remote targets, which can look like the tool is
// "broken" rather than intentionally gated.
const SANDBOX_ALLOWED_TOOLS =
  "Task AskUserQuestion Bash CronCreate CronDelete CronList Edit " +
  "EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor " +
  "NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill " +
  "TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write";

// The claude.ai Google Calendar/Drive MCP connectors are a SINGLE shared
// connector identity (bound to one account), so an agent using them reads the
// WRONG user's data, and they don't do our per-user token auto-refresh. Agents
// must instead use the Paperclip server-side Google endpoints (which use each
// responsible user's own token with refresh — see the paperclip skill's
// google-chat-and-calendar reference + AGENTS rules). Block them at the tool
// layer for EVERY local run so no agent — existing or future — can fall back to
// MCP regardless of its per-agent config. (Remote runs already exclude them: the
// SANDBOX_ALLOWED_TOOLS allowlist has no mcp__claude_ai_* entries.)
const BLOCKED_LOCAL_MCP_CONNECTORS = "mcp__claude_ai_Google_Calendar mcp__claude_ai_Google_Drive";

function localSkipWithBlockedMcp(): string[] {
  return ["--dangerously-skip-permissions", "--disallowedTools", BLOCKED_LOCAL_MCP_CONNECTORS];
}

export function buildClaudeProbePermissionArgs(input: {
  dangerouslySkipPermissions: boolean;
  targetIsRemote: boolean;
}): string[] {
  if (!input.dangerouslySkipPermissions) return [];
  // For remote targets, mirror the execution path: pass `--allowedTools`
  // with the curated allowlist instead of dropping the flag entirely. The
  // hello probe is a one-shot prompt that should never trigger a tool, but
  // if a future probe prompt does, we don't want Claude CLI to stall on an
  // interactive permission prompt that no human can answer.
  if (input.targetIsRemote) return ["--allowedTools", SANDBOX_ALLOWED_TOOLS];
  return localSkipWithBlockedMcp();
}

export function buildClaudeExecutionPermissionArgs(input: {
  dangerouslySkipPermissions: boolean;
  targetIsRemote: boolean;
}): string[] {
  if (!input.dangerouslySkipPermissions) return [];
  if (input.targetIsRemote) {
    return ["--allowedTools", SANDBOX_ALLOWED_TOOLS];
  }
  return localSkipWithBlockedMcp();
}
