// @vitest-environment jsdom
// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as jestDomMatchers from "@testing-library/jest-dom/matchers"
import { act, cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"

expect.extend(jestDomMatchers)
import {
  ACP_CONTEXT_MAX_CHARS,
  AntigravityAcpView,
  truncateSurrogateSafe,
} from "./antigravity-acp-view"
import {
  buildWriterQuickActionPrompt,
  inferChapterContext,
} from "./antigravity-acp-quick-actions"
import {
  clearMainControlTabHandoff,
  peekMainControlTabHandoff,
} from "./main-control-handoff"
import {
  disposeAcpEventListener,
  useAntigravityAcpStore,
} from "@/stores/antigravity-acp-store"
import type { AcpEventPayload } from "@/lib/antigravity-acp-client"
import type { FileNode } from "@/types/wiki"

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  isTauri: vi.fn(() => true),
  pickDirectory: vi.fn(async () => null as string | null),
  setActiveView: vi.fn(),
  setSelectedFile: vi.fn(),
  setActiveSettingsCategory: vi.fn(),
  bumpDataVersion: vi.fn(),
  writeDraft: vi.fn(),
  listChapterDrafts: vi.fn(
    async () =>
      [] as Array<{
        id?: string
        chapterName: string
        status: string
        createdAt?: number
        revisionRound?: number
        adoptionGate?: { status: string }
      }>,
  ),
  prepareInteractiveChapterSnapshot: vi.fn(),
  commitInteractiveChapterSnapshot: vi.fn(),
  usePendingDraftCount: vi.fn<(projectPath: string, reloadKey: unknown) => number | null>(() => 0),
  storeState: {
    project: { path: "C:\\books\\demo", name: "Demo" } as { path: string; name: string } | null,
    fileTree: [] as FileNode[],
    selectedFile: "chapters/ch01.md" as string | null,
    fileContent: "Chapter 1 draft content",
    dataVersion: 0,
    llmConfig: undefined as Record<string, unknown> | undefined,
    novelConfig: undefined as Record<string, unknown> | undefined,
    embeddingConfig: undefined as Record<string, unknown> | undefined,
    providerConfigs: undefined as Record<string, unknown> | undefined,
    defaultLlmModel: "",
    aiChatModel: "",
  },
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }))
vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>()
  return {
    ...actual,
    isTauri: mocks.isTauri,
    pickDirectory: mocks.pickDirectory,
  }
})
vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    writeDraft: mocks.writeDraft,
    listChapterDrafts: mocks.listChapterDrafts,
    prepareInteractiveChapterSnapshot: (...args: unknown[]) =>
      mocks.prepareInteractiveChapterSnapshot(...args),
    commitInteractiveChapterSnapshot: (...args: unknown[]) =>
      mocks.commitInteractiveChapterSnapshot(...args),
  }
})
vi.mock("@/components/layout/writing-workspace-widgets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/layout/writing-workspace-widgets")>()
  return {
    ...actual,
    usePendingDraftCount: (projectPath: string, reloadKey: unknown) =>
      mocks.usePendingDraftCount(projectPath, reloadKey),
  }
})
vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  const stateProxy = () => ({
    ...mocks.storeState,
    setActiveView: mocks.setActiveView,
    setSelectedFile: mocks.setSelectedFile,
    setActiveSettingsCategory: mocks.setActiveSettingsCategory,
    bumpDataVersion: mocks.bumpDataVersion,
  })
  return {
    ...actual,
    useWikiStore: Object.assign(
      (selector: (s: ReturnType<typeof stateProxy>) => unknown) => selector(stateProxy()),
      { getState: stateProxy },
    ),
  }
})

const INITIAL_STATUS = {
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
}

const CONNECTED_STATUS = {
  connected: true,
  binaryPath: "C:\\Users\\demo\\.gemini\\antigravity\\bin\\agy.exe",
  agentName: "Antigravity ACP Server",
  agentVersion: "1.5.14",
  protocolVersion: 1,
  authMethods: [{ id: "oauth-personal", name: "Google Account (OAuth)" }],
  activeSessionId: null,
  cwd: "C:\\books\\demo",
  configOptions: [],
  pendingPermissions: [],
  httpMcpEnabled: false,
}

describe("truncateSurrogateSafe", () => {
  it("never splits a UTF-16 surrogate pair at the truncation boundary", () => {
    const emoji = "😀" // 2 UTF-16 code units: 0xD83D 0xDE00
    const text = "a".repeat(ACP_CONTEXT_MAX_CHARS - 1) + emoji + "tail"
    const res = truncateSurrogateSafe(text, ACP_CONTEXT_MAX_CHARS)
    expect(res.truncated).toBe(true)
    expect(res.text.length).toBe(ACP_CONTEXT_MAX_CHARS - 1)
    // Last code unit must NOT be an unpaired high surrogate.
    const lastCode = res.text.charCodeAt(res.text.length - 1)
    expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true)
  })

  it("returns original text unchanged when within limit", () => {
    const res = truncateSurrogateSafe("hello", 10)
    expect(res).toEqual({ text: "hello", truncated: false })
  })
})

describe("inferChapterContext & buildWriterQuickActionPrompt", () => {
  it("defaults to nextChapter=1 when fileTree and selectedFile are empty", () => {
    expect(inferChapterContext([], null)).toEqual({
      currentChapter: null,
      nextChapter: 1,
      currentChapterPath: null,
      latestChapter: null,
      chapterCount: 0,
    })
  })

  it("infers latest and next chapter deterministically from wiki/chapters and selectedFile", () => {
    const tree: FileNode[] = [
      {
        name: "wiki",
        path: "wiki",
        is_dir: true,
        children: [
          {
            name: "chapters",
            path: "wiki/chapters",
            is_dir: true,
            children: [
              { name: "ch01.md", path: "wiki/chapters/ch01.md", is_dir: false },
              { name: "ch03.md", path: "wiki/chapters/ch03.md", is_dir: false },
              { name: "ch02.md", path: "wiki/chapters/ch02.md", is_dir: false },
            ],
          },
        ],
      },
    ]
    const ctx = inferChapterContext(tree, "wiki/chapters/ch02.md")
    expect(ctx.currentChapter).toBe(2)
    expect(ctx.latestChapter).toBe(3)
    expect(ctx.nextChapter).toBe(4)
    expect(ctx.chapterCount).toBe(3)

    const zhDraft = buildWriterQuickActionPrompt("draft_next", ctx, "zh")
    expect(zhDraft).toContain("chapter.write")
    expect(zhDraft).toContain("gate.check_mechanical")
    expect(zhDraft).toContain("第 4 章")

    const enAudit = buildWriterQuickActionPrompt("canon_audit", ctx, "en")
    expect(enAudit).toContain("project.state")
    expect(enAudit).toContain("canon.query")
    expect(enAudit).toContain("read")
  })
})

describe("AntigravityAcpView", () => {
  let emitEvent: ((payload: AcpEventPayload) => void) | null = null

  beforeEach(() => {
    emitEvent = null
    disposeAcpEventListener()
    useAntigravityAcpStore.getState().reset()
    clearMainControlTabHandoff()
    mocks.invoke.mockReset()
    mocks.listen.mockReset()
    mocks.pickDirectory.mockReset()
    mocks.pickDirectory.mockResolvedValue(null)
    mocks.setActiveView.mockReset()
    mocks.setSelectedFile.mockReset()
    mocks.setActiveSettingsCategory.mockReset()
    mocks.bumpDataVersion.mockReset()
    mocks.writeDraft.mockReset()
    mocks.writeDraft.mockResolvedValue({
      id: "draft_test_1",
      chapterName: "第3章",
      content: "",
      createdAt: Date.now(),
      status: "draft",
    })
    mocks.listChapterDrafts.mockReset()
    mocks.listChapterDrafts.mockResolvedValue([])
    mocks.prepareInteractiveChapterSnapshot.mockReset()
    mocks.commitInteractiveChapterSnapshot.mockReset()
    mocks.usePendingDraftCount.mockReset()
    mocks.usePendingDraftCount.mockReturnValue(0)
    mocks.isTauri.mockReturnValue(true)
    mocks.storeState.project = { path: "C:\\books\\demo", name: "Demo" }
    mocks.storeState.fileTree = []
    mocks.storeState.selectedFile = "chapters/ch01.md"
    mocks.storeState.fileContent = "Chapter 1 draft content"
    mocks.storeState.dataVersion = 0
    mocks.storeState.llmConfig = undefined
    mocks.storeState.novelConfig = undefined
    mocks.storeState.embeddingConfig = undefined
    mocks.storeState.providerConfigs = undefined
    mocks.storeState.defaultLlmModel = ""
    mocks.storeState.aiChatModel = ""

    mocks.listen.mockImplementation(
      async (_topic: string, cb: (e: { payload: AcpEventPayload }) => void) => {
        emitEvent = (payload) => cb({ payload })
        return () => {}
      },
    )
  })

  afterEach(() => {
    cleanup()
    disposeAcpEventListener()
    useAntigravityAcpStore.getState().reset()
    clearMainControlTabHandoff()
    try {
      delete (navigator as unknown as Record<string, unknown>).clipboard
    } catch {
      /* ignore */
    }
  })

  it("connects, surfaces -32000 auth flow, creates session, streams updates, and handles manual permission approval", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "antigravity_cli_detect":
          return {
            installed: true,
            version: "1.5.14",
            path: "C:\\Users\\demo\\.gemini\\antigravity\\bin\\agy.exe",
            error: null,
            acp_supported: true,
          }
        case "antigravity_acp_status":
          return INITIAL_STATUS
        case "antigravity_acp_connect":
          return CONNECTED_STATUS
        case "antigravity_acp_new_session":
          return {
            sessionId: "sess-abc12345",
            cwd: "C:\\books\\demo",
            attachedLocalMcp: false,
            configOptions: [
              {
                id: "model",
                name: "Model",
                currentValue: "gemini-3-pro",
                options: [
                  { value: "gemini-3-pro", name: "Gemini 3 Pro" },
                  { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
                ],
              },
            ],
            rawResult: {},
          }
        case "antigravity_acp_set_config_option":
          return {}
        case "antigravity_acp_prompt":
          return { stopReason: "end_turn" }
        case "antigravity_acp_respond_permission":
          return undefined
        case "antigravity_acp_disconnect":
          return undefined
        default:
          return undefined
      }
    })

    render(<AntigravityAcpView />)

    await screen.findByTestId("acp-cli-ready")
    expect(screen.getByTestId("acp-compliance-notice")).toBeInTheDocument()

    // Connect to agy acp
    fireEvent.click(screen.getByTestId("acp-connect-btn"))
    await screen.findByTestId("acp-connected-badge")
    expect(screen.getByTestId("acp-auth-panel")).toBeInTheDocument()

    // Simulate -32000 auth required on first new_session attempt, then succeed after auth
    mocks.invoke.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "antigravity_acp_new_session") {
        throw new Error("[ACP -32000] Authentication required")
      }
      return undefined
    })
    fireEvent.click(screen.getByTestId("acp-new-session-btn"))
    await waitFor(() => {
      expect(screen.getByTestId("acp-error-banner")).toHaveTextContent("-32000")
    })

    // Trigger explicit authenticate RPC
    fireEvent.click(screen.getByTestId("acp-auth-oauth-personal"))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("antigravity_acp_authenticate", {
        methodId: "oauth-personal",
      })
    })

    // Create session succeeds and exposes advertised model selector
    fireEvent.click(screen.getByTestId("acp-new-session-btn"))
    const modelSelect = await screen.findByTestId("acp-config-model")
    fireEvent.change(modelSelect, { target: { value: "claude-sonnet-4-6" } })
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("antigravity_acp_set_config_option", {
        sessionId: "sess-abc12345",
        configId: "model",
        value: "claude-sonnet-4-6",
      })
    })

    // Stream an incoming manual permission prompt — must wait for explicit user click
    act(() => {
      emitEvent?.({
        kind: "permission_request",
        permission: {
          requestId: "req-42",
          sessionId: "sess-abc12345",
          title: "Run chapter linter",
          options: [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject_once", name: "Deny", kind: "reject_once" },
          ],
        },
      })
    })

    const permCard = await screen.findByTestId("acp-permission-req-42")
    expect(permCard).toHaveAttribute("role", "alertdialog")
    fireEvent.click(screen.getByTestId("acp-perm-opt-req-42-allow_once"))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("antigravity_acp_respond_permission", {
        requestId: "req-42",
        optionId: "allow_once",
      })
    })

    // Resolve permission event clears the card
    act(() => {
      emitEvent?.({ kind: "permission_resolved", requestId: "req-42", optionId: "allow_once" })
    })
    await waitFor(() => {
      expect(screen.queryByTestId("acp-permission-req-42")).toBeNull()
    })

    // Send prompt + stream assistant reply chunk
    fireEvent.change(screen.getByTestId("acp-prompt-input"), {
      target: { value: "Review pacing of ch01" },
    })
    fireEvent.click(screen.getByTestId("acp-send-btn"))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("antigravity_acp_prompt", {
        sessionId: "sess-abc12345",
        text: "Review pacing of ch01",
        contextTitle: null,
        contextText: null,
      })
    })

    act(() => {
      emitEvent?.({
        kind: "session_update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Pacing looks tight." },
          },
        },
      })
    })
    expect(await screen.findByText("Pacing looks tight.")).toBeInTheDocument()

    // Disconnect button invokes antigravity_acp_disconnect
    fireEvent.click(screen.getByTestId("acp-disconnect-btn"))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("antigravity_acp_disconnect")
    })
  })

  it("navigates to External Control MCP settings when clicking MCP settings button", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "antigravity_cli_detect") {
        return {
          installed: false,
          version: null,
          path: null,
          error: "agy not found",
          acp_supported: false,
        }
      }
      return INITIAL_STATUS
    })
    render(<AntigravityAcpView />)
    await screen.findByTestId("acp-cli-missing")
    expect(screen.getByTestId("acp-connect-btn")).toBeDisabled()

    fireEvent.click(screen.getByTestId("acp-open-mcp-settings"))
    expect(mocks.setActiveSettingsCategory).toHaveBeenCalledWith("external-control")
    expect(mocks.setActiveView).toHaveBeenCalledWith("settings")
  })

  it("isolates cross-session events, disables new-session while prompting, preserves tool titles, and refreshes dependent configOptions", async () => {
    let resolvePrompt!: (v: unknown) => void
    mocks.invoke.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "antigravity_cli_detect":
          return {
            installed: true,
            version: "1.5.14",
            path: "agy.exe",
            error: null,
            acp_supported: true,
          }
        case "antigravity_acp_status":
          return INITIAL_STATUS
        case "antigravity_acp_connect":
          return CONNECTED_STATUS
        case "antigravity_acp_new_session":
          return {
            sessionId: "sess-active",
            cwd: "C:\\books\\demo",
            attachedLocalMcp: false,
            configOptions: [
              {
                id: "model",
                name: "Model",
                currentValue: "gemini-3-pro",
                options: [
                  { value: "gemini-3-pro", name: "Gemini 3 Pro" },
                  { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
                ],
              },
            ],
            rawResult: {},
          }
        case "antigravity_acp_set_config_option":
          return {
            configOptions: [
              {
                id: "model",
                name: "Model",
                currentValue: "claude-sonnet-4-6",
                options: [{ value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
              },
              {
                id: "thinking",
                name: "Thinking",
                currentValue: "high",
                options: [
                  { value: "low", name: "Low" },
                  { value: "high", name: "High" },
                ],
              },
            ],
          }
        case "antigravity_acp_prompt":
          return new Promise((res) => {
            resolvePrompt = res
          })
        default:
          return undefined
      }
    })

    render(<AntigravityAcpView />)
    await screen.findByTestId("acp-cli-ready")

    fireEvent.click(screen.getByTestId("acp-connect-btn"))
    await screen.findByTestId("acp-connected-badge")
    fireEvent.click(screen.getByTestId("acp-new-session-btn"))
    const modelSelect = await screen.findByTestId("acp-config-model")

    // Changing model refreshes dependent configOptions (e.g. thinking selector) from server response.
    fireEvent.change(modelSelect, { target: { value: "claude-sonnet-4-6" } })
    expect(await screen.findByTestId("acp-config-thinking")).toBeInTheDocument()

    // Start a turn — New Session button must be disabled while prompting.
    fireEvent.change(screen.getByTestId("acp-prompt-input"), { target: { value: "Draft outline" } })
    fireEvent.click(screen.getByTestId("acp-send-btn"))
    await waitFor(() => {
      expect(screen.getByTestId("acp-new-session-btn")).toBeDisabled()
    })

    // Events belonging to a stale sessionId must be ignored completely.
    act(() => {
      emitEvent?.({
        kind: "session_update",
        params: {
          sessionId: "sess-stale-other",
          update: { sessionUpdate: "agent_message_chunk", content: { text: "LEAKED_TEXT" } },
        },
      })
      emitEvent?.({
        kind: "permission_request",
        permission: {
          requestId: "req-stale",
          sessionId: "sess-stale-other",
          title: "Stale permission",
          options: [{ optionId: "allow_once", name: "Allow" }],
        },
      })
    })
    expect(screen.queryByText("LEAKED_TEXT")).toBeNull()
    expect(screen.queryByTestId("acp-permission-req-stale")).toBeNull()

    // Active session tool_call followed by title-less tool_call_update preserves original title.
    act(() => {
      emitEvent?.({
        kind: "session_update",
        params: {
          sessionId: "sess-active",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-99",
            title: "Inspect chapter canon",
            status: "in_progress",
          },
        },
      })
      emitEvent?.({
        kind: "session_update",
        params: {
          sessionId: "sess-active",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc-99",
            status: "completed",
          },
        },
      })
    })
    expect(await screen.findByText(/Inspect chapter canon · completed/)).toBeInTheDocument()

    resolvePrompt({ stopReason: "end_turn" })
    await waitFor(() => {
      expect(screen.getByTestId("acp-new-session-btn")).not.toBeDisabled()
    })
  })

  it("persists streaming transcript and stderr logs across view unmount/remount", async () => {
    const activeStatus = {
      ...CONNECTED_STATUS,
      activeSessionId: "sess-persist",
    }
    mocks.invoke.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "antigravity_cli_detect":
          return { installed: true, version: "1.6.0", path: "agy.exe", error: null, acp_supported: true }
        case "antigravity_acp_status":
          return activeStatus
        default:
          return undefined
      }
    })

    const firstMount = render(<AntigravityAcpView />)
    await screen.findByTestId("acp-connected-badge")

    act(() => {
      emitEvent?.({
        kind: "session_update",
        params: {
          sessionId: "sess-persist",
          update: { sessionUpdate: "agent_message_chunk", content: { text: "Part 1. " } },
        },
      })
      emitEvent?.({ kind: "stderr", message: "[stderr] initial diagnostic\n" })
    })
    expect(await screen.findByText("Part 1.")).toBeInTheDocument()

    // Unmount view (simulate switching to another view) while events keep arriving!
    firstMount.unmount()

    act(() => {
      emitEvent?.({
        kind: "session_update",
        params: {
          sessionId: "sess-persist",
          update: { sessionUpdate: "agent_message_chunk", content: { text: "Part 2 while away." } },
        },
      })
      emitEvent?.({ kind: "stderr", message: "[stderr] away diagnostic\n" })
    })

    // Remount view — transcript and stderr diagnostics remain intact!
    render(<AntigravityAcpView />)
    expect(await screen.findByText("Part 1. Part 2 while away.")).toBeInTheDocument()
    expect(screen.getByTestId("acp-stderr-content")).toHaveTextContent("[stderr] away diagnostic")

    // Clear stderr button empties diagnostics drawer
    fireEvent.click(screen.getByTestId("acp-stderr-clear-btn"))
    await waitFor(() => {
      expect(screen.queryByTestId("acp-stderr-content")).toBeNull()
    })
  })

  it("controls inline MCP readiness safely (project/read only, never mcp_server_token or full/auto) and warns on unsupported CLI", async () => {
    let mcpRunning = false
    let mcpScope: "read" | "project" = "read"

    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "antigravity_cli_detect":
          return {
            installed: true,
            version: "0.9.0",
            path: "agy.exe",
            error: null,
            acp_supported: false,
          }
        case "antigravity_acp_status":
          return INITIAL_STATUS
        case "mcp_server_status":
          return {
            running: mcpRunning,
            port: mcpRunning ? 45871 : null,
            tool_count: 17,
            scope: mcpScope,
            endpoint: "http://127.0.0.1:45871/mcp",
          }
        case "mcp_server_start":
          mcpRunning = true
          mcpScope = (args?.scope as "read" | "project") ?? "read"
          return 45871
        default:
          return undefined
      }
    })

    render(<AntigravityAcpView />)
    await screen.findByTestId("acp-cli-unsupported")
    expect(screen.getByTestId("acp-connect-btn")).toBeDisabled()
    expect(screen.getByTestId("acp-connect-and-start-btn")).toBeDisabled()

    // Start local MCP in draft-safe project scope
    fireEvent.click(screen.getByTestId("acp-mcp-start-project-btn"))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("mcp_server_start", { scope: "project" })
    })
    expect(screen.getByTestId("acp-mcp-status-badge")).toHaveTextContent("project")

    // Verify strict compliance: NEVER invoke mcp_server_token, NEVER request full/auto!
    expect(mocks.invoke).not.toHaveBeenCalledWith("mcp_server_token")
    expect(mocks.invoke).not.toHaveBeenCalledWith("mcp_server_token", expect.anything())
    for (const call of mocks.invoke.mock.calls) {
      if (call[0] === "mcp_server_start") {
        const scopeArg = (call[1] as { scope?: string } | undefined)?.scope
        expect(scopeArg).not.toBe("full")
        expect(scopeArg).not.toBe("auto")
      }
    }
  })

  it("supports 1-click Connect & Start, workspace browse, quick actions pre-fill only, chapter.write draft handoff, enhanced permission card, stopReason, and 16k truncation", async () => {
    let resolvePerm!: () => void
    mocks.pickDirectory.mockResolvedValue("C:\\books\\picked")
    mocks.storeState.fileTree = [
      { name: "ch01.md", path: "wiki/chapters/ch01.md", is_dir: false },
      { name: "ch02.md", path: "wiki/chapters/ch02.md", is_dir: false },
    ]
    mocks.storeState.fileContent = "字".repeat(ACP_CONTEXT_MAX_CHARS + 20)

    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })

    mocks.invoke.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "antigravity_cli_detect":
          return { installed: true, version: "1.6.0", path: "agy.exe", error: null, acp_supported: true }
        case "antigravity_acp_status":
          return INITIAL_STATUS
        case "antigravity_acp_connect":
          return CONNECTED_STATUS
        case "antigravity_acp_new_session":
          return {
            sessionId: "sess-ux-1",
            cwd: "C:\\books\\picked",
            attachedLocalMcp: false,
            localMcpSkipReason: "mcp_server_not_running",
            configOptions: [],
            rawResult: {},
          }
        case "antigravity_acp_prompt":
          return { stopReason: "max_tokens" }
        case "antigravity_acp_respond_permission":
          return new Promise<void>((res) => {
            resolvePerm = res
          })
        default:
          return undefined
      }
    })

    render(<AntigravityAcpView />)
    await screen.findByTestId("acp-cli-ready")

    // Browse workspace button updates workspace path
    fireEvent.click(screen.getByTestId("acp-workspace-pick-btn"))
    await waitFor(() => {
      expect(screen.getByTestId("acp-workspace-input")).toHaveValue("C:\\books\\picked")
    })

    // 1-click Connect & Start Session creates session and surfaces localMcpSkipReason warning
    fireEvent.click(screen.getByTestId("acp-connect-and-start-btn"))
    await screen.findByTestId("acp-mcp-skip-warning")
    expect(mocks.invoke).toHaveBeenCalledWith("antigravity_acp_connect", {
      cwd: "C:\\books\\picked",
      enableHttpMcp: false,
    })
    expect(mocks.invoke).toHaveBeenCalledWith("antigravity_acp_new_session", {
      cwd: "C:\\books\\picked",
      attachLocalMcp: false,
    })

    // Quick-action button ONLY pre-fills composer — NEVER auto-sends!
    fireEvent.click(screen.getByTestId("acp-quick-action-draft_next"))
    const textarea = screen.getByTestId("acp-prompt-input") as HTMLTextAreaElement
    expect(textarea.value).toContain("chapter.write")
    expect(textarea.value).toContain("3")
    expect(mocks.invoke).not.toHaveBeenCalledWith("antigravity_acp_prompt", expect.anything())

    // Attach large context (>16000 chars) shows explicit truncation badge and truncates safely
    fireEvent.click(screen.getByTestId("acp-attach-context"))
    expect(screen.getByTestId("acp-context-truncated-badge")).toBeInTheDocument()

    // Manual send triggers prompt and surfaces max_tokens stopReason badge
    fireEvent.click(screen.getByTestId("acp-send-btn"))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith(
        "antigravity_acp_prompt",
        expect.objectContaining({
          sessionId: "sess-ux-1",
          contextTitle: "chapters/ch01.md",
          contextText: "字".repeat(ACP_CONTEXT_MAX_CHARS),
        }),
      )
    })
    expect(await screen.findByTestId("acp-stop-reason-badge")).toHaveTextContent("max_tokens")

    // Enhanced permission card renders toolKind, locations, rawInputSummary, allow_always caution, and disables while submitting
    act(() => {
      emitEvent?.({
        kind: "permission_request",
        permission: {
          requestId: "req-informed",
          sessionId: "sess-ux-1",
          title: "Run chapter.write",
          toolKind: "mcp",
          locations: ["wiki/drafts/ch03.md"],
          rawInputSummary: '{"chapter":3}',
          options: [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
          ],
        },
      })
    })
    expect(await screen.findByTestId("acp-perm-kind-req-informed")).toHaveTextContent("mcp")
    expect(screen.getByTestId("acp-perm-locations-req-informed")).toHaveTextContent("wiki/drafts/ch03.md")
    expect(screen.getByTestId("acp-perm-input-req-informed")).toHaveTextContent('{"chapter":3}')
    expect(screen.getByTestId("acp-perm-always-warning-req-informed")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("acp-perm-opt-req-informed-allow_once"))
    expect(screen.getByTestId("acp-perm-opt-req-informed-allow_once")).toBeDisabled()
    expect(screen.getByTestId("acp-perm-opt-req-informed-allow_always")).toBeDisabled()
    resolvePerm()
    await waitFor(() => {
      expect(screen.getByTestId("acp-perm-opt-req-informed-allow_once")).not.toBeDisabled()
    })

    // Completed chapter.write triggers Draft Handoff Strip + assistant copy button works
    act(() => {
      emitEvent?.({
        kind: "session_update",
        params: {
          sessionId: "sess-ux-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Chapter 3 draft ready." },
          },
        },
      })
      emitEvent?.({
        kind: "session_update",
        params: {
          sessionId: "sess-ux-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-draft-3",
            title: "niko-buddy/chapter.write",
            status: "in_progress",
          },
        },
      })
      emitEvent?.({
        kind: "session_update",
        params: {
          sessionId: "sess-ux-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc-draft-3",
            status: "completed",
          },
        },
      })
    })

    expect(await screen.findByTestId("acp-draft-handoff-strip")).toBeInTheDocument()

    // Click Main Control Drafts handoff button
    fireEvent.click(screen.getByTestId("acp-handoff-main-control-drafts"))
    expect(peekMainControlTabHandoff()).toBe("drafts")
    expect(mocks.setActiveView).toHaveBeenCalledWith("mainControl")

    // Click Review Center handoff button
    fireEvent.click(screen.getByTestId("acp-handoff-review-center"))
    expect(mocks.setActiveView).toHaveBeenCalledWith("reviewCenter")

    // Copy assistant message
    const copyBtn = document.querySelector('[data-testid^="acp-copy-msg-"]') as HTMLButtonElement
    expect(copyBtn).toBeTruthy()
    fireEvent.click(copyBtn)
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("Chapter 3 draft ready.")
    })

    // Clear transcript resets transcript and draft handoff strip
    fireEvent.click(screen.getByTestId("acp-clear-transcript-btn"))
    expect(screen.queryByText("Chapter 3 draft ready.")).toBeNull()
    expect(screen.queryByTestId("acp-draft-handoff-strip")).toBeNull()
  })

  it("renders assistant replies via SafeMarkdownProse, saves replies as Draft-first drafts with bumpDataVersion, and shows live pending drafts badge", async () => {
    mocks.usePendingDraftCount.mockReturnValue(2)
    mocks.storeState.dataVersion = 7
    mocks.storeState.fileTree = [
      { name: "ch01.md", path: "wiki/chapters/ch01.md", is_dir: false },
    ]
    const activeStatus = {
      ...CONNECTED_STATUS,
      activeSessionId: "sess-md-1",
    }
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "antigravity_cli_detect") {
        return { installed: true, version: "1.6.0", path: "agy.exe", error: null, acp_supported: true }
      }
      if (cmd === "antigravity_acp_status") return activeStatus
      return undefined
    })

    const { container } = render(<AntigravityAcpView />)
    await screen.findByTestId("acp-connected-badge")

    // Live pending drafts badge uses usePendingDraftCount(project.path, dataVersion) and navigates to drafts
    expect(mocks.usePendingDraftCount).toHaveBeenCalledWith("C:\\books\\demo", 7)
    const pendingBadge = screen.getByTestId("acp-pending-drafts-badge")
    expect(pendingBadge).toHaveTextContent("2")
    fireEvent.click(pendingBadge)
    expect(peekMainControlTabHandoff()).toBe("drafts")
    expect(mocks.setActiveView).toHaveBeenCalledWith("mainControl")

    // Assistant Markdown prose renders headings and escapes raw HTML safely
    act(() => {
      emitEvent?.({
        kind: "session_update",
        params: {
          sessionId: "sess-md-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "# 第五章 暗流涌动\n\n<script>alert(1)</script>\n\n林川推开了院门。",
            },
          },
        },
      })
    })
    expect(
      await screen.findByRole("heading", { level: 1, name: "第五章 暗流涌动" }),
    ).toBeInTheDocument()
    expect(container.querySelector("script")).toBeNull()

    // Click per-message Save as Draft -> writes via writeDraft WITHOUT adoptionGate (never deadlocks zero-API-key users), bumps dataVersion, lights up handoff strip
    const saveBtn = document.querySelector('[data-testid^="acp-save-draft-msg-"]') as HTMLButtonElement
    expect(saveBtn).toBeTruthy()
    fireEvent.click(saveBtn)
    await waitFor(() => {
      expect(mocks.writeDraft).toHaveBeenCalledWith(
        "C:\\books\\demo",
        "第5章",
        "# 第五章 暗流涌动\n\n<script>alert(1)</script>\n\n林川推开了院门。",
        expect.objectContaining({
          sourceConversationId: "acp:sess-md-1",
          sourceMessageId: expect.any(String),
        }),
      )
    })
    const writeDraftOpts = mocks.writeDraft.mock.calls[0]?.[3] as Record<string, unknown> | undefined
    expect(writeDraftOpts).toBeDefined()
    expect(writeDraftOpts).not.toHaveProperty("adoptionGate")
    expect(mocks.bumpDataVersion).toHaveBeenCalledTimes(1)
    expect(await screen.findByTestId("acp-draft-handoff-strip")).toBeInTheDocument()
  })

  it("preserves local enableHttpMcp checkbox on window focus while disconnected", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "antigravity_cli_detect") {
        return { installed: true, version: "1.6.0", path: "agy.exe", error: null, acp_supported: true }
      }
      if (cmd === "antigravity_acp_status") {
        return { ...INITIAL_STATUS, connected: false, httpMcpEnabled: false }
      }
      return undefined
    })

    render(<AntigravityAcpView />)
    await screen.findByTestId("acp-cli-ready")

    const checkbox = screen.getByTestId("acp-enable-http-mcp") as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)

    const statusCallsBefore = mocks.invoke.mock.calls.filter(
      ([c]) => c === "antigravity_acp_status",
    ).length
    fireEvent(window, new Event("focus"))
    await waitFor(() => {
      const statusCallsAfter = mocks.invoke.mock.calls.filter(
        ([c]) => c === "antigravity_acp_status",
      ).length
      expect(statusCallsAfter).toBeGreaterThan(statusCallsBefore)
    })
    expect(checkbox.checked).toBe(true)
  })

  it("shows stale MCP banners for all 5 reasons with 1-click rebuild, unattached running MCP banner, agent_unsupported banner, and refreshes status on focus & MCP start", async () => {
    let statusSnapshot = {
      ...CONNECTED_STATUS,
      activeSessionId: "sess-stale-1",
      httpMcpEnabled: true,
      attachedLocalMcp: true,
      localMcpScope: "project",
      localMcpStale: true,
      localMcpStaleReason: "token_rotated" as
        | "mcp_server_stopped"
        | "token_rotated"
        | "port_changed"
        | "scope_changed"
        | "server_restarted",
      supportsHttpMcp: true,
    }
    let mcpRunning = true
    let mcpScope: "read" | "project" = "project"

    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "antigravity_cli_detect":
          return { installed: true, version: "1.6.0", path: "agy.exe", error: null, acp_supported: true }
        case "antigravity_acp_status":
          return statusSnapshot
        case "mcp_server_status":
          return {
            running: mcpRunning,
            port: mcpRunning ? 45871 : null,
            tool_count: 17,
            scope: mcpScope,
            endpoint: "http://127.0.0.1:45871/mcp",
          }
        case "mcp_server_start":
          mcpRunning = true
          mcpScope = (args?.scope as "read" | "project") ?? "project"
          return 45871
        case "antigravity_acp_new_session":
          statusSnapshot = {
            ...statusSnapshot,
            activeSessionId: "sess-rebuilt-2",
            attachedLocalMcp: true,
            localMcpStale: false,
            localMcpStaleReason: null as never,
          }
          return {
            sessionId: "sess-rebuilt-2",
            cwd: "C:\\books\\demo",
            attachedLocalMcp: true,
            localMcpScope: "project",
            localMcpSkipReason: null,
            configOptions: [],
            rawResult: {},
          }
        default:
          return undefined
      }
    })

    render(<AntigravityAcpView />)
    expect(await screen.findByTestId("acp-mcp-stale-banner")).toBeInTheDocument()
    expect(screen.getByTestId("acp-mcp-stale-reason")).toHaveTextContent(/Token|token/)

    // Verify all other canonical stale reasons render cleanly via window focus status refresh
    for (const reason of [
      "port_changed",
      "scope_changed",
      "server_restarted",
      "mcp_server_stopped",
    ] as const) {
      statusSnapshot = {
        ...statusSnapshot,
        localMcpStale: true,
        localMcpStaleReason: reason,
      }
      if (reason === "mcp_server_stopped") mcpRunning = false
      const callsBefore = mocks.invoke.mock.calls.filter(([c]) => c === "antigravity_acp_status").length
      fireEvent(window, new Event("focus"))
      await waitFor(() => {
        const callsAfter = mocks.invoke.mock.calls.filter(([c]) => c === "antigravity_acp_status").length
        expect(callsAfter).toBeGreaterThan(callsBefore)
      })
      expect(screen.getByTestId("acp-mcp-stale-banner")).toBeInTheDocument()
    }

    // 1-click restart MCP & rebuild clears stale banner
    fireEvent.click(screen.getByTestId("acp-mcp-stale-rebuild-btn"))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("mcp_server_start", { scope: "project" })
      expect(mocks.invoke).toHaveBeenCalledWith("antigravity_acp_new_session", {
        cwd: "C:\\books\\demo",
        attachLocalMcp: true,
      })
    })
    await waitFor(() => {
      expect(screen.queryByTestId("acp-mcp-stale-banner")).toBeNull()
    })

    // Unattached running MCP banner shows 1-click rebuild CTA
    act(() => {
      useAntigravityAcpStore.getState().applyStatusSnapshot({
        ...CONNECTED_STATUS,
        activeSessionId: "sess-unattached",
        httpMcpEnabled: true,
        attachedLocalMcp: false,
        localMcpStale: false,
        localMcpStaleReason: null,
        supportsHttpMcp: true,
      })
    })
    expect(await screen.findByTestId("acp-mcp-unattached-banner")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("acp-mcp-unattached-rebuild-btn"))
    await waitFor(() => {
      expect(screen.queryByTestId("acp-mcp-unattached-banner")).toBeNull()
    })

    // agent_unsupported banner renders cleanly and links to Official MCP Settings
    act(() => {
      useAntigravityAcpStore.getState().applyStatusSnapshot({
        ...CONNECTED_STATUS,
        activeSessionId: "sess-unsup",
        supportsHttpMcp: false,
      })
    })
    expect(await screen.findByTestId("acp-mcp-agent-unsupported-banner")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("acp-mcp-unsupported-settings-btn"))
    expect(mocks.setActiveSettingsCategory).toHaveBeenCalledWith("external-control")
    expect(mocks.setActiveView).toHaveBeenCalledWith("settings")

    // handleStartLocalMcp ALSO refreshes antigravity_acp_status alongside mcp_server_status
    mcpScope = "read"
    fireEvent(window, new Event("focus"))
    const startBtn = await screen.findByTestId("acp-mcp-start-project-btn")
    const statusCallsBeforeStart = mocks.invoke.mock.calls.filter(
      ([c]) => c === "antigravity_acp_status",
    ).length
    fireEvent.click(startBtn)
    await waitFor(() => {
      const statusCallsAfterStart = mocks.invoke.mock.calls.filter(
        ([c]) => c === "antigravity_acp_status",
      ).length
      expect(statusCallsAfterStart).toBeGreaterThan(statusCallsBeforeStart)
    })
  })

  it("handles duplicate permission locations, per-button aria-busy + submitting label, basename in attachCurrentDoc UI, and aria-busy on transcript", async () => {
    let resolvePerm!: () => void
    let resolvePrompt!: (v: unknown) => void
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    mocks.invoke.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "antigravity_cli_detect":
          return { installed: true, version: "1.6.0", path: "agy.exe", error: null, acp_supported: true }
        case "antigravity_acp_status":
          return { ...CONNECTED_STATUS, activeSessionId: "sess-a11y" }
        case "antigravity_acp_respond_permission":
          return new Promise<void>((res) => {
            resolvePerm = res
          })
        case "antigravity_acp_prompt":
          return new Promise((res) => {
            resolvePrompt = res
          })
        default:
          return undefined
      }
    })

    render(<AntigravityAcpView />)
    await screen.findByTestId("acp-connected-badge")

    // attachCurrentDoc UI shows basename (ch01.md) rather than full relative path
    const attachCheckbox = screen.getByTestId("acp-attach-context")
    const attachLabelText = attachCheckbox.parentElement?.textContent ?? ""
    expect(attachLabelText).toContain("ch01.md")
    expect(attachLabelText).not.toContain("chapters/ch01.md")

    // Duplicate locations must not trigger duplicate React key warnings; clicked button sets aria-busy="true"
    act(() => {
      emitEvent?.({
        kind: "permission_request",
        permission: {
          requestId: "req-dup",
          sessionId: "sess-a11y",
          title: "Write draft",
          locations: ["wiki/drafts/ch03.md", "wiki/drafts/ch03.md"],
          options: [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject_once", name: "Deny", kind: "reject_once" },
          ],
        },
      })
    })

    const allowBtn = await screen.findByTestId("acp-perm-opt-req-dup-allow_once")
    const denyBtn = screen.getByTestId("acp-perm-opt-req-dup-reject_once")
    fireEvent.click(allowBtn)
    expect(allowBtn).toHaveAttribute("aria-busy", "true")
    expect(denyBtn).toHaveAttribute("aria-busy", "false")
    expect(allowBtn).toHaveTextContent(/提交中|Submitting/)

    resolvePerm()
    await waitFor(() => {
      expect(allowBtn).toHaveAttribute("aria-busy", "false")
    })

    // Transcript log exposes aria-busy="true" while a prompt is in-flight
    expect(screen.getByTestId("acp-transcript")).toHaveAttribute("aria-busy", "false")
    fireEvent.change(screen.getByTestId("acp-prompt-input"), { target: { value: "Write scene" } })
    fireEvent.click(screen.getByTestId("acp-send-btn"))
    await waitFor(() => {
      expect(screen.getByTestId("acp-transcript")).toHaveAttribute("aria-busy", "true")
    })

    resolvePrompt({ stopReason: "end_turn" })
    await waitFor(() => {
      expect(screen.getByTestId("acp-transcript")).toHaveAttribute("aria-busy", "false")
    })

    // Outer MCP strip no longer holds role="status" (narrowed to inner badges/banners)
    expect(screen.getByTestId("acp-mcp-readiness-strip")).not.toHaveAttribute("role", "status")
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining("same key"), expect.anything())
    errSpy.mockRestore()
  })

  it("supports MCP profile selector, pending hint, 1-click isolated read-only reviewer session, parent code repo warning, and Writer Plugin sync/global install with isolated status errors", async () => {
    const basePluginStatus = {
      pluginName: "niko-buddy-writer",
      pluginVersion: "1.0.0",
      declarativeOnly: true,
      skillCount: 4,
      agentCount: 5,
      isolatedPluginPath: "C:\\Users\\demo\\AppData\\Local\\niko-buddy\\writer-plugin",
      isolatedPluginUpToDate: true,
      projectPath: "C:\\books\\demo",
      projectState: "not_synced" as "synced" | "needs_update" | "not_synced",
      projectVersion: null as string | null,
      projectHasClaudeMd: false,
      globalInstalled: false,
      globalEnabled: false,
      globalUpToDate: false,
      globalPath: null as string | null,
      parentCodeRepoWarning: null as string | null,
    }
    let currentPluginStatus = { ...basePluginStatus }
    let failPluginSync = false

    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "antigravity_cli_detect":
          return { installed: true, version: "1.6.0", path: "agy.exe", error: null, acp_supported: true }
        case "antigravity_acp_status":
          return {
            ...CONNECTED_STATUS,
            httpMcpEnabled: true,
            activeSessionId: "sess-writer-1",
            attachedLocalMcp: true,
            localMcpScope: "project",
            localMcpProfile: "writer-sub",
            parentCodeRepoWarning: "Detected .git in C:\\books",
          }
        case "mcp_server_status":
          return {
            running: true,
            port: 45871,
            tool_count: 17,
            scope: "project",
            endpoint: "http://127.0.0.1:45871/mcp",
          }
        case "antigravity_acp_new_session": {
          const requestedProfile = (args?.mcpProfile as string | undefined) ?? "writer-sub"
          return {
            sessionId: requestedProfile === "reviewer" ? "sess-reviewer-9" : "sess-arch-2",
            cwd: (args?.cwd as string) ?? "C:\\books\\demo",
            attachedLocalMcp: true,
            localMcpScope: "project",
            localMcpProfile: requestedProfile,
            parentCodeRepoWarning: requestedProfile === "reviewer" ? null : "Detected .git in C:\\books",
            configOptions: [],
            rawResult: {},
          }
        }
        case "writer_plugin_status":
          return currentPluginStatus
        case "writer_plugin_sync_project": {
          if (failPluginSync) throw new Error("disk read-only")
          currentPluginStatus = {
            ...currentPluginStatus,
            projectState: "synced",
            projectVersion: "1.0.0",
            projectHasClaudeMd: Boolean(args?.includeClaudeMd),
          }
          return {
            ok: true,
            pluginName: "niko-buddy-writer",
            pluginVersion: "1.0.0",
            projectPath: "C:\\books\\demo",
            includeClaudeMd: Boolean(args?.includeClaudeMd),
            writtenFiles: ["AGENTS.md", ".agents/skills/draft/SKILL.md"],
            unchangedFiles: [],
            agentsMdPreservedUserContent: true,
            parentCodeRepoWarning: null,
            status: currentPluginStatus,
          }
        }
        case "writer_plugin_install_global":
          currentPluginStatus = {
            ...currentPluginStatus,
            globalInstalled: true,
            globalEnabled: false,
            globalUpToDate: true,
            globalPath: "C:\\Users\\demo\\.gemini\\plugins\\niko-buddy-writer",
          }
          return {
            ok: true,
            pluginName: "niko-buddy-writer",
            pluginVersion: "1.0.0",
            installPath: "C:\\Users\\demo\\.gemini\\plugins\\niko-buddy-writer",
            enabled: false,
            disabled: true,
            writtenFiles: ["plugin.json"],
            unchangedFiles: [],
            enableCommand: "agy plugin enable niko-buddy-writer",
            disableCommand: "agy plugin disable niko-buddy-writer",
          }
        default:
          return undefined
      }
    })

    render(<AntigravityAcpView />)
    await screen.findByTestId("acp-active-profile-badge")
    expect(screen.getByTestId("acp-active-profile-badge")).toHaveTextContent("writer-sub")

    // Parent code repo warning banner renders with role="status", outer MCP strip still has no role="status"
    const repoBanner = screen.getByTestId("acp-parent-repo-warning-banner")
    expect(repoBanner).toHaveAttribute("role", "status")
    expect(repoBanner).toHaveTextContent("Detected .git in C:\\books")
    expect(screen.getByTestId("acp-mcp-readiness-strip")).not.toHaveAttribute("role", "status")

    // Changing profile mid-session surfaces pending hint and passes explicit mcpProfile on New Session
    const profileSelect = screen.getByTestId("acp-mcp-profile-select") as HTMLSelectElement
    expect(profileSelect.value).toBe("writer-sub")
    const optionMap = Object.fromEntries(
      Array.from(profileSelect.options).map((opt) => [opt.value, opt.textContent ?? ""]),
    )
    expect(optionMap["writer-sub"]).toContain("36")
    expect(optionMap.reviewer).toContain("25")
    expect(optionMap.architect).toContain("28")
    expect(optionMap["full-legacy"]).toContain("50")
    fireEvent.change(profileSelect, { target: { value: "architect" } })
    expect(screen.getByTestId("acp-profile-pending-hint")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("acp-new-session-btn"))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("antigravity_acp_new_session", {
        cwd: "C:\\books\\demo",
        attachLocalMcp: true,
        mcpProfile: "architect",
      })
    })
    expect(screen.getByTestId("acp-active-profile-badge")).toHaveTextContent("architect")
    expect(screen.queryByTestId("acp-profile-pending-hint")).toBeNull()

    // Populate writer composer input & transcript, then click non-destructive Hand off to Reviewer Slot
    mocks.listChapterDrafts.mockResolvedValueOnce([
      {
        id: "draft-ch03-xyz",
        chapterName: "第3章 夜雨",
        status: "draft",
        createdAt: 1700000000,
        revisionRound: 1,
        adoptionGate: { status: "blocked" },
      },
    ])
    act(() => {
      emitEvent?.({
        kind: "session_update",
        params: {
          sessionId: "sess-arch-2",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "起草完成，context.prepare_write prepareId: prep-ch03-77" },
          },
        },
      })
    })
    fireEvent.change(screen.getByTestId("acp-prompt-input"), { target: { value: "Unsent writer note" } })
    fireEvent.click(screen.getByTestId("acp-handoff-reviewer-slot-btn"))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("antigravity_acp_new_session", {
        cwd: "C:\\books\\demo",
        attachLocalMcp: true,
        mcpProfile: "reviewer",
        slot: "reviewer",
      })
    })
    // Reviewer tab is active, profile selector is protocol-locked [RO], and composer is PRE-FILLED ONLY (zero auto-send!)
    expect(screen.getByTestId("acp-slot-tab-reviewer")).toHaveAttribute("aria-selected", "true")
    expect(profileSelect.value).toBe("reviewer")
    expect(profileSelect).toBeDisabled()
    expect(screen.getByTestId("acp-reviewer-profile-locked-hint")).toBeInTheDocument()
    expect(screen.getByTestId("acp-active-profile-badge")).toHaveTextContent("reviewer")
    const reviewerPromptVal = (screen.getByTestId("acp-prompt-input") as HTMLTextAreaElement).value
    expect(reviewerPromptVal).toContain("draft-ch03-xyz")
    expect(reviewerPromptVal).toContain("第3章 夜雨")
    expect(reviewerPromptVal).toContain("prep-ch03-77")
    expect(reviewerPromptVal).toContain("blocked")
    expect(reviewerPromptVal).toContain("Consistency(P0) > Anti-AI(P1) > Quality(P2)")
    expect(mocks.invoke).not.toHaveBeenCalledWith("antigravity_acp_prompt", expect.anything())
    // Explicit parentCodeRepoWarning: null cleared the stale banner on reviewer slot
    expect(screen.queryByTestId("acp-parent-repo-warning-banner")).toBeNull()

    // Switching back to Writer slot proves Writer's sessionId, transcript, unsent composerText, and mcpProfile are 100% intact!
    fireEvent.click(screen.getByTestId("acp-slot-tab-writer"))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("antigravity_acp_switch_slot", { slot: "writer" })
    })
    expect(screen.getByTestId("acp-slot-tab-writer")).toHaveAttribute("aria-selected", "true")
    expect((screen.getByTestId("acp-prompt-input") as HTMLTextAreaElement).value).toBe("Unsent writer note")
    expect(screen.getByTestId("acp-transcript").textContent).toContain("prep-ch03-77")
    expect(profileSelect.value).toBe("architect")
    expect(useAntigravityAcpStore.getState().slots.writer.sessionId).toBe("sess-arch-2")

    // Clicking Hand off again while reviewer slot already has a non-stale session REUSES it via switch_slot (no new_session!)
    const newSessionCallsBeforeReuse = mocks.invoke.mock.calls.filter(
      ([c]) => c === "antigravity_acp_new_session",
    ).length
    fireEvent.click(screen.getByTestId("acp-handoff-reviewer-slot-btn"))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("antigravity_acp_switch_slot", { slot: "reviewer" })
    })
    expect(
      mocks.invoke.mock.calls.filter(([c]) => c === "antigravity_acp_new_session").length,
    ).toBe(newSessionCallsBeforeReuse)
    expect(mocks.invoke).not.toHaveBeenCalledWith("antigravity_acp_prompt", expect.anything())

    // Writer Plugin Card: check includeClaudeMd, sync project, then install disabled global plugin
    expect(screen.getByTestId("acp-writer-plugin-state-badge")).toHaveTextContent(/未同步|Not synced/)
    fireEvent.click(screen.getByTestId("acp-writer-plugin-include-claude-md"))
    fireEvent.click(screen.getByTestId("acp-writer-plugin-sync-btn"))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("writer_plugin_sync_project", {
        projectPath: "C:\\books\\demo",
        includeClaudeMd: true,
      })
    })
    expect(screen.getByTestId("acp-writer-plugin-state-badge")).toHaveTextContent(/已同步|Synced/)
    expect(screen.getByTestId("acp-writer-plugin-feedback")).toHaveAttribute("role", "status")

    fireEvent.click(screen.getByTestId("acp-writer-plugin-install-global-btn"))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("writer_plugin_install_global", {
        enable: false,
      })
    })
    const guidance = await screen.findByTestId("acp-writer-plugin-global-guidance")
    expect(guidance).toHaveTextContent("agy plugin enable niko-buddy-writer")
    expect(guidance).toHaveTextContent("agy plugin disable niko-buddy-writer")

    // Plugin errors remain strictly inside acp-writer-plugin-error (role="status") and NEVER pollute acp-error-banner
    failPluginSync = true
    fireEvent.click(screen.getByTestId("acp-writer-plugin-sync-btn"))
    const pluginErr = await screen.findByTestId("acp-writer-plugin-error")
    expect(pluginErr).toHaveAttribute("role", "status")
    expect(pluginErr).toHaveTextContent("disk read-only")
    expect(screen.queryByTestId("acp-error-banner")).toBeNull()

    // Strict compliance invariant: zero mcp_server_token invoke, zero full/auto scopes
    expect(mocks.invoke).not.toHaveBeenCalledWith("mcp_server_token")
    expect(mocks.invoke).not.toHaveBeenCalledWith("mcp_server_token", expect.anything())
  })

  it("disables Writer Plugin project sync with hint when no novel project is open", async () => {
    mocks.storeState.project = null
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "antigravity_cli_detect") {
        return { installed: true, version: "1.6.0", path: "agy.exe", error: null, acp_supported: true }
      }
      if (cmd === "antigravity_acp_status") return INITIAL_STATUS
      return undefined
    })

    render(<AntigravityAcpView />)
    await screen.findByTestId("acp-cli-ready")
    expect(screen.getByTestId("acp-writer-plugin-sync-btn")).toBeDisabled()
    expect(screen.getByTestId("acp-writer-plugin-no-project-hint")).toBeInTheDocument()
  })

  it("preserves unsent input, savedDraftMsgMap, and mcpProfile when isolated reviewer session creation fails", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "antigravity_cli_detect":
          return { installed: true, version: "1.6.0", path: "agy.exe", error: null, acp_supported: true }
        case "antigravity_acp_status":
          return {
            ...CONNECTED_STATUS,
            httpMcpEnabled: true,
            activeSessionId: "sess-writer-keep",
            attachedLocalMcp: true,
            localMcpScope: "project",
            localMcpProfile: "architect",
          }
        case "antigravity_acp_new_session":
          throw new Error("RPC timeout while creating reviewer session")
        default:
          return undefined
      }
    })

    render(<AntigravityAcpView />)
    await screen.findByTestId("acp-active-profile-badge")

    // Emit an assistant message and save it as draft so savedDraftMsgMap is populated.
    act(() => {
      emitEvent?.({
        kind: "session_update",
        params: {
          sessionId: "sess-writer-keep",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "# 第四章 暗夜潜行\n\n林川屏息贴近廊柱。" },
          },
        },
      })
    })
    const saveBtn = (await waitFor(() => {
      const btn = document.querySelector('[data-testid^="acp-save-draft-msg-"]') as HTMLButtonElement | null
      expect(btn).toBeTruthy()
      return btn!
    }))
    fireEvent.click(saveBtn)
    await waitFor(() => {
      expect(saveBtn).toHaveTextContent(/已存入草稿|Saved to drafts/)
    })

    // Type an unsent prompt and verify current profile is architect.
    const promptInput = screen.getByTestId("acp-prompt-input") as HTMLTextAreaElement
    const profileSelect = screen.getByTestId("acp-mcp-profile-select") as HTMLSelectElement
    fireEvent.change(promptInput, { target: { value: "Unsent ch04 revision note" } })
    expect(profileSelect.value).toBe("architect")

    // Click handoff to reviewer slot -> RPC fails -> writer composer input, savedDraftMsgMap, and mcpProfile remain 100% intact!
    fireEvent.click(screen.getByTestId("acp-handoff-reviewer-slot-btn"))
    await waitFor(() => {
      expect(screen.getByTestId("acp-error-banner")).toHaveTextContent(
        "RPC timeout while creating reviewer session",
      )
    })
    expect(promptInput.value).toBe("Unsent ch04 revision note")
    expect(profileSelect.value).toBe("architect")
    expect(useAntigravityAcpStore.getState().activeSlot).toBe("writer")
    expect(useAntigravityAcpStore.getState().mcpProfile).toBe("architect")
    expect(saveBtn).toHaveTextContent(/已存入草稿|Saved to drafts/)
    expect(mocks.invoke).not.toHaveBeenCalledWith("antigravity_acp_prompt", expect.anything())
  })

  it("shows honest no-MCP system message when reviewer slot handoff starts with attachedLocalMcp=false while keeping writer composer intact", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "antigravity_cli_detect":
          return { installed: true, version: "1.6.0", path: "agy.exe", error: null, acp_supported: true }
        case "antigravity_acp_status":
          return {
            ...CONNECTED_STATUS,
            httpMcpEnabled: false,
            activeSessionId: "sess-writer-nomcp",
            attachedLocalMcp: false,
          }
        case "antigravity_acp_new_session":
          return {
            slot: "reviewer",
            sessionId: "sess-rev-nomcp-7",
            cwd: "C:\\books\\demo",
            attachedLocalMcp: false,
            localMcpScope: null,
            localMcpProfile: null,
            localMcpSkipReason: "http_mcp_disabled",
            readOnly: true,
            parentCodeRepoWarning: null,
            configOptions: [],
            rawResult: {},
          }
        default:
          return undefined
      }
    })

    render(<AntigravityAcpView />)
    await screen.findByTestId("acp-connected-badge")

    fireEvent.change(screen.getByTestId("acp-prompt-input"), { target: { value: "Old writer note" } })
    fireEvent.click(screen.getByTestId("acp-handoff-reviewer-slot-btn"))

    const transcript = screen.getByTestId("acp-transcript")
    await waitFor(() => {
      expect(transcript.textContent).toContain("sess-rev")
    })
    // Honest wording: explicitly notes local read-only MCP tools were NOT attached, never claims they were attached!
    expect(transcript.textContent).toMatch(/未挂载本地只读 MCP|local read-only MCP tools were not attached/)
    expect(transcript.textContent).not.toContain("仅挂载只读审稿工具")
    expect(transcript.textContent).not.toContain("with read-only review tools")
    // Reviewer composer pre-filled with read-only handoff (zero auto-send), while Writer's unsent note is preserved!
    expect((screen.getByTestId("acp-prompt-input") as HTMLTextAreaElement).value).toContain("[RO]")
    expect(useAntigravityAcpStore.getState().slots.writer.composerText).toBe("Old writer note")
    expect(mocks.invoke).not.toHaveBeenCalledWith("antigravity_acp_prompt", expect.anything())
  })

  it("renders pure_subscription memory banner (role=status, zero extra mount invokes), navigates to Novel extract settings, and supports interactive snapshot dialog pre-fill & commit", async () => {
    mocks.storeState.fileTree = [
      {
        name: "wiki",
        path: "wiki",
        is_dir: true,
        children: [
          {
            name: "chapters",
            path: "wiki/chapters",
            is_dir: true,
            children: [
              { name: "ch01.md", path: "wiki/chapters/ch01.md", is_dir: false },
              { name: "ch02.md", path: "wiki/chapters/ch02.md", is_dir: false },
            ],
          },
        ],
      },
    ]
    mocks.storeState.selectedFile = "wiki/chapters/ch02.md"

    const sampleSnapshot = {
      chapterId: "chapter-2",
      chapterNumber: 2,
      summary: "第二章关键摘要",
      characters: ["林川"],
      locations: [],
      organizations: [],
      items: [],
      events: [],
      characterStateChanges: [],
      relationshipChanges: [],
      knowledgeChanges: [],
      foreshadowingChanges: [],
      newCanonFacts: ["青铜印章刻有星图"],
      timelineEvents: [],
      conflicts: [],
      endingHook: "",
      graphNodes: [],
      graphEdges: [],
    }
    const preparedSnapshot = {
      prepared: {
        snapshot: sampleSnapshot,
        source: {
          readPath: "wiki/chapters/ch02.md",
          chapterNumber: 2,
          bodySha256: "a".repeat(64),
          contentSha256: "b".repeat(64),
        },
      },
      snapshot: sampleSnapshot,
      preview: "preview",
      validationWarnings: [],
      warnings: [],
      chapterPath: "wiki/chapters/ch02.md",
      chapterNumber: 2,
    }
    mocks.prepareInteractiveChapterSnapshot.mockResolvedValue({
      ok: true,
      prepared: preparedSnapshot,
    })
    mocks.commitInteractiveChapterSnapshot.mockResolvedValue({
      ingestResult: {
        snapshot: sampleSnapshot,
        canonOutcome: { status: "completed", report: { written: 1 } },
      },
      memoryStatus: {
        ingest: "ok",
        canonOutcome: { status: "completed", report: { written: 1 } },
      },
    })

    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "antigravity_cli_detect") {
        return { installed: true, version: "1.6.0", path: "agy.exe", error: null, acp_supported: true }
      }
      if (cmd === "antigravity_acp_status") {
        return { ...CONNECTED_STATUS, activeSessionId: "sess-hybrid-1" }
      }
      return undefined
    })

    render(<AntigravityAcpView />)
    await screen.findByTestId("acp-connected-badge")

    // Zero extra mount invokes beyond the 4 standard mount commands
    const mountCommands = new Set(mocks.invoke.mock.calls.map(([cmd]) => cmd as string))
    for (const cmd of mountCommands) {
      expect([
        "antigravity_cli_detect",
        "antigravity_acp_status",
        "mcp_server_status",
        "writer_plugin_status",
      ]).toContain(cmd)
    }

    // Memory mode banner is role="status" (never role="alert"), sibling after acp-mcp-readiness-strip
    const memoryBanner = screen.getByTestId("acp-memory-mode-banner")
    expect(memoryBanner).toHaveAttribute("role", "status")
    expect(memoryBanner).toHaveAttribute("data-memory-mode", "pure_subscription")
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByTestId("acp-mcp-readiness-strip")).not.toHaveAttribute("role", "status")

    // Configure extract model button routes to Settings -> novel
    fireEvent.click(screen.getByTestId("acp-configure-extract-model-btn"))
    expect(mocks.setActiveSettingsCategory).toHaveBeenCalledWith("novel")
    expect(mocks.setActiveView).toHaveBeenCalledWith("settings")

    // Open interactive snapshot dialog -> Step 1 Pre-fill populates composer ONLY (never auto-sends)
    fireEvent.click(screen.getByTestId("acp-open-snapshot-ingest-btn"))
    expect(await screen.findByTestId("acp-snapshot-ingest-dialog")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("snapshot-ingest-prefill-btn"))
    await waitFor(() => {
      expect(screen.queryByTestId("acp-snapshot-ingest-dialog")).toBeNull()
    })
    const composer = screen.getByTestId("acp-prompt-input") as HTMLTextAreaElement
    expect(composer.value).toContain("chapter.read")
    expect(composer.value).toContain("wiki/chapters/ch02.md")
    expect(mocks.invoke).not.toHaveBeenCalledWith("antigravity_acp_prompt", expect.anything())

    // Re-open dialog -> Step 2 Validate & Step 3 Commit triggers bumpDataVersion
    fireEvent.click(screen.getByTestId("acp-open-snapshot-ingest-btn"))
    await screen.findByTestId("acp-snapshot-ingest-dialog")
    fireEvent.change(screen.getByTestId("snapshot-ingest-json-input"), {
      target: { value: '{"chapterNumber":2,"summary":"第二章关键摘要"}' },
    })
    fireEvent.click(screen.getByTestId("snapshot-ingest-validate-btn"))
    await screen.findByTestId("snapshot-ingest-preview")

    fireEvent.click(screen.getByTestId("snapshot-ingest-commit-btn"))
    await screen.findByTestId("snapshot-ingest-result")
    expect(mocks.commitInteractiveChapterSnapshot).toHaveBeenCalledWith(
      "C:\\books\\demo",
      preparedSnapshot,
      { confirmed: true },
    )
    expect(mocks.bumpDataVersion).toHaveBeenCalledTimes(1)
  })

  it("renders golden_hybrid memory banner with extractModelLabel, embedding badge, autoIngestOnSave=false note, and disables manual commit when project is null", async () => {
    mocks.storeState.project = null
    mocks.storeState.llmConfig = {
      provider: "openai",
      apiKey: "",
      model: "",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    }
    mocks.storeState.novelConfig = {
      extractModel: "ollama-local/qwen2.5:7b",
      autoIngestOnSave: false,
    }
    mocks.storeState.providerConfigs = {
      "ollama-local": {
        apiKey: "",
        baseUrl: "http://127.0.0.1:11434",
        savedModels: [{ id: "m-ollama", name: "Qwen 2.5 7B", model: "qwen2.5:7b", createdAt: 1 }],
      },
    }
    mocks.storeState.embeddingConfig = {
      enabled: true,
    }

    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "antigravity_cli_detect") {
        return { installed: true, version: "1.6.0", path: "agy.exe", error: null, acp_supported: true }
      }
      if (cmd === "antigravity_acp_status") return INITIAL_STATUS
      return undefined
    })

    render(<AntigravityAcpView />)
    await screen.findByTestId("acp-cli-ready")

    const memoryBanner = screen.getByTestId("acp-memory-mode-banner")
    expect(memoryBanner).toHaveAttribute("role", "status")
    expect(memoryBanner).toHaveAttribute("data-memory-mode", "golden_hybrid")
    expect(screen.getByTestId("acp-memory-mode-extract-model")).toHaveTextContent(
      "ollama/qwen2.5:7b",
    )
    expect(screen.getByTestId("acp-memory-mode-embedding-badge")).toBeInTheDocument()
    expect(screen.getByTestId("acp-memory-mode-auto-ingest-off-note")).toBeInTheDocument()
    expect(screen.queryByTestId("acp-configure-extract-model-btn")).toBeNull()
    expect(screen.getByTestId("acp-open-snapshot-ingest-btn")).toBeDisabled()
    expect(screen.getByTestId("acp-toggle-draft-drawer-btn")).toBeDisabled()
  })

  it("toggles inline Draft-first drawer via header & handoff buttons while preserving pending-drafts badge and Main Control handoff", async () => {
    mocks.usePendingDraftCount.mockReturnValue(1)
    mocks.listChapterDrafts.mockResolvedValue([
      {
        id: "draft_inline_1",
        chapterName: "第4章",
        content: "第四章草稿正文",
        createdAt: 1_700_000_000_000,
        status: "draft",
      } as unknown as { chapterName: string; status: string },
    ])
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "antigravity_cli_detect") {
        return { installed: true, version: "1.6.0", path: "agy.exe", error: null, acp_supported: true }
      }
      if (cmd === "antigravity_acp_status") {
        return { ...CONNECTED_STATUS, activeSessionId: "sess-drawer-1" }
      }
      return undefined
    })

    render(<AntigravityAcpView />)
    await screen.findByTestId("acp-connected-badge")

    // Closed by default: drawer is absent and zero listChapterDrafts calls on mount
    expect(screen.queryByTestId("acp-draft-drawer")).toBeNull()
    expect(mocks.listChapterDrafts).not.toHaveBeenCalled()

    // Toggle open via header button
    fireEvent.click(screen.getByTestId("acp-toggle-draft-drawer-btn"))
    expect(await screen.findByTestId("acp-draft-drawer")).toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.listChapterDrafts).toHaveBeenCalledWith("C:\\books\\demo")
    })

    // Close drawer via drawer close button
    fireEvent.click(screen.getByTestId("acp-draft-drawer-close"))
    expect(screen.queryByTestId("acp-draft-drawer")).toBeNull()

    // Trigger draft write handoff strip -> click inline drawer button opens drawer without navigating away
    act(() => {
      emitEvent?.({
        kind: "session_update",
        params: {
          sessionId: "sess-drawer-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-write-4",
            title: "chapter.write",
            kind: "execute",
            status: "completed",
          },
        },
      })
    })
    expect(await screen.findByTestId("acp-draft-handoff-strip")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("acp-handoff-open-drawer"))
    expect(await screen.findByTestId("acp-draft-drawer")).toBeInTheDocument()
    expect(mocks.setActiveView).not.toHaveBeenCalled()

    // Existing pending badge & Main Control handoff remain intact
    expect(screen.getByTestId("acp-pending-drafts-badge")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("acp-handoff-main-control-drafts"))
    expect(peekMainControlTabHandoff()).toBe("drafts")
    expect(mocks.setActiveView).toHaveBeenCalledWith("mainControl")
  })

  it("renders per-message read-only snapshot preview button only on finalized assistant replies with ChapterSnapshot JSON and never auto-commits Step 3", async () => {
    mocks.storeState.fileTree = [
      {
        name: "wiki",
        path: "wiki",
        is_dir: true,
        children: [
          {
            name: "chapters",
            path: "wiki/chapters",
            is_dir: true,
            children: [
              { name: "ch01.md", path: "wiki/chapters/ch01.md", is_dir: false },
              { name: "ch03.md", path: "wiki/chapters/ch03.md", is_dir: false },
            ],
          },
        ],
      },
    ]
    const sampleSnapshot = {
      chapterId: "chapter-3",
      chapterNumber: 3,
      summary: "林川查清暗账来源",
      characters: ["林川"],
      locations: [],
      organizations: [],
      items: [],
      events: ["核对暗账"],
      characterStateChanges: [],
      relationshipChanges: [],
      knowledgeChanges: [],
      foreshadowingChanges: [],
      newCanonFacts: ["盐引暗账出自沈府"],
      timelineEvents: [],
      conflicts: [],
      endingHook: "",
      graphNodes: [],
      graphEdges: [],
    }
    const preparedCh3 = {
      prepared: {
        snapshot: sampleSnapshot,
        source: {
          readPath: "wiki/chapters/ch03.md",
          chapterNumber: 3,
          bodySha256: "a".repeat(64),
          contentSha256: "b".repeat(64),
        },
      },
      snapshot: sampleSnapshot,
      preview: "preview",
      validationWarnings: [],
      warnings: [],
      chapterPath: "wiki/chapters/ch03.md",
      chapterNumber: 3,
    }
    mocks.prepareInteractiveChapterSnapshot.mockResolvedValue({
      ok: true,
      prepared: preparedCh3,
    })

    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "antigravity_cli_detect") {
        return { installed: true, version: "1.6.0", path: "agy.exe", error: null, acp_supported: true }
      }
      if (cmd === "antigravity_acp_status") {
        return { ...CONNECTED_STATUS, activeSessionId: "sess-snap-1" }
      }
      return undefined
    })

    render(<AntigravityAcpView />)
    await screen.findByTestId("acp-connected-badge")

    // Plain prose assistant reply without snapshot JSON must NOT render snapshot preview button
    act(() => {
      emitEvent?.({
        kind: "session_update",
        params: {
          sessionId: "sess-snap-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "好的，这就为你读取第 3 章。" },
          },
        },
      })
    })
    expect(document.querySelector('[data-testid^="acp-load-snapshot-msg-"]')).toBeNull()

    // While actively streaming a snapshot JSON reply, button must NOT render until finalized
    const snapshotJson = JSON.stringify({
      chapterNumber: 3,
      summary: "林川查清暗账来源",
      characters: ["林川"],
      newCanonFacts: ["盐引暗账出自沈府"],
    })
    act(() => {
      useAntigravityAcpStore.getState().beginPromptTurn("提取第 3 章快照")
      emitEvent?.({
        kind: "session_update",
        params: {
          sessionId: "sess-snap-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `提取完成：\n\`\`\`json\n${snapshotJson}\n\`\`\``,
            },
          },
        },
      })
    })
    expect(document.querySelector('[data-testid^="acp-load-snapshot-msg-"]')).toBeNull()

    // Finalizing the prompt turn reveals the one-click read-only snapshot preview button
    act(() => {
      useAntigravityAcpStore.getState().finishPromptTurn("end_turn")
    })

    const loadSnapshotBtn = await waitFor(() => {
      const el = document.querySelector('[data-testid^="acp-load-snapshot-msg-"]') as HTMLButtonElement | null
      expect(el).not.toBeNull()
      return el!
    })

    // Click one-click snapshot preview button -> opens dialog, selects ch03, auto-validates read-only ONCE, NEVER auto-sends or auto-commits
    fireEvent.click(loadSnapshotBtn)
    expect(await screen.findByTestId("acp-snapshot-ingest-dialog")).toBeInTheDocument()
    await screen.findByTestId("snapshot-ingest-preview")

    expect(mocks.prepareInteractiveChapterSnapshot).toHaveBeenCalledTimes(1)
    expect(mocks.prepareInteractiveChapterSnapshot).toHaveBeenCalledWith(
      "C:\\books\\demo",
      "wiki/chapters/ch03.md",
      3,
      snapshotJson,
    )
    expect(mocks.commitInteractiveChapterSnapshot).not.toHaveBeenCalled()
    expect(mocks.invoke).not.toHaveBeenCalledWith("antigravity_acp_prompt", expect.anything())
  })

  it("isolates streaming updates, pending permissions, and savedDraftMsgMap across Writer and Reviewer slots during tab round-trips", async () => {
    let serverActiveSlot: "writer" | "reviewer" | "architect" = "writer"
    const reviewerPerms: Array<{
      requestId: string
      sessionId: string
      slot: "reviewer"
      title: string
      options: Array<{ optionId: string; name: string }>
    }> = []
    const buildStatus = () => ({
      ...CONNECTED_STATUS,
      httpMcpEnabled: true,
      activeSlot: serverActiveSlot,
      activeSessionId: serverActiveSlot === "reviewer" ? "sess-r1" : "sess-w1",
      attachedLocalMcp: true,
      localMcpScope: "project",
      localMcpProfile: serverActiveSlot === "reviewer" ? "reviewer" : "writer-sub",
      pendingPermissions: serverActiveSlot === "reviewer" ? [...reviewerPerms] : [],
      slots: {
        writer: {
          slot: "writer" as const,
          sessionId: "sess-w1",
          cwd: "C:\\books\\demo",
          configOptions: [],
          pendingPermissions: [],
          attachedLocalMcp: true,
          localMcpScope: "project",
          effectiveMcpScope: "project",
          localMcpProfile: "writer-sub" as const,
          readOnly: false,
          inFlightPrompt: false,
        },
        reviewer: {
          slot: "reviewer" as const,
          sessionId: "sess-r1",
          cwd: "C:\\books\\demo",
          configOptions: [],
          pendingPermissions: [...reviewerPerms],
          attachedLocalMcp: true,
          localMcpScope: "project",
          effectiveMcpScope: "read",
          localMcpProfile: "reviewer" as const,
          readOnly: true,
          inFlightPrompt: false,
        },
      },
    })

    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "antigravity_cli_detect":
          return { installed: true, version: "1.6.0", path: "agy.exe", error: null, acp_supported: true }
        case "antigravity_acp_status":
          return buildStatus()
        case "antigravity_acp_switch_slot":
          serverActiveSlot = (args?.slot as "writer" | "reviewer" | "architect") ?? "writer"
          return buildStatus()
        default:
          return undefined
      }
    })

    render(<AntigravityAcpView />)
    await screen.findByTestId("acp-slot-bar")
    await screen.findByTestId("acp-slot-connected-writer")
    expect(screen.getByTestId("acp-slot-connected-reviewer")).toBeInTheDocument()
    const tabpanel = screen.getByRole("tabpanel")
    expect(tabpanel).toHaveAttribute("id", "acp-slot-tabpanel")
    expect(tabpanel).toHaveAttribute("aria-labelledby", "acp-slot-tab-writer")
    expect(screen.getByTestId("acp-slot-tab-writer")).toHaveAttribute("aria-controls", "acp-slot-tabpanel")

    // Writer gets an assistant message and saves it as draft
    act(() => {
      emitEvent?.({
        kind: "session_update",
        slot: "writer",
        params: {
          sessionId: "sess-w1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "# 第六章 孤灯\n\n风雪拍打木窗。" },
          },
        },
      })
    })
    const saveBtn = await waitFor(() => {
      const btn = document.querySelector('[data-testid^="acp-save-draft-msg-"]') as HTMLButtonElement | null
      expect(btn).toBeTruthy()
      return btn!
    })
    fireEvent.click(saveBtn)
    await waitFor(() => {
      expect(saveBtn).toHaveTextContent(/已存入草稿|Saved to drafts/)
    })
    fireEvent.change(screen.getByTestId("acp-prompt-input"), { target: { value: "Writer draft note" } })

    // While viewing Writer, Reviewer receives a streaming chunk & permission request -> ZERO leakage into Writer UI!
    const revPerm = {
      requestId: "perm-rev-isolated",
      sessionId: "sess-r1",
      slot: "reviewer" as const,
      title: "draft.read",
      options: [{ optionId: "allow_once", name: "Allow" }],
    }
    reviewerPerms.push(revPerm)
    act(() => {
      emitEvent?.({
        kind: "session_update",
        slot: "reviewer",
        params: {
          sessionId: "sess-r1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Reviewer isolated verdict: P0 PASS" },
          },
        },
      })
      emitEvent?.({
        kind: "permission_request",
        slot: "reviewer",
        permission: revPerm,
      })
    })

    expect(screen.getByTestId("acp-transcript").textContent).toContain("风雪拍打木窗")
    expect(screen.getByTestId("acp-transcript").textContent).not.toContain("Reviewer isolated verdict")
    expect(screen.queryByTestId("acp-permission-perm-rev-isolated")).toBeNull()
    expect(screen.getByTestId("acp-slot-perm-badge-reviewer")).toHaveTextContent("1")

    // Switch to Reviewer tab -> Reviewer transcript & permission card appear
    fireEvent.click(screen.getByTestId("acp-slot-tab-reviewer"))
    await waitFor(() => {
      expect(screen.getByTestId("acp-slot-tab-reviewer")).toHaveAttribute("aria-selected", "true")
    })
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "acp-slot-tab-reviewer")
    expect(screen.getByTestId("acp-transcript").textContent).toContain("Reviewer isolated verdict: P0 PASS")
    expect(screen.getByTestId("acp-transcript").textContent).not.toContain("风雪拍打木窗")
    expect(screen.getByTestId("acp-permission-perm-rev-isolated")).toBeInTheDocument()

    // Switch back to Writer -> Writer transcript, unsent composerText, and saved-draft badge are 100% preserved!
    fireEvent.click(screen.getByTestId("acp-slot-tab-writer"))
    await waitFor(() => {
      expect(screen.getByTestId("acp-slot-tab-writer")).toHaveAttribute("aria-selected", "true")
    })
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "acp-slot-tab-writer")
    expect((screen.getByTestId("acp-prompt-input") as HTMLTextAreaElement).value).toBe("Writer draft note")
    expect(screen.getByTestId("acp-transcript").textContent).toContain("风雪拍打木窗")
    expect(screen.queryByTestId("acp-permission-perm-rev-isolated")).toBeNull()
    const restoredSaveBtn = document.querySelector('[data-testid^="acp-save-draft-msg-"]') as HTMLButtonElement | null
    expect(restoredSaveBtn).toHaveTextContent(/已存入草稿|Saved to drafts/)
  })
})
