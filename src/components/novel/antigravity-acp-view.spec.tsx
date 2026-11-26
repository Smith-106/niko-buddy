// @vitest-environment jsdom
// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"
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
  setActiveSettingsCategory: vi.fn(),
  bumpDataVersion: vi.fn(),
  writeDraft: vi.fn(),
  listChapterDrafts: vi.fn(async () => [] as Array<{ chapterName: string; status: string }>),
  usePendingDraftCount: vi.fn<(projectPath: string, reloadKey: unknown) => number | null>(() => 0),
  storeState: {
    project: { path: "C:\\books\\demo", name: "Demo" } as { path: string; name: string } | null,
    fileTree: [] as FileNode[],
    selectedFile: "chapters/ch01.md" as string | null,
    fileContent: "Chapter 1 draft content",
    dataVersion: 0,
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
    mocks.usePendingDraftCount.mockReset()
    mocks.usePendingDraftCount.mockReturnValue(0)
    mocks.isTauri.mockReturnValue(true)
    mocks.storeState.project = { path: "C:\\books\\demo", name: "Demo" }
    mocks.storeState.fileTree = []
    mocks.storeState.selectedFile = "chapters/ch01.md"
    mocks.storeState.fileContent = "Chapter 1 draft content"
    mocks.storeState.dataVersion = 0

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
})
