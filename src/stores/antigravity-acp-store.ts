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
  ACP_ROLE_SLOTS,
  isAcpRoleSlotId,
  listenAntigravityAcpEvents,
  parseAcpConfigOptions,
  parseAcpSessionUpdate,
  type AcpConfigOption,
  type AcpEventPayload,
  type AcpPendingPermission,
  type AcpRoleSlotId,
  type AcpSessionResult,
  type AcpSlotStatusSnapshot,
  type AcpStatusSnapshot,
  type LocalMcpStaleReason,
  type McpToolProfile,
} from "@/lib/antigravity-acp-client"
import {
  buildReassessmentIssue,
  checkTosTriggers,
  type TosReassessmentIssue,
  type TosTriggerCondition,
  type TosTriggerMonitorResult,
} from "@/lib/tos-trigger-monitor"

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

export interface AcpRoleSlotState {
  slot: AcpRoleSlotId
  sessionId: string | null
  cwd: string | null
  transcript: AcpTranscriptItem[]
  composerText: string
  prompting: boolean
  pendingPermissions: AcpPendingPermission[]
  configOptions: AcpConfigOption[]
  lastStopReason: string | null
  hasRecentDraftWrite: boolean
  recentDraftWriteSummary: string | null
  lastLocalMcpSkipReason: string | null
  activeAssistantId: string | null
  mcpProfile: McpToolProfile
  localMcpProfile: McpToolProfile | null
  attachedLocalMcp: boolean
  localMcpScope: string | null
  effectiveMcpScope: string | null
  readOnly: boolean
  localMcpStale: boolean
  localMcpStaleReason: LocalMcpStaleReason | null
  parentCodeRepoWarning: string | null
}

export interface AntigravityAcpStoreState {
  status: AcpStatusSnapshot | null
  activeSlot: AcpRoleSlotId
  slots: Record<AcpRoleSlotId, AcpRoleSlotState>
  transcript: AcpTranscriptItem[]
  composerText: string
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
  mcpProfile: McpToolProfile
  localMcpProfile: McpToolProfile | null
  parentCodeRepoWarning: string | null
  tosCompliance: TosTriggerMonitorResult
  tosReassessmentIssues: TosReassessmentIssue[]

  handleAcpEvent: (evt: AcpEventPayload) => void
  applyStatusSnapshot: (st: AcpStatusSnapshot) => void
  applySessionCreated: (
    res: AcpSessionResult,
    systemMessage?: string,
    slot?: AcpRoleSlotId,
  ) => void
  beginPromptTurn: (userText: string, slot?: AcpRoleSlotId) => void
  finishPromptTurn: (stopReason?: string | null, slot?: AcpRoleSlotId) => void
  setActiveSlot: (slot: AcpRoleSlotId) => void
  setSlotComposerText: (slot: AcpRoleSlotId, text: string) => void
  setComposerText: (text: string) => void
  setConfigOptions: (
    options: AcpConfigOption[] | ((prev: AcpConfigOption[]) => AcpConfigOption[]),
    slot?: AcpRoleSlotId,
  ) => void
  setMcpProfile: (profile: McpToolProfile, slot?: AcpRoleSlotId) => void
  setAuthRequired: (required: boolean) => void
  setError: (error: string | null) => void
  setPrompting: (prompting: boolean, slot?: AcpRoleSlotId) => void
  clearTranscript: (slot?: AcpRoleSlotId) => void
  clearStderr: () => void
  dismissDraftWriteBanner: (slot?: AcpRoleSlotId) => void
  markRecentDraftWrite: (summary?: string, slot?: AcpRoleSlotId) => void
  appendSystemMessage: (text: string, slot?: AcpRoleSlotId) => void
  evaluateTosTriggers: (conditions?: TosTriggerCondition[]) => TosReassessmentIssue[]
  reset: () => void
}

type AntigravityAcpDataState = Pick<
  AntigravityAcpStoreState,
  | "status"
  | "activeSlot"
  | "slots"
  | "transcript"
  | "composerText"
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
  | "mcpProfile"
  | "localMcpProfile"
  | "parentCodeRepoWarning"
  | "tosCompliance"
  | "tosReassessmentIssues"
>

function defaultSlotProfile(slot: AcpRoleSlotId): McpToolProfile {
  if (slot === "reviewer") return "reviewer"
  if (slot === "architect") return "architect"
  return "writer-sub"
}

function createInitialSlotState(slot: AcpRoleSlotId): AcpRoleSlotState {
  return {
    slot,
    sessionId: null,
    cwd: null,
    transcript: [],
    composerText: "",
    prompting: false,
    pendingPermissions: [],
    configOptions: [],
    lastStopReason: null,
    hasRecentDraftWrite: false,
    recentDraftWriteSummary: null,
    lastLocalMcpSkipReason: null,
    activeAssistantId: null,
    mcpProfile: defaultSlotProfile(slot),
    localMcpProfile: null,
    attachedLocalMcp: false,
    localMcpScope: null,
    effectiveMcpScope: null,
    readOnly: slot === "reviewer",
    localMcpStale: false,
    localMcpStaleReason: null,
    parentCodeRepoWarning: null,
  }
}

function createInitialSlots(): Record<AcpRoleSlotId, AcpRoleSlotState> {
  return {
    writer: createInitialSlotState("writer"),
    reviewer: createInitialSlotState("reviewer"),
    architect: createInitialSlotState("architect"),
  }
}

function projectActiveSlot(
  slots: Record<AcpRoleSlotId, AcpRoleSlotState>,
  activeSlot: AcpRoleSlotId,
  status: AcpStatusSnapshot | null,
  syncStatusMirrors = true,
): Pick<
  AntigravityAcpDataState,
  | "activeSlot"
  | "slots"
  | "status"
  | "activeSessionId"
  | "transcript"
  | "composerText"
  | "prompting"
  | "pendingPermissions"
  | "configOptions"
  | "lastStopReason"
  | "hasRecentDraftWrite"
  | "recentDraftWriteSummary"
  | "lastLocalMcpSkipReason"
  | "activeAssistantId"
  | "mcpProfile"
  | "localMcpProfile"
  | "parentCodeRepoWarning"
> {
  const active = slots[activeSlot]
  let nextStatus = status
  if (syncStatusMirrors && status) {
    nextStatus = {
      ...status,
      activeSlot,
      activeSessionId: active.sessionId,
      cwd: active.cwd ?? status.cwd,
      pendingPermissions: active.pendingPermissions,
      attachedLocalMcp: active.attachedLocalMcp,
      localMcpScope: active.localMcpScope,
      localMcpProfile: active.localMcpProfile,
      inFlightPrompt: active.prompting,
      localMcpStale: active.localMcpStale,
      localMcpStaleReason: active.localMcpStaleReason,
      parentCodeRepoWarning: active.parentCodeRepoWarning,
    }
  }
  return {
    activeSlot,
    slots,
    status: nextStatus,
    activeSessionId: active.sessionId,
    transcript: active.transcript,
    composerText: active.composerText,
    prompting: active.prompting,
    pendingPermissions: active.pendingPermissions,
    configOptions: active.configOptions,
    lastStopReason: active.lastStopReason,
    hasRecentDraftWrite: active.hasRecentDraftWrite,
    recentDraftWriteSummary: active.recentDraftWriteSummary,
    lastLocalMcpSkipReason: active.lastLocalMcpSkipReason,
    activeAssistantId: active.activeAssistantId,
    mcpProfile: active.mcpProfile,
    localMcpProfile: active.localMcpProfile,
    parentCodeRepoWarning: active.parentCodeRepoWarning,
  }
}

function createInitialDataState(): AntigravityAcpDataState {
  const slots = createInitialSlots()
  const projected = projectActiveSlot(slots, "writer", null, false)
  return {
    ...projected,
    stderrLogs: [],
    authRequired: false,
    error: null,
    tosCompliance: checkTosTriggers(),
    tosReassessmentIssues: [],
  }
}

function hasAnyLiveSlotSession(slots: Record<AcpRoleSlotId, AcpRoleSlotState>): boolean {
  return ACP_ROLE_SLOTS.some((slot) => slots[slot].sessionId !== null)
}

function isStoreDisconnected(state: AntigravityAcpDataState): boolean {
  if (state.status !== null) return !state.status.connected
  return !hasAnyLiveSlotSession(state.slots)
}

/**
 * Strictly resolve the owning role slot for an incoming ACP event.
 *
 * When a non-empty `sessionId` is present, ONLY the slot whose `sessionId`
 * matches verbatim receives the event; if unmatched while any slot has a live
 * session, return `null` to drop the event and prevent cross-slot leakage.
 */
function resolveEventTargetSlot(
  state: AntigravityAcpDataState,
  evtSlot: AcpRoleSlotId | null | undefined,
  evtSessionId: string | null,
): AcpRoleSlotId | null {
  const trimmedSid = evtSessionId?.trim() || null
  if (trimmedSid) {
    for (const slot of ACP_ROLE_SLOTS) {
      if (state.slots[slot].sessionId === trimmedSid) {
        return slot
      }
    }
    if (hasAnyLiveSlotSession(state.slots)) {
      return null
    }
    return isAcpRoleSlotId(evtSlot) ? evtSlot : state.activeSlot
  }
  if (isAcpRoleSlotId(evtSlot)) {
    return evtSlot
  }
  return state.activeSlot
}

function clearSlotConnectionState(
  prev: AcpRoleSlotState,
  resetProfileToDefault: boolean,
): AcpRoleSlotState {
  return {
    ...prev,
    sessionId: null,
    cwd: null,
    pendingPermissions: [],
    configOptions: [],
    prompting: false,
    activeAssistantId: null,
    lastLocalMcpSkipReason: null,
    mcpProfile: resetProfileToDefault
      ? defaultSlotProfile(prev.slot)
      : prev.slot === "reviewer"
        ? "reviewer"
        : prev.mcpProfile,
    localMcpProfile: null,
    attachedLocalMcp: false,
    localMcpScope: null,
    effectiveMcpScope: null,
    readOnly: prev.slot === "reviewer",
    localMcpStale: false,
    localMcpStaleReason: null,
    parentCodeRepoWarning: null,
  }
}

function mergeServerSlotSnapshot(
  prev: AcpRoleSlotState,
  srv: AcpSlotStatusSnapshot,
): AcpRoleSlotState {
  const nextLocalProfile = srv.localMcpProfile ?? null
  const nextMcpProfile: McpToolProfile =
    prev.slot === "reviewer"
      ? "reviewer"
      : nextLocalProfile && srv.sessionId !== prev.sessionId
        ? nextLocalProfile
        : prev.mcpProfile
  const nextParentWarning =
    "parentCodeRepoWarning" in srv
      ? (srv.parentCodeRepoWarning ?? null)
      : prev.parentCodeRepoWarning

  return {
    ...prev,
    sessionId: srv.sessionId,
    cwd: srv.cwd,
    configOptions: parseAcpConfigOptions(srv.configOptions ?? []),
    pendingPermissions: srv.pendingPermissions ?? [],
    attachedLocalMcp: srv.attachedLocalMcp,
    localMcpScope: srv.localMcpScope ?? null,
    effectiveMcpScope: srv.effectiveMcpScope ?? null,
    localMcpProfile: nextLocalProfile,
    mcpProfile: nextMcpProfile,
    readOnly: prev.slot === "reviewer" ? true : Boolean(srv.readOnly),
    prompting: typeof srv.inFlightPrompt === "boolean" ? srv.inFlightPrompt : prev.prompting,
    localMcpStale: Boolean(srv.localMcpStale),
    localMcpStaleReason: srv.localMcpStaleReason ?? null,
    parentCodeRepoWarning: nextParentWarning,
  }
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
      set((state) => {
        const nextSlots: Record<AcpRoleSlotId, AcpRoleSlotState> = {
          writer: clearSlotConnectionState(state.slots.writer, true),
          reviewer: clearSlotConnectionState(state.slots.reviewer, true),
          architect: clearSlotConnectionState(state.slots.architect, true),
        }
        const nextStatus: AcpStatusSnapshot | null = state.status
          ? {
              ...state.status,
              connected: false,
              activeSlot: "writer",
              slots: {},
              activeSessionId: null,
              configOptions: [],
              pendingPermissions: [],
              inFlightPrompt: false,
              attachedLocalMcp: false,
              localMcpScope: null,
              localMcpProfile: null,
              localMcpStale: false,
              localMcpStaleReason: null,
              supportsHttpMcp: undefined,
              supportsLoadSession: undefined,
              parentCodeRepoWarning: null,
            }
          : state.status

        return {
          ...projectActiveSlot(nextSlots, "writer", nextStatus, false),
          authRequired: false,
        }
      })
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
        const hintSlot = isAcpRoleSlotId(evt.slot)
          ? evt.slot
          : isAcpRoleSlotId(evt.permission.slot)
            ? evt.permission.slot
            : null
        const targetSlot = resolveEventTargetSlot(state, hintSlot, permSid)
        if (!targetSlot) return state

        const prevSlot = state.slots[targetSlot]
        const nextSlot: AcpRoleSlotState = {
          ...prevSlot,
          pendingPermissions: [
            ...prevSlot.pendingPermissions.filter((p) => p.requestId !== evt.permission.requestId),
            evt.permission,
          ],
        }
        const nextSlots = { ...state.slots, [targetSlot]: nextSlot }
        return projectActiveSlot(nextSlots, state.activeSlot, state.status, true)
      })
      return
    }

    if (evt.kind === "permission_resolved") {
      set((state) => {
        if (isStoreDisconnected(state)) return state
        let changed = false
        const nextSlots: Record<AcpRoleSlotId, AcpRoleSlotState> = { ...state.slots }
        for (const slot of ACP_ROLE_SLOTS) {
          const prevSlot = state.slots[slot]
          if (prevSlot.pendingPermissions.some((p) => p.requestId === evt.requestId)) {
            nextSlots[slot] = {
              ...prevSlot,
              pendingPermissions: prevSlot.pendingPermissions.filter(
                (p) => p.requestId !== evt.requestId,
              ),
            }
            changed = true
          }
        }
        if (!changed) return state
        return projectActiveSlot(nextSlots, state.activeSlot, state.status, true)
      })
      return
    }

    if (evt.kind === "session_update") {
      set((state) => {
        if (isStoreDisconnected(state)) return state
        const rawSid = evt.params.sessionId
        const evtSid = typeof rawSid === "string" && rawSid.trim() ? rawSid.trim() : null
        const hintSlot = isAcpRoleSlotId(evt.slot) ? evt.slot : null
        const targetSlot = resolveEventTargetSlot(state, hintSlot, evtSid)
        if (!targetSlot) return state

        const parsed = parseAcpSessionUpdate(evt.params)
        if (!parsed) return state
        const prevSlot = state.slots[targetSlot]

        if (parsed.type === "config_option_update") {
          const nextSlots = {
            ...state.slots,
            [targetSlot]: {
              ...prevSlot,
              configOptions: parsed.configOptions,
            },
          }
          return projectActiveSlot(nextSlots, state.activeSlot, state.status, false)
        }
        if (parsed.type === "other") return state

        const targetId = prevSlot.activeAssistantId ?? makeItemId("asst")
        const idx = prevSlot.transcript.findIndex((item) => item.id === targetId)
        const base: AcpTranscriptItem =
          idx >= 0 ? prevSlot.transcript[idx]! : { id: targetId, role: "assistant", text: "" }
        let nextItem: AcpTranscriptItem = base
        let nextHasRecentDraftWrite = prevSlot.hasRecentDraftWrite
        let nextRecentDraftWriteSummary = prevSlot.recentDraftWriteSummary

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
            ? prevSlot.transcript.map((item, i) => (i === idx ? nextItem : item))
            : [...prevSlot.transcript, nextItem]

        const nextSlots = {
          ...state.slots,
          [targetSlot]: {
            ...prevSlot,
            activeAssistantId: targetId,
            transcript: nextTranscript,
            hasRecentDraftWrite: nextHasRecentDraftWrite,
            recentDraftWriteSummary: nextRecentDraftWriteSummary,
          },
        }
        return projectActiveSlot(nextSlots, state.activeSlot, state.status, false)
      })
    }
  },

  applyStatusSnapshot: (st) => {
    set((state) => {
      const nextActiveSlot: AcpRoleSlotId = isAcpRoleSlotId(st.activeSlot)
        ? st.activeSlot
        : state.activeSlot

      if (!st.connected) {
        const nextSlots: Record<AcpRoleSlotId, AcpRoleSlotState> = {
          writer: clearSlotConnectionState(state.slots.writer, false),
          reviewer: clearSlotConnectionState(state.slots.reviewer, false),
          architect: clearSlotConnectionState(state.slots.architect, false),
        }
        return projectActiveSlot(nextSlots, nextActiveSlot, st, false)
      }

      if (st.slots !== undefined) {
        const nextSlots: Record<AcpRoleSlotId, AcpRoleSlotState> = { ...state.slots }
        for (const slot of ACP_ROLE_SLOTS) {
          const srv = st.slots[slot]
          const prev = state.slots[slot]
          if (srv) {
            nextSlots[slot] = mergeServerSlotSnapshot(prev, srv)
          } else {
            const cleared = clearSlotConnectionState(prev, false)
            nextSlots[slot] = {
              ...cleared,
              cwd: slot === nextActiveSlot ? (st.cwd ?? null) : null,
              parentCodeRepoWarning:
                slot === nextActiveSlot && "parentCodeRepoWarning" in st
                  ? (st.parentCodeRepoWarning ?? null)
                  : null,
            }
          }
        }
        return projectActiveSlot(nextSlots, nextActiveSlot, st, false)
      }

      // Legacy single-slot snapshot mode (when `st.slots` is omitted)
      const prev = state.slots[nextActiveSlot]
      const nextLocalMcpProfile = st.localMcpProfile ?? null
      const nextParentWarning =
        "parentCodeRepoWarning" in st
          ? (st.parentCodeRepoWarning ?? null)
          : prev.parentCodeRepoWarning
      // Never overwrite user's chosen mcpProfile while disconnected (or when
      // refreshing an already-known active session mid-flight). Only adopt the
      // server's active profile when attaching to a newly discovered session.
      const nextMcpProfile: McpToolProfile =
        nextActiveSlot === "reviewer"
          ? "reviewer"
          : nextLocalMcpProfile &&
              st.activeSessionId &&
              st.activeSessionId !== prev.sessionId
            ? nextLocalMcpProfile
            : prev.mcpProfile

      const nextSlots: Record<AcpRoleSlotId, AcpRoleSlotState> = {
        ...state.slots,
        [nextActiveSlot]: {
          ...prev,
          sessionId: st.activeSessionId ?? null,
          cwd: st.cwd ?? prev.cwd,
          activeAssistantId: prev.activeAssistantId,
          pendingPermissions: st.pendingPermissions ?? [],
          configOptions: parseAcpConfigOptions(st.configOptions ?? []),
          prompting:
            typeof st.inFlightPrompt === "boolean" ? st.inFlightPrompt : prev.prompting,
          mcpProfile: nextMcpProfile,
          localMcpProfile: nextLocalMcpProfile,
          attachedLocalMcp: Boolean(st.attachedLocalMcp),
          localMcpScope: st.localMcpScope ?? null,
          readOnly: nextActiveSlot === "reviewer",
          localMcpStale: Boolean(st.localMcpStale),
          localMcpStaleReason: st.localMcpStaleReason ?? null,
          parentCodeRepoWarning: nextParentWarning,
        },
      }
      return projectActiveSlot(nextSlots, nextActiveSlot, st, false)
    })
  },

  applySessionCreated: (res, systemMessage, slotOverride) => {
    set((state) => {
      const targetSlot: AcpRoleSlotId =
        slotOverride ?? (isAcpRoleSlotId(res.slot) ? res.slot : state.activeSlot)
      const prev = state.slots[targetSlot]
      const nextLocalMcpProfile = res.localMcpProfile ?? null
      const nextParentWarning =
        "parentCodeRepoWarning" in res
          ? (res.parentCodeRepoWarning ?? null)
          : prev.parentCodeRepoWarning
      const nextReadOnly = targetSlot === "reviewer" ? true : Boolean(res.readOnly)
      const nextEffectiveScope =
        res.effectiveMcpScope ?? (nextReadOnly ? "read" : (res.localMcpScope ?? null))
      const nextPendingPermissions = prev.pendingPermissions.filter(
        (p) => p.sessionId === res.sessionId,
      )

      const nextSlotState: AcpRoleSlotState = {
        ...prev,
        sessionId: res.sessionId,
        cwd: res.cwd,
        activeAssistantId: null,
        prompting: false,
        lastStopReason: null,
        hasRecentDraftWrite: false,
        recentDraftWriteSummary: null,
        lastLocalMcpSkipReason: res.localMcpSkipReason ?? null,
        mcpProfile:
          targetSlot === "reviewer" ? "reviewer" : (nextLocalMcpProfile ?? prev.mcpProfile),
        localMcpProfile: nextLocalMcpProfile,
        attachedLocalMcp: res.attachedLocalMcp,
        localMcpScope: res.localMcpScope ?? null,
        effectiveMcpScope: nextEffectiveScope,
        readOnly: nextReadOnly,
        localMcpStale: false,
        localMcpStaleReason: null,
        parentCodeRepoWarning: nextParentWarning,
        pendingPermissions: nextPendingPermissions,
        configOptions: parseAcpConfigOptions(res.configOptions ?? []),
        transcript: systemMessage
          ? [{ id: makeItemId("sys"), role: "system", text: systemMessage }]
          : [],
      }

      const nextSlots: Record<AcpRoleSlotId, AcpRoleSlotState> = {
        ...state.slots,
        [targetSlot]: nextSlotState,
      }

      const nextStatus: AcpStatusSnapshot | null = state.status
        ? {
            ...state.status,
            activeSlot: targetSlot,
            activeSessionId: res.sessionId,
            cwd: res.cwd,
            configOptions: res.configOptions,
            pendingPermissions: nextPendingPermissions,
            attachedLocalMcp: res.attachedLocalMcp,
            localMcpScope: res.localMcpScope ?? null,
            localMcpProfile: nextLocalMcpProfile,
            inFlightPrompt: false,
            localMcpStale: false,
            localMcpStaleReason: null,
            parentCodeRepoWarning: nextParentWarning,
            ...(state.status.slots
              ? {
                  slots: {
                    ...state.status.slots,
                    [targetSlot]: {
                      slot: targetSlot,
                      sessionId: res.sessionId,
                      cwd: res.cwd,
                      configOptions: res.configOptions,
                      pendingPermissions: nextPendingPermissions,
                      attachedLocalMcp: res.attachedLocalMcp,
                      localMcpScope: res.localMcpScope ?? null,
                      effectiveMcpScope: nextEffectiveScope,
                      localMcpProfile: nextLocalMcpProfile,
                      readOnly: nextReadOnly,
                      inFlightPrompt: false,
                      localMcpStale: false,
                      localMcpStaleReason: null,
                      parentCodeRepoWarning: nextParentWarning,
                    },
                  },
                }
              : {}),
          }
        : state.status

      return {
        ...projectActiveSlot(nextSlots, targetSlot, nextStatus, false),
        authRequired: false,
      }
    })
  },

  beginPromptTurn: (userText, slotOverride) => {
    set((state) => {
      const targetSlot = slotOverride ?? state.activeSlot
      const prev = state.slots[targetSlot]
      const nextSlots: Record<AcpRoleSlotId, AcpRoleSlotState> = {
        ...state.slots,
        [targetSlot]: {
          ...prev,
          prompting: true,
          activeAssistantId: null,
          lastStopReason: null,
          transcript: [
            ...prev.transcript,
            { id: makeItemId("usr"), role: "user", text: userText },
          ],
        },
      }
      return {
        ...projectActiveSlot(nextSlots, state.activeSlot, state.status, true),
        error: null,
      }
    })
  },

  finishPromptTurn: (stopReason, slotOverride) => {
    set((state) => {
      const targetSlot = slotOverride ?? state.activeSlot
      const prev = state.slots[targetSlot]
      const nextSlots: Record<AcpRoleSlotId, AcpRoleSlotState> = {
        ...state.slots,
        [targetSlot]: {
          ...prev,
          prompting: false,
          activeAssistantId: null,
          lastStopReason: stopReason !== undefined ? stopReason : prev.lastStopReason,
        },
      }
      return projectActiveSlot(nextSlots, state.activeSlot, state.status, true)
    })
  },

  setActiveSlot: (slot) => {
    set((state) => projectActiveSlot(state.slots, slot, state.status, true))
  },

  setSlotComposerText: (slot, text) => {
    set((state) => {
      const prev = state.slots[slot]
      if (prev.composerText === text) return state
      const nextSlots: Record<AcpRoleSlotId, AcpRoleSlotState> = {
        ...state.slots,
        [slot]: { ...prev, composerText: text },
      }
      return projectActiveSlot(nextSlots, state.activeSlot, state.status, false)
    })
  },

  setComposerText: (text) => {
    set((state) => {
      const prev = state.slots[state.activeSlot]
      if (prev.composerText === text) return state
      const nextSlots: Record<AcpRoleSlotId, AcpRoleSlotState> = {
        ...state.slots,
        [state.activeSlot]: { ...prev, composerText: text },
      }
      return projectActiveSlot(nextSlots, state.activeSlot, state.status, false)
    })
  },

  setConfigOptions: (options, slotOverride) => {
    set((state) => {
      const targetSlot = slotOverride ?? state.activeSlot
      const prev = state.slots[targetSlot]
      const nextOptions = typeof options === "function" ? options(prev.configOptions) : options
      const nextSlots: Record<AcpRoleSlotId, AcpRoleSlotState> = {
        ...state.slots,
        [targetSlot]: { ...prev, configOptions: nextOptions },
      }
      return projectActiveSlot(nextSlots, state.activeSlot, state.status, false)
    })
  },

  setMcpProfile: (profile, slotOverride) => {
    set((state) => {
      const targetSlot = slotOverride ?? state.activeSlot
      const enforcedProfile: McpToolProfile = targetSlot === "reviewer" ? "reviewer" : profile
      const prev = state.slots[targetSlot]
      const nextSlots: Record<AcpRoleSlotId, AcpRoleSlotState> = {
        ...state.slots,
        [targetSlot]: { ...prev, mcpProfile: enforcedProfile },
      }
      return projectActiveSlot(nextSlots, state.activeSlot, state.status, false)
    })
  },

  setAuthRequired: (required) => {
    set({ authRequired: required })
  },

  setError: (error) => {
    set({ error })
  },

  setPrompting: (prompting, slotOverride) => {
    set((state) => {
      const targetSlot = slotOverride ?? state.activeSlot
      const prev = state.slots[targetSlot]
      const nextSlots: Record<AcpRoleSlotId, AcpRoleSlotState> = {
        ...state.slots,
        [targetSlot]: { ...prev, prompting },
      }
      return projectActiveSlot(nextSlots, state.activeSlot, state.status, true)
    })
  },

  clearTranscript: (slotOverride) => {
    set((state) => {
      const targetSlot = slotOverride ?? state.activeSlot
      const prev = state.slots[targetSlot]
      const nextSlots: Record<AcpRoleSlotId, AcpRoleSlotState> = {
        ...state.slots,
        [targetSlot]: {
          ...prev,
          transcript: [],
          activeAssistantId: null,
          lastStopReason: null,
          hasRecentDraftWrite: false,
          recentDraftWriteSummary: null,
        },
      }
      return projectActiveSlot(nextSlots, state.activeSlot, state.status, false)
    })
  },

  clearStderr: () => {
    set({ stderrLogs: [] })
  },

  dismissDraftWriteBanner: (slotOverride) => {
    set((state) => {
      const targetSlot = slotOverride ?? state.activeSlot
      const prev = state.slots[targetSlot]
      const nextSlots: Record<AcpRoleSlotId, AcpRoleSlotState> = {
        ...state.slots,
        [targetSlot]: {
          ...prev,
          hasRecentDraftWrite: false,
          recentDraftWriteSummary: null,
        },
      }
      return projectActiveSlot(nextSlots, state.activeSlot, state.status, false)
    })
  },

  markRecentDraftWrite: (summary, slotOverride) => {
    set((state) => {
      const targetSlot = slotOverride ?? state.activeSlot
      const prev = state.slots[targetSlot]
      const nextSlots: Record<AcpRoleSlotId, AcpRoleSlotState> = {
        ...state.slots,
        [targetSlot]: {
          ...prev,
          hasRecentDraftWrite: true,
          recentDraftWriteSummary: summary?.trim() ? summary.trim() : null,
        },
      }
      return projectActiveSlot(nextSlots, state.activeSlot, state.status, false)
    })
  },

  appendSystemMessage: (text, slotOverride) => {
    set((state) => {
      const targetSlot = slotOverride ?? state.activeSlot
      const prev = state.slots[targetSlot]
      const nextSlots: Record<AcpRoleSlotId, AcpRoleSlotState> = {
        ...state.slots,
        [targetSlot]: {
          ...prev,
          transcript: [...prev.transcript, { id: makeItemId("sys"), role: "system", text }],
        },
      }
      return projectActiveSlot(nextSlots, state.activeSlot, state.status, false)
    })
  },

  evaluateTosTriggers: (conditions) => {
    const result = checkTosTriggers(conditions)
    const issues = result.hasTrigger
      ? result.triggers.map((trigger) => buildReassessmentIssue(trigger))
      : []
    set({
      tosCompliance: result,
      tosReassessmentIssues: issues,
    })
    return issues
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
