// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest"

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }))

import {
  ACP_ROLE_SLOTS,
  ANTIGRAVITY_ACP_EVENT_TOPIC,
  MCP_TOOL_PROFILES,
  authenticateAntigravityAcp,
  cancelAntigravityAcpTurn,
  connectAntigravityAcp,
  createAntigravityAcpSession,
  disconnectAntigravityAcp,
  getAntigravityAcpStatus,
  getWriterPluginStatus,
  installGlobalWriterPlugin,
  isAcpAuthRequiredError,
  isAcpRoleSlotId,
  isWriterPluginStatus,
  listenAntigravityAcpEvents,
  parseAcpConfigOptions,
  parseAcpSessionUpdate,
  respondAntigravityAcpPermission,
  sendAntigravityAcpPrompt,
  setAntigravityAcpConfigOption,
  switchAntigravityAcpSlot,
  syncProjectWriterPlugin,
  type AcpEventPayload,
  type AcpPendingPermission,
  type AcpPromptResult,
  type AcpRoleSlotId,
  type AcpSessionResult,
  type AcpSlotStatusSnapshot,
  type AcpStatusSnapshot,
  type LocalMcpStaleReason,
  type McpToolProfile,
  type WriterPluginGlobalResult,
  type WriterPluginStatus,
  type WriterPluginSyncResult,
} from "./antigravity-acp-client"

describe("antigravity-acp-client", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
  })

  it("parses flat and grouped ACP configOptions (model / thinking selectors)", () => {
    const parsed = parseAcpConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "gemini-3-pro",
        options: [
          {
            group: "Gemini",
            options: [
              { value: "gemini-3-pro", name: "Gemini 3 Pro" },
              { value: "gemini-3-flash", name: "Gemini 3 Flash" },
            ],
          },
          { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        ],
      },
      {
        id: "thinking",
        name: "Thinking",
        currentValue: "high",
        options: [
          { id: "low", name: "Low" },
          { id: "high", name: "High" },
        ],
      },
      // Empty options should be ignored
      { id: "empty", name: "Empty", options: [] },
    ])

    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toEqual({
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "gemini-3-pro",
      options: [
        { value: "gemini-3-pro", name: "Gemini 3 Pro", description: undefined },
        { value: "gemini-3-flash", name: "Gemini 3 Flash", description: undefined },
        { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", description: undefined },
      ],
    })
    expect(parsed[1]?.options.map((o) => o.value)).toEqual(["low", "high"])
  })

  it("parses ACP session/update notifications across all supported kinds", () => {
    expect(
      parseAcpSessionUpdate({
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } },
      }),
    ).toEqual({ type: "agent_message_chunk", text: "Hello" })

    expect(
      parseAcpSessionUpdate({
        update: { sessionUpdate: "agent_thought_chunk", content: [{ text: "Step 1 " }, { text: "Step 2" }] },
      }),
    ).toEqual({ type: "agent_thought_chunk", text: "Step 1 Step 2" })

    expect(
      parseAcpSessionUpdate({
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "Read chapter 01",
          status: "completed",
        },
      }),
    ).toEqual({ type: "tool_call", toolCallId: "tc-1", title: "Read chapter 01", status: "completed" })

    expect(
      parseAcpSessionUpdate({
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
        },
      }),
    ).toEqual({ type: "tool_call", toolCallId: "tc-1", title: null, status: "completed" })

    const cfg = parseAcpSessionUpdate({
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [
          { id: "model", name: "Model", currentValue: "m1", options: [{ value: "m1", name: "M1" }] },
        ],
      },
    })
    expect(cfg).toEqual({
      type: "config_option_update",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: undefined,
          currentValue: "m1",
          options: [{ value: "m1", name: "M1", description: undefined }],
        },
      ],
    })

    expect(parseAcpSessionUpdate({ update: { sessionUpdate: "plan" } })).toEqual({
      type: "other",
      sessionUpdate: "plan",
    })
    expect(parseAcpSessionUpdate({})).toBeNull()
  })

  it("detects standard ACP -32000 Authentication required errors and rejects non-auth codes/causes", () => {
    // 明确认证错误与裸 -32000 认证错误 -> true
    expect(isAcpAuthRequiredError("[ACP -32000] Authentication required")).toBe(true)
    expect(isAcpAuthRequiredError("Authentication Required by server")).toBe(true)
    expect(isAcpAuthRequiredError("Unauthenticated request")).toBe(true)
    expect(isAcpAuthRequiredError("User is not authenticated")).toBe(true)
    expect(isAcpAuthRequiredError("[ACP -32000]")).toBe(true)
    expect(isAcpAuthRequiredError("[ACP -32000] Server error")).toBe(true)

    // 非认证错误码（含 -320001 子串陷阱）-> false
    expect(isAcpAuthRequiredError("[ACP -32096] session busy")).toBe(false)
    expect(isAcpAuthRequiredError("[ACP -32097] tool error")).toBe(false)
    expect(isAcpAuthRequiredError("[ACP -32098] cancelled")).toBe(false)
    expect(isAcpAuthRequiredError("[ACP -32099] timed out")).toBe(false)
    expect(isAcpAuthRequiredError("[ACP -32601] Method not found")).toBe(false)
    expect(isAcpAuthRequiredError("[ACP -32602] Invalid params")).toBe(false)
    expect(isAcpAuthRequiredError("[ACP -320001] Internal error")).toBe(false)

    // -32000 但携带明确非认证原因 -> false
    expect(isAcpAuthRequiredError("[ACP -32000] rate limit exceeded")).toBe(false)
    expect(isAcpAuthRequiredError("[ACP -32000] invalid workspace path")).toBe(false)
    expect(isAcpAuthRequiredError("[ACP -32000] request timed out")).toBe(false)
    expect(isAcpAuthRequiredError("[ACP -32000] prompt cancelled by user")).toBe(false)
    expect(isAcpAuthRequiredError("[ACP -32000] session is busy")).toBe(false)
    expect(isAcpAuthRequiredError("[ACP -32000] permission denied")).toBe(false)

    // 普通网络错误 / 空串 -> false
    expect(isAcpAuthRequiredError("connection refused")).toBe(false)
    expect(isAcpAuthRequiredError("")).toBe(false)
  })

  it("preserves additive optional ACP metadata fields and typed AcpPromptResult", async () => {
    const permission: AcpPendingPermission = {
      requestId: "perm-1",
      sessionId: "sess-1",
      title: "Write draft",
      options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
      toolKind: "mcp",
      locations: [".qm-drafts/draft_1.md"],
      rawInputSummary: "chapterName=第1章",
    }
    const status: AcpStatusSnapshot = {
      connected: true,
      binaryPath: "agy",
      agentName: "antigravity",
      agentVersion: "1.0.0",
      protocolVersion: 1,
      authMethods: [],
      activeSessionId: "sess-1",
      cwd: "/book",
      configOptions: [],
      pendingPermissions: [permission],
      httpMcpEnabled: true,
      attachedLocalMcp: true,
      localMcpScope: "draft_write",
      inFlightPrompt: false,
    }
    const session: AcpSessionResult = {
      sessionId: "sess-1",
      cwd: "/book",
      configOptions: [],
      attachedLocalMcp: false,
      rawResult: {},
      localMcpScope: null,
      localMcpSkipReason: "mcp_server_not_running",
    }
    const promptRes: AcpPromptResult = {
      stopReason: "end_turn",
      usage: { inputTokens: 120, outputTokens: 80 },
      rawResult: { stopReason: "end_turn" },
    }

    invokeMock.mockResolvedValueOnce(status)
    expect(await getAntigravityAcpStatus()).toEqual(status)

    invokeMock.mockResolvedValueOnce(session)
    expect(await createAntigravityAcpSession("/book", true)).toEqual(session)

    invokeMock.mockResolvedValueOnce(promptRes)
    const result = await sendAntigravityAcpPrompt({ sessionId: "sess-1", text: "Check chapter" })
    expect(result.stopReason).toBe("end_turn")
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 80 })
  })

  it("invokes all 9 Rust ACP commands with exact camelCase keys", async () => {
    invokeMock.mockResolvedValue({})

    await getAntigravityAcpStatus()
    expect(invokeMock).toHaveBeenLastCalledWith("antigravity_acp_status")

    await connectAntigravityAcp({ cwd: "/book", enableHttpMcp: true })
    expect(invokeMock).toHaveBeenLastCalledWith("antigravity_acp_connect", {
      cwd: "/book",
      enableHttpMcp: true,
    })

    await authenticateAntigravityAcp("oauth-personal")
    expect(invokeMock).toHaveBeenLastCalledWith("antigravity_acp_authenticate", {
      methodId: "oauth-personal",
    })

    await createAntigravityAcpSession("/book", true)
    expect(invokeMock).toHaveBeenLastCalledWith("antigravity_acp_new_session", {
      cwd: "/book",
      attachLocalMcp: true,
    })

    await sendAntigravityAcpPrompt({
      sessionId: "sess-1",
      text: "Polish chapter 1",
      contextTitle: "ch01.md",
      contextText: "Draft text",
    })
    expect(invokeMock).toHaveBeenLastCalledWith("antigravity_acp_prompt", {
      sessionId: "sess-1",
      text: "Polish chapter 1",
      contextTitle: "ch01.md",
      contextText: "Draft text",
    })

    await cancelAntigravityAcpTurn("sess-1")
    expect(invokeMock).toHaveBeenLastCalledWith("antigravity_acp_cancel", { sessionId: "sess-1" })

    await setAntigravityAcpConfigOption("sess-1", "model", "gemini-3-pro")
    expect(invokeMock).toHaveBeenLastCalledWith("antigravity_acp_set_config_option", {
      sessionId: "sess-1",
      configId: "model",
      value: "gemini-3-pro",
    })

    await respondAntigravityAcpPermission("perm-7", "allow_once")
    expect(invokeMock).toHaveBeenLastCalledWith("antigravity_acp_respond_permission", {
      requestId: "perm-7",
      optionId: "allow_once",
    })

    await disconnectAntigravityAcp()
    expect(invokeMock).toHaveBeenLastCalledWith("antigravity_acp_disconnect")
  })

  it("subscribes to unified antigravity-acp:event topic", async () => {
    const unlisten = vi.fn()
    let captured: ((e: { payload: unknown }) => void) | undefined
    listenMock.mockImplementation(async (topic: string, cb: (e: { payload: unknown }) => void) => {
      expect(topic).toBe(ANTIGRAVITY_ACP_EVENT_TOPIC)
      captured = cb
      return unlisten
    })

    const received: unknown[] = []
    const off = await listenAntigravityAcpEvents((p) => received.push(p))
    captured?.({ payload: { kind: "disconnected", reason: "eof" } })
    expect(received).toEqual([{ kind: "disconnected", reason: "eof" }])
    off()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it("supports R2 status fields (supportsHttpMcp/supportsLoadSession/localMcpStale), agent_unsupported skipReason, and protocol_warning events", async () => {
    const staleReasons: LocalMcpStaleReason[] = [
      "mcp_server_stopped",
      "token_rotated",
      "port_changed",
      "scope_changed",
      "server_restarted",
    ]

    for (const reason of staleReasons) {
      const status: AcpStatusSnapshot = {
        connected: true,
        binaryPath: "agy",
        agentName: "antigravity",
        agentVersion: "2.0.0",
        protocolVersion: 1,
        authMethods: [],
        activeSessionId: "sess-r2",
        cwd: "/book",
        configOptions: [],
        pendingPermissions: [],
        httpMcpEnabled: true,
        attachedLocalMcp: true,
        localMcpScope: "draft_write",
        inFlightPrompt: false,
        supportsHttpMcp: true,
        supportsLoadSession: false,
        localMcpStale: true,
        localMcpStaleReason: reason,
      }
      invokeMock.mockResolvedValueOnce(status)
      const receivedStatus = await getAntigravityAcpStatus()
      expect(receivedStatus.supportsHttpMcp).toBe(true)
      expect(receivedStatus.supportsLoadSession).toBe(false)
      expect(receivedStatus.localMcpStale).toBe(true)
      expect(receivedStatus.localMcpStaleReason).toBe(reason)
    }

    const unsupportedSession: AcpSessionResult = {
      sessionId: "sess-no-http-mcp",
      cwd: "/book",
      configOptions: [],
      attachedLocalMcp: false,
      rawResult: {},
      localMcpScope: null,
      localMcpSkipReason: "agent_unsupported",
    }
    invokeMock.mockResolvedValueOnce(unsupportedSession)
    const created = await createAntigravityAcpSession("/book", true)
    expect(created.localMcpSkipReason).toBe("agent_unsupported")

    const unlisten = vi.fn()
    let captured: ((e: { payload: AcpEventPayload }) => void) | undefined
    listenMock.mockImplementationOnce(async (_topic: string, cb: (e: { payload: AcpEventPayload }) => void) => {
      captured = cb
      return unlisten
    })
    const events: AcpEventPayload[] = []
    const off = await listenAntigravityAcpEvents((payload) => events.push(payload))
    const warningPayload: AcpEventPayload = {
      kind: "protocol_warning",
      code: "oversized_stdout_line",
      bytes: 12_582_912,
      limitBytes: 8_388_608,
      preview: "{\"jsonrpc\":\"2.0\"...",
      message: "ACP stdout frame exceeded 8 MiB limit and was dropped.",
    }
    captured?.({ payload: warningPayload })
    expect(events).toEqual([warningPayload])
    off()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  // ── P1-B4: MCP tool profiles + Writer Plugin IPC wrappers + runtime guard ──

  it("supports MCP_TOOL_PROFILES, dual-branch createAntigravityAcpSession, and additive profile/warning fields", async () => {
    expect([...MCP_TOOL_PROFILES]).toEqual(["writer-sub", "reviewer", "architect", "full-legacy"])

    invokeMock.mockResolvedValue({
      sessionId: "sess-p1",
      cwd: "/book",
      configOptions: [],
      attachedLocalMcp: true,
      rawResult: {},
      localMcpScope: "draft_write",
      localMcpProfile: "writer-sub" as McpToolProfile,
      parentCodeRepoWarning: null,
    } satisfies AcpSessionResult)

    // 省略 mcpProfile 时保持双字段静态对象（不携带 mcpProfile 键）
    await createAntigravityAcpSession("/book", true)
    expect(invokeMock).toHaveBeenLastCalledWith("antigravity_acp_new_session", {
      cwd: "/book",
      attachLocalMcp: true,
    })

    // 显式传入各个 profile 与 null 时走三字段静态分支
    for (const profile of [...MCP_TOOL_PROFILES, null] as const) {
      const session = await createAntigravityAcpSession("/book", true, profile)
      expect(invokeMock).toHaveBeenLastCalledWith("antigravity_acp_new_session", {
        cwd: "/book",
        attachLocalMcp: true,
        mcpProfile: profile,
      })
      expect(session.localMcpProfile).toBe("writer-sub")
    }

    const statusWithWarning: AcpStatusSnapshot = {
      connected: true,
      binaryPath: "agy",
      agentName: "antigravity",
      agentVersion: "2.1.0",
      protocolVersion: 1,
      authMethods: [],
      activeSessionId: "sess-p1",
      cwd: "/book",
      configOptions: [],
      pendingPermissions: [],
      httpMcpEnabled: true,
      localMcpProfile: "reviewer",
      parentCodeRepoWarning: "Detected parent git code repository above project folder.",
    }
    invokeMock.mockResolvedValueOnce(statusWithWarning)
    const st = await getAntigravityAcpStatus()
    expect(st.localMcpProfile).toBe("reviewer")
    expect(st.parentCodeRepoWarning).toContain("parent git code repository")
  })

  it("invokes all 3 Writer Plugin IPC commands with exact literal names and camelCase keys", async () => {
    const sampleStatus: WriterPluginStatus = {
      pluginName: "niko-buddy-writer",
      pluginVersion: "1.0.0",
      declarativeOnly: true,
      skillCount: 6,
      agentCount: 3,
      isolatedPluginPath: "/app-data/plugins/niko-buddy-writer",
      isolatedPluginUpToDate: true,
      projectPath: "/book",
      projectState: "synced",
      projectVersion: "1.0.0",
      projectHasClaudeMd: false,
      globalInstalled: true,
      globalEnabled: true,
      globalUpToDate: true,
      globalPath: "/home/.gemini/antigravity/plugins/niko-buddy-writer",
      parentCodeRepoWarning: null,
    }
    const sampleSync: WriterPluginSyncResult = {
      ok: true,
      pluginName: "niko-buddy-writer",
      pluginVersion: "1.0.0",
      projectPath: "/book",
      includeClaudeMd: true,
      writtenFiles: ["AGENTS.md", "CLAUDE.md"],
      unchangedFiles: [],
      agentsMdPreservedUserContent: true,
      parentCodeRepoWarning: null,
      status: sampleStatus,
    }
    const sampleGlobal: WriterPluginGlobalResult = {
      ok: true,
      pluginName: "niko-buddy-writer",
      pluginVersion: "1.0.0",
      installPath: "/home/.gemini/antigravity/plugins/niko-buddy-writer",
      enabled: true,
      disabled: false,
      writtenFiles: ["plugin.json"],
      unchangedFiles: [],
      enableCommand: "agy plugin enable niko-buddy-writer",
      disableCommand: "agy plugin disable niko-buddy-writer",
    }

    invokeMock.mockResolvedValueOnce(sampleStatus)
    expect(await getWriterPluginStatus()).toEqual(sampleStatus)
    expect(invokeMock).toHaveBeenLastCalledWith("writer_plugin_status", { projectPath: null })

    invokeMock.mockResolvedValueOnce(sampleStatus)
    await getWriterPluginStatus("/book")
    expect(invokeMock).toHaveBeenLastCalledWith("writer_plugin_status", { projectPath: "/book" })

    invokeMock.mockResolvedValueOnce(sampleSync)
    expect(await syncProjectWriterPlugin("/book")).toEqual(sampleSync)
    expect(invokeMock).toHaveBeenLastCalledWith("writer_plugin_sync_project", {
      projectPath: "/book",
      includeClaudeMd: null,
    })

    invokeMock.mockResolvedValueOnce(sampleSync)
    await syncProjectWriterPlugin("/book", true)
    expect(invokeMock).toHaveBeenLastCalledWith("writer_plugin_sync_project", {
      projectPath: "/book",
      includeClaudeMd: true,
    })

    invokeMock.mockResolvedValueOnce(sampleGlobal)
    expect(await installGlobalWriterPlugin()).toEqual(sampleGlobal)
    expect(invokeMock).toHaveBeenLastCalledWith("writer_plugin_install_global", { enable: null })

    invokeMock.mockResolvedValueOnce(sampleGlobal)
    await installGlobalWriterPlugin(false)
    expect(invokeMock).toHaveBeenLastCalledWith("writer_plugin_install_global", { enable: false })
  })

  it("isWriterPluginStatus validates full WriterPluginStatus shape and safely rejects legacy/malformed mocks", () => {
    const valid: WriterPluginStatus = {
      pluginName: "niko-buddy-writer",
      pluginVersion: "1.0.0",
      declarativeOnly: true,
      skillCount: 6,
      agentCount: 3,
      isolatedPluginPath: "/isolated",
      isolatedPluginUpToDate: true,
      projectPath: null,
      projectState: "not_synced",
      projectVersion: null,
      projectHasClaudeMd: false,
      globalInstalled: false,
      globalEnabled: false,
      globalUpToDate: false,
      globalPath: null,
      parentCodeRepoWarning: null,
    }

    expect(isWriterPluginStatus(valid)).toBe(true)
    expect(isWriterPluginStatus({ ...valid, projectState: "synced", projectPath: "/book", projectVersion: "1.0.0" })).toBe(true)
    expect(isWriterPluginStatus({ ...valid, projectState: "needs_update", parentCodeRepoWarning: "warn" })).toBe(true)

    const invalidCases: unknown[] = [
      undefined,
      null,
      "string",
      42,
      [],
      {},
      { connected: true },
      { ...valid, projectState: "unknown_state" },
      { ...valid, skillCount: Number.NaN },
      { ...valid, agentCount: "3" },
      { ...valid, declarativeOnly: "true" },
      { ...valid, projectPath: 123 },
      { ...valid, parentCodeRepoWarning: false },
    ]
    for (const candidate of invalidCases) {
      expect(isWriterPluginStatus(candidate)).toBe(false)
    }
  })

  // ── Multi-role slot types & optional slot IPC forwarding ──

  it("validates ACP_ROLE_SLOTS, invokes antigravity_acp_switch_slot, and forwards optional slot only when defined", async () => {
    expect([...ACP_ROLE_SLOTS]).toEqual(["writer", "reviewer", "architect"])
    expect(isAcpRoleSlotId("writer")).toBe(true)
    expect(isAcpRoleSlotId("reviewer")).toBe(true)
    expect(isAcpRoleSlotId("architect")).toBe(true)
    expect(isAcpRoleSlotId("Reviewer")).toBe(false)
    expect(isAcpRoleSlotId("")).toBe(false)
    expect(isAcpRoleSlotId("unknown")).toBe(false)
    expect(isAcpRoleSlotId(null)).toBe(false)

    const reviewerSlotSnap: AcpSlotStatusSnapshot = {
      slot: "reviewer",
      sessionId: "sess-rev-1",
      cwd: "/book",
      configOptions: [],
      pendingPermissions: [],
      attachedLocalMcp: true,
      localMcpScope: "project",
      effectiveMcpScope: "read",
      localMcpProfile: "reviewer",
      readOnly: true,
      inFlightPrompt: false,
      localMcpStale: false,
      localMcpStaleReason: null,
      parentCodeRepoWarning: null,
    }
    const multiSlotStatus: AcpStatusSnapshot = {
      connected: true,
      binaryPath: "agy",
      agentName: "antigravity",
      agentVersion: "2.2.0",
      protocolVersion: 1,
      authMethods: [],
      activeSlot: "reviewer",
      slots: { reviewer: reviewerSlotSnap },
      activeSessionId: "sess-rev-1",
      cwd: "/book",
      configOptions: [],
      pendingPermissions: [],
      httpMcpEnabled: true,
      localMcpProfile: "reviewer",
    }

    invokeMock.mockResolvedValueOnce(multiSlotStatus)
    const switched = await switchAntigravityAcpSlot("reviewer")
    expect(invokeMock).toHaveBeenLastCalledWith("antigravity_acp_switch_slot", { slot: "reviewer" })
    expect(switched.activeSlot).toBe("reviewer")
    expect(switched.slots?.reviewer?.readOnly).toBe(true)
    expect(switched.slots?.reviewer?.effectiveMcpScope).toBe("read")

    const sessionRes: AcpSessionResult = {
      slot: "reviewer",
      sessionId: "sess-rev-2",
      cwd: "/book",
      configOptions: [],
      attachedLocalMcp: true,
      localMcpScope: "project",
      effectiveMcpScope: "read",
      localMcpProfile: "reviewer",
      readOnly: true,
      rawResult: {},
    }
    invokeMock.mockResolvedValue(sessionRes)

    await createAntigravityAcpSession("/book", true, "reviewer", "reviewer")
    expect(invokeMock).toHaveBeenLastCalledWith("antigravity_acp_new_session", {
      cwd: "/book",
      attachLocalMcp: true,
      mcpProfile: "reviewer",
      slot: "reviewer",
    })

    // Omit mcpProfile while passing explicit slot
    await createAntigravityAcpSession("/book", false, undefined, "architect")
    expect(invokeMock).toHaveBeenLastCalledWith("antigravity_acp_new_session", {
      cwd: "/book",
      attachLocalMcp: false,
      slot: "architect",
    })

    await sendAntigravityAcpPrompt({
      sessionId: "sess-rev-2",
      text: "Audit chapter 3",
      slot: "reviewer",
    })
    expect(invokeMock).toHaveBeenLastCalledWith("antigravity_acp_prompt", {
      sessionId: "sess-rev-2",
      text: "Audit chapter 3",
      contextTitle: null,
      contextText: null,
      slot: "reviewer",
    })

    await cancelAntigravityAcpTurn("sess-rev-2", "reviewer")
    expect(invokeMock).toHaveBeenLastCalledWith("antigravity_acp_cancel", {
      sessionId: "sess-rev-2",
      slot: "reviewer",
    })

    await setAntigravityAcpConfigOption("sess-rev-2", "model", "gemini-3-pro", "reviewer")
    expect(invokeMock).toHaveBeenLastCalledWith("antigravity_acp_set_config_option", {
      sessionId: "sess-rev-2",
      configId: "model",
      value: "gemini-3-pro",
      slot: "reviewer",
    })

    // Additive slot metadata on AcpEventPayload & AcpPendingPermission type-checks cleanly
    const slotId: AcpRoleSlotId = "reviewer"
    const perm: AcpPendingPermission = {
      requestId: "req-ro-1",
      sessionId: "sess-rev-2",
      slot: slotId,
      title: "draft.read",
      options: [{ optionId: "allow_once", name: "Allow" }],
    }
    const events: AcpEventPayload[] = [
      { kind: "session_update", params: { sessionId: "sess-rev-2" }, slot: slotId },
      { kind: "permission_request", permission: perm, slot: slotId },
      {
        kind: "permission_resolved",
        requestId: "req-ro-1",
        optionId: "allow_once",
        sessionId: "sess-rev-2",
        slot: slotId,
      },
    ]
    expect(events).toHaveLength(3)
  })
})
