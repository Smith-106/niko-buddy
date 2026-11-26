// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

/**
 * Interactive Google Antigravity ACP Panel (`agy acp`, protocol v1).
 *
 * Strictly complies with Google Antigravity Terms of Service and ACP docs:
 * - Connects directly to the user's unmodified local `agy acp` binary.
 * - Antigravity manages its own sign-in, session, model/thinking options, and tools.
 * - Every `session/request_permission` prompt requires explicit manual user action.
 * - Quick actions only pre-fill the composer textarea for user review and manual send.
 * - Never invokes `mcp_server_token` or requests `full`/`auto` MCP scopes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useTranslation } from "react-i18next"
import {
  AlertTriangle,
  ArrowDown,
  Bot,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  FilePlus2,
  FileText,
  FolderOpen,
  Loader2,
  Plug,
  PlugZap,
  RefreshCw,
  Send,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import {
  ensureAcpEventListener,
  useAntigravityAcpStore,
} from "@/stores/antigravity-acp-store"
import { isTauri, pickDirectory } from "@/lib/platform"
import { getFileName } from "@/lib/path-utils"
import { toErrorMessage } from "@/lib/utils"
import { listChapterDrafts, parseChapterOrdinal, writeDraft } from "@/lib/novel"
import { usePendingDraftCount } from "@/components/layout/writing-workspace-widgets"
import {
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
  isWriterPluginStatus,
  parseAcpConfigOptions,
  respondAntigravityAcpPermission,
  sendAntigravityAcpPrompt,
  setAntigravityAcpConfigOption,
  syncProjectWriterPlugin,
  type AcpPendingPermission,
  type LocalMcpStaleReason,
  type McpToolProfile,
  type WriterPluginGlobalResult,
  type WriterPluginStatus,
} from "@/lib/antigravity-acp-client"
import { setMainControlTabHandoff } from "./main-control-handoff"
import {
  AntigravityAcpQuickActions,
  inferChapterContext,
} from "./antigravity-acp-quick-actions"
import { SafeMarkdownProse } from "./safe-markdown-prose"

export const ACP_CONTEXT_MAX_CHARS = 16000
const NEAR_BOTTOM_THRESHOLD_PX = 48
const RAW_INPUT_PREVIEW_MAX_CHARS = 1000

interface DetectResult {
  installed: boolean
  version: string | null
  path: string | null
  error: string | null
  acp_supported?: boolean
}

interface LocalMcpStatus {
  running: boolean
  port: number | null
  tool_count: number
  scope: "read" | "settings" | "project"
  endpoint: string
}

/**
 * Truncate text to at most `maxChars` UTF-16 code units without ever splitting
 * a surrogate pair (e.g. emoji or CJK Extension B characters).
 */
export function truncateSurrogateSafe(
  text: string,
  maxChars = ACP_CONTEXT_MAX_CHARS,
): { text: string; truncated: boolean } {
  if (maxChars <= 0) {
    return { text: "", truncated: text.length > 0 }
  }
  if (text.length <= maxChars) {
    return { text, truncated: false }
  }
  let cut = maxChars
  const lastCodeUnit = text.charCodeAt(cut - 1)
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    const nextCodeUnit = text.charCodeAt(cut)
    if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
      cut -= 1
    }
  }
  return { text: text.slice(0, cut), truncated: true }
}

function isValidLocalMcpStatus(raw: unknown): raw is LocalMcpStatus {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false
  const rec = raw as Record<string, unknown>
  return (
    typeof rec.running === "boolean" &&
    typeof rec.tool_count === "number" &&
    (rec.scope === "read" || rec.scope === "settings" || rec.scope === "project")
  )
}

function redactBearerInPreview(text: string): string {
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
}

function extractPermissionRawInput(perm: AcpPendingPermission): string | null {
  if (typeof perm.rawInputSummary === "string" && perm.rawInputSummary.trim()) {
    return redactBearerInPreview(perm.rawInputSummary.trim())
  }
  if (!perm.rawParams || typeof perm.rawParams !== "object" || Array.isArray(perm.rawParams)) {
    return null
  }
  const params = perm.rawParams as Record<string, unknown>
  const toolCall =
    params.toolCall && typeof params.toolCall === "object" && !Array.isArray(params.toolCall)
      ? (params.toolCall as Record<string, unknown>)
      : null
  const candidate =
    toolCall?.rawInput ??
    params.rawInput ??
    params.input ??
    params.arguments ??
    null
  if (candidate === null || candidate === undefined) return null
  try {
    const serialized =
      typeof candidate === "string" ? candidate : JSON.stringify(candidate, null, 2)
    if (!serialized.trim()) return null
    const redacted = redactBearerInPreview(serialized)
    const { text, truncated } = truncateSurrogateSafe(redacted, RAW_INPUT_PREVIEW_MAX_CHARS)
    return truncated ? `${text}…` : text
  } catch {
    return null
  }
}

function inferDraftChapterName(text: string, fallbackNextChapter: number): string {
  const firstLines = text.split(/\r?\n/).slice(0, 8)
  for (const rawLine of firstLines) {
    const line = rawLine.replace(/^#+\s*/, "").trim()
    if (!line) continue
    const zhOrdinal = parseChapterOrdinal(line)
    if (zhOrdinal !== null && zhOrdinal > 0) {
      return `第${zhOrdinal}章`
    }
    const enMatch = line.match(/^chapter\s+0*(\d+)\b/i)
    if (enMatch?.[1]) {
      const enOrdinal = Number.parseInt(enMatch[1], 10)
      if (Number.isSafeInteger(enOrdinal) && enOrdinal > 0) {
        return `第${enOrdinal}章`
      }
    }
  }
  return `第${fallbackNextChapter}章`
}

const CANONICAL_STALE_REASONS: ReadonlySet<LocalMcpStaleReason> = new Set([
  "mcp_server_stopped",
  "token_rotated",
  "port_changed",
  "scope_changed",
  "server_restarted",
])

function resolveStaleReasonI18nKey(reason: LocalMcpStaleReason | null | undefined): string {
  if (reason && CANONICAL_STALE_REASONS.has(reason)) {
    return `antigravityAcp.mcpStrip.staleReasons.${reason}`
  }
  return "antigravityAcp.mcpStrip.staleReasons.unknown"
}

function resolveSessionMcpProfileArg(profile: McpToolProfile): McpToolProfile | undefined {
  return profile === "writer-sub" ? undefined : profile
}

export function AntigravityAcpView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const fileTree = useWikiStore((s) => s.fileTree)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const fileContent = useWikiStore((s) => s.fileContent)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setActiveSettingsCategory = useWikiStore((s) => s.setActiveSettingsCategory)

  const status = useAntigravityAcpStore((s) => s.status)
  const transcript = useAntigravityAcpStore((s) => s.transcript)
  const prompting = useAntigravityAcpStore((s) => s.prompting)
  const stderrLogs = useAntigravityAcpStore((s) => s.stderrLogs)
  const pendingPermissions = useAntigravityAcpStore((s) => s.pendingPermissions)
  const configOptions = useAntigravityAcpStore((s) => s.configOptions)
  const lastStopReason = useAntigravityAcpStore((s) => s.lastStopReason)
  const hasRecentDraftWrite = useAntigravityAcpStore((s) => s.hasRecentDraftWrite)
  const recentDraftWriteSummary = useAntigravityAcpStore((s) => s.recentDraftWriteSummary)
  const lastLocalMcpSkipReason = useAntigravityAcpStore((s) => s.lastLocalMcpSkipReason)
  const activeSessionId = useAntigravityAcpStore((s) => s.activeSessionId)
  const activeAssistantId = useAntigravityAcpStore((s) => s.activeAssistantId)
  const authRequired = useAntigravityAcpStore((s) => s.authRequired)
  const error = useAntigravityAcpStore((s) => s.error)
  const mcpProfile = useAntigravityAcpStore((s) => s.mcpProfile)
  const localMcpProfile = useAntigravityAcpStore((s) => s.localMcpProfile)
  const parentCodeRepoWarning = useAntigravityAcpStore((s) => s.parentCodeRepoWarning)

  const applyStatusSnapshot = useAntigravityAcpStore((s) => s.applyStatusSnapshot)
  const applySessionCreated = useAntigravityAcpStore((s) => s.applySessionCreated)
  const beginPromptTurn = useAntigravityAcpStore((s) => s.beginPromptTurn)
  const finishPromptTurn = useAntigravityAcpStore((s) => s.finishPromptTurn)
  const setConfigOptions = useAntigravityAcpStore((s) => s.setConfigOptions)
  const setMcpProfile = useAntigravityAcpStore((s) => s.setMcpProfile)
  const setAuthRequired = useAntigravityAcpStore((s) => s.setAuthRequired)
  const setError = useAntigravityAcpStore((s) => s.setError)
  const clearTranscript = useAntigravityAcpStore((s) => s.clearTranscript)
  const clearStderr = useAntigravityAcpStore((s) => s.clearStderr)
  const dismissDraftWriteBanner = useAntigravityAcpStore((s) => s.dismissDraftWriteBanner)
  const markRecentDraftWrite = useAntigravityAcpStore((s) => s.markRecentDraftWrite)
  const appendSystemMessage = useAntigravityAcpStore((s) => s.appendSystemMessage)
  const handleAcpEvent = useAntigravityAcpStore((s) => s.handleAcpEvent)

  const pendingDraftCount = usePendingDraftCount(project?.path ?? "", dataVersion)

  const [detect, setDetect] = useState<DetectResult | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [mcpStatus, setMcpStatus] = useState<LocalMcpStatus | null>(null)
  const [mcpBusy, setMcpBusy] = useState(false)
  const [writerPluginStatus, setWriterPluginStatus] = useState<WriterPluginStatus | null>(null)
  const [includeClaudeMd, setIncludeClaudeMd] = useState(false)
  const [pluginSyncBusy, setPluginSyncBusy] = useState(false)
  const [pluginGlobalBusy, setPluginGlobalBusy] = useState(false)
  const [pluginFeedback, setPluginFeedback] = useState<string | null>(null)
  const [pluginError, setPluginError] = useState<string | null>(null)
  const [globalInstallResult, setGlobalInstallResult] =
    useState<WriterPluginGlobalResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [enableHttpMcp, setEnableHttpMcp] = useState(status?.httpMcpEnabled ?? false)
  const [attachContext, setAttachContext] = useState(false)
  const [workspacePath, setWorkspacePath] = useState(status?.cwd ?? project?.path ?? "")
  const [input, setInput] = useState("")
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null)
  const [savingDraftMsgId, setSavingDraftMsgId] = useState<string | null>(null)
  const [savedDraftMsgMap, setSavedDraftMsgMap] = useState<Record<string, string>>({})
  const [submittingPermIds, setSubmittingPermIds] = useState<Record<string, string>>({})
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)

  const mountedRef = useRef(true)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const isNearBottomRef = useRef(true)
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (project?.path) {
      setWorkspacePath(project.path)
    }
  }, [project?.path])

  const fetchMcpStatus = useCallback(async (): Promise<LocalMcpStatus | null> => {
    if (!isTauri()) return null
    try {
      const raw = await invoke<unknown>("mcp_server_status")
      return isValidLocalMcpStatus(raw) ? raw : null
    } catch {
      return null
    }
  }, [])

  const fetchWriterPluginStatus = useCallback(
    async (syncClaudeMdDefault = false) => {
      if (!isTauri()) return
      try {
        const raw = await getWriterPluginStatus(project?.path ?? null)
        if (!mountedRef.current) return
        if (isWriterPluginStatus(raw)) {
          setWriterPluginStatus(raw)
          if (syncClaudeMdDefault) {
            setIncludeClaudeMd(raw.projectHasClaudeMd)
          }
        } else {
          setWriterPluginStatus(null)
        }
      } catch {
        if (mountedRef.current) {
          setWriterPluginStatus(null)
        }
      }
    },
    [project?.path],
  )

  useEffect(() => {
    setPluginFeedback(null)
    setPluginError(null)
    void fetchWriterPluginStatus(true)
  }, [fetchWriterPluginStatus])

  const refreshState = useCallback(async () => {
    if (!isTauri()) return
    setDetecting(true)
    try {
      const [det, st, mcp] = await Promise.all([
        invoke<DetectResult>("antigravity_cli_detect"),
        getAntigravityAcpStatus(),
        fetchMcpStatus(),
      ])
      if (!mountedRef.current) return
      setDetect(det)
      if (st) {
        applyStatusSnapshot(st)
        setEnableHttpMcp(st.httpMcpEnabled)
        if (st.cwd) setWorkspacePath(st.cwd)
      }
      if (mcp) {
        setMcpStatus(mcp)
      }
    } catch (e) {
      if (mountedRef.current) setError(toErrorMessage(e))
    } finally {
      if (mountedRef.current) setDetecting(false)
    }
  }, [applyStatusSnapshot, fetchMcpStatus, setError])

  useEffect(() => {
    mountedRef.current = true
    void refreshState()

    if (isTauri()) {
      void ensureAcpEventListener().catch((e) => {
        if (mountedRef.current) setError(toErrorMessage(e))
      })
    }

    const handleWindowFocus = () => {
      if (!isTauri()) return
      void Promise.all([
        fetchMcpStatus(),
        getAntigravityAcpStatus().catch(() => null),
      ]).then(([nextMcp, nextStatus]) => {
        if (!mountedRef.current) return
        if (nextMcp) setMcpStatus(nextMcp)
        if (nextStatus) {
          applyStatusSnapshot(nextStatus)
          if (nextStatus.connected) {
            setEnableHttpMcp(nextStatus.httpMcpEnabled)
          }
        }
      })
    }
    window.addEventListener("focus", handleWindowFocus)

    return () => {
      mountedRef.current = false
      window.removeEventListener("focus", handleWindowFocus)
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = null
      }
    }
  }, [applyStatusSnapshot, fetchMcpStatus, refreshState, setError])

  // Smart auto-scroll: follow new streaming chunks only when user is near the bottom.
  useEffect(() => {
    const el = transcriptRef.current
    if (!el) return
    if (isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [transcript])

  const connected = status?.connected === true
  const inFlight = prompting || status?.inFlightPrompt === true
  const authMethods = useMemo(() => status?.authMethods ?? [], [status?.authMethods])
  const acpUnsupported = detect?.installed === true && detect?.acp_supported === false
  const canConnect =
    !busy && isTauri() && detect?.installed !== false && !acpUnsupported

  const chapterContext = useMemo(
    () => inferChapterContext(fileTree ?? [], selectedFile),
    [fileTree, selectedFile],
  )

  const selectedFileDisplayName = useMemo(
    () => (selectedFile ? getFileName(selectedFile) : ""),
    [selectedFile],
  )

  const attachedSnippet = useMemo(() => {
    if (!attachContext || !selectedFile || !fileContent) return null
    return truncateSurrogateSafe(fileContent, ACP_CONTEXT_MAX_CHARS)
  }, [attachContext, fileContent, selectedFile])

  const handleStartLocalMcp = useCallback(
    async (scope: "project" | "read") => {
      if (!isTauri() || mcpBusy) return
      setMcpBusy(true)
      setError(null)
      try {
        await invoke<number>("mcp_server_start", { scope })
        const [nextMcp, nextStatus] = await Promise.all([
          fetchMcpStatus(),
          getAntigravityAcpStatus().catch(() => null),
        ])
        if (!mountedRef.current) return
        if (nextMcp) {
          setMcpStatus(nextMcp)
        }
        if (nextStatus) {
          applyStatusSnapshot(nextStatus)
        }
        if (!connected) {
          setEnableHttpMcp(true)
        }
      } catch (e) {
        if (mountedRef.current) setError(toErrorMessage(e))
      } finally {
        if (mountedRef.current) setMcpBusy(false)
      }
    },
    [applyStatusSnapshot, connected, fetchMcpStatus, mcpBusy, setError],
  )

  const handleRebuildSessionWithMcp = useCallback(async () => {
    if (prompting || busy) return
    const cwd = workspacePath.trim()
    if (!cwd) {
      setError(t("antigravityAcp.workspaceRequired"))
      return
    }
    setBusy(true)
    setError(null)
    setEnableHttpMcp(true)
    try {
      if (!connected || !status?.httpMcpEnabled) {
        if (connected) {
          await disconnectAntigravityAcp()
        }
        const nextStatus = await connectAntigravityAcp({
          cwd,
          enableHttpMcp: true,
        })
        if (!mountedRef.current) return
        applyStatusSnapshot(nextStatus)
      }
      const res = await createAntigravityAcpSession(cwd, true, resolveSessionMcpProfileArg(mcpProfile))
      const [latestStatus, latestMcp] = await Promise.all([
        getAntigravityAcpStatus().catch(() => null),
        fetchMcpStatus(),
      ])
      if (!mountedRef.current) return
      if (latestStatus) applyStatusSnapshot(latestStatus)
      if (latestMcp) setMcpStatus(latestMcp)
      setSavedDraftMsgMap({})
      const sysMsg = res.attachedLocalMcp
        ? t("antigravityAcp.sessionStartedWithMcp", { sessionId: res.sessionId.slice(0, 8) })
        : t("antigravityAcp.sessionStarted", { sessionId: res.sessionId.slice(0, 8) })
      applySessionCreated(res, sysMsg)
    } catch (e) {
      const msg = toErrorMessage(e)
      if (isAcpAuthRequiredError(msg)) {
        setAuthRequired(true)
      }
      if (mountedRef.current) setError(msg)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [
    applySessionCreated,
    applyStatusSnapshot,
    busy,
    connected,
    fetchMcpStatus,
    mcpProfile,
    prompting,
    setAuthRequired,
    setError,
    status?.httpMcpEnabled,
    t,
    workspacePath,
  ])

  const handleStartMcpAndRebuildSession = useCallback(async () => {
    if (!isTauri() || mcpBusy || busy || prompting) return
    const cwd = workspacePath.trim()
    if (!cwd) {
      setError(t("antigravityAcp.workspaceRequired"))
      return
    }
    setMcpBusy(true)
    setBusy(true)
    setError(null)
    setEnableHttpMcp(true)
    try {
      await invoke<number>("mcp_server_start", { scope: "project" })
      if (!connected || !status?.httpMcpEnabled) {
        if (connected) {
          await disconnectAntigravityAcp()
        }
        const nextStatus = await connectAntigravityAcp({
          cwd,
          enableHttpMcp: true,
        })
        if (!mountedRef.current) return
        applyStatusSnapshot(nextStatus)
      }
      const res = await createAntigravityAcpSession(cwd, true, resolveSessionMcpProfileArg(mcpProfile))
      const [latestStatus, latestMcp] = await Promise.all([
        getAntigravityAcpStatus().catch(() => null),
        fetchMcpStatus(),
      ])
      if (!mountedRef.current) return
      if (latestStatus) applyStatusSnapshot(latestStatus)
      if (latestMcp) setMcpStatus(latestMcp)
      setSavedDraftMsgMap({})
      const sysMsg = res.attachedLocalMcp
        ? t("antigravityAcp.sessionStartedWithMcp", { sessionId: res.sessionId.slice(0, 8) })
        : t("antigravityAcp.sessionStarted", { sessionId: res.sessionId.slice(0, 8) })
      applySessionCreated(res, sysMsg)
    } catch (e) {
      const msg = toErrorMessage(e)
      if (isAcpAuthRequiredError(msg)) {
        setAuthRequired(true)
      }
      if (mountedRef.current) setError(msg)
    } finally {
      if (mountedRef.current) {
        setMcpBusy(false)
        setBusy(false)
      }
    }
  }, [
    applySessionCreated,
    applyStatusSnapshot,
    busy,
    connected,
    fetchMcpStatus,
    mcpBusy,
    mcpProfile,
    prompting,
    setAuthRequired,
    setError,
    status?.httpMcpEnabled,
    t,
    workspacePath,
  ])

  const handleConnect = useCallback(async () => {
    setBusy(true)
    setError(null)
    setAuthRequired(false)
    try {
      const next = await connectAntigravityAcp({
        cwd: workspacePath.trim() || null,
        enableHttpMcp,
      })
      const latestMcp = await fetchMcpStatus()
      if (!mountedRef.current) return
      if (latestMcp) setMcpStatus(latestMcp)
      applyStatusSnapshot(next)
    } catch (e) {
      if (mountedRef.current) setError(toErrorMessage(e))
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [applyStatusSnapshot, enableHttpMcp, fetchMcpStatus, setAuthRequired, setError, workspacePath])

  const handleDisconnect = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await disconnectAntigravityAcp()
      handleAcpEvent({ kind: "disconnected", reason: "user_disconnect" })
    } catch (e) {
      if (mountedRef.current) setError(toErrorMessage(e))
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [handleAcpEvent, setError])

  const handleAuthenticate = useCallback(
    async (methodId: string) => {
      setBusy(true)
      setError(null)
      try {
        await authenticateAntigravityAcp(methodId)
        setAuthRequired(false)
        appendSystemMessage(t("antigravityAcp.authCompleted", { method: methodId }))
      } catch (e) {
        if (mountedRef.current) setError(toErrorMessage(e))
      } finally {
        if (mountedRef.current) setBusy(false)
      }
    },
    [appendSystemMessage, setAuthRequired, setError, t],
  )

  const handleNewSession = useCallback(async () => {
    if (prompting) return
    const cwd = workspacePath.trim()
    if (!cwd) {
      setError(t("antigravityAcp.workspaceRequired"))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await createAntigravityAcpSession(
        cwd,
        enableHttpMcp,
        resolveSessionMcpProfileArg(mcpProfile),
      )
      const latestMcp = await fetchMcpStatus()
      if (mountedRef.current) {
        if (latestMcp) {
          setMcpStatus(latestMcp)
        }
        setSavedDraftMsgMap({})
      }
      const sysMsg = res.attachedLocalMcp
        ? t("antigravityAcp.sessionStartedWithMcp", { sessionId: res.sessionId.slice(0, 8) })
        : t("antigravityAcp.sessionStarted", { sessionId: res.sessionId.slice(0, 8) })
      applySessionCreated(res, sysMsg)
    } catch (e) {
      const msg = toErrorMessage(e)
      if (isAcpAuthRequiredError(msg)) {
        setAuthRequired(true)
      }
      setError(msg)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [
    applySessionCreated,
    enableHttpMcp,
    fetchMcpStatus,
    mcpProfile,
    prompting,
    setAuthRequired,
    setError,
    t,
    workspacePath,
  ])

  const handleStartIsolatedReviewerSession = useCallback(async () => {
    if (!connected || prompting || busy) return
    const cwd = workspacePath.trim()
    if (!cwd) {
      setError(t("antigravityAcp.workspaceRequired"))
      return
    }
    const attachLocalMcp = status?.httpMcpEnabled ?? enableHttpMcp
    setBusy(true)
    setError(null)
    try {
      const res = await createAntigravityAcpSession(cwd, attachLocalMcp, "reviewer")
      const latestMcp = await fetchMcpStatus()
      if (mountedRef.current) {
        if (latestMcp) {
          setMcpStatus(latestMcp)
        }
        setInput("")
        setSavedDraftMsgMap({})
      }
      setMcpProfile("reviewer")
      const sysMsg = res.attachedLocalMcp
        ? t("antigravityAcp.isolatedReviewerStarted", {
            sessionId: res.sessionId.slice(0, 8),
          })
        : t("antigravityAcp.isolatedReviewerStartedNoMcp", {
            sessionId: res.sessionId.slice(0, 8),
          })
      applySessionCreated(res, sysMsg)
    } catch (e) {
      const msg = toErrorMessage(e)
      if (isAcpAuthRequiredError(msg)) {
        setAuthRequired(true)
      }
      if (mountedRef.current) setError(msg)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [
    applySessionCreated,
    busy,
    connected,
    enableHttpMcp,
    fetchMcpStatus,
    prompting,
    setAuthRequired,
    setError,
    setMcpProfile,
    status?.httpMcpEnabled,
    t,
    workspacePath,
  ])

  const handleSyncProjectWriterPlugin = useCallback(async () => {
    const projectPath = project?.path?.trim()
    if (!isTauri() || !projectPath || pluginSyncBusy) return
    setPluginSyncBusy(true)
    setPluginError(null)
    setPluginFeedback(null)
    try {
      const res = await syncProjectWriterPlugin(projectPath, includeClaudeMd)
      if (!mountedRef.current) return
      if (isWriterPluginStatus(res?.status)) {
        setWriterPluginStatus(res.status)
      } else {
        await fetchWriterPluginStatus(false)
      }
      setPluginFeedback(
        t("antigravityAcp.writerPlugin.syncSuccess", {
          written: res?.writtenFiles?.length ?? 0,
          unchanged: res?.unchangedFiles?.length ?? 0,
        }),
      )
    } catch (e) {
      if (mountedRef.current) {
        setPluginError(toErrorMessage(e))
      }
    } finally {
      if (mountedRef.current) setPluginSyncBusy(false)
    }
  }, [fetchWriterPluginStatus, includeClaudeMd, pluginSyncBusy, project?.path, t])

  const handleInstallGlobalWriterPlugin = useCallback(async () => {
    if (!isTauri() || pluginGlobalBusy) return
    setPluginGlobalBusy(true)
    setPluginError(null)
    setPluginFeedback(null)
    try {
      const res = await installGlobalWriterPlugin(false)
      if (!mountedRef.current) return
      setGlobalInstallResult(res)
      await fetchWriterPluginStatus(false)
      if (!mountedRef.current) return
      setPluginFeedback(
        t("antigravityAcp.writerPlugin.globalInstallSuccess", {
          path: res.installPath,
        }),
      )
    } catch (e) {
      if (mountedRef.current) {
        setPluginError(toErrorMessage(e))
      }
    } finally {
      if (mountedRef.current) setPluginGlobalBusy(false)
    }
  }, [fetchWriterPluginStatus, pluginGlobalBusy, t])

  const handleConnectAndStart = useCallback(async () => {
    if (!canConnect || prompting) return
    const cwd = workspacePath.trim()
    if (!cwd) {
      setError(t("antigravityAcp.workspaceRequired"))
      return
    }
    setBusy(true)
    setError(null)
    setAuthRequired(false)
    try {
      const next = await connectAntigravityAcp({
        cwd,
        enableHttpMcp,
      })
      applyStatusSnapshot(next)

      const res = await createAntigravityAcpSession(
        cwd,
        enableHttpMcp,
        resolveSessionMcpProfileArg(mcpProfile),
      )
      const latestMcp = await fetchMcpStatus()
      if (mountedRef.current) {
        if (latestMcp) {
          setMcpStatus(latestMcp)
        }
        setSavedDraftMsgMap({})
      }
      const sysMsg = res.attachedLocalMcp
        ? t("antigravityAcp.sessionStartedWithMcp", { sessionId: res.sessionId.slice(0, 8) })
        : t("antigravityAcp.sessionStarted", { sessionId: res.sessionId.slice(0, 8) })
      applySessionCreated(res, sysMsg)
    } catch (e) {
      const msg = toErrorMessage(e)
      if (isAcpAuthRequiredError(msg)) {
        setAuthRequired(true)
      }
      setError(msg)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [
    applySessionCreated,
    applyStatusSnapshot,
    canConnect,
    enableHttpMcp,
    fetchMcpStatus,
    mcpProfile,
    prompting,
    setAuthRequired,
    setError,
    t,
    workspacePath,
  ])

  const handlePickWorkspace = useCallback(async () => {
    try {
      const picked = await pickDirectory()
      if (mountedRef.current && picked && picked.trim()) {
        setWorkspacePath(picked.trim())
      }
    } catch (e) {
      if (mountedRef.current) setError(toErrorMessage(e))
    }
  }, [setError])

  const handleConfigChange = useCallback(
    async (configId: string, value: string) => {
      if (!activeSessionId) return
      setError(null)
      try {
        const res = await setAntigravityAcpConfigOption(activeSessionId, configId, value)
        const maybeUpdated =
          res &&
          typeof res === "object" &&
          Array.isArray((res as { configOptions?: unknown[] }).configOptions)
            ? parseAcpConfigOptions((res as { configOptions: unknown[] }).configOptions)
            : null
        if (maybeUpdated && maybeUpdated.length > 0) {
          setConfigOptions(maybeUpdated)
        } else {
          setConfigOptions((prev) =>
            prev.map((opt) => (opt.id === configId ? { ...opt, currentValue: value } : opt)),
          )
        }
      } catch (e) {
        setError(toErrorMessage(e))
      }
    },
    [activeSessionId, setConfigOptions, setError],
  )

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || !activeSessionId || prompting) return
    setInput("")
    beginPromptTurn(text)

    let stopReason: string | null = null
    try {
      const snippet =
        attachContext && selectedFile && fileContent
          ? truncateSurrogateSafe(fileContent, ACP_CONTEXT_MAX_CHARS).text
          : null
      const result = await sendAntigravityAcpPrompt({
        sessionId: activeSessionId,
        text,
        contextTitle: snippet ? selectedFile : null,
        contextText: snippet,
      })
      stopReason = result?.stopReason ?? null
    } catch (e) {
      const msg = toErrorMessage(e)
      if (isAcpAuthRequiredError(msg)) {
        setAuthRequired(true)
      }
      setError(msg)
    } finally {
      finishPromptTurn(stopReason)
    }
  }, [
    activeSessionId,
    attachContext,
    beginPromptTurn,
    fileContent,
    finishPromptTurn,
    input,
    prompting,
    selectedFile,
    setAuthRequired,
    setError,
  ])

  const handleCancel = useCallback(async () => {
    if (!activeSessionId) return
    try {
      await cancelAntigravityAcpTurn(activeSessionId)
    } catch (e) {
      if (mountedRef.current) setError(toErrorMessage(e))
    }
  }, [activeSessionId, setError])

  const handlePermissionDecision = useCallback(
    async (requestId: string, optionId: string | null) => {
      setError(null)
      const choiceKey = optionId ?? "__cancel__"
      setSubmittingPermIds((prev) => ({ ...prev, [requestId]: choiceKey }))
      try {
        await respondAntigravityAcpPermission(requestId, optionId)
      } catch (e) {
        if (mountedRef.current) setError(toErrorMessage(e))
      } finally {
        if (mountedRef.current) {
          setSubmittingPermIds((prev) => {
            const copy = { ...prev }
            delete copy[requestId]
            return copy
          })
        }
      }
    },
    [setError],
  )

  const handleSelectQuickActionPrompt = useCallback((prompt: string) => {
    setInput(prompt)
    promptInputRef.current?.focus()
  }, [])

  const handleSaveMessageAsDraft = useCallback(
    async (msgId: string, text: string) => {
      const projectPath = project?.path?.trim()
      if (!projectPath) {
        setError(t("antigravityAcp.saveAsDraftNoProject"))
        return
      }
      const body = text.trim()
      if (!body || savingDraftMsgId === msgId) return
      setSavingDraftMsgId(msgId)
      setError(null)
      try {
        let fallbackChapter = chapterContext.nextChapter
        try {
          const existingDrafts = await listChapterDrafts(projectPath)
          const maxDraftOrdinal = existingDrafts.reduce((max, draft) => {
            if (draft.status === "saved" || draft.status === "failed") return max
            const ord = parseChapterOrdinal(draft.chapterName)
            return ord !== null && ord > max ? ord : max
          }, 0)
          if (maxDraftOrdinal >= fallbackChapter) {
            fallbackChapter = maxDraftOrdinal + 1
          }
        } catch {
          // Fall back cleanly to inferred nextChapter when listing fails.
        }
        const chapterName = inferDraftChapterName(body, fallbackChapter)
        await writeDraft(projectPath, chapterName, body, {
          sourceConversationId: activeSessionId ? `acp:${activeSessionId}` : "acp:panel",
          sourceMessageId: msgId,
        })
        if (!mountedRef.current) return
        bumpDataVersion()
        markRecentDraftWrite(t("antigravityAcp.savedAsDraft", { chapter: chapterName }))
        setSavedDraftMsgMap((prev) => ({ ...prev, [msgId]: chapterName }))
      } catch (e) {
        if (mountedRef.current) {
          setError(t("antigravityAcp.saveAsDraftFailed", { error: toErrorMessage(e) }))
        }
      } finally {
        if (mountedRef.current) {
          setSavingDraftMsgId((prev) => (prev === msgId ? null : prev))
        }
      }
    },
    [
      activeSessionId,
      bumpDataVersion,
      chapterContext.nextChapter,
      markRecentDraftWrite,
      project?.path,
      savingDraftMsgId,
      setError,
      t,
    ],
  )

  const handleCopyMessage = useCallback(
    async (msgId: string, text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        if (!mountedRef.current) return
        setCopiedMsgId(msgId)
        if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = setTimeout(() => {
          copiedTimerRef.current = null
          if (mountedRef.current) setCopiedMsgId(null)
        }, 1500)
      } catch (e) {
        if (mountedRef.current) setError(toErrorMessage(e))
      }
    },
    [setError],
  )

  const handleTranscriptScroll = useCallback(() => {
    const el = transcriptRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const nearBottom = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX
    isNearBottomRef.current = nearBottom
    setShowJumpToLatest(!nearBottom && transcript.length > 0)
  }, [transcript.length])

  const jumpToLatest = useCallback(() => {
    const el = transcriptRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
    isNearBottomRef.current = true
    setShowJumpToLatest(false)
  }, [])

  const openExternalControlSettings = useCallback(() => {
    setActiveSettingsCategory("external-control")
    setActiveView("settings")
  }, [setActiveSettingsCategory, setActiveView])

  const openMainControlDrafts = useCallback(() => {
    setMainControlTabHandoff("drafts")
    setActiveView("mainControl")
  }, [setActiveView])

  const openReviewCenter = useCallback(() => {
    setActiveView("reviewCenter")
  }, [setActiveView])

  const stopReasonIsHighlighted =
    lastStopReason === "max_tokens" ||
    lastStopReason === "refusal" ||
    lastStopReason === "cancelled"

  const stopReasonLabel = useMemo(() => {
    if (!lastStopReason) return null
    if (
      lastStopReason === "end_turn" ||
      lastStopReason === "max_tokens" ||
      lastStopReason === "refusal" ||
      lastStopReason === "cancelled"
    ) {
      return t(`antigravityAcp.stopReason.${lastStopReason}`)
    }
    return t("antigravityAcp.stopReason.label", { reason: lastStopReason })
  }, [lastStopReason, t])

  const effectiveParentRepoWarning = activeSessionId
    ? parentCodeRepoWarning?.trim() || null
    : parentCodeRepoWarning?.trim() || writerPluginStatus?.parentCodeRepoWarning?.trim() || null

  const profileChangePending =
    connected && Boolean(activeSessionId) && Boolean(localMcpProfile) && mcpProfile !== localMcpProfile

  const globalEnableCommand =
    globalInstallResult?.enableCommand || "agy plugin enable niko-buddy-writer"
  const globalDisableCommand =
    globalInstallResult?.disableCommand || "agy plugin disable niko-buddy-writer"

  return (
    <div
      className="flex h-full flex-col gap-3 overflow-hidden p-4"
      data-testid="antigravity-acp-view"
    >
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 pb-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Bot className="h-5 w-5 text-primary" aria-hidden="true" />
            <h1 className="text-lg font-semibold">{t("antigravityAcp.title")}</h1>
            {connected && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs text-success-foreground"
                data-testid="acp-connected-badge"
              >
                <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                {status?.agentName ?? "Antigravity ACP"}
                {status?.agentVersion ? ` v${status.agentVersion}` : ""}
              </span>
            )}
            {stopReasonLabel && (
              <span
                data-testid="acp-stop-reason-badge"
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  stopReasonIsHighlighted
                    ? "border border-warning/50 bg-warning/15 text-warning-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {stopReasonLabel}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("antigravityAcp.subtitle")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {pendingDraftCount !== null && pendingDraftCount > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openMainControlDrafts}
              data-testid="acp-pending-drafts-badge"
              className="border-warning/50 bg-warning/10 text-warning-foreground hover:bg-warning/20"
            >
              <FileText className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {t("antigravityAcp.pendingDraftsBadge", { count: pendingDraftCount })}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openExternalControlSettings}
            data-testid="acp-open-mcp-settings"
          >
            {t("antigravityAcp.openMcpSettings")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              clearTranscript()
              setSavedDraftMsgMap({})
            }}
            disabled={transcript.length === 0 || prompting}
            data-testid="acp-clear-transcript-btn"
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {t("antigravityAcp.clearTranscript")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void refreshState()
              void fetchWriterPluginStatus(false)
            }}
            disabled={detecting || busy}
            data-testid="acp-refresh-btn"
          >
            <RefreshCw
              className={`mr-1 h-3.5 w-3.5 ${detecting ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {t("antigravityAcp.recheck")}
          </Button>
          {connected ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => void handleDisconnect()}
              disabled={busy}
              data-testid="acp-disconnect-btn"
            >
              <Plug className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {t("antigravityAcp.disconnect")}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleConnect()}
                disabled={!canConnect}
                data-testid="acp-connect-btn"
              >
                {busy ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <PlugZap className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                )}
                {t("antigravityAcp.connect")}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleConnectAndStart()}
                disabled={!canConnect || prompting || !workspacePath.trim()}
                data-testid="acp-connect-and-start-btn"
              >
                {busy ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <PlugZap className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                )}
                {t("antigravityAcp.connectAndStart")}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* CLI detection & connection controls */}
      <div className="grid gap-3 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs md:grid-cols-2">
        <div className="space-y-1">
          <div className="font-medium">{t("antigravityAcp.cliStatusLabel")}</div>
          {!isTauri() ? (
            <div className="text-muted-foreground">
              {t("settings.sections.llm.cliStatus.desktopOnly")}
            </div>
          ) : acpUnsupported ? (
            <div className="space-y-0.5">
              <div className="text-warning-foreground" data-testid="acp-cli-unsupported">
                {t("antigravityAcp.cliUnsupported", { version: detect?.version ?? "agy" })}
              </div>
              {detect?.path && (
                <div className="truncate font-mono text-muted-foreground">{detect.path}</div>
              )}
            </div>
          ) : detect?.installed ? (
            <div className="space-y-0.5">
              <div className="text-success-foreground" data-testid="acp-cli-ready">
                {t("antigravityAcp.cliInstalled", { version: detect.version ?? "agy" })}
              </div>
              {detect.path && (
                <div className="truncate font-mono text-muted-foreground">{detect.path}</div>
              )}
            </div>
          ) : (
            <div className="text-destructive" data-testid="acp-cli-missing">
              {detect?.error ?? t("antigravityAcp.cliMissing")}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="acp-workspace-input" className="font-medium">
              {t("antigravityAcp.workspaceLabel")}
            </label>
            <input
              id="acp-workspace-input"
              type="text"
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
              placeholder={t("antigravityAcp.workspacePlaceholder")}
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-xs"
              data-testid="acp-workspace-input"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || prompting}
              onClick={() => void handlePickWorkspace()}
              data-testid="acp-workspace-pick-btn"
              title={t("antigravityAcp.browseWorkspace")}
            >
              <FolderOpen className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {t("antigravityAcp.browseWorkspace")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!connected || busy || prompting || !workspacePath.trim()}
              onClick={() => void handleNewSession()}
              data-testid="acp-new-session-btn"
            >
              {t("antigravityAcp.newSession")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!connected || busy || prompting || !workspacePath.trim()}
              onClick={() => void handleStartIsolatedReviewerSession()}
              data-testid="acp-isolated-reviewer-btn"
            >
              <Eye className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {t("antigravityAcp.isolatedReviewerBtn")}
            </Button>
          </div>
          <label className="flex items-center gap-2 text-muted-foreground">
            <input
              type="checkbox"
              checked={enableHttpMcp}
              disabled={connected}
              onChange={(e) => setEnableHttpMcp(e.target.checked)}
              data-testid="acp-enable-http-mcp"
            />
            <span>{t("antigravityAcp.attachMcpOption")}</span>
          </label>
        </div>
      </div>

      {/* Inline Local MCP Readiness Strip (never calls mcp_server_token, never requests full/auto) */}
      <div
        data-testid="acp-mcp-readiness-strip"
        className="space-y-2 rounded-lg border border-border/60 bg-muted/15 px-3 py-2 text-xs"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{t("antigravityAcp.mcpStrip.title")}</span>
            <span role="status" aria-live="polite">
              {mcpStatus ? (
                mcpStatus.running ? (
                  <span
                    data-testid="acp-mcp-status-badge"
                    className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] text-success-foreground"
                  >
                    {t("antigravityAcp.mcpStrip.running", {
                      scope: mcpStatus.scope,
                      count: mcpStatus.tool_count,
                    })}
                  </span>
                ) : (
                  <span
                    data-testid="acp-mcp-status-badge"
                    className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {t("antigravityAcp.mcpStrip.stopped")}
                  </span>
                )
              ) : (
                <span
                  data-testid="acp-mcp-status-badge"
                  className="text-[11px] text-muted-foreground"
                >
                  {t("antigravityAcp.mcpStrip.unknown")}
                </span>
              )}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {(!mcpStatus || !mcpStatus.running || mcpStatus.scope !== "project") && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={!isTauri() || mcpBusy}
                onClick={() => void handleStartLocalMcp("project")}
                data-testid="acp-mcp-start-project-btn"
              >
                {mcpBusy ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                ) : null}
                {mcpStatus?.running
                  ? t("antigravityAcp.mcpStrip.switchProject")
                  : t("antigravityAcp.mcpStrip.startProject")}
              </Button>
            )}
            {(!mcpStatus || !mcpStatus.running) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={!isTauri() || mcpBusy}
                onClick={() => void handleStartLocalMcp("read")}
                data-testid="acp-mcp-start-read-btn"
              >
                {t("antigravityAcp.mcpStrip.startRead")}
              </Button>
            )}
          </div>
        </div>

        {/* Role / MCP tool profile selector */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-1.5">
          <label htmlFor="acp-mcp-profile-select" className="font-medium text-muted-foreground">
            {t("antigravityAcp.profiles.label")}
          </label>
          <select
            id="acp-mcp-profile-select"
            value={mcpProfile}
            disabled={busy || prompting}
            onChange={(e) => setMcpProfile(e.target.value as McpToolProfile)}
            data-testid="acp-mcp-profile-select"
            className="rounded border border-border bg-background px-2 py-0.5 text-xs"
          >
            {MCP_TOOL_PROFILES.map((profile) => (
              <option key={profile} value={profile}>
                {t(`antigravityAcp.profiles.${profile}`)}
              </option>
            ))}
          </select>
          {connected && activeSessionId && localMcpProfile && (
            <span
              data-testid="acp-active-profile-badge"
              className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
            >
              {t("antigravityAcp.profiles.activeBadge", { profile: localMcpProfile })}
            </span>
          )}
          {profileChangePending && localMcpProfile && (
            <span
              role="status"
              aria-live="polite"
              data-testid="acp-profile-pending-hint"
              className="text-[11px] text-warning-foreground"
            >
              {t("antigravityAcp.profiles.pendingHint", {
                selected: mcpProfile,
                active: localMcpProfile,
              })}
            </span>
          )}
        </div>

        {mcpStatus?.running && mcpStatus.scope !== "project" && (
          <p className="text-[11px] text-muted-foreground">
            {t("antigravityAcp.mcpStrip.scopeRestartNote")}
          </p>
        )}

        {connected && status?.localMcpStale && (
          <div
            role="status"
            aria-live="polite"
            data-testid="acp-mcp-stale-banner"
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-warning/50 bg-warning/15 px-2.5 py-1.5 text-[11px] text-warning-foreground"
          >
            <div className="space-y-0.5">
              <div className="font-medium">{t("antigravityAcp.mcpStrip.staleTitle")}</div>
              <div data-testid="acp-mcp-stale-reason">
                {t(resolveStaleReasonI18nKey(status.localMcpStaleReason))}
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={busy || mcpBusy || prompting || !workspacePath.trim()}
              onClick={() => {
                if (status.localMcpStaleReason === "mcp_server_stopped" || !mcpStatus?.running) {
                  void handleStartMcpAndRebuildSession()
                } else {
                  void handleRebuildSessionWithMcp()
                }
              }}
              data-testid="acp-mcp-stale-rebuild-btn"
            >
              {busy || mcpBusy ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
              ) : null}
              {status.localMcpStaleReason === "mcp_server_stopped" || !mcpStatus?.running
                ? t("antigravityAcp.mcpStrip.restartMcpAndRebuild")
                : t("antigravityAcp.mcpStrip.rebuildSession")}
            </Button>
          </div>
        )}

        {(lastLocalMcpSkipReason === "agent_unsupported" ||
          (connected && status?.supportsHttpMcp === false)) && (
          <div
            role="status"
            aria-live="polite"
            data-testid="acp-mcp-agent-unsupported-banner"
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning-foreground"
          >
            <span>{t("antigravityAcp.mcpStrip.skipAgentUnsupported")}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={openExternalControlSettings}
              data-testid="acp-mcp-unsupported-settings-btn"
            >
              {t("antigravityAcp.openMcpSettings")}
            </Button>
          </div>
        )}

        {connected &&
          activeSessionId &&
          mcpStatus?.running &&
          status?.attachedLocalMcp !== true &&
          !status?.localMcpStale &&
          lastLocalMcpSkipReason !== "agent_unsupported" &&
          status?.supportsHttpMcp !== false && (
            <div
              role="status"
              aria-live="polite"
              data-testid="acp-mcp-unattached-banner"
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning-foreground"
            >
              <span>
                {t("antigravityAcp.mcpStrip.unattachedRunning", { scope: mcpStatus.scope })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                disabled={busy || prompting || !workspacePath.trim()}
                onClick={() => void handleRebuildSessionWithMcp()}
                data-testid="acp-mcp-unattached-rebuild-btn"
              >
                {busy ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                ) : null}
                {status?.httpMcpEnabled
                  ? t("antigravityAcp.mcpStrip.rebuildSession")
                  : t("antigravityAcp.mcpStrip.reconnectWithMcp")}
              </Button>
            </div>
          )}

        {((lastLocalMcpSkipReason === "mcp_server_not_running" && !mcpStatus?.running) ||
          (lastLocalMcpSkipReason === "http_mcp_disabled" && !mcpStatus?.running)) && (
          <div
            role="status"
            aria-live="polite"
            data-testid="acp-mcp-skip-warning"
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning-foreground"
          >
            <span>
              {lastLocalMcpSkipReason === "mcp_server_not_running"
                ? t("antigravityAcp.mcpStrip.skipNotRunning")
                : t("antigravityAcp.mcpStrip.skipHttpDisabled")}
            </span>
            {lastLocalMcpSkipReason === "mcp_server_not_running" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                disabled={!isTauri() || mcpBusy}
                onClick={() => void handleStartLocalMcp("project")}
                data-testid="acp-mcp-skip-start-btn"
              >
                {t("antigravityAcp.mcpStrip.startProject")}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                disabled={busy || prompting || !workspacePath.trim()}
                onClick={() => void handleRebuildSessionWithMcp()}
                data-testid="acp-mcp-skip-reconnect-btn"
              >
                {t("antigravityAcp.mcpStrip.reconnectWithMcp")}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Parent code repository warning banner (strictly role="status") */}
      {effectiveParentRepoWarning && (
        <div
          role="status"
          aria-live="polite"
          data-testid="acp-parent-repo-warning-banner"
          className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/15 px-3 py-2 text-xs text-warning-foreground"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="space-y-0.5">
            <div className="font-medium">{t("antigravityAcp.parentRepoWarning.title")}</div>
            <p className="break-words text-[11px]">{effectiveParentRepoWarning}</p>
          </div>
        </div>
      )}

      {/* Declarative Writer Plugin sync & disabled-by-default global install card */}
      <div
        data-testid="acp-writer-plugin-card"
        className="space-y-2 rounded-lg border border-border/60 bg-muted/15 px-3 py-2 text-xs"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{t("antigravityAcp.writerPlugin.title")}</span>
            <span
              role="status"
              aria-live="polite"
              data-testid="acp-writer-plugin-state-badge"
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] ${
                writerPluginStatus?.projectState === "synced"
                  ? "bg-success/15 text-success-foreground"
                  : writerPluginStatus?.projectState === "needs_update"
                    ? "border border-warning/50 bg-warning/15 text-warning-foreground"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {writerPluginStatus
                ? t(`antigravityAcp.writerPlugin.state.${writerPluginStatus.projectState}`)
                : t("antigravityAcp.writerPlugin.state.unknown")}
            </span>
            {writerPluginStatus && (
              <span className="text-[11px] text-muted-foreground">
                {t("antigravityAcp.writerPlugin.meta", {
                  version: writerPluginStatus.pluginVersion,
                  skills: writerPluginStatus.skillCount,
                  agents: writerPluginStatus.agentCount,
                })}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={!isTauri() || !project?.path?.trim() || pluginSyncBusy}
              title={
                !project?.path?.trim()
                  ? t("antigravityAcp.writerPlugin.noProjectHint")
                  : undefined
              }
              onClick={() => void handleSyncProjectWriterPlugin()}
              data-testid="acp-writer-plugin-sync-btn"
            >
              {pluginSyncBusy ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                  {t("antigravityAcp.writerPlugin.syncing")}
                </>
              ) : (
                <>
                  <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
                  {t("antigravityAcp.writerPlugin.syncBtn")}
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={!isTauri() || pluginGlobalBusy}
              onClick={() => void handleInstallGlobalWriterPlugin()}
              data-testid="acp-writer-plugin-install-global-btn"
            >
              {pluginGlobalBusy ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                  {t("antigravityAcp.writerPlugin.installingGlobal")}
                </>
              ) : (
                <>
                  <Download className="mr-1 h-3 w-3" aria-hidden="true" />
                  {t("antigravityAcp.writerPlugin.installGlobalBtn")}
                </>
              )}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={includeClaudeMd}
              disabled={pluginSyncBusy || !project?.path?.trim()}
              onChange={(e) => setIncludeClaudeMd(e.target.checked)}
              data-testid="acp-writer-plugin-include-claude-md"
            />
            <span>{t("antigravityAcp.writerPlugin.includeClaudeMd")}</span>
          </label>
          {!project?.path?.trim() && (
            <span role="status" data-testid="acp-writer-plugin-no-project-hint">
              {t("antigravityAcp.writerPlugin.noProjectHint")}
            </span>
          )}
        </div>

        {(globalInstallResult || writerPluginStatus?.globalInstalled) && (
          <div
            data-testid="acp-writer-plugin-global-guidance"
            className="flex flex-wrap items-center gap-1.5 rounded border border-border/50 bg-background/60 px-2 py-1 text-[11px] text-muted-foreground"
          >
            <span>{t("antigravityAcp.writerPlugin.globalGuidance")}</span>
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
              {globalEnableCommand}
            </code>
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
              {globalDisableCommand}
            </code>
          </div>
        )}

        {pluginFeedback && (
          <div
            role="status"
            aria-live="polite"
            data-testid="acp-writer-plugin-feedback"
            className="rounded border border-success/40 bg-success/10 px-2 py-1 text-[11px] text-success-foreground"
          >
            {pluginFeedback}
          </div>
        )}

        {pluginError && (
          <div
            role="status"
            aria-live="polite"
            data-testid="acp-writer-plugin-error"
            className="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning-foreground"
          >
            {pluginError}
          </div>
        )}
      </div>

      {/* Authentication panel when required or available before session */}
      {connected && (authRequired || (!activeSessionId && authMethods.length > 0)) && (
        <div
          className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs"
          data-testid="acp-auth-panel"
        >
          <div className="font-medium">
            {authRequired
              ? t("antigravityAcp.authRequiredTitle")
              : t("antigravityAcp.authOptionalTitle")}
          </div>
          <p className="text-muted-foreground">{t("antigravityAcp.authHint")}</p>
          <div className="flex flex-wrap gap-2">
            {authMethods.map((method) => (
              <Button
                key={method.id}
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || prompting}
                onClick={() => void handleAuthenticate(method.id)}
                data-testid={`acp-auth-${method.id}`}
              >
                {method.name}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Official ACP model & thinking-level selectors (only advertised options) */}
      {activeSessionId && configOptions.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-md border border-border/60 px-3 py-2 text-xs"
          data-testid="acp-config-options"
        >
          {configOptions.map((opt) => (
            <label key={opt.id} className="flex items-center gap-2">
              <span className="font-medium text-muted-foreground">{opt.name}</span>
              <select
                value={opt.currentValue}
                onChange={(e) => void handleConfigChange(opt.id, e.target.value)}
                disabled={prompting}
                className="rounded border border-border bg-background px-2 py-1 text-xs"
                data-testid={`acp-config-${opt.id}`}
              >
                {opt.options.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}

      {error && (
        <div
          role="alert"
          data-testid="acp-error-banner"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="break-words">{error}</span>
        </div>
      )}

      {/* Draft-first handoff strip when `chapter.write` completed */}
      {hasRecentDraftWrite && (
        <div
          role="status"
          data-testid="acp-draft-handoff-strip"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-xs"
        >
          <div className="space-y-0.5">
            <div className="font-medium text-success-foreground">
              {t("antigravityAcp.draftHandoff.title")}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {recentDraftWriteSummary
                ? `${recentDraftWriteSummary} — ${t("antigravityAcp.draftHandoff.description")}`
                : t("antigravityAcp.draftHandoff.description")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={openMainControlDrafts}
              data-testid="acp-handoff-main-control-drafts"
            >
              {t("antigravityAcp.draftHandoff.openMainControlDrafts")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={openReviewCenter}
              data-testid="acp-handoff-review-center"
            >
              {t("antigravityAcp.draftHandoff.openReviewCenter")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={dismissDraftWriteBanner}
              data-testid="acp-handoff-dismiss"
              aria-label={t("antigravityAcp.draftHandoff.dismiss")}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}

      {/* Pending informed-consent manual permission approval cards */}
      {pendingPermissions.length > 0 && (
        <div className="space-y-2" data-testid="acp-permission-list">
          {pendingPermissions.map((perm) => {
            const submittingChoice = submittingPermIds[perm.requestId]
            const isSubmitting = submittingChoice !== undefined
            const isCancelSubmitting = submittingChoice === "__cancel__"
            const rawInputPreview = extractPermissionRawInput(perm)
            const hasAllowAlwaysOption = perm.options.some(
              (opt) => opt.kind === "allow_always" || opt.optionId === "allow_always",
            )
            return (
              <div
                key={perm.requestId}
                role="alertdialog"
                aria-label={perm.title}
                data-testid={`acp-permission-${perm.requestId}`}
                className="space-y-2 rounded-lg border border-warning bg-warning/10 p-3 text-xs"
              >
                <div className="flex flex-wrap items-center gap-2 font-semibold">
                  <ShieldCheck className="h-4 w-4 text-warning-foreground" aria-hidden="true" />
                  <span>{t("antigravityAcp.permissionTitle")}</span>
                  {perm.toolKind && (
                    <span
                      data-testid={`acp-perm-kind-${perm.requestId}`}
                      className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-[11px] font-normal text-muted-foreground"
                    >
                      {t("antigravityAcp.permission.toolKind")}: {perm.toolKind}
                    </span>
                  )}
                </div>
                <div className="font-mono">{perm.title}</div>

                {perm.locations && perm.locations.length > 0 && (
                  <div
                    data-testid={`acp-perm-locations-${perm.requestId}`}
                    className="space-y-0.5 rounded border border-border/50 bg-background/60 p-2"
                  >
                    <div className="text-[11px] font-medium text-muted-foreground">
                      {t("antigravityAcp.permission.locations")}
                    </div>
                    <ul className="list-inside list-disc space-y-0.5 font-mono text-[11px]">
                      {perm.locations.map((loc, idx) => (
                        <li key={`${loc}-${idx}`} className="break-all">
                          {loc}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {rawInputPreview && (
                  <details
                    data-testid={`acp-perm-input-${perm.requestId}`}
                    className="rounded border border-border/50 bg-background/60 px-2 py-1"
                  >
                    <summary className="cursor-pointer select-none text-[11px] text-muted-foreground">
                      {t("antigravityAcp.permission.rawInput")}
                    </summary>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
                      {rawInputPreview}
                    </pre>
                  </details>
                )}

                {hasAllowAlwaysOption && (
                  <p
                    data-testid={`acp-perm-always-warning-${perm.requestId}`}
                    className="text-[11px] text-warning-foreground"
                  >
                    {t("antigravityAcp.permission.allowAlwaysWarning")}
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  {perm.options.map((opt) => {
                    const isReject = Boolean(opt.kind?.includes("reject"))
                    const isAllowAlways =
                      opt.kind === "allow_always" || opt.optionId === "allow_always"
                    const isOptionSubmitting = submittingChoice === opt.optionId
                    return (
                      <Button
                        key={opt.optionId}
                        type="button"
                        size="sm"
                        disabled={isSubmitting}
                        aria-busy={isOptionSubmitting}
                        variant={isReject || isAllowAlways ? "outline" : "default"}
                        className={
                          isAllowAlways
                            ? "border-destructive/60 text-destructive hover:bg-destructive/10"
                            : undefined
                        }
                        onClick={() => void handlePermissionDecision(perm.requestId, opt.optionId)}
                        data-testid={`acp-perm-opt-${perm.requestId}-${opt.optionId}`}
                      >
                        {isOptionSubmitting ? (
                          <>
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                            {t("antigravityAcp.permission.submitting")}
                          </>
                        ) : (
                          opt.name
                        )}
                      </Button>
                    )
                  })}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={isSubmitting}
                    aria-busy={isCancelSubmitting}
                    onClick={() => void handlePermissionDecision(perm.requestId, null)}
                    data-testid={`acp-perm-cancel-${perm.requestId}`}
                  >
                    {isCancelSubmitting ? (
                      <>
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                        {t("antigravityAcp.permission.submitting")}
                      </>
                    ) : (
                      t("antigravityAcp.permissionCancel")
                    )}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Conversation transcript */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={transcriptRef}
          role="log"
          aria-live="polite"
          aria-busy={inFlight}
          onScroll={handleTranscriptScroll}
          className="flex-1 space-y-3 overflow-y-auto rounded-lg border border-border/60 bg-background/60 p-3"
          data-testid="acp-transcript"
        >
          {transcript.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center text-xs text-muted-foreground">
              {connected
                ? activeSessionId
                  ? t("antigravityAcp.emptyReady")
                  : t("antigravityAcp.emptyCreateSession")
                : t("antigravityAcp.emptyDisconnected")}
            </div>
          ) : (
            transcript.map((item) => {
              const isStreamingMessage = prompting && activeAssistantId === item.id
              const canSaveAsDraft =
                Boolean(project?.path) &&
                item.role === "assistant" &&
                item.text.trim().length > 0 &&
                !isStreamingMessage
              const isSavingThisDraft = savingDraftMsgId === item.id
              const savedDraftChapter = savedDraftMsgMap[item.id]

              return (
                <div
                  key={item.id}
                  className={`rounded-md px-3 py-2 text-sm ${
                    item.role === "user"
                      ? "ml-8 bg-primary/10"
                      : item.role === "system"
                        ? "bg-muted/40 text-xs text-muted-foreground"
                        : "mr-8 border border-border/60 bg-card"
                  }`}
                >
                  {item.role === "assistant" && item.text && (
                    <div className="mb-1 flex flex-wrap justify-end gap-1">
                      {canSaveAsDraft && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={isSavingThisDraft}
                          aria-busy={isSavingThisDraft}
                          className="h-6 px-2 text-[11px] text-muted-foreground"
                          onClick={() => void handleSaveMessageAsDraft(item.id, item.text)}
                          data-testid={`acp-save-draft-msg-${item.id}`}
                        >
                          {isSavingThisDraft ? (
                            <>
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                              {t("antigravityAcp.savingAsDraft")}
                            </>
                          ) : savedDraftChapter ? (
                            <>
                              <Check className="mr-1 h-3 w-3 text-success-foreground" aria-hidden="true" />
                              {t("antigravityAcp.savedAsDraft", { chapter: savedDraftChapter })}
                            </>
                          ) : (
                            <>
                              <FilePlus2 className="mr-1 h-3 w-3" aria-hidden="true" />
                              {t("antigravityAcp.saveAsDraft")}
                            </>
                          )}
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px] text-muted-foreground"
                        onClick={() => void handleCopyMessage(item.id, item.text)}
                        data-testid={`acp-copy-msg-${item.id}`}
                      >
                        {copiedMsgId === item.id ? (
                          <>
                            <Check className="mr-1 h-3 w-3" aria-hidden="true" />
                            {t("antigravityAcp.copiedMessage")}
                          </>
                        ) : (
                          <>
                            <Copy className="mr-1 h-3 w-3" aria-hidden="true" />
                            {t("antigravityAcp.copyMessage")}
                          </>
                        )}
                      </Button>
                    </div>
                  )}
                  {item.thought && (
                    <details className="mb-2 text-xs text-muted-foreground">
                      <summary className="cursor-pointer select-none">
                        {t("antigravityAcp.thoughtLabel")}
                      </summary>
                      <pre className="mt-1 whitespace-pre-wrap font-sans">{item.thought}</pre>
                    </details>
                  )}
                  {item.tools && item.tools.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {item.tools.map((tool) => (
                        <span
                          key={tool.id}
                          className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                        >
                          <Wrench className="h-3 w-3" aria-hidden="true" />
                          {tool.title} · {tool.status}
                        </span>
                      ))}
                    </div>
                  )}
                  {item.role === "assistant" ? (
                    <SafeMarkdownProse content={item.text} />
                  ) : (
                    <div className="whitespace-pre-wrap break-words">{item.text}</div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {showJumpToLatest && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={jumpToLatest}
            data-testid="acp-jump-latest-btn"
            className="absolute right-4 bottom-3 h-7 rounded-full px-2.5 text-xs shadow-sm"
          >
            <ArrowDown className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {t("antigravityAcp.jumpToLatest")}
          </Button>
        )}
      </div>

      {/* Collapsible stderr diagnostics drawer */}
      <details
        data-testid="acp-stderr-drawer"
        className="rounded-md border border-border/60 bg-muted/15 px-3 py-1.5 text-xs"
      >
        <summary className="flex cursor-pointer select-none items-center justify-between gap-2 text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
            {t("antigravityAcp.stderr.drawerTitle", { count: stderrLogs.length })}
          </span>
        </summary>
        <div className="mt-2 space-y-1.5">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={stderrLogs.length === 0}
              onClick={() => clearStderr()}
              data-testid="acp-stderr-clear-btn"
            >
              {t("antigravityAcp.stderr.clear")}
            </Button>
          </div>
          {stderrLogs.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t("antigravityAcp.stderr.empty")}</p>
          ) : (
            <pre
              data-testid="acp-stderr-content"
              className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/60 p-2 font-mono text-[11px] text-muted-foreground"
            >
              {stderrLogs.join("\n")}
            </pre>
          )}
        </div>
      </details>

      {/* Writer quick actions & prompt composer */}
      <div className="space-y-2 border-t border-border/60 pt-2">
        <AntigravityAcpQuickActions
          chapterContext={chapterContext}
          disabled={!activeSessionId || prompting}
          onSelectPrompt={handleSelectQuickActionPrompt}
        />

        {selectedFile && fileContent && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={attachContext}
                onChange={(e) => setAttachContext(e.target.checked)}
                data-testid="acp-attach-context"
              />
              <span title={selectedFile}>
                {t("antigravityAcp.attachCurrentDoc", { file: selectedFileDisplayName })}
              </span>
            </label>
            {attachedSnippet?.truncated && (
              <span
                data-testid="acp-context-truncated-badge"
                className="rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning-foreground"
              >
                {t("antigravityAcp.contextTruncated", { limit: ACP_CONTEXT_MAX_CHARS })}
              </span>
            )}
          </div>
        )}

        <div className="flex items-end gap-2">
          <textarea
            ref={promptInputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault()
                void handleSend()
              }
            }}
            disabled={!activeSessionId || prompting}
            rows={2}
            placeholder={
              activeSessionId
                ? t("antigravityAcp.inputPlaceholder")
                : t("antigravityAcp.inputDisabledPlaceholder")
            }
            aria-label={t("antigravityAcp.inputLabel")}
            className="min-w-0 flex-1 resize-y rounded-md border border-border bg-background px-3 py-2 text-sm"
            data-testid="acp-prompt-input"
          />
          {prompting ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleCancel()}
              data-testid="acp-cancel-btn"
            >
              <Square className="mr-1 h-4 w-4" aria-hidden="true" />
              {t("antigravityAcp.cancel")}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => void handleSend()}
              disabled={!activeSessionId || !input.trim()}
              data-testid="acp-send-btn"
            >
              <Send className="mr-1 h-4 w-4" aria-hidden="true" />
              {t("antigravityAcp.send")}
            </Button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground" data-testid="acp-compliance-notice">
          {t("antigravityAcp.complianceNotice")}
        </p>
      </div>
    </div>
  )
}
