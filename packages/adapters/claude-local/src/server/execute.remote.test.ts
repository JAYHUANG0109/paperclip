import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
  getQuotaWindowsForEnv,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "ssh://fixture@127.0.0.1:2222/remote/workspace :: claude"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  syncDirectoryToSsh: vi.fn(async () => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
  getQuotaWindowsForEnv: vi.fn(async () => ({
    provider: "anthropic",
    source: "test",
    ok: true,
    windows: [{ label: "Current session", usedPercent: 10, resetsAt: null, valueLabel: null, detail: null }],
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    syncDirectoryToSsh,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

vi.mock("./quota.js", async () => {
  const actual = await vi.importActual<typeof import("./quota.js")>("./quota.js");
  return {
    ...actual,
    getQuotaWindowsForEnv,
  };
});

import { execute } from "./execute.js";

describe("claude remote execution", () => {
  const cleanupDirs: string[] = [];
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeEach(async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-test-home-"));
    cleanupDirs.push(homeDir);
    process.env.PAPERCLIP_HOME = homeDir;
    process.env.PAPERCLIP_INSTANCE_ID = "test";
  });

  afterEach(async () => {
    vi.clearAllMocks();
    getQuotaWindowsForEnv.mockResolvedValue({
      provider: "anthropic",
      source: "test",
      ok: true,
      windows: [{ label: "Current session", usedPercent: 10, resetsAt: null, valueLabel: null, detail: null }],
    });
    if (originalPaperclipHome == null) {
      delete process.env.PAPERCLIP_HOME;
    } else {
      process.env.PAPERCLIP_HOME = originalPaperclipHome;
    }
    if (originalPaperclipInstanceId == null) {
      delete process.env.PAPERCLIP_INSTANCE_ID;
    } else {
      process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("prepares the workspace, syncs Claude runtime assets, and restores workspace changes for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-remote-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const alternateWorkspaceDir = path.join(rootDir, "workspace-other");
    const instructionsPath = path.join(rootDir, "instructions.md");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-1/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(alternateWorkspaceDir, { recursive: true });
    await writeFile(instructionsPath, "Use the remote workspace.\n", "utf8");

    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "claude",
        instructionsFilePath: instructionsPath,
        env: {
          QA_PROJECT_WORKSPACE_CWD: workspaceDir,
          RANDOM_WORKSPACE_CWD: workspaceDir,
          OTHER_ENV: workspaceDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          strategy: "git_worktree",
          workspaceId: "workspace-1",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          repoRef: "main",
          branchName: "feature/remote-claude",
          worktreePath: workspaceDir,
        },
        paperclipWorkspaces: [
          {
            workspaceId: "workspace-1",
            cwd: workspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "main",
          },
          {
            workspaceId: "workspace-2",
            cwd: alternateWorkspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "feature/other",
          },
        ],
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: `${managedRemoteWorkspace}/.paperclip-runtime/claude/skills`,
      followSymlinks: true,
    }));
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2]).toContain("--allowedTools");
    expect(call?.[2]).toContain(
      "Task AskUserQuestion Bash CronCreate CronDelete CronList Edit EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write",
    );
    expect(call?.[2]).not.toContain("--dangerously-skip-permissions");
    expect(call?.[2]).toContain("--append-system-prompt-file");
    expect(call?.[2]).toContain(
      `${managedRemoteWorkspace}/.paperclip-runtime/claude/skills/agent-instructions.md`,
    );
    expect(call?.[2]).toContain("--add-dir");
    expect(call?.[2]).toContain(`${managedRemoteWorkspace}/.paperclip-runtime/claude/skills`);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_WORKTREE_PATH).toBeUndefined();
    expect(JSON.parse(call?.[3].env.PAPERCLIP_WORKSPACES_JSON ?? "[]")).toEqual([
      {
        workspaceId: "workspace-1",
        cwd: managedRemoteWorkspace,
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "main",
      },
      {
        workspaceId: "workspace-2",
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "feature/other",
      },
    ]);
    expect(call?.[3].env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:4310");
    expect(call?.[3].env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
    expect(call?.[3].env.QA_PROJECT_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(call?.[3].env.RANDOM_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(call?.[3].env.OTHER_ENV).toBe(workspaceDir);
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
  });

  it("does not resume saved Claude sessions for remote SSH execution without a matching remote identity", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-remote-resume-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    await execute({
      runId: "run-ssh-no-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "12345678-1234-4abc-9def-123456789012",
        sessionParams: {
          sessionId: "12345678-1234-4abc-9def-123456789012",
          cwd: "/remote/workspace",
        },
        sessionDisplayId: "12345678-1234-4abc-9def-123456789012",
        taskKey: null,
      },
      config: {
        command: "claude",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).not.toContain("--resume");
  });

  it("resumes saved Claude sessions for remote SSH execution when the remote identity matches", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-remote-resume-match-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-ssh-resume/workspace";
    await mkdir(workspaceDir, { recursive: true });

    await execute({
      runId: "run-ssh-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "12345678-1234-4abc-9def-123456789012",
        sessionParams: {
          sessionId: "12345678-1234-4abc-9def-123456789012",
          cwd: managedRemoteWorkspace,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: managedRemoteWorkspace,
          },
        },
        sessionDisplayId: "12345678-1234-4abc-9def-123456789012",
        taskKey: null,
      },
      config: {
        command: "claude",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).toContain("--resume");
    expect(call?.[2]).toContain("12345678-1234-4abc-9def-123456789012");
  });

  it("switches local Claude account config dirs after a usage-limit failure", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-switch-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const accountB = path.join(rootDir, "account-b");
    await mkdir(workspaceDir, { recursive: true });

    runChildProcess
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Claude usage limit reached. Try again later.",
        pid: 111,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-b", model: "claude-sonnet" }),
          JSON.stringify({ type: "result", session_id: "claude-session-b", result: "done", usage: { input_tokens: 2, cache_read_input_tokens: 0, output_tokens: 3 } }),
        ].join("\n"),
        stderr: "",
        pid: 112,
        startedAt: new Date().toISOString(),
      });

    const logs: string[] = [];
    const metaEnvs: Array<Record<string, string>> = [];
    const result = await execute({
      runId: "run-switch",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "claude",
        cwd: workspaceDir,
        accountConfigDirs: [
          "claude_bot_13@seasonart.org=default",
          `claude_bot_08@seasonart.org=${accountB}`,
        ],
      },
      context: {},
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      onMeta: async (meta) => {
        metaEnvs.push({ ...(meta.env ?? {}) });
      },
    });

    expect(runChildProcess).toHaveBeenCalledTimes(2);
    expect(metaEnvs[0]?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(metaEnvs[1]?.CLAUDE_CONFIG_DIR).toBe(accountB);
    expect(logs.join("")).toContain('hit a usage limit; switching to "claude_bot_08@seasonart.org"');
    expect(result.errorCode).toBeNull();
    expect(result.sessionId).toBe("claude-session-b");
    expect(result.sessionParams).toMatchObject({ claudeConfigDir: accountB });
    expect(result.resultJson).toMatchObject({
      claudeAccountConfigDir: accountB,
      claudeAccountLabel: "claude_bot_08@seasonart.org",
    });
  });

  it("proactively switches through three local Claude accounts at the quota threshold", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-threshold-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const accountB = path.join(rootDir, "account-b");
    const accountC = path.join(rootDir, "account-c");
    await mkdir(workspaceDir, { recursive: true });

    getQuotaWindowsForEnv
      .mockResolvedValueOnce({
        provider: "anthropic",
        source: "test",
        ok: true,
        windows: [{ label: "Current session", usedPercent: 95, resetsAt: null, valueLabel: null, detail: null }],
      })
      .mockResolvedValueOnce({
        provider: "anthropic",
        source: "test",
        ok: true,
        windows: [{ label: "Current session", usedPercent: 98, resetsAt: null, valueLabel: null, detail: null }],
      })
      .mockResolvedValueOnce({
        provider: "anthropic",
        source: "test",
        ok: true,
        windows: [{ label: "Current session", usedPercent: 40, resetsAt: null, valueLabel: null, detail: null }],
      });

    const logs: string[] = [];
    const metaEnvs: Array<Record<string, string>> = [];
    const result = await execute({
      runId: "run-threshold-switch",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-default",
        sessionParams: {
          sessionId: "session-default",
          cwd: workspaceDir,
          claudeConfigDir: "default",
        },
        sessionDisplayId: "session-default",
        taskKey: null,
      },
      config: {
        command: "claude",
        cwd: workspaceDir,
        accountConfigDirs: [
          "claude_bot_13@seasonart.org=default",
          `claude_bot_08@seasonart.org=${accountB}`,
          `jay20020109@gmail.com=${accountC}`,
        ],
        quotaSwitchThresholdPercent: 95,
      },
      context: {},
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      onMeta: async (meta) => {
        metaEnvs.push({ ...(meta.env ?? {}) });
      },
    });

    expect(getQuotaWindowsForEnv).toHaveBeenCalledTimes(3);
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(metaEnvs).toHaveLength(1);
    expect(metaEnvs[0]?.CLAUDE_CONFIG_DIR).toBe(accountC);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    const commandArgs = call?.[2];
    expect(commandArgs).not.toContain("--resume");
    expect(logs.join("")).toContain('"claude_bot_13@seasonart.org" is at 95% quota usage');
    expect(logs.join("")).toContain('"claude_bot_08@seasonart.org" is at 98% quota usage');
    expect(result.errorCode).toBeNull();
    expect(result.resultJson).toMatchObject({
      claudeAccountConfigDir: accountC,
      claudeAccountLabel: "jay20020109@gmail.com",
    });
    expect(result.sessionParams).toMatchObject({ claudeConfigDir: accountC });
  });

});
