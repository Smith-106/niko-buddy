// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

/**
 * Memory-only Zustand store for the official Google Antigravity ACP v1 panel.
 *
 * Keeps live ACP transcript, permissions, model/thinking config options, and
 * redacted stderr diagnostics alive across view switches without writing any
 * sensitive session transcript or token data to localStorage/disk.
 */

import { create } from "zustand"
import type { UnlistenFn } from "@tauri-apps/api/event"
import { isTauri } from "@/lib/platform"
import {
  listenAntigravityAcpEvents,
  parseAcpConfigOptions,
  parseAcpSessionUpdate,
  type AcpConfigOption,
  type AcpEventPayload,
  type AcpPendingPermission,
  type AcpSessionResult,
  type AcpStatusSnapshot,
} from "@/lib/antigravity-acp-client"

export const STDERR_LOG_LIMIT = 100

export interface AcpTranscriptTool {
  id: string
  title: string
  status: string
}

export interface AcpTranscriptItem {
  id: string
  role: "user" | "assistant" | "system"
  text: string
  thought?: string
  tools?: AcpTranscriptTool[]
}

const CHAPTER_WRITE_RE =
  /(?:^|[\s/:_([「"'`-])chapter[._-]write(?=$|[\s,:;)）\]」"'`！。；]|\.(?=$|\s))/i
const CHAPTER_WRITE_EXCLUDED_RE =
  /chapter[._-]write(?:[._-](?:direct|preview)|direct|preview)/i

/**
 * Detect whether a completed ACP tool call refers to Niko Buddy's Draft-first
 * `chapter.write` MCP tool (including `mcp__*__chapter.write` prefixes) while
 * strictly excluding `chapter.write.preview` and `chapter.write_direct`.
 */
export function isDraftChapterWriteTool(title: string): boolean {
  const trimmed = title.trim()
  if (!trimmed) return false
  if (CHAPTER_WRITE_EXCLUDED_RE.test(trimmed)) return false
  return CHAPTER_WRITE_RE.test(trimmed)
}

export interface AntigravityAcpStoreState {
  status: AcpStatusSnapshot | null
  transcript: AcpTranscriptItem[]
  prompting: boolean
  stderrLogs: string[]
  pendingPermissions: AcpPendingPermission[]
  configOptions: AcpConfigOption[]
  lastStopReason: string | null
  hasRecentDraftWrite: boolean
  recentDraftWriteSummary: string | null
  lastLocalMcpSkipReason: string | null
  activeSessionId: string | null
  activeAssistantId: string | null
  authRequired: boolean
  error: string | null

  handleAcpEvent: (evt: AcpEventPayload) => void
  applyStatusSnapshot: (st: AcpStatusSnapshot) => void
  applySessionCreated: (res: AcpSessionResult, systemMessage?: string) => void
  beginPromptTurn: (userText: string) => void
  finishPromptTurn: (stopReason?: string | null) => void
  setConfigOptions: (
    options: AcpConfigOption[] | ((prev: AcpConfigOption[]) => AcpConfigOption[]),
  ) => void
  setAuthRequired: (required: boolean) => void
  setError: (error: string | null) => void
  setPrompting: (prompting: boolean) => void
  clearTranscript: () => void
  clearStderr: () => void
  dismissDraftWriteBanner: () => void
  markRecentDraftWrite: (summary?: string) => void
  appendSystemMessage: (text: string) => void
  reset: () => void
}

type AntigravityAcpDataState = Pick<
  AntigravityAcpStoreState,
  | "status"
  | "transcript"
  | "prompting"
  | "stderrLogs"
  | "pendingPermissions"
  | "configOptions"
  | "lastStopReason"
  | "hasRecentDraftWrite"
  | "recentDraftWriteSummary"
  | "lastLocalMcpSkipReason"
  | "activeSessionId"
  | "activeAssistantId"
  | "authRequired"
  | "error"
>

function createInitialDataState(): AntigravityAcpDataState {
  return {
    status: null,
    transcript: [],
    prompting: false,
    stderrLogs: [],
    pendingPermissions: [],
    configOptions: [],
    lastStopReason: null,
    hasRecentDraftWrite: false,
    recentDraftWriteSummary: null,
    lastLocalMcpSkipReason: null,
    activeSessionId: null,
    activeAssistantId: null,
    authRequired: false,
    error: null,
  }
}

function isStoreDisconnected(state: AntigravityAcpDataState): boolean {
  if (state.status !== null) return !state.status.connected
  return state.activeSessionId === null
}

function appendStderrLine(logs: string[], line: string): string[] {
  const next = [...logs, line]
  return next.length > STDERR_LOG_LIMIT ? next.slice(-STDERR_LOG_LIMIT) : next
}

function makeItemId(prefix: "usr" | "asst" | "sys"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

export const useAntigravityAcpStore = create<AntigravityAcpStoreState>((set) => ({
  ...createInitialDataState(),

  handleAcpEvent: (evt) => {
    if (evt.kind === "disconnected") {
      set((state) => ({
        status: state.status
          ? {
              ...state.status,
              connected: false,
              activeSessionId: null,
              configOptions: [],
              pendingPermissions: [],
              inFlightPrompt: false,
              attachedLocalMcp: false,
              localMcpScope: null,
              localMcpStale: false,
              localMcpStaleReason: null,
              supportsHttpMcp: undefined,
              supportsLoadSession: undefined,
            }
          : state.status,
        pendingPermissions: [],
        configOptions: [],
        prompting: false,
        activeSessionId: null,
        activeAssistantId: null,
        authRequired: false,
        lastLocalMcpSkipReason: null,
      }))
      return
    }

    if (evt.kind === "stderr") {
      const cleaned = evt.message.replace(/\r?\n$/, "")
      if (!cleaned.trim()) return
      set((state) => ({
        stderrLogs: appendStderrLine(state.stderrLogs, cleaned),
      }))
      return
    }

    if (evt.kind === "protocol_warning") {
      const preview = evt.preview?.trim()
      const previewSuffix = preview ? ` | preview: ${preview}` : ""
      const formatted = `[protocol_warning:${evt.code}] ${evt.message} (${evt.bytes}/${evt.limitBytes} bytes)${previewSuffix}`
      set((state) => ({
        stderrLogs: appendStderrLine(state.stderrLogs, formatted),
      }))
      return
    }

    if (evt.kind === "permission_request") {
      set((state) => {
        if (isStoreDisconnected(state)) return state
        const permSid = evt.permission.sessionId?.trim() || null
        if (permSid && state.activeSessionId && permSid !== state.activeSessionId) {
          return state
        }
        return {
          pendingPermissions: [
            ...state.pendingPermissions.filter((p) => p.requestId !== evt.permission.requestId),
            evt.permission,
          ],
        }
      })
      return
    }

    if (evt.kind === "permission_resolved") {
      set((state) => {
        if (isStoreDisconnected(state)) return state
        return {
          pendingPermissions: state.pendingPermissions.filter((p) => p.requestId !== evt.requestId),
        }
      })
      return
    }

    if (evt.kind === "session_update") {
      set((state) => {
        if (isStoreDisconnected(state)) return state
        const rawSid = evt.params.sessionId
        const evtSid = typeof rawSid === "string" && rawSid.trim() ? rawSid.trim() : null
        if (evtSid && state.activeSessionId && evtSid !== state.activeSessionId) {
          return state
        }
        const parsed = parseAcpSessionUpdate(evt.params)
        if (!parsed) return state
        if (parsed.type === "config_option_update") {
          return { configOptions: parsed.configOptions }
        }
        if (parsed.type === "other") return state

        const targetId = state.activeAssistantId ?? makeItemId("asst")
        const idx = state.transcript.findIndex((item) => item.id === targetId)
        const base: AcpTranscriptItem =
          idx >= 0 ? state.transcript[idx]! : { id: targetId, role: "assistant", text: "" }
        let nextItem: AcpTranscriptItem = base
        let nextHasRecentDraftWrite = state.hasRecentDraftWrite
        let nextRecentDraftWriteSummary = state.recentDraftWriteSummary

        if (parsed.type === "agent_message_chunk") {
          nextItem = { ...base, text: base.text + parsed.text }
        } else if (parsed.type === "agent_thought_chunk") {
          nextItem = { ...base, thought: (base.thought ?? "") + parsed.text }
        } else if (parsed.type === "tool_call") {
          const tools = [...(base.tools ?? [])]
          const tIdx = tools.findIndex((item) => item.id === parsed.toolCallId)
          // Merge existing tool title BEFORE inspecting completion, since ACP
          // `tool_call_update` frames with `status: "completed"` frequently omit `title`.
          const existingTitle = tIdx >= 0 ? tools[tIdx]!.title : null
          const resolvedTitle = parsed.title ?? existingTitle ?? parsed.toolCallId
          const entry: AcpTranscriptTool = {
            id: parsed.toolCallId,
            title: resolvedTitle,
            status: parsed.status,
          }
          if (tIdx >= 0) tools[tIdx] = entry
          else tools.push(entry)
          nextItem = { ...base, tools }
          if (
            parsed.status.toLowerCase() === "completed" &&
            isDraftChapterWriteTool(resolvedTitle)
          ) {
            nextHasRecentDraftWrite = true
            nextRecentDraftWriteSummary = null
          }
        }

        const nextTranscript =
          idx >= 0
            ? state.transcript.map((item, i) => (i === idx ? nextItem : item))
            : [...state.transcript, nextItem]

        return {
          activeAssistantId: targetId,
          transcript: nextTranscript,
          hasRecentDraftWrite: nextHasRecentDraftWrite,
          recentDraftWriteSummary: nextRecentDraftWriteSummary,
        }
      })
    }
  },

  applyStatusSnapshot: (st) => {
    set((state) => ({
      status: st,
      activeSessionId: st.activeSessionId ?? null,
      activeAssistantId: st.connected ? state.activeAssistantId : null,
      pendingPermissions: st.pendingPermissions ?? [],
      configOptions: parseAcpConfigOptions(st.configOptions ?? []),
      prompting:
        typeof st.inFlightPrompt === "boolean"
          ? st.inFlightPrompt
          : st.connected
            ? state.prompting
            : false,
    }))
  },

  applySessionCreated: (res, systemMessage) => {
    set((state) => ({
      status: state.status
        ? {
            ...state.status,
            activeSessionId: res.sessionId,
            cwd: res.cwd,
            configOptions: res.configOptions,
            attachedLocalMcp: res.attachedLocalMcp,
            localMcpScope: res.localMcpScope ?? null,
            localMcpStale: false,
            localMcpStaleReason: null,
          }
        : state.status,
      activeSessionId: res.sessionId,
      activeAssistantId: null,
      authRequired: false,
      lastStopReason: null,
      hasRecentDraftWrite: false,
      recentDraftWriteSummary: null,
      lastLocalMcpSkipReason: res.localMcpSkipReason ?? null,
      pendingPermissions: state.pendingPermissions.filter((p) => p.sessionId === res.sessionId),
      configOptions: parseAcpConfigOptions(res.configOptions ?? []),
      transcript: systemMessage
        ? [{ id: makeItemId("sys"), role: "system", text: systemMessage }]
        : [],
    }))
  },

  beginPromptTurn: (userText) => {
    set((state) => ({
      error: null,
      prompting: true,
      activeAssistantId: null,
      lastStopReason: null,
      transcript: [
        ...state.transcript,
        { id: makeItemId("usr"), role: "user", text: userText },
      ],
    }))
  },

  finishPromptTurn: (stopReason) => {
    set((state) => ({
      prompting: false,
      activeAssistantId: null,
      lastStopReason: stopReason !== undefined ? stopReason : state.lastStopReason,
    }))
  },

  setConfigOptions: (options) => {
    set((state) => ({
      configOptions: typeof options === "function" ? options(state.configOptions) : options,
    }))
  },

  setAuthRequired: (required) => {
    set({ authRequired: required })
  },

  setError: (error) => {
    set({ error })
  },

  setPrompting: (prompting) => {
    set({ prompting })
  },

  clearTranscript: () => {
    set({
      transcript: [],
      activeAssistantId: null,
      lastStopReason: null,
      hasRecentDraftWrite: false,
      recentDraftWriteSummary: null,
    })
  },

  clearStderr: () => {
    set({ stderrLogs: [] })
  },

  dismissDraftWriteBanner: () => {
    set({ hasRecentDraftWrite: false, recentDraftWriteSummary: null })
  },

  markRecentDraftWrite: (summary) => {
    set({
      hasRecentDraftWrite: true,
      recentDraftWriteSummary: summary?.trim() ? summary.trim() : null,
    })
  },

  appendSystemMessage: (text) => {
    set((state) => ({
      transcript: [
        ...state.transcript,
        { id: makeItemId("sys"), role: "system", text },
      ],
    }))
  },

  reset: () => {
    set(createInitialDataState())
  },
}))

// StrictMode-safe singleton Tauri event subscription
let activeUnlisten: UnlistenFn | null = null
let listenerPromise: Promise<void> | null = null
let listenerGeneration = 0

/**
 * Subscribe to `antigravity-acp:event` once for the lifetime of the app window.
 * Concurrent calls deduplicate onto the in-flight Promise; failures clear the
 * Promise so subsequent retries succeed.
 */
export function ensureAcpEventListener(): Promise<void> {
  if (!isTauri()) return Promise.resolve()
  if (activeUnlisten) return Promise.resolve()
  if (listenerPromise) return listenerPromise

  const gen = ++listenerGeneration
  const promise = listenAntigravityAcpEvents((evt) => {
    if (gen !== listenerGeneration) return
    useAntigravityAcpStore.getState().handleAcpEvent(evt)
  })
    .then((unlisten) => {
      if (gen !== listenerGeneration) {
        unlisten()
        return
      }
      activeUnlisten = unlisten
    })
    .catch((err) => {
      if (gen === listenerGeneration) {
        listenerPromise = null
      }
      throw err
    })

  listenerPromise = promise
  return promise
}

/** Tear down the singleton listener (intended for unit tests and clean resets). */
export function disposeAcpEventListener(): void {
  listenerGeneration += 1
  listenerPromise = null
  const fn = activeUnlisten
  activeUnlisten = null
  if (fn) fn()
}
