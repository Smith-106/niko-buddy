// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useTranslation } from "react-i18next"
import { AlertTriangle, Copy, Download, Eye, EyeOff, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SettingsSwitch } from "../settings-widgets"
import { toErrorMessage } from "@/lib/utils"
import { useWikiStore } from "@/stores/wiki-store"
import {
  getWriterPluginStatus,
  installGlobalWriterPlugin,
  isWriterPluginStatus,
  syncProjectWriterPlugin,
  type McpToolProfile,
  type WriterPluginStatus,
} from "@/lib/antigravity-acp-client"

/** 与 `src-tauri/src/mcp_server/mod.rs::McpServerStatus` 一一对应。 */
interface McpSession {
  id: string
  scope: string
  connected_at: number
  last_call_at: number
  calls: number
  /** 是否被用户逐会话授予了完整写入（full）。 */
  full_granted: boolean
  /** 是否被用户逐会话授予了自动编排（auto = settings + project，不含直写正文）。 */
  auto_granted: boolean
  /** 客户端在 MCP `initialize` 握手中上报的 `clientInfo.name`（可选）。 */
  client_name?: string | null
  /** 客户端在 MCP `initialize` 握手中上报的 `clientInfo.version`（可选）。 */
  client_version?: string | null
}

/**
 * 服务端授予外部 Agent 的权限域（启动时可选的部分）。
 *
 * 三项**互斥**，不是累加：`project` 不蕴含 `settings`（见后端 `SessionScope::satisfies`）。
 * 同时要两类写权限的 `auto` 档与直写正文的 `full` 档都不能在启动时授予，只能对
 * 具体会话逐次授权（下方会话列表里的两个按钮）。
 */
type McpScope = "read" | "settings" | "project"

const SCOPES: { value: McpScope; labelKey: string; fallback: string; hintKey: string; hintFallback: string }[] = [
  {
    value: "read",
    labelKey: "settings.sections.externalControl.scopeRead",
    fallback: "Read only",
    hintKey: "settings.sections.externalControl.scopeReadHint",
    hintFallback: "Query tools only. Nothing in the project or the settings can be changed.",
  },
  {
    value: "settings",
    labelKey: "settings.sections.externalControl.scopeSettings",
    fallback: "Read + settings",
    hintKey: "settings.sections.externalControl.scopeSettingsHint",
    hintFallback: "Also allows settings.set. Every write is appended to the project audit log.",
  },
  {
    value: "project",
    labelKey: "settings.sections.externalControl.scopeProject",
    fallback: "Read + project actions",
    hintKey: "settings.sections.externalControl.scopeProjectHint",
    hintFallback:
      "Also allows chapter.write, pipeline.run_chapter and gate.run. Output only ever lands in the draft area.",
  },
]

interface McpServerStatus {
  running: boolean
  port: number | null
  tool_count: number
  tools: string[]
  sessions: McpSession[]
  endpoint: string
  scope: McpScope
}

function buildProfiledEndpoint(baseEndpoint: string, profile: McpToolProfile): string {
  if (profile === "full-legacy") return baseEndpoint
  try {
    const url = new URL(baseEndpoint)
    url.searchParams.set("profile", profile)
    return url.toString()
  } catch {
    const separator = baseEndpoint.includes("?") ? "&" : "?"
    return `${baseEndpoint}${separator}profile=${encodeURIComponent(profile)}`
  }
}

/**
 * 「外部控制」——让 Claude Code / PI 等外部 Agent 连进来控制本应用。
 *
 * 与相邻的 MCP 分区方向相反：那个是「本应用连出去」（客户端配置），这个是
 * 「外部连进来」（服务端）。两者不共用端口，也不共用开关。
 *
 * 开关直接反映**服务端真实运行状态**（读 `mcp_server_status`），不是前端本地标记：
 * 关掉就是真的停监听、端口释放、已握手会话清空。
 */
export function ExternalControlSection() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<McpServerStatus | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [tokenVisible, setTokenVisible] = useState(false)
  const [tokenBusy, setTokenBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedAntigravity, setCopiedAntigravity] = useState(false)
  const [antigravityProfile, setAntigravityProfile] = useState<McpToolProfile>("full-legacy")
  const [antigravityCopyWarning, setAntigravityCopyWarning] = useState<
    "stopped_and_masked" | "stopped" | "masked" | null
  >(null)
  const [writerPluginStatus, setWriterPluginStatus] = useState<WriterPluginStatus | null>(null)
  const [pluginSyncBusy, setPluginSyncBusy] = useState(false)
  const [pluginGlobalBusy, setPluginGlobalBusy] = useState(false)
  const [pluginFeedback, setPluginFeedback] = useState<string | null>(null)
  const [pluginError, setPluginError] = useState<string | null>(null)
  // 停止状态下先记住用户想要的权限域，下次启动时带上去。
  const [wantScope, setWantScope] = useState<McpScope>("read")
  const mountedRef = useRef(true)
  const tokenGenRef = useRef(0)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copiedAntigravityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const project = useWikiStore((s) => s.project)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const projectPath = project?.path?.trim() || null

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = null
      }
      if (copiedAntigravityTimerRef.current !== null) {
        clearTimeout(copiedAntigravityTimerRef.current)
        copiedAntigravityTimerRef.current = null
      }
    }
  }, [])

  const running = status?.running ?? false
  /** 界面上应显示的权限域：运行中读真实状态，停止时显示待生效的意图。 */
  const currentScope: McpScope = running ? (status?.scope ?? "read") : wantScope

  const refresh = useCallback(async (options?: { preserveError?: boolean }) => {
    try {
      const next = await invoke<McpServerStatus>("mcp_server_status")
      if (!mountedRef.current) return
      setStatus(next)
      if (next.running) setWantScope(next.scope)
      if (!options?.preserveError) setError(null)
    } catch (e) {
      if (!mountedRef.current) return
      setError(toErrorMessage(e))
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void invoke<McpServerStatus>("mcp_server_status").then(
      (next) => {
        if (cancelled || !mountedRef.current) return
        setStatus(next)
        if (next.running) setWantScope(next.scope)
        setError(null)
      },
      (e: unknown) => {
        if (cancelled || !mountedRef.current) return
        setError(toErrorMessage(e))
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  // 仅当存在已打开小说项目时才查询写作插件状态，避免无项目场景发出额外 invoke。
  useEffect(() => {
    if (!projectPath) {
      setWriterPluginStatus(null)
      setPluginFeedback(null)
      setPluginError(null)
      return
    }
    let cancelled = false
    setPluginFeedback(null)
    setPluginError(null)
    void getWriterPluginStatus(projectPath).then(
      (raw) => {
        if (cancelled || !mountedRef.current) return
        setWriterPluginStatus(isWriterPluginStatus(raw) ? raw : null)
      },
      () => {
        if (cancelled || !mountedRef.current) return
        setWriterPluginStatus(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [projectPath])

  /**
   * 逐会话授予 / 吊销完整写入（`full`）。
   *
   * 授权落在**会话**上而不是服务端：用户点这一下时心里想的是"让屏幕上这个客户端
   * 能写"，不是"给未来所有连上来的客户端开门"。所以界面上每个会话各有一个按钮。
   */
  const toggleFull = useCallback(
    async (sessionId: string, grant: boolean) => {
      setBusy(true)
      setError(null)
      try {
        await invoke(
          grant ? "mcp_session_grant_full" : "mcp_session_revoke_full",
          { sessionId },
        )
        await refresh()
      } catch (e) {
        if (mountedRef.current) setError(toErrorMessage(e))
      } finally {
        if (mountedRef.current) setBusy(false)
      }
    },
    [refresh],
  )

  /**
   * 逐会话授予 / 吊销自动编排（`auto`）。
   *
   * 为什么和 `full` 分开：「一个窗口跑完整流程」需要同时改设置 + 起项目动作，但
   * **不需要**直写正文。少一条护栏的档位单独授权，用户才能看清自己给了什么。
   */
  const toggleAuto = useCallback(
    async (sessionId: string, grant: boolean) => {
      setBusy(true)
      setError(null)
      try {
        await invoke(
          grant ? "mcp_session_grant_auto" : "mcp_session_revoke_auto",
          { sessionId },
        )
        await refresh()
      } catch (e) {
        if (mountedRef.current) setError(toErrorMessage(e))
      } finally {
        if (mountedRef.current) setBusy(false)
      }
    },
    [refresh],
  )

  const toggle = useCallback(
    async (next: boolean) => {
      setBusy(true)
      setError(null)
      if (!next) {
        tokenGenRef.current += 1
      }
      try {
        if (next) {
          await invoke<number>("mcp_server_start", { scope: wantScope })
        } else {
          await invoke("mcp_server_stop")
          // 停服后旧 token 不再展示，避免用户以为它还生效。
          if (mountedRef.current) {
            setToken(null)
            setTokenVisible(false)
          }
        }
        await refresh()
      } catch (e) {
        if (mountedRef.current) setError(toErrorMessage(e))
        // 失败也要重读真实状态：开关必须反映现实，不能停在用户点击的意图上；同时保留本次报错。
        await refresh({ preserveError: true })
      } finally {
        if (mountedRef.current) setBusy(false)
      }
    },
    [refresh, wantScope],
  )

  /**
   * 切换权限域。
   *
   * 服务端在跑时**立即重启**（scope 变了旧会话就不该继续带着旧权限），因此这会
   * 断开已连接的客户端——文案里明说了，不偷偷做。没在跑时只记住意图。
   */
  const changeScope = useCallback(
    async (next: McpScope) => {
      if (next === currentScope) return
      setWantScope(next)
      if (!running) return
      setBusy(true)
      setError(null)
      try {
        await invoke<number>("mcp_server_start", { scope: next })
        await refresh()
      } catch (e) {
        if (mountedRef.current) setError(toErrorMessage(e))
        await refresh({ preserveError: true })
      } finally {
        if (mountedRef.current) setBusy(false)
      }
    },
    [currentScope, refresh, running],
  )

  const revealToken = useCallback(async () => {
    if (busy || tokenBusy) return
    if (token) {
      setTokenVisible((v) => !v)
      return
    }
    const gen = ++tokenGenRef.current
    setTokenBusy(true)
    try {
      const value = await invoke<string>("mcp_server_token")
      if (!mountedRef.current || gen !== tokenGenRef.current) return
      setToken(value)
      setTokenVisible(true)
    } catch (e) {
      if (mountedRef.current && gen === tokenGenRef.current) setError(toErrorMessage(e))
    } finally {
      if (mountedRef.current) setTokenBusy(false)
    }
  }, [busy, token, tokenBusy])

  const rotateToken = useCallback(async () => {
    const gen = ++tokenGenRef.current
    setBusy(true)
    setError(null)
    try {
      const value = await invoke<string>("mcp_server_rotate_token")
      if (!mountedRef.current || gen !== tokenGenRef.current) return
      setToken(value)
      setTokenVisible(true)
      await refresh()
    } catch (e) {
      if (mountedRef.current && gen === tokenGenRef.current) {
        setToken(null)
        setTokenVisible(false)
        setError(toErrorMessage(e))
      }
      await refresh({ preserveError: true })
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [refresh])

  const copyEndpoint = useCallback(async () => {
    /* v8 ignore next -- 台账 external-control-section.tsx L211：复制端点按钮 disabled={!status}（L348），status 为空时不可点 */
    if (!status) return
    try {
      await navigator.clipboard.writeText(status.endpoint)
      if (!mountedRef.current) return
      setCopied(true)
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => {
        copiedTimerRef.current = null
        if (mountedRef.current) setCopied(false)
      }, 1500)
    } catch (e) {
      if (mountedRef.current) setError(toErrorMessage(e))
    }
  }, [status])

  const antigravityMcpSnippet = useMemo(() => {
    const baseEndpoint = status?.endpoint ?? "http://127.0.0.1:45871/mcp"
    const endpoint = buildProfiledEndpoint(baseEndpoint, antigravityProfile)
    const bearer = token && tokenVisible ? token : "<YOUR_BEARER_TOKEN>"
    return JSON.stringify(
      {
        mcpServers: {
          "niko-buddy": {
            serverUrl: endpoint,
            headers: {
              Authorization: `Bearer ${bearer}`,
            },
            timeoutSeconds: 600,
          },
        },
      },
      null,
      2,
    )
  }, [antigravityProfile, status?.endpoint, token, tokenVisible])

  const handleSyncProjectWriterPlugin = useCallback(async () => {
    if (!projectPath || pluginSyncBusy) return
    setPluginSyncBusy(true)
    setPluginFeedback(null)
    setPluginError(null)
    try {
      const res = await syncProjectWriterPlugin(
        projectPath,
        writerPluginStatus?.projectHasClaudeMd ?? false,
      )
      if (!mountedRef.current) return
      if (isWriterPluginStatus(res?.status)) {
        setWriterPluginStatus(res.status)
      } else {
        try {
          const next = await getWriterPluginStatus(projectPath)
          if (mountedRef.current && isWriterPluginStatus(next)) {
            setWriterPluginStatus(next)
          }
        } catch {
          // 忽略状态刷新失败，保留项目同步成功反馈。
        }
      }
      if (!mountedRef.current) return
      setPluginFeedback(
        t("settings.sections.externalControl.writerPluginSyncSuccess", {
          defaultValue:
            "Synced project writer agent config ({{written}} written, {{unchanged}} unchanged).",
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
  }, [pluginSyncBusy, projectPath, t, writerPluginStatus?.projectHasClaudeMd])

  const handleInstallGlobalWriterPlugin = useCallback(async () => {
    if (pluginGlobalBusy) return
    setPluginGlobalBusy(true)
    setPluginFeedback(null)
    setPluginError(null)
    try {
      const res = await installGlobalWriterPlugin(false)
      if (!mountedRef.current) return
      if (projectPath) {
        try {
          const next = await getWriterPluginStatus(projectPath)
          if (mountedRef.current && isWriterPluginStatus(next)) {
            setWriterPluginStatus(next)
          }
        } catch {
          // 忽略状态刷新失败，保留全局安装成功反馈。
        }
      }
      if (!mountedRef.current) return
      setPluginFeedback(
        t("settings.sections.externalControl.writerPluginGlobalSuccess", {
          defaultValue:
            "Installed disabled global plugin at {{path}}. Enable: {{enableCmd}}; disable: {{disableCmd}}.",
          path: res.installPath,
          enableCmd: res.enableCommand || "agy plugin enable niko-buddy-writer",
          disableCmd: res.disableCommand || "agy plugin disable niko-buddy-writer",
        }),
      )
    } catch (e) {
      if (mountedRef.current) {
        setPluginError(toErrorMessage(e))
      }
    } finally {
      if (mountedRef.current) setPluginGlobalBusy(false)
    }
  }, [pluginGlobalBusy, projectPath, t])

  const copyAntigravityConfig = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(antigravityMcpSnippet)
      if (!mountedRef.current) return
      setCopiedAntigravity(true)
      const isMasked = !tokenVisible || !token
      const isStopped = !running
      if (isStopped && isMasked) {
        setAntigravityCopyWarning("stopped_and_masked")
      } else if (isStopped) {
        setAntigravityCopyWarning("stopped")
      } else if (isMasked) {
        setAntigravityCopyWarning("masked")
      } else {
        setAntigravityCopyWarning(null)
      }
      if (copiedAntigravityTimerRef.current !== null) clearTimeout(copiedAntigravityTimerRef.current)
      copiedAntigravityTimerRef.current = setTimeout(() => {
        copiedAntigravityTimerRef.current = null
        if (mountedRef.current) setCopiedAntigravity(false)
      }, 1500)
    } catch (e) {
      if (mountedRef.current) setError(toErrorMessage(e))
    }
  }, [antigravityMcpSnippet, running, token, tokenVisible])

  const sessions = status?.sessions ?? []

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.externalControl.title", {
            defaultValue: "External Control",
          })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.externalControl.description", {
            defaultValue:
              "Let an external agent (Claude Code, PI) connect to this app over a loopback-only MCP endpoint. Read-only by default; write actions follow the scope and per-session grants below. The app must stay running.",
          })}
        </p>
      </div>

      <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 p-4">
        <div>
          <div className="text-sm font-medium">
            {t("settings.sections.externalControl.enable", {
              defaultValue: "Allow external control",
            })}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("settings.sections.externalControl.enableHint", {
              defaultValue:
                "Turning this off stops the listener immediately, releases the port, and drops every connected session.",
            })}
          </p>
        </div>
        <SettingsSwitch
          checked={running}
          onCheckedChange={(next) => void toggle(next)}
          disabled={busy}
          label={t("settings.sections.externalControl.enable", {
            defaultValue: "Allow external control",
          })}
          data-testid="external-control-toggle"
        />
      </div>

      <div className="rounded-lg border border-border/60 p-4">
        <div className="text-sm font-medium">
          {t("settings.sections.externalControl.scope", { defaultValue: "What external agents may do" })}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("settings.sections.externalControl.scopeHint", {
            defaultValue:
              "Changing this while the listener is running restarts it and disconnects current clients. Sessions keep the scope they connected with, so a permission change only takes effect after the client reconnects.",
          })}
        </p>
        <div className="mt-3 space-y-2">
          {SCOPES.map((option) => {
            const selected = currentScope === option.value
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => void changeScope(option.value)}
                disabled={busy}
                aria-pressed={selected}
                data-testid={`external-control-scope-${option.value}`}
                className={
                  "flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors " +
                  (selected
                    ? "border-primary bg-primary/5"
                    : "border-border/60 hover:border-border")
                }
              >
                <span
                  aria-hidden
                  className={
                    "mt-1 h-3 w-3 shrink-0 rounded-full border " +
                    (selected ? "border-primary bg-primary" : "border-muted-foreground/50")
                  }
                />
                <span>
                  <span className="block text-sm">{t(option.labelKey, { defaultValue: option.fallback })}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {t(option.hintKey, { defaultValue: option.hintFallback })}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
        <p
          className="text-xs text-muted-foreground"
          data-testid="external-control-full-note"
        >
          {t("settings.sections.externalControl.fullNote", {
            defaultValue:
              "Full write (direct edits to formal chapters and memory) is never granted at startup. Grant it per session below, and revoke it any time.",
          })}
        </p>
      </div>

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          data-testid="external-control-error"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="text-sm font-medium">
          {t("settings.sections.externalControl.endpoint", {
            defaultValue: "Connection address",
          })}
        </div>
        <div className="flex items-center gap-2">
          <code
            className="flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs"
            data-testid="external-control-endpoint"
          >
            {status?.endpoint ?? "—"}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void copyEndpoint()}
            disabled={!status}
            data-testid="external-control-copy"
          >
            <Copy className="mr-1 h-3.5 w-3.5" />
            {copied
              ? t("settings.sections.externalControl.copied", { defaultValue: "Copied" })
              : t("settings.sections.externalControl.copy", { defaultValue: "Copy" })}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.externalControl.endpointHint", {
            defaultValue:
              "Loopback only (127.0.0.1). The external agent must run on this machine.",
          })}
        </p>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium">
          {t("settings.sections.externalControl.token", { defaultValue: "Bearer token" })}
        </div>
        <div className="flex items-center gap-2">
          <code
            className="flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs"
            data-testid="external-control-token"
          >
            {token && tokenVisible ? token : "••••••••••••••••••••••••••••••••"}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void revealToken()}
            disabled={busy || tokenBusy}
            data-testid="external-control-reveal"
          >
            {tokenVisible ? (
              <EyeOff className="mr-1 h-3.5 w-3.5" />
            ) : (
              <Eye className="mr-1 h-3.5 w-3.5" />
            )}
            {tokenVisible
              ? t("settings.sections.externalControl.hide", { defaultValue: "Hide" })
              : t("settings.sections.externalControl.show", { defaultValue: "Show" })}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void rotateToken()}
            disabled={busy}
            data-testid="external-control-rotate"
          >
            {busy ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
            )}
            {t("settings.sections.externalControl.regenerate", {
              defaultValue: "Regenerate",
            })}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.externalControl.tokenHint", {
            defaultValue:
              "Stored in the OS credential vault, never in plain app state. Regenerating revokes every existing client.",
          })}
        </p>
      </div>

      <div
        className="space-y-3 rounded-lg border border-border/60 bg-muted/15 p-4"
        data-testid="external-control-antigravity-card"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium">
              {t("settings.sections.externalControl.antigravityMcpTitle", {
                defaultValue: "Google Antigravity (Official MCP Integration)",
              })}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("settings.sections.externalControl.antigravityMcpHint", {
                defaultValue:
                  "Connect Antigravity App, CLI (agy), or IDE directly to Niko Buddy using your official Antigravity subscription and all available models — zero reverse proxy, fully compliant with Google Terms of Service.",
              })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void copyAntigravityConfig()}
              data-testid="external-control-copy-antigravity-mcp"
            >
              <Copy className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {copiedAntigravity
                ? t("settings.sections.externalControl.copied", { defaultValue: "Copied" })
                : t("settings.sections.externalControl.antigravityMcpCopy", {
                    defaultValue: "Copy mcp_config.json",
                  })}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!project}
              title={
                !project
                  ? t("settings.sections.externalControl.openAntigravityAcpRequiresProject", {
                      defaultValue:
                        "Create or open a novel project first before opening the Antigravity ACP Panel.",
                    })
                  : undefined
              }
              onClick={() => {
                /* v8 ignore next -- 按钮在 !project 时 disabled，此处为双重守卫 */
                if (!project) return
                setActiveView("antigravityAcp")
              }}
              data-testid="external-control-open-acp"
            >
              {t("settings.sections.externalControl.openAntigravityAcp", {
                defaultValue: "Open Antigravity ACP Panel",
              })}
            </Button>
          </div>
        </div>
        {!project ? (
          <p
            role="status"
            data-testid="external-control-open-acp-project-hint"
            className="text-xs text-muted-foreground"
          >
            {t("settings.sections.externalControl.openAntigravityAcpRequiresProject", {
              defaultValue:
                "Create or open a novel project first before opening the Antigravity ACP Panel.",
            })}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label
            htmlFor="external-control-antigravity-profile"
            className="font-medium text-muted-foreground"
          >
            {t("settings.sections.externalControl.antigravityProfileLabel", {
              defaultValue: "MCP tool profile (serverUrl profile)",
            })}
          </label>
          <select
            id="external-control-antigravity-profile"
            value={antigravityProfile}
            onChange={(e) => setAntigravityProfile(e.target.value as McpToolProfile)}
            data-testid="external-control-antigravity-profile"
            className="rounded border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="full-legacy">
              {t("settings.sections.externalControl.antigravityProfileFullLegacy", {
                defaultValue: "Full legacy (bare URL, no ?profile)",
              })}
            </option>
            <option value="writer-sub">
              {t("settings.sections.externalControl.antigravityProfileWriterSub", {
                defaultValue: "Recommended: Writer compact (?profile=writer-sub)",
              })}
            </option>
            <option value="reviewer">
              {t("settings.sections.externalControl.antigravityProfileReviewer", {
                defaultValue: "Reviewer read-only (?profile=reviewer)",
              })}
            </option>
            <option value="architect">
              {t("settings.sections.externalControl.antigravityProfileArchitect", {
                defaultValue: "Architect / outline (?profile=architect)",
              })}
            </option>
          </select>
        </div>
        <pre
          className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs"
          data-testid="external-control-antigravity-snippet"
        >
          {antigravityMcpSnippet}
        </pre>
        {status && !running ? (
          <p
            role="status"
            data-testid="external-control-antigravity-stopped-hint"
            className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-warning-foreground"
          >
            {t("settings.sections.externalControl.antigravityMcpStoppedHint", {
              defaultValue:
                "External Control is currently stopped. Enable Allow external control above before connecting Antigravity.",
            })}
          </p>
        ) : null}
        {antigravityCopyWarning ? (
          <p
            role="status"
            data-testid="external-control-antigravity-copy-warning"
            className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-warning-foreground"
          >
            {antigravityCopyWarning === "stopped_and_masked"
              ? t("settings.sections.externalControl.antigravityCopyWarnStoppedAndMasked", {
                  defaultValue:
                    "Copied snippet while the server is stopped and the Bearer token is hidden (<YOUR_BEARER_TOKEN>). Start the server and reveal the token above before connecting.",
                })
              : antigravityCopyWarning === "stopped"
                ? t("settings.sections.externalControl.antigravityCopyWarnStopped", {
                    defaultValue:
                      "Copied snippet, but the External Control server is currently stopped. Enable Allow external control above before connecting from Antigravity.",
                  })
                : t("settings.sections.externalControl.antigravityCopyWarnMasked", {
                    defaultValue:
                      "Copied snippet with placeholder <YOUR_BEARER_TOKEN> because the Bearer token is hidden. Reveal the token above and copy again, or replace it manually.",
                  })}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.externalControl.antigravityMcpPathHint", {
            defaultValue:
              "Paste into %USERPROFILE%\\.gemini\\config\\mcp_config.json (Windows global), ~/.gemini/config/mcp_config.json (macOS/Linux global), or <workspace>/.agents/mcp_config.json (workspace). Reveal the Bearer token above first to pre-fill it. Never commit a workspace mcp_config.json containing a Bearer token to Git.",
          })}
        </p>

        <div
          data-testid="external-control-writer-plugin-row"
          className="space-y-2 border-t border-border/60 pt-3 text-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {t("settings.sections.externalControl.writerPluginTitle", {
                  defaultValue: "Declarative Writer Agent Plugin (Project Sync / Disabled Global)",
                })}
              </span>
              {writerPluginStatus ? (
                <span
                  role="status"
                  data-testid="external-control-writer-plugin-state"
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] ${
                    writerPluginStatus.projectState === "synced"
                      ? "bg-success/15 text-success-foreground"
                      : writerPluginStatus.projectState === "needs_update"
                        ? "border border-warning/50 bg-warning/15 text-warning-foreground"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  {writerPluginStatus.projectState === "synced"
                    ? t("settings.sections.externalControl.writerPluginStateSynced", {
                        defaultValue: "Project synced",
                      })
                    : writerPluginStatus.projectState === "needs_update"
                      ? t("settings.sections.externalControl.writerPluginStateNeedsUpdate", {
                          defaultValue: "Update available",
                        })
                      : t("settings.sections.externalControl.writerPluginStateNotSynced", {
                          defaultValue: "Not synced",
                        })}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={!projectPath || pluginSyncBusy}
                title={
                  !projectPath
                    ? t("settings.sections.externalControl.writerPluginNoProjectHint", {
                        defaultValue:
                          "Open a novel project first to sync project-level writer agent config.",
                      })
                    : undefined
                }
                onClick={() => void handleSyncProjectWriterPlugin()}
                data-testid="external-control-sync-writer-plugin"
              >
                {pluginSyncBusy ? (
                  <>
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                    {t("settings.sections.externalControl.writerPluginSyncing", {
                      defaultValue: "Syncing...",
                    })}
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
                    {t("settings.sections.externalControl.writerPluginSyncBtn", {
                      defaultValue: "Sync Project Writer Agent Config",
                    })}
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={pluginGlobalBusy}
                onClick={() => void handleInstallGlobalWriterPlugin()}
                data-testid="external-control-install-global-writer-plugin"
              >
                {pluginGlobalBusy ? (
                  <>
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                    {t("settings.sections.externalControl.writerPluginInstallingGlobal", {
                      defaultValue: "Installing...",
                    })}
                  </>
                ) : (
                  <>
                    <Download className="mr-1 h-3 w-3" aria-hidden="true" />
                    {t("settings.sections.externalControl.writerPluginInstallGlobalBtn", {
                      defaultValue: "Install Global Plugin (Disabled)",
                    })}
                  </>
                )}
              </Button>
            </div>
          </div>
          {!projectPath ? (
            <p
              role="status"
              data-testid="external-control-writer-plugin-no-project-hint"
              className="text-xs text-muted-foreground"
            >
              {t("settings.sections.externalControl.writerPluginNoProjectHint", {
                defaultValue:
                  "Open a novel project first to sync project-level writer agent config.",
              })}
            </p>
          ) : null}
          {writerPluginStatus?.parentCodeRepoWarning ? (
            <p
              role="status"
              data-testid="external-control-writer-plugin-repo-warning"
              className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-warning-foreground"
            >
              {writerPluginStatus.parentCodeRepoWarning}
            </p>
          ) : null}
          {pluginFeedback ? (
            <p
              role="status"
              aria-live="polite"
              data-testid="external-control-writer-plugin-feedback"
              className="rounded-md border border-success/40 bg-success/10 px-2.5 py-1.5 text-xs text-success-foreground"
            >
              {pluginFeedback}
            </p>
          ) : null}
          {pluginError ? (
            <p
              role="status"
              aria-live="polite"
              data-testid="external-control-writer-plugin-error"
              className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-warning-foreground"
            >
              {pluginError}
            </p>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium">
            {t("settings.sections.externalControl.sessions", {
              defaultValue: "Connected sessions",
            })}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground" data-testid="external-control-tool-count">
              {t("settings.sections.externalControl.toolCount", {
                defaultValue: "{{count}} available tools",
                count: status?.tool_count ?? 0,
              })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={busy}
              onClick={() => void refresh()}
              data-testid="external-control-refresh"
            >
              <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
              {t("settings.sections.externalControl.refreshSessions", {
                defaultValue: "Refresh",
              })}
            </Button>
          </div>
        </div>
        {sessions.length === 0 ? (
          <p
            className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground"
            data-testid="external-control-sessions-empty"
          >
            {t("settings.sections.externalControl.sessionsEmpty", {
              defaultValue: "No external agent connected.",
            })}
          </p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-md border border-border/60">
            {sessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-xs"
                data-testid="external-control-session-row"
              >
                <code className="truncate font-mono">{session.id.slice(0, 8)}</code>
                {session.client_name ? (
                  <span
                    className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                    data-testid="external-control-session-client"
                  >
                    {session.client_version
                      ? `${session.client_name} v${session.client_version}`
                      : session.client_name}
                  </span>
                ) : null}
                <span className="text-muted-foreground">{session.scope}</span>
                {session.auto_granted ? (
                  <span
                    className="rounded bg-info/15 px-1.5 py-0.5 text-info"
                    data-testid="external-control-session-auto-badge"
                  >
                    {t("settings.sections.externalControl.autoGranted", {
                      defaultValue: "Auto orchestration",
                    })}
                  </span>
                ) : null}
                {session.full_granted ? (
                  <span
                    className="rounded bg-warning/15 px-1.5 py-0.5 text-warning-foreground"
                    data-testid="external-control-session-full-badge"
                  >
                    {t("settings.sections.externalControl.fullGranted", {
                      defaultValue: "Full write",
                    })}
                  </span>
                ) : null}
                <span className="text-muted-foreground">
                  {new Date(session.connected_at).toLocaleTimeString()}
                </span>
                <span className="text-muted-foreground">
                  {t("settings.sections.externalControl.calls", {
                    defaultValue: "{{count}} calls",
                    count: session.calls,
                  })}
                </span>
                <Button
                  variant={session.auto_granted ? "outline" : "secondary"}
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  data-testid="external-control-session-auto-toggle"
                  aria-pressed={session.auto_granted}
                  disabled={busy}
                  onClick={() => void toggleAuto(session.id, !session.auto_granted)}
                >
                  {session.auto_granted
                    ? t("settings.sections.externalControl.revokeAuto", {
                        defaultValue: "Revoke auto"
                      })
                    : t("settings.sections.externalControl.grantAuto", {
                        defaultValue: "Grant auto (settings + actions)"
                      })}
                </Button>
                <Button
                  variant={session.full_granted ? "outline" : "secondary"}
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  data-testid="external-control-session-full-toggle"
                  aria-pressed={session.full_granted}
                  disabled={busy}
                  onClick={() =>
                    void toggleFull(session.id, !session.full_granted)
                  }
                >
                  {session.full_granted
                    ? t("settings.sections.externalControl.revokeFull", {
                        defaultValue: "Revoke full write",
                      })
                    : t("settings.sections.externalControl.grantFull", {
                        defaultValue: "Grant full write",
                      })}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
