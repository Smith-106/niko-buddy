import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import { readCapabilityTraces, type CapabilityTraceRecord } from "@/lib/agent/capability-trace-store"
import { toErrorMessage } from "@/lib/utils"

/**
 * Capability DAG 回放抽屉（第二波范围A）。
 * 只读：从 .novel/capability-traces/trace.jsonl 读最近 N 条，展示 intent/mode/outcome/planned 链；
 * trace 是旁路观测，读失败只显示空态，绝不阻断诊断面板。
 */
export function CapabilityReplayDrawer() {
  const { t } = useTranslation()
  const projectPath = useWikiStore((s) => s.project?.path)
  const [open, setOpen] = useState(false)
  const [traces, setTraces] = useState<CapabilityTraceRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!projectPath) return
    setError(null)
    try {
      const all = await readCapabilityTraces(projectPath)
      setTraces(all.slice(-20).reverse())
    } catch (err) {
      setError(toErrorMessage(err))
      setTraces([])
    }
  }, [projectPath])

  return (
    <div data-testid="capability-replay-drawer">
      <button
        type="button"
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) void load()
        }}
        disabled={!projectPath}
        className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        {t("novel.doctor.capabilityReplay", "能力回放")}
      </button>
      {open && (
        <div className="mt-2 max-h-64 space-y-1.5 overflow-y-auto rounded-md border border-border/50 p-2 text-xs">
          {error && <p className="text-destructive">{error}</p>}
          {traces !== null && traces.length === 0 && (
            <p className="text-muted-foreground">{t("novel.doctor.capabilityReplayEmpty", "暂无能力规划记录")}</p>
          )}
          {traces?.map((r, i) => (
            <div key={`${r.at}-${i}`} className="rounded border border-border/40 px-2 py-1">
              <div className="font-medium">
                {r.intent} · {r.mode} · {r.outcome}
              </div>
              <div className="truncate text-muted-foreground">
                {r.planned.map((p) => p.id).join(" → ") || "(empty)"}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
