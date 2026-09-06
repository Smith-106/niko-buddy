import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Stethoscope, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { formatDoctorReport, runProjectDoctor, type DoctorReport } from "@/lib/novel/doctor"

/**
 * DoctorPanel — 项目医生整链诊断面板（65 号共识 G2 挂载：形态轴 F7 消费侧）。
 *
 * 边界：`runProjectDoctor` 只读 IO（不写任何文件）；extras 由调用方
 * 从现有 store 状态聚合（canonDualWriteEnabled / ftsIndexReady / budgetTasks）；
 * 零 LLM；渲染走 `formatDoctorReport` 文本契约。
 */
export function DoctorPanel() {
  const { t } = useTranslation()
  const projectPath = useWikiStore((s) => s.projectPath)
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
      setError(`${t("novel.doctor.failed") ?? "诊断失败"}：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRunning(false)
    }
  }, [projectPath, t])

  // 挂载即自动跑一次（只读诊断，无副作用）
  useEffect(() => {
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-4 doctor-panel" data-testid="doctor-panel">
      <div className="flex items-center gap-2 text-sm font-semibold">
          <Stethoscope className="h-4 w-4" />
          {t("novel.doctor.title")}
          <Button size="sm" variant="ghost" onClick={run} disabled={running || !projectPath} className="ml-auto">
            <RefreshCw className={`h-3 w-3 ${running ? "animate-spin" : ""}`} />
          </Button>
      </div>
      <div className="space-y-2 pt-2">
        {error && <p className="text-xs text-red-500">{error}</p>}
        {report ? (
          <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded border p-2 text-xs">{formatDoctorReport(report)}</pre>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("novel.doctor.empty") ?? projectPath ? "打开项目后自动运行整链诊断" : "未打开项目"}
          </p>
        )}
      </div>
    </div>
  )
}
