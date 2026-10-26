import { useEffect, useState } from "react"
import { CheckCircle2, Loader2, XCircle } from "lucide-react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"
import { Label } from "@/components/ui/label"
import { isTauri } from "@/lib/platform"
import { getCursorProxyStatus, stopCursorProxy } from "@/lib/cursor-cli-proxy"
import { toErrorMessage } from "@/lib/utils"

export interface DetectResult {
  installed: boolean
  version: string | null
  path: string | null
  /** Antigravity：gemini 内核降级候选路径。 */
  fallback_path?: string | null
  error: string | null
}

/**
 * Health-check pill for the Claude Code CLI provider. Auto-runs
 * `claude --version` on mount, with a refresh button for when the user
 * just installed the binary and wants to re-check without reopening the
 * panel. The error message comes straight from the Rust side — it
 * already tailors the hint (macOS quarantine, missing binary, etc).
 */
export function ClaudeCliStatusPill() {
  const { t } = useTranslation()
  const [state, setState] = useState<"loading" | "ok" | "err">("loading")
  const [result, setResult] = useState<DetectResult | null>(null)

  async function detect() {
    setState("loading")
    if (!isTauri()) {
      setResult({ installed: false, version: null, path: null, error: t("settings.sections.llm.cliStatus.desktopOnly") })
      setState("err")
      return
    }
    try {
      const r = await invoke<DetectResult>("claude_cli_detect")
      setResult(r)
      setState(r.installed ? "ok" : "err")
    } catch (e) {
      setResult({
        installed: false,
        version: null,
        path: null,
        error: toErrorMessage(e),
      })
      setState("err")
    }
  }

  useEffect(() => {
    void detect()
  }, [])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label className="m-0">{t("settings.sections.llm.cliStatus.title")}</Label>
        <button
          type="button"
          onClick={() => void detect()}
          className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          disabled={state === "loading"}
          aria-label={state === "loading" ? t("settings.sections.llm.cliStatus.checking") : t("settings.sections.llm.cliStatus.recheck")}
        >
          {state === "loading"
            ? t("settings.sections.llm.cliStatus.checking")
            : t("settings.sections.llm.cliStatus.recheck")}
        </button>
      </div>
      <div
        className={`flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${
          state === "ok"
            ? "border-success/40 bg-success/5 text-success"
            : state === "err"
              ? "border-destructive/40 bg-destructive/5 text-destructive"
              : "border-border bg-background/50 text-muted-foreground"
        }`}
      >
        {state === "loading" && <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />}
        {state === "ok" && <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        {state === "err" && <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        <div className="min-w-0 flex-1 space-y-0.5">
          {state === "loading" && <div>{t("settings.sections.llm.cliStatus.claudeDetecting")}</div>}
          {state === "ok" && (
            <>
              <div>
                {t("settings.sections.llm.cliStatus.claudeReady", {
                  versionSuffix: result?.version ? ` ${result.version}` : "",
                })}
              </div>
              <div className="text-muted-foreground text-xs">
                {t("settings.sections.llm.cliStatus.claudeTransportHint")}
              </div>
              {result?.path && (
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {result.path}
                </div>
              )}
              {/* `claude --version` doesn't validate OAuth, so even a
                  green pill can hide an expired login. Surface the
                  remediation up front so users don't mis-diagnose
                  the resulting "Unauthenticated" exit-1 as a LLM
                  Wiki bug. */}
              <div className="text-muted-foreground">
                {t("settings.sections.llm.cliStatus.authErrorPrefix")}{" "}
                <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-xs">
                  claude
                </code>{" "}
                {t("settings.sections.llm.cliStatus.claudeAuthErrorSuffix")}
              </div>
            </>
          )}
          {state === "err" && (
            <>
              <div>{result?.error ?? t("settings.sections.llm.cliStatus.claudeUnavailable")}</div>
              <div className="text-muted-foreground">
                {t("settings.sections.llm.cliStatus.installPrefix")}{" "}
                <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-xs">
                  npm i -g @anthropic-ai/claude-code
                </code>{" "}
                {t("settings.sections.llm.cliStatus.installSuffix")}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export function CodexCliStatusPill() {
  const { t } = useTranslation()
  const [state, setState] = useState<"loading" | "ok" | "err">("loading")
  const [result, setResult] = useState<DetectResult | null>(null)

  async function detect() {
    setState("loading")
    if (!isTauri()) {
      setResult({ installed: false, version: null, path: null, error: t("settings.sections.llm.cliStatus.desktopOnly") })
      setState("err")
      return
    }
    try {
      const r = await invoke<DetectResult>("codex_cli_detect")
      setResult(r)
      setState(r.installed ? "ok" : "err")
    } catch (e) {
      setResult({
        installed: false,
        version: null,
        path: null,
        error: toErrorMessage(e),
      })
      setState("err")
    }
  }

  useEffect(() => {
    void detect()
  }, [])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label className="m-0">{t("settings.sections.llm.cliStatus.title")}</Label>
        <button
          type="button"
          onClick={() => void detect()}
          className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          disabled={state === "loading"}
          aria-label={state === "loading" ? t("settings.sections.llm.cliStatus.checking") : t("settings.sections.llm.cliStatus.recheck")}
        >
          {state === "loading"
            ? t("settings.sections.llm.cliStatus.checking")
            : t("settings.sections.llm.cliStatus.recheck")}
        </button>
      </div>
      <div
        className={`flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${
          state === "ok"
            ? "border-success/40 bg-success/5 text-success"
            : state === "err"
              ? "border-destructive/40 bg-destructive/5 text-destructive"
              : "border-border bg-background/50 text-muted-foreground"
        }`}
      >
        {state === "loading" && <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />}
        {state === "ok" && <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        {state === "err" && <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        <div className="min-w-0 flex-1 space-y-0.5">
          {state === "loading" && <div>{t("settings.sections.llm.cliStatus.codexDetecting")}</div>}
          {state === "ok" && (
            <>
              <div>
                {t("settings.sections.llm.cliStatus.codexReady", {
                  versionSuffix: result?.version ? ` ${result.version}` : "",
                })}
              </div>
              {result?.path && (
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {result.path}
                </div>
              )}
              <div className="text-muted-foreground">
                {t("settings.sections.llm.cliStatus.authErrorPrefix")}{" "}
                <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-xs">
                  codex
                </code>{" "}
                {t("settings.sections.llm.cliStatus.codexAuthErrorSuffix")}
              </div>
            </>
          )}
          {state === "err" && (
            <>
              <div>{result?.error ?? t("settings.sections.llm.cliStatus.codexUnavailable")}</div>
              <div className="text-muted-foreground">
                {t("settings.sections.llm.cliStatus.installPrefix")}{" "}
                <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-xs">
                  npm install -g @openai/codex
                </code>{" "}
                {t("settings.sections.llm.cliStatus.installSuffix")}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export interface CursorProxyStatusPayload {
  healthy: boolean
  base_url: string
  managed: boolean
  error: string | null
}

/** Health-check pill for Antigravity CLI (local binary / Google account, no API key). */
export function AntigravityCliStatusPill() {
  const { t } = useTranslation()
  const [state, setState] = useState<"loading" | "ok" | "err">("loading")
  const [result, setResult] = useState<DetectResult | null>(null)

  async function detect() {
    setState("loading")
    if (!isTauri()) {
      setResult({ installed: false, version: null, path: null, error: t("settings.sections.llm.cliStatus.desktopOnly") })
      setState("err")
      return
    }
    try {
      const r = await invoke<DetectResult>("antigravity_cli_detect")
      setResult(r)
      setState(r.installed ? "ok" : "err")
    } catch (e) {
      setResult({ installed: false, version: null, path: null, error: toErrorMessage(e) })
      setState("err")
    }
  }

  useEffect(() => {
    void detect()
  }, [])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label className="m-0">{t("settings.sections.llm.cliStatus.title")}</Label>
        <button
          type="button"
          onClick={() => void detect()}
          className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          disabled={state === "loading"}
          aria-label={state === "loading" ? t("settings.sections.llm.cliStatus.checking") : t("settings.sections.llm.cliStatus.recheck")}
        >
          {state === "loading"
            ? t("settings.sections.llm.cliStatus.checking")
            : t("settings.sections.llm.cliStatus.recheck")}
        </button>
      </div>
      <div
        className={`flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${
          state === "ok"
            ? "border-success/40 bg-success/5 text-success"
            : state === "err"
              ? "border-destructive/40 bg-destructive/5 text-destructive"
              : "border-border bg-background/50 text-muted-foreground"
        }`}
      >
        {state === "loading" && <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />}
        {state === "ok" && <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        {state === "err" && <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        <div className="min-w-0 flex-1 space-y-0.5">
          {state === "loading" && <div>{t("settings.sections.llm.cliStatus.antigravityDetecting")}</div>}
          {state === "ok" && (
            <>
              <div>
                {t("settings.sections.llm.cliStatus.antigravityReady", {
                  versionSuffix: result?.version ? ` ${result.version}` : "",
                })}
              </div>
              {result?.path && (
                <div className="truncate font-mono text-xs text-muted-foreground">{result.path}</div>
              )}
              {result?.fallback_path && result.path !== result.fallback_path && (
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {t("settings.sections.llm.cliStatus.antigravityFallback")}: {result.fallback_path}
                </div>
              )}
            </>
          )}
          {state === "err" && (
            <>
              <div>{result?.error ?? t("settings.sections.llm.cliStatus.antigravityUnavailable")}</div>
              <div className="text-muted-foreground">
                {t("settings.sections.llm.cliStatus.installPrefix")}{" "}
                <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-xs">
                  antigravity / gemini
                </code>{" "}
                {t("settings.sections.llm.cliStatus.installSuffix")}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}


/** Extract `host:port` from a proxy base URL, e.g. `http://127.0.0.1:8765` → `127.0.0.1:8765`. */
export function proxyEndpointLabel(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    const host = url.host || baseUrl
    return host
  } catch {
    return baseUrl
  }
}

/**
 * Status badge + stop control for the managed cursor-api-proxy (audit
 * ①-2 / ③-13). Shows healthy / port when the proxy is reachable, an
 * error hint otherwise, and lets the user stop the process the app
 * started.
 */
export function CursorProxyStatusBadge() {
  const { t } = useTranslation()
  const [state, setState] = useState<"loading" | "ok" | "err">("loading")
  const [status, setStatus] = useState<CursorProxyStatusPayload | null>(null)
  const [stopping, setStopping] = useState(false)

  async function refresh() {
    setState("loading")
    try {
      const s = await getCursorProxyStatus()
      setStatus(s)
      setState(s.healthy ? "ok" : "err")
    } catch (e) {
      setStatus({
        healthy: false,
        base_url: "",
        managed: false,
        error: toErrorMessage(e),
      })
      setState("err")
    }
  }

  async function handleStop() {
    if (!status?.managed) return
    setStopping(true)
    try {
      await stopCursorProxy()
    } catch {
      // 状态刷新会展示服务端错误；停止失败不阻塞。
    } finally {
      setStopping(false)
      await refresh()
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const endpointLabel = status ? proxyEndpointLabel(status.base_url) : ""

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label className="m-0">
          {t("settings.sections.llm.cursorProxy.title", { defaultValue: "Cursor 代理状态" })}
        </Label>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          disabled={state === "loading"}
          aria-label={state === "loading" ? t("settings.sections.llm.cliStatus.checking") : t("settings.sections.llm.cliStatus.recheck")}
        >
          {state === "loading"
            ? t("settings.sections.llm.cliStatus.checking")
            : t("settings.sections.llm.cliStatus.recheck")}
        </button>
      </div>
      <div
        className={`flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${
          state === "ok"
            ? "border-success/40 bg-success/5 text-success"
            : state === "err"
              ? "border-destructive/40 bg-destructive/5 text-destructive"
              : "border-border bg-background/50 text-muted-foreground"
        }`}
      >
        {state === "loading" && <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />}
        {state === "ok" && <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        {state === "err" && <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        <div className="min-w-0 flex-1 space-y-0.5">
          {state === "loading" && (
            <div>{t("settings.sections.llm.cursorProxy.checking", { defaultValue: "正在检测代理状态…" })}</div>
          )}
          {state === "ok" && (
            <>
              <div>
                {t("settings.sections.llm.cursorProxy.healthy", {
                  defaultValue: "代理运行正常（{{endpoint}}）",
                  endpoint: endpointLabel,
                })}
              </div>
              {status?.managed ? (
                <div className="text-muted-foreground">
                  {t("settings.sections.llm.cursorProxy.managedHint", {
                    defaultValue: "由应用托管，可随时停止",
                  })}
                </div>
              ) : null}
            </>
          )}
          {state === "err" && (
            <>
              <div>
                {status?.error ?? t("settings.sections.llm.cursorProxy.unavailable", { defaultValue: "代理不可用" })}
              </div>
              <div className="text-muted-foreground">
                {t("settings.sections.llm.cursorProxy.errHint", {
                  defaultValue: "模型请求时会自动拉起托管代理；如需手动检查，请确认 cursor-api-proxy 可访问。",
                })}
              </div>
            </>
          )}
        </div>
        {status?.managed && (
          <button
            type="button"
            onClick={() => void handleStop()}
            disabled={stopping || state === "loading"}
            className="shrink-0 rounded border border-destructive/40 px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
            title={t("settings.sections.llm.cursorProxy.stopTitle", { defaultValue: "停止托管代理" })}
          >
            {stopping
              ? t("settings.sections.llm.cursorProxy.stopping", { defaultValue: "停止中…" })
              : t("settings.sections.llm.cursorProxy.stop", { defaultValue: "停止代理" })}
          </button>
        )}
      </div>
    </div>
  )
}
