import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/platform"
import { toErrorMessage } from "@/lib/utils"

interface ProbeState {
  status: "loading" | "ok" | "err"
  version: string | null
  error: string | null
}

const PROBES = [
  { key: "claude", command: "claude_cli_detect" },
  { key: "codex", command: "codex_cli_detect" },
  { key: "cursor", command: "cursor_cli_detect" },
  { key: "antigravity", command: "antigravity_cli_detect" },
] as const

/**
 * 本地 CLI 四探针统一状态条（第二波范围A）。
 * 并行 invoke 四个 detect 命令，一次展示 claude/codex/cursor/antigravity 安装态；
 * 只读诊断：失败只显示 error，不阻断设置页其他操作。
 */
export function CliProbeStrip() {
  const { t } = useTranslation()
  const [states, setStates] = useState<Record<string, ProbeState>>({})
  const [refreshing, setRefreshing] = useState(false)

  const run = useCallback(async () => {
    if (!isTauri()) {
      const err = { status: "err", version: null, error: "desktopOnly" } as ProbeState
      setStates({ claude: err, codex: err, cursor: err, antigravity: err })
      return
    }
    setRefreshing(true)
    const results = await Promise.all(
      PROBES.map(async (p) => {
        try {
          const r = await invoke<{ installed: boolean; version: string | null; error: string | null }>(p.command)
          return [p.key, { status: r.installed ? "ok" : "err", version: r.version, error: r.error }] as const
        } catch (err) {
          return [p.key, { status: "err", version: null, error: toErrorMessage(err) }] as const
        }
      }),
    )
    setStates(Object.fromEntries(results))
    setRefreshing(false)
  }, [])

  useEffect(() => {
    void run()
  }, [run])

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3" data-testid="cli-probe-strip">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{t("settings.sections.llm.cliStrip.title", "本地 CLI 探针")}</h3>
        <button
          type="button"
          onClick={() => void run()}
          disabled={refreshing}
          className="ml-auto rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          {refreshing
            ? t("settings.sections.llm.cliStatus.checking", "检测中…")
            : t("settings.sections.llm.cliStatus.recheck", "重新检测")}
        </button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {PROBES.map((p) => {
          const s = states[p.key]
          const dot = !s || s.status === "loading" ? "bg-muted-foreground" : s.status === "ok" ? "bg-success" : "bg-destructive"
          return (
            <div key={p.key} className="rounded-md border border-border/50 px-2 py-1.5 text-xs" data-testid={`cli-probe-${p.key}`}>
              <div className="flex items-center gap-1.5 font-medium">
                <span className={`inline-block h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
                {p.key}
              </div>
              <div className="mt-0.5 truncate text-muted-foreground">
                {!s ? "…" : s.status === "ok" ? (s.version ?? "ok") : (s.error ?? "unavailable")}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
