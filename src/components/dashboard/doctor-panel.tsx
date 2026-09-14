import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Stethoscope, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { formatDoctorReport, runProjectDoctor } from "@/lib/novel"
import type { DoctorReport } from "@/lib/novel"

/**
 * DoctorPanel — 项目医生整链诊断面板（65 号共识 G2 挂载：形态轴 F7 消费侧）。
 *
 * 边界：`runProjectDoctor` 只读 IO（不写任何文件）；extras 由调用方
 * 从现有 store 状态聚合（canonDualWriteEnabled / ftsIndexReady / budgetTasks）；
 * 零 LLM；渲染走 `formatDoctorReport` 文本契约。
 */
export function DoctorPanel() {
  const { t } = useTranslation()
  const projectPath = useWikiStore((s) => s.project?.path)
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    if (!projectPath) return
    setRunning(true)
    setError(null)
    try {
      const r = await runProjectDoctor(projectPath, {
        canonDualWriteEnabled: false,
        ftsIndexReady: false,
        budgetTasks: [],
        budgetCompleted: [],
      })
      setReport(r)
    } catch (err) {
      setError(`${t("novel.doctor.failed")}：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRunning(false)
    }
  }, [projectPath, t])

  // 项目打开/切换后自动跑一次（只读诊断，无副作用）；无项目时渲染空态提示
  useEffect(() => {
    if (!projectPath) return
    void run()
  }, [projectPath, run])

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-4 doctor-panel" data-testid="doctor-panel">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <h3 className="flex items-center gap-2">
          <Stethoscope className="h-4 w-4" aria-hidden="true" />
          {t("novel.doctor.title")}
        </h3>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void run()}
          disabled={running || !projectPath}
          className="ml-auto"
          aria-label={t("novel.doctor.refresh")}
          title={t("novel.doctor.refresh")}
        >
          <RefreshCw className={`h-3 w-3 ${running ? "animate-spin" : ""}`} aria-hidden="true" />
        </Button>
      </div>
      <div className="space-y-2 pt-2">
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        {report ? (
          <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded border p-2 text-xs">{formatDoctorReport(report)}</pre>
        ) : (
          <p className="text-sm text-muted-foreground">{projectPath ? t("novel.doctor.empty") : t("novel.doctor.noProject")}</p>
        )}
      </div>
    </div>
  )
}
