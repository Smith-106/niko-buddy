// @vitest-environment jsdom
// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AcpEventPayload } from "@/lib/antigravity-acp-client"

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  isTauri: vi.fn(() => true),
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}))

vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>()
  return { ...actual, isTauri: mocks.isTauri }
})

import {
  STDERR_LOG_LIMIT,
  disposeAcpEventListener,
  ensureAcpEventListener,
  isDraftChapterWriteTool,
  useAntigravityAcpStore,
} from "./antigravity-acp-store"

describe("isDraftChapterWriteTool", () => {
  it("matches Draft-first chapter.write tool names across MCP prefixes", () => {
    expect(isDraftChapterWriteTool("chapter.write")).toBe(true)
    expect(isDraftChapterWriteTool("mcp__niko-buddy__chapter.write")).toBe(true)
    expect(isDraftChapterWriteTool("mcp__local-server__chapter.write")).toBe(true)
    expect(isDraftChapterWriteTool("niko-buddy/chapter.write")).toBe(true)
    expect(isDraftChapterWriteTool("niko-buddy:chapter.write")).toBe(true)
    expect(isDraftChapterWriteTool("chapter_write")).toBe(true)
    expect(isDraftChapterWriteTool("chapter-write")).toBe(true)
    expect(isDraftChapterWriteTool("Call chapter.write (ch03)")).toBe(true)
    expect(isDraftChapterWriteTool("Finished chapter.write.")).toBe(true)
  })

  it("strictly excludes chapter.write.preview, chapter.write_direct, and unrelated tool names", () => {
    expect(isDraftChapterWriteTool("chapter.write.preview")).toBe(false)
    expect(isDraftChapterWriteTool("mcp__niko-buddy__chapter.write.preview")).toBe(false)
    expect(isDraftChapterWriteTool("niko-buddy/chapter.write.preview")).toBe(false)
    expect(isDraftChapterWriteTool("chapter_write_preview")).toBe(false)
    expect(isDraftChapterWriteTool("chapter-write-preview")).toBe(false)
    expect(isDraftChapterWriteTool("chapter.writePreview")).toBe(false)
    expect(isDraftChapterWriteTool("chapter.write_direct")).toBe(false)
    expect(isDraftChapterWriteTool("niko-buddy/chapter.write_direct")).toBe(false)
    expect(isDraftChapterWriteTool("mcp__niko-buddy__chapter_write_direct")).toBe(false)
    expect(isDraftChapterWriteTool("chapter-write-direct")).toBe(false)
    expect(isDraftChapterWriteTool("chapter.writeDirect")).toBe(false)
    expect(isDraftChapterWriteTool("mychapter.write")).toBe(false)
    expect(isDraftChapterWriteTool("chapter.read")).toBe(false)
    expect(isDraftChapterWriteTool("")).toBe(false)
  })
})

describe("useAntigravityAcpStore", () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.listen.mockReset()
    mocks.isTauri.mockReturnValue(true)
    disposeAcpEventListener()
    useAntigravityAcpStore.getState().reset()
  })

  afterEach(() => {
    disposeAcpEventListener()
    useAntigravityAcpStore.getState().reset()
  })

  it("deduplicates concurrent ensureAcpEventListener calls and retries after rejection", async () => {
    let resolveFirst!: (fn: () => void) => void
    const unlistenSpy = vi.fn()
    mocks.listen.mockImplementationOnce(
      () => new Promise<() => void>((resolve) => {
        resolveFirst = resolve
      }),
    )

    const p1 = ensureAcpEventListener()
    const p2 = ensureAcpEventListener()
    expect(p1).toBe(p2)
    expect(mocks.listen).toHaveBeenCalledTimes(1)

    resolveFirst(unlistenSpy)
    await Promise.all([p1, p2])

    // Calling again after settled is a no-op.
    await ensureAcpEventListener()
    expect(mocks.listen).toHaveBeenCalledTimes(1)

    disposeAcpEventListener()
    expect(unlistenSpy).toHaveBeenCalledTimes(1)

    // Rejection clears in-flight promise so a retry works.
    mocks.listen.mockRejectedValueOnce(new Error("listen failed"))
    await expect(ensureAcpEventListener()).rejects.toThrow("listen failed")

    const unlistenRetry = vi.fn()
    mocks.listen.mockResolvedValueOnce(unlistenRetry)
    await ensureAcpEventListener()
    expect(mocks.listen).toHaveBeenCalledTimes(3)
  })

  it("cleans up a late-resolving listener if disposed while in-flight", async () => {
    let resolveLate!: (fn: () => void) => void
    const lateUnlisten = vi.fn()
    mocks.listen.mockImplementationOnce(
      () => new Promise<() => void>((resolve) => {
        resolveLate = resolve
      }),
    )

    const pending = ensureAcpEventListener()
    disposeAcpEventListener()
    resolveLate(lateUnlisten)
    await pending
    expect(lateUnlisten).toHaveBeenCalledTimes(1)
  })

  it("merges existing tool title on title-less completed tool_call_update before detecting chapter.write", () => {
    const store = useAntigravityAcpStore.getState()
    store.applySessionCreated(
      {
        sessionId: "sess-1",
        cwd: "C:\\books\\demo",
        configOptions: [],
        attachedLocalMcp: true,
        rawResult: {},
      },
      "Started",
    )

    // 1. Initial tool_call with chapter.write (in_progress) does not trigger handoff yet.
    useAntigravityAcpStore.getState().handleAcpEvent({
      kind: "session_update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-write-1",
          title: "mcp__niko-buddy__chapter.write",
          status: "in_progress",
        },
      },
    })
    expect(useAntigravityAcpStore.getState().hasRecentDraftWrite).toBe(false)

    // 2. Title-less completion update merges title FIRST, then detects chapter.write!
    useAntigravityAcpStore.getState().handleAcpEvent({
      kind: "session_update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-write-1",
          status: "completed",
        },
      },
    })
    const afterWrite = useAntigravityAcpStore.getState()
    expect(afterWrite.hasRecentDraftWrite).toBe(true)
    const assistant = afterWrite.transcript.find((item) => item.role === "assistant")
    expect(assistant?.tools?.[0]).toEqual({
      id: "tc-write-1",
      title: "mcp__niko-buddy__chapter.write",
      status: "completed",
    })

    // 3. Dismiss banner, then verify chapter.write_direct NEVER triggers hasRecentDraftWrite!
    afterWrite.dismissDraftWriteBanner()
    expect(useAntigravityAcpStore.getState().hasRecentDraftWrite).toBe(false)

    useAntigravityAcpStore.getState().handleAcpEvent({
      kind: "session_update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-direct-1",
          title: "niko-buddy/chapter.write_direct",
          status: "in_progress",
        },
      },
    })
    useAntigravityAcpStore.getState().handleAcpEvent({
      kind: "session_update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-direct-1",
          status: "completed",
        },
      },
    })
    expect(useAntigravityAcpStore.getState().hasRecentDraftWrite).toBe(false)
  })

  it("preserves transcript and stderrLogs on disconnect while clearing connection state", () => {
    const store = useAntigravityAcpStore.getState()
    store.applyStatusSnapshot({
      connected: true,
      binaryPath: "agy.exe",
      agentName: "Antigravity",
      agentVersion: "1.6.0",
      protocolVersion: 1,
      authMethods: [],
      activeSessionId: "sess-keep",
      cwd: "C:\\books\\demo",
      configOptions: [],
      pendingPermissions: [],
      httpMcpEnabled: true,
      inFlightPrompt: true,
    })
    store.beginPromptTurn("Draft chapter 2")
    store.handleAcpEvent({
      kind: "session_update",
      params: {
        sessionId: "sess-keep",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Draft text" },
        },
      },
    })
    store.handleAcpEvent({
      kind: "permission_request",
      permission: {
        requestId: "req-1",
        sessionId: "sess-keep",
        title: "Write file",
        options: [{ optionId: "allow_once", name: "Allow" }],
      },
    })
    store.handleAcpEvent({ kind: "stderr", message: "diag line 1\n" })

    useAntigravityAcpStore.getState().handleAcpEvent({
      kind: "disconnected",
      reason: "eof",
    })

    const next = useAntigravityAcpStore.getState()
    expect(next.status?.connected).toBe(false)
    expect(next.activeSessionId).toBeNull()
    expect(next.activeAssistantId).toBeNull()
    expect(next.prompting).toBe(false)
    expect(next.pendingPermissions).toEqual([])
    expect(next.transcript).toHaveLength(2)
    expect(next.transcript[1]?.text).toBe("Draft text")
    expect(next.stderrLogs).toEqual(["diag line 1"])
    // Strictly memory-only: zero localStorage writes.
    expect(localStorage.length).toBe(0)
  })

  it("caps stderrLogs at last 100 lines and enforces cross-session isolation", () => {
    const store = useAntigravityAcpStore.getState()
    store.applySessionCreated({
      sessionId: "sess-active",
      cwd: "C:\\books\\demo",
      configOptions: [],
      attachedLocalMcp: false,
      localMcpSkipReason: "mcp_server_not_running",
      rawResult: {},
    })

    expect(useAntigravityAcpStore.getState().lastLocalMcpSkipReason).toBe("mcp_server_not_running")

    for (let i = 1; i <= 120; i += 1) {
      useAntigravityAcpStore.getState().handleAcpEvent({
        kind: "stderr",
        message: `line-${i}\n`,
      })
    }
    const logs = useAntigravityAcpStore.getState().stderrLogs
    expect(logs).toHaveLength(STDERR_LOG_LIMIT)
    expect(logs[0]).toBe("line-21")
    expect(logs[99]).toBe("line-120")

    // Stale session events are ignored.
    const staleEvents: AcpEventPayload[] = [
      {
        kind: "session_update",
        params: {
          sessionId: "sess-stale",
          update: { sessionUpdate: "agent_message_chunk", content: { text: "NOPE" } },
        },
      },
      {
        kind: "permission_request",
        permission: {
          requestId: "req-stale",
          sessionId: "sess-stale",
          title: "Stale op",
          options: [{ optionId: "allow_once", name: "Allow" }],
        },
      },
    ]
    for (const evt of staleEvents) {
      useAntigravityAcpStore.getState().handleAcpEvent(evt)
    }
    expect(useAntigravityAcpStore.getState().transcript).toEqual([])
    expect(useAntigravityAcpStore.getState().pendingPermissions).toEqual([])
  })

  it("resets all MCP fields on disconnect and drops delayed streaming/tool/permission events while disconnected", () => {
    const store = useAntigravityAcpStore.getState()
    store.applyStatusSnapshot({
      connected: true,
      binaryPath: "agy.exe",
      agentName: "Antigravity",
      agentVersion: "1.6.0",
      protocolVersion: 1,
      authMethods: [],
      activeSessionId: "sess-mcp",
      cwd: "C:\\books\\demo",
      configOptions: [],
      pendingPermissions: [],
      httpMcpEnabled: true,
      attachedLocalMcp: true,
      localMcpScope: "project",
      localMcpStale: true,
      localMcpStaleReason: "token_rotated",
      supportsHttpMcp: true,
      supportsLoadSession: true,
      inFlightPrompt: true,
    })
    store.applySessionCreated({
      sessionId: "sess-mcp",
      cwd: "C:\\books\\demo",
      configOptions: [],
      attachedLocalMcp: false,
      localMcpSkipReason: "mcp_server_not_running",
      rawResult: {},
    })

    // applySessionCreated clears stale flags immediately.
    expect(useAntigravityAcpStore.getState().status?.localMcpStale).toBe(false)
    expect(useAntigravityAcpStore.getState().status?.localMcpStaleReason).toBeNull()
    expect(useAntigravityAcpStore.getState().lastLocalMcpSkipReason).toBe("mcp_server_not_running")

    // Re-mark stale before disconnect to prove disconnect resets every MCP field.
    store.applyStatusSnapshot({
      ...useAntigravityAcpStore.getState().status!,
      attachedLocalMcp: true,
      localMcpScope: "project",
      localMcpStale: true,
      localMcpStaleReason: "scope_changed",
      supportsHttpMcp: true,
      supportsLoadSession: true,
    })

    useAntigravityAcpStore.getState().handleAcpEvent({
      kind: "disconnected",
      reason: "eof",
    })

    const afterDisc = useAntigravityAcpStore.getState()
    expect(afterDisc.status?.connected).toBe(false)
    expect(afterDisc.status?.attachedLocalMcp).toBe(false)
    expect(afterDisc.status?.localMcpScope).toBeNull()
    expect(afterDisc.status?.localMcpStale).toBe(false)
    expect(afterDisc.status?.localMcpStaleReason).toBeNull()
    expect(afterDisc.status?.supportsHttpMcp).toBeUndefined()
    expect(afterDisc.status?.supportsLoadSession).toBeUndefined()
    expect(afterDisc.lastLocalMcpSkipReason).toBeNull()

    // Delayed events arriving while disconnected must be dropped!
    const delayed: AcpEventPayload[] = [
      {
        kind: "session_update",
        params: {
          sessionId: "sess-mcp",
          update: { sessionUpdate: "agent_message_chunk", content: { text: "LATE_CHUNK" } },
        },
      },
      {
        kind: "session_update",
        params: {
          sessionId: "sess-mcp",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-late",
            title: "chapter.write",
            status: "completed",
          },
        },
      },
      {
        kind: "permission_request",
        permission: {
          requestId: "req-late",
          sessionId: "sess-mcp",
          title: "Late permission",
          options: [{ optionId: "allow_once", name: "Allow" }],
        },
      },
    ]
    for (const evt of delayed) {
      useAntigravityAcpStore.getState().handleAcpEvent(evt)
    }

    const afterDelayed = useAntigravityAcpStore.getState()
    expect(afterDelayed.transcript).toEqual([])
    expect(afterDelayed.pendingPermissions).toEqual([])
    expect(afterDelayed.hasRecentDraftWrite).toBe(false)
  })

  it("appends formatted protocol_warning events to stderrLogs within ring buffer limit and supports markRecentDraftWrite", () => {
    for (let i = 1; i <= STDERR_LOG_LIMIT; i += 1) {
      useAntigravityAcpStore.getState().handleAcpEvent({
        kind: "stderr",
        message: `err-${i}\n`,
      })
    }

    useAntigravityAcpStore.getState().handleAcpEvent({
      kind: "protocol_warning",
      code: "oversized_stdout_line",
      bytes: 12_000_000,
      limitBytes: 8_388_608,
      preview: '{"jsonrpc":"2.0"...',
      message: "Dropped oversized stdout JSON-RPC frame",
    })

    const logs = useAntigravityAcpStore.getState().stderrLogs
    expect(logs).toHaveLength(STDERR_LOG_LIMIT)
    expect(logs[0]).toBe("err-2")
    expect(logs[logs.length - 1]).toContain("[protocol_warning:oversized_stdout_line]")
    expect(logs[logs.length - 1]).toContain("12000000/8388608 bytes")
    expect(logs[logs.length - 1]).toContain('{"jsonrpc":"2.0"...')

    // markRecentDraftWrite lights up the draft handoff strip with optional summary
    useAntigravityAcpStore.getState().markRecentDraftWrite("已存入草稿（第3章）")
    expect(useAntigravityAcpStore.getState().hasRecentDraftWrite).toBe(true)
    expect(useAntigravityAcpStore.getState().recentDraftWriteSummary).toBe("已存入草稿（第3章）")

    useAntigravityAcpStore.getState().dismissDraftWriteBanner()
    expect(useAntigravityAcpStore.getState().hasRecentDraftWrite).toBe(false)
    expect(useAntigravityAcpStore.getState().recentDraftWriteSummary).toBeNull()
  })

  it("tracks mcpProfile, localMcpProfile, and parentCodeRepoWarning in memory only, preserves choice while disconnected, clears stale warning on null, and resets on disconnect", () => {
    const store = useAntigravityAcpStore.getState()
    expect(store.mcpProfile).toBe("writer-sub")
    expect(store.localMcpProfile).toBeNull()
    expect(store.parentCodeRepoWarning).toBeNull()

    // User selects architect while disconnected -> disconnected snapshot must NOT overwrite mcpProfile.
    store.setMcpProfile("architect")
    store.applyStatusSnapshot({
      connected: false,
      binaryPath: null,
      agentName: null,
      agentVersion: null,
      protocolVersion: null,
      authMethods: [],
      activeSessionId: null,
      cwd: null,
      configOptions: [],
      pendingPermissions: [],
      httpMcpEnabled: false,
      localMcpProfile: null,
      parentCodeRepoWarning: null,
    })
    expect(useAntigravityAcpStore.getState().mcpProfile).toBe("architect")
    expect(useAntigravityAcpStore.getState().localMcpProfile).toBeNull()

    // Connected snapshot + session creation syncs localMcpProfile & parentCodeRepoWarning
    store.applyStatusSnapshot({
      connected: true,
      binaryPath: "agy.exe",
      agentName: "Antigravity",
      agentVersion: "1.6.0",
      protocolVersion: 1,
      authMethods: [],
      activeSessionId: "sess-w1",
      cwd: "C:\\code-repo\\novel",
      configOptions: [],
      pendingPermissions: [
        {
          requestId: "req-writer-1",
          sessionId: "sess-w1",
          title: "Write draft",
          options: [{ optionId: "allow_once", name: "Allow" }],
        },
      ],
      httpMcpEnabled: true,
      localMcpProfile: "writer-sub",
      parentCodeRepoWarning: "Detected .git in C:\\code-repo",
    })
    store.beginPromptTurn("Draft ch01")
    store.markRecentDraftWrite("已存入草稿（第1章）")

    // Changing mcpProfile mid-session is NOT clobbered by same-session status refresh.
    store.setMcpProfile("reviewer")
    store.applyStatusSnapshot({
      ...useAntigravityAcpStore.getState().status!,
      localMcpProfile: "writer-sub",
    })
    expect(useAntigravityAcpStore.getState().mcpProfile).toBe("reviewer")
    expect(useAntigravityAcpStore.getState().localMcpProfile).toBe("writer-sub")
    expect(useAntigravityAcpStore.getState().parentCodeRepoWarning).toBe(
      "Detected .git in C:\\code-repo",
    )

    // New isolated reviewer session with explicit parentCodeRepoWarning: null clears stale warning,
    // prior transcript, draft handoff, and prior pending permissions!
    store.applySessionCreated(
      {
        sessionId: "sess-rev-2",
        cwd: "D:\\clean-novel",
        configOptions: [],
        attachedLocalMcp: true,
        localMcpScope: "project",
        localMcpProfile: "reviewer",
        parentCodeRepoWarning: null,
        rawResult: {},
      },
      "Isolated reviewer ready",
    )
    const afterRev = useAntigravityAcpStore.getState()
    expect(afterRev.localMcpProfile).toBe("reviewer")
    expect(afterRev.status?.localMcpProfile).toBe("reviewer")
    expect(afterRev.parentCodeRepoWarning).toBeNull()
    expect(afterRev.status?.parentCodeRepoWarning).toBeNull()
    expect(afterRev.hasRecentDraftWrite).toBe(false)
    expect(afterRev.pendingPermissions).toEqual([])
    expect(afterRev.transcript).toHaveLength(1)
    expect(afterRev.transcript[0]?.text).toBe("Isolated reviewer ready")

    // Re-attach a warning then disconnect -> resets mcpProfile, localMcpProfile, and parentCodeRepoWarning
    // both at top-level and inside status mirror.
    store.applySessionCreated({
      sessionId: "sess-warn-3",
      cwd: "C:\\code-repo\\novel",
      configOptions: [],
      attachedLocalMcp: true,
      localMcpProfile: "architect",
      parentCodeRepoWarning: "Parent repo detected",
      rawResult: {},
    })
    expect(useAntigravityAcpStore.getState().parentCodeRepoWarning).toBe("Parent repo detected")

    store.handleAcpEvent({ kind: "disconnected", reason: "user_disconnect" })
    const afterDisc = useAntigravityAcpStore.getState()
    expect(afterDisc.mcpProfile).toBe("writer-sub")
    expect(afterDisc.localMcpProfile).toBeNull()
    expect(afterDisc.parentCodeRepoWarning).toBeNull()
    expect(afterDisc.status?.localMcpProfile).toBeNull()
    expect(afterDisc.status?.parentCodeRepoWarning).toBeNull()
    // Strictly memory-only: zero localStorage writes.
    expect(localStorage.length).toBe(0)
  })

  it("initializes ANL-009 tosCompliance in NO-GO state, evaluates triggers into memory-only reassessment issues, and resets cleanly", () => {
    const initial = useAntigravityAcpStore.getState()
    expect(initial.tosCompliance.hasTrigger).toBe(false)
    expect(initial.tosCompliance.anl009Status).toBe("no_go")
    expect(initial.tosCompliance.triggers).toEqual([])
    expect(initial.tosCompliance.note).toContain("ANL-009")
    expect(initial.tosReassessmentIssues).toEqual([])

    // Invalid/empty conditions keep ANL-009 NO-GO intact and emit no reassessment issues.
    const emptyIssues = initial.evaluateTosTriggers([
      {
        type: "tos_change",
        description: "   ",
        evidence: "",
        detectedAt: "2026-11-27T00:00:00Z",
      },
    ])
    expect(emptyIssues).toEqual([])
    expect(useAntigravityAcpStore.getState().tosCompliance.hasTrigger).toBe(false)
    expect(useAntigravityAcpStore.getState().tosCompliance.anl009Status).toBe("no_go")
    expect(useAntigravityAcpStore.getState().tosReassessmentIssues).toEqual([])

    // Valid trigger generates in-memory reassessment issue without writing localStorage/disk.
    const triggered = initial.evaluateTosTriggers([
      {
        type: "embedded_sdk_available",
        description: "First-party embedded SDK published",
        evidence: "https://example.com/embedded-sdk-v1",
        detectedAt: "2026-11-27T12:00:00Z",
      },
      {
        type: "billing_model_change",
        description: "",
        evidence: "missing description",
        detectedAt: "2026-11-27T12:01:00Z",
      },
    ])
    expect(triggered).toHaveLength(1)
    expect(triggered[0]).toMatchObject({
      type: "reassessment",
      severity: "info",
      status: "open",
      source: "tos-trigger-monitor",
      related: "ANL-009",
      created_at: "2026-11-27T12:00:00Z",
    })
    expect(triggered[0]?.description).toContain("https://example.com/embedded-sdk-v1")
    expect(triggered[0]?.description).toContain("NO-GO remains enforced")

    const afterEval = useAntigravityAcpStore.getState()
    expect(afterEval.tosCompliance.hasTrigger).toBe(true)
    expect(afterEval.tosCompliance.anl009Status).toBe("reassessment_recommended")
    expect(afterEval.tosCompliance.triggers).toHaveLength(1)
    expect(afterEval.tosReassessmentIssues).toEqual(triggered)
    expect(localStorage.length).toBe(0)

    // reset() restores NO-GO compliance snapshot and clears reassessment issues.
    afterEval.reset()
    const afterReset = useAntigravityAcpStore.getState()
    expect(afterReset.tosCompliance.hasTrigger).toBe(false)
    expect(afterReset.tosCompliance.anl009Status).toBe("no_go")
    expect(afterReset.tosCompliance.triggers).toEqual([])
    expect(afterReset.tosReassessmentIssues).toEqual([])
    expect(localStorage.length).toBe(0)
  })

  it("coexists writer/reviewer/architect slots with strict cross-slot event isolation, per-slot composerText/prompting, and non-destructive setActiveSlot", () => {
    const store = useAntigravityAcpStore.getState()
    expect(store.activeSlot).toBe("writer")
    expect(store.slots.writer.mcpProfile).toBe("writer-sub")
    expect(store.slots.reviewer.mcpProfile).toBe("reviewer")
    expect(store.slots.reviewer.readOnly).toBe(true)
    expect(store.slots.architect.mcpProfile).toBe("architect")

    // Reviewer slot profile is protocol-locked to "reviewer" even if caller tries to override.
    store.setMcpProfile("writer-sub", "reviewer")
    expect(useAntigravityAcpStore.getState().slots.reviewer.mcpProfile).toBe("reviewer")

    // Establish writer and reviewer sessions via multi-slot snapshot
    store.applyStatusSnapshot({
      connected: true,
      binaryPath: "agy.exe",
      agentName: "Antigravity",
      agentVersion: "2.2.0",
      protocolVersion: 1,
      authMethods: [],
      activeSlot: "writer",
      activeSessionId: "sess-w1",
      cwd: "C:\\books\\demo",
      configOptions: [],
      pendingPermissions: [],
      httpMcpEnabled: true,
      attachedLocalMcp: true,
      localMcpScope: "project",
      localMcpProfile: "writer-sub",
      slots: {
        writer: {
          slot: "writer",
          sessionId: "sess-w1",
          cwd: "C:\\books\\demo",
          configOptions: [],
          pendingPermissions: [],
          attachedLocalMcp: true,
          localMcpScope: "project",
          effectiveMcpScope: "project",
          localMcpProfile: "writer-sub",
          readOnly: false,
          inFlightPrompt: false,
        },
        reviewer: {
          slot: "reviewer",
          sessionId: "sess-r1",
          cwd: "C:\\books\\demo",
          configOptions: [],
          pendingPermissions: [],
          attachedLocalMcp: true,
          localMcpScope: "project",
          effectiveMcpScope: "read",
          localMcpProfile: "reviewer",
          readOnly: true,
          inFlightPrompt: false,
        },
      },
    })

    // Writer types unsent draft note and starts a prompt turn
    store.setComposerText("Writer unsent note")
    store.beginPromptTurn("Draft chapter 5", "writer")
    store.setSlotComposerText("reviewer", "Reviewer pre-filled handoff")

    // Reviewer receives streaming chunk + permission request while activeSlot is still "writer"
    useAntigravityAcpStore.getState().handleAcpEvent({
      kind: "session_update",
      slot: "reviewer",
      params: {
        sessionId: "sess-r1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Reviewer P0 audit finding" },
        },
      },
    })
    useAntigravityAcpStore.getState().handleAcpEvent({
      kind: "permission_request",
      slot: "reviewer",
      permission: {
        requestId: "req-rev-1",
        sessionId: "sess-r1",
        slot: "reviewer",
        title: "draft.read",
        options: [{ optionId: "allow_once", name: "Allow" }],
      },
    })

    // Unmatched stale session event is dropped completely (zero cross-slot leakage!)
    useAntigravityAcpStore.getState().handleAcpEvent({
      kind: "session_update",
      slot: "writer",
      params: {
        sessionId: "sess-unknown-999",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "LEAKED_CHUNK" },
        },
      },
    })
    useAntigravityAcpStore.getState().handleAcpEvent({
      kind: "permission_request",
      permission: {
        requestId: "req-stale-999",
        sessionId: "sess-unknown-999",
        title: "Stale write",
        options: [{ optionId: "allow_once", name: "Allow" }],
      },
    })

    // Active top-level mirror (writer) has ZERO reviewer leakage!
    const whileOnWriter = useAntigravityAcpStore.getState()
    expect(whileOnWriter.activeSlot).toBe("writer")
    expect(whileOnWriter.activeSessionId).toBe("sess-w1")
    expect(whileOnWriter.composerText).toBe("Writer unsent note")
    expect(whileOnWriter.prompting).toBe(true)
    expect(whileOnWriter.pendingPermissions).toEqual([])
    expect(whileOnWriter.transcript.map((m) => m.text)).toEqual(["Draft chapter 5"])

    // Reviewer slot captured its own chunk and permission cleanly
    expect(whileOnWriter.slots.reviewer.transcript.map((m) => m.text)).toEqual([
      "Reviewer P0 audit finding",
    ])
    expect(whileOnWriter.slots.reviewer.pendingPermissions.map((p) => p.requestId)).toEqual([
      "req-rev-1",
    ])
    expect(whileOnWriter.slots.reviewer.composerText).toBe("Reviewer pre-filled handoff")
    expect(whileOnWriter.slots.reviewer.prompting).toBe(false)

    // Non-destructive switch to reviewer projects reviewer state while keeping writer intact
    whileOnWriter.setActiveSlot("reviewer")
    const onReviewer = useAntigravityAcpStore.getState()
    expect(onReviewer.activeSlot).toBe("reviewer")
    expect(onReviewer.activeSessionId).toBe("sess-r1")
    expect(onReviewer.composerText).toBe("Reviewer pre-filled handoff")
    expect(onReviewer.prompting).toBe(false)
    expect(onReviewer.mcpProfile).toBe("reviewer")
    expect(onReviewer.pendingPermissions.map((p) => p.requestId)).toEqual(["req-rev-1"])
    expect(onReviewer.transcript.map((m) => m.text)).toEqual(["Reviewer P0 audit finding"])

    // Finishing writer's prompt turn while viewing reviewer ONLY updates writer
    onReviewer.finishPromptTurn("end_turn", "writer")
    expect(useAntigravityAcpStore.getState().slots.writer.prompting).toBe(false)
    expect(useAntigravityAcpStore.getState().slots.writer.lastStopReason).toBe("end_turn")
    expect(useAntigravityAcpStore.getState().lastStopReason).toBeNull()

    // Resolving reviewer's permission removes it from reviewer without affecting writer
    onReviewer.handleAcpEvent({
      kind: "permission_resolved",
      requestId: "req-rev-1",
      optionId: "allow_once",
      sessionId: "sess-r1",
      slot: "reviewer",
    })
    expect(useAntigravityAcpStore.getState().pendingPermissions).toEqual([])
    expect(useAntigravityAcpStore.getState().slots.reviewer.pendingPermissions).toEqual([])

    // Disconnect clears connection fields across ALL slots, resets activeSlot to writer,
    // and preserves per-slot transcripts & composerText in memory only.
    useAntigravityAcpStore.getState().handleAcpEvent({ kind: "disconnected", reason: "eof" })
    const afterDisc = useAntigravityAcpStore.getState()
    expect(afterDisc.activeSlot).toBe("writer")
    expect(afterDisc.activeSessionId).toBeNull()
    expect(afterDisc.slots.writer.sessionId).toBeNull()
    expect(afterDisc.slots.reviewer.sessionId).toBeNull()
    expect(afterDisc.slots.writer.transcript.map((m) => m.text)).toEqual(["Draft chapter 5"])
    expect(afterDisc.slots.writer.composerText).toBe("Writer unsent note")
    expect(afterDisc.slots.reviewer.transcript.map((m) => m.text)).toEqual([
      "Reviewer P0 audit finding",
    ])
    expect(afterDisc.slots.reviewer.composerText).toBe("Reviewer pre-filled handoff")
    expect(localStorage.length).toBe(0)
  })
})
