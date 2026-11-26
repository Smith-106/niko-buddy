// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest"

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }))

import {
  ANTIGRAVITY_ACP_EVENT_TOPIC,
  authenticateAntigravityAcp,
  cancelAntigravityAcpTurn,
  connectAntigravityAcp,
  createAntigravityAcpSession,
  disconnectAntigravityAcp,
  getAntigravityAcpStatus,
  isAcpAuthRequiredError,
  listenAntigravityAcpEvents,
  parseAcpConfigOptions,
  parseAcpSessionUpdate,
  respondAntigravityAcpPermission,
  sendAntigravityAcpPrompt,
  setAntigravityAcpConfigOption,
  type AcpEventPayload,
  type AcpPendingPermission,
  type AcpPromptResult,
  type AcpSessionResult,
  type AcpStatusSnapshot,
  type LocalMcpStaleReason,
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
})
