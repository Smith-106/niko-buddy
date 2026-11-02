// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useTranslation } from "react-i18next"
import { AlertTriangle, Copy, Eye, EyeOff, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SettingsSwitch } from "../settings-widgets"
import { toErrorMessage } from "@/lib/utils"

/** 与 `src-tauri/src/mcp_server/mod.rs::McpServerStatus` 一一对应。 */
interface McpSession {
  id: string
  scope: string
  connected_at: number
  last_call_at: number
  calls: number
}

/**
 * 服务端授予外部 Agent 的权限域。
 *
 * 三项**互斥**，不是累加：`project` 不蕴含 `settings`（见后端 `SessionScope::satisfies`）。
 * 同时要两类写权限的组合 scope 属于 P3，届时在设置页显式授权。
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
      "Also allows chapter.write, memory.write, pipeline.run_chapter and gate.run. Output only ever lands in the draft area.",
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // 停止状态下先记住用户想要的权限域，下次启动时带上去。
  const [wantScope, setWantScope] = useState<McpScope>("read")

  const running = status?.running ?? false
  /** 界面上应显示的权限域：运行中读真实状态，停止时显示待生效的意图。 */
  const currentScope: McpScope = running ? (status?.scope ?? "read") : wantScope

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<McpServerStatus>("mcp_server_status")
      setStatus(next)
      if (next.running) setWantScope(next.scope)
      setError(null)
    } catch (e) {
      setError(toErrorMessage(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggle = useCallback(
    async (next: boolean) => {
      setBusy(true)
      setError(null)
      try {
        if (next) {
          await invoke<number>("mcp_server_start", { scope: wantScope })
        } else {
          await invoke("mcp_server_stop")
          // 停服后旧 token 不再展示，避免用户以为它还生效。
          setToken(null)
          setTokenVisible(false)
        }
        await refresh()
      } catch (e) {
        setError(toErrorMessage(e))
        // 失败也要重读真实状态：开关必须反映现实，不能停在用户点击的意图上。
        await refresh()
      } finally {
        setBusy(false)
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
        setError(toErrorMessage(e))
        await refresh()
      } finally {
        setBusy(false)
      }
    },
    [currentScope, refresh, running],
  )

  const revealToken = useCallback(async () => {
    if (token) {
      setTokenVisible((v) => !v)
      return
    }
    try {
      const value = await invoke<string>("mcp_server_token")
      setToken(value)
      setTokenVisible(true)
    } catch (e) {
      setError(toErrorMessage(e))
    }
  }, [token])

  const rotateToken = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const value = await invoke<string>("mcp_server_rotate_token")
      setToken(value)
      setTokenVisible(true)
      await refresh()
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const copyEndpoint = useCallback(async () => {
    if (!status) return
    try {
      await navigator.clipboard.writeText(status.endpoint)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      setError(toErrorMessage(e))
    }
  }, [status])

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
              "Let an external agent (Claude Code, PI) connect to this app over a loopback-only MCP endpoint. Read-only unless you explicitly grant settings write access; the app must stay running.",
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
      </div>

      {error ? (
        <div
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

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">
            {t("settings.sections.externalControl.sessions", {
              defaultValue: "Connected sessions",
            })}
          </div>
          <span className="text-xs text-muted-foreground" data-testid="external-control-tool-count">
            {t("settings.sections.externalControl.toolCount", {
              defaultValue: "{{count}} read-only tools",
              count: status?.tool_count ?? 0,
            })}
          </span>
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
                className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                data-testid="external-control-session-row"
              >
                <code className="truncate font-mono">{session.id.slice(0, 8)}</code>
                <span className="text-muted-foreground">{session.scope}</span>
                <span className="text-muted-foreground">
                  {new Date(session.connected_at).toLocaleTimeString()}
                </span>
                <span className="text-muted-foreground">
                  {t("settings.sections.externalControl.calls", {
                    defaultValue: "{{count}} calls",
                    count: session.calls,
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
