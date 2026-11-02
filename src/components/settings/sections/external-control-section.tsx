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

interface McpServerStatus {
  running: boolean
  port: number | null
  tool_count: number
  tools: string[]
  sessions: McpSession[]
  endpoint: string
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

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<McpServerStatus>("mcp_server_status")
      setStatus(next)
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
          await invoke<number>("mcp_server_start")
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
    [refresh],
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

  const running = status?.running ?? false
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
              "Let an external agent (Claude Code, PI) connect to this app over a loopback-only MCP endpoint. Read-only in this phase; the app must stay running.",
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
