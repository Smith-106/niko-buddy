import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import {
  countVectorChunks,
  dropLegacyVectorTable,
  legacyVectorRowCount,
  triggerIdleCompaction,
} from "@/lib/embedding"
import { toErrorMessage } from "@/lib/utils"

const K = "settings.sections.maintenance.vectorHealth"

export function VectorHealthCard() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const [chunks, setChunks] = useState<number | null>(null)
  const [legacy, setLegacy] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!project) return
    try {
      const [c, l] = await Promise.all([
        countVectorChunks(project.path),
        legacyVectorRowCount(project.path),
      ])
      setChunks(c)
      setLegacy(l)
    } catch {
      setChunks(null)
      setLegacy(null)
    }
  }, [project])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = useCallback(
    async (kind: "reconcile" | "compaction" | "drop") => {
      if (!project || busy) return
      // 删除 legacy 表不可恢复：沿用数据管理页的二次确认（两次 confirm 都通过才执行）
      if (kind === "drop") {
        const first = window.confirm(
          t("settings.sections.dataManagement.vectorCleanConfirm", {
            defaultValue: "确定清理遗留（legacy）向量表？此操作不可恢复。",
          }),
        )
        if (!first) return
        const second = window.confirm(
          t("settings.sections.dataManagement.vectorCleanConfirm2", {
            defaultValue: "再次确认：将删除 legacy 向量行并触发重建，继续吗？",
          }),
        )
        if (!second) return
      }
      setBusy(kind)
      setNote(null)
      try {
        if (kind === "compaction") {
          const r = await triggerIdleCompaction(project.path)
          setNote(
            r
              ? t(`${K}.compactionDoneCount`, { defaultValue: "压缩完成，已合并 {{count}} 个 chunk", count: r.chunks_compacted })
              : t(`${K}.compactionDone`, { defaultValue: "压缩完成" }),
          )
        } else if (kind === "drop") {
          await dropLegacyVectorTable(project.path)
          setNote(t(`${K}.dropDone`, { defaultValue: "旧版残留已清理" }))
        } else {
          const { invoke } = await import("@tauri-apps/api/core")
          const report = await invoke<{ skipped?: boolean; deleted_pages?: string[] }>(
            "vector_run_startup_reconcile",
            { projectPath: project.path, expected: [] },
          )
          setNote(
            report?.skipped === true
              ? t(`${K}.reconcileSkipped`, { defaultValue: "已跳过（无预置索引清单，请先触发索引构建）" })
              : t(`${K}.reconcileDone`, { defaultValue: "对账完成" }),
          )
        }
        await refresh()
      } catch (err) {
        setNote(toErrorMessage(err))
      } finally {
        setBusy(null)
      }
    },
    [project, busy, refresh, t],
  )

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-4" data-testid="vector-health-card">
      <h3 className="text-sm font-semibold">{t(`${K}.title`, { defaultValue: "向量库健康" })}</h3>
      <p className="text-xs text-muted-foreground">
        {t(`${K}.summary`, {
          defaultValue: "Chunk总数 {{chunks}} · 旧表残留 {{legacy}}",
          chunks: chunks ?? "—",
          legacy: legacy ?? "—",
        })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!project || busy !== null} onClick={() => void run("compaction")}>
          {busy === "compaction"
            ? t(`${K}.compacting`, { defaultValue: "压缩中…" })
            : t(`${K}.compact`, { defaultValue: "立即压缩" })}
        </Button>
        <Button size="sm" variant="outline" disabled={!project || busy !== null} onClick={() => void run("reconcile")}>
          {busy === "reconcile"
            ? t(`${K}.reconciling`, { defaultValue: "对账中…" })
            : t(`${K}.reconcile`, { defaultValue: "对账校验" })}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={!project || busy !== null}
          onClick={() => void run("drop")}
          data-testid="vector-health-drop-legacy"
        >
          {busy === "drop"
            ? t(`${K}.dropping`, { defaultValue: "清理中…" })
            : t(`${K}.drop`, { defaultValue: "清理旧版残留" })}
        </Button>
        <Button size="sm" variant="ghost" disabled={!project || busy !== null} onClick={() => void refresh()}>
          {t(`${K}.refresh`, { defaultValue: "刷新" })}
        </Button>
      </div>
      {note ? <p role="status" className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  )
}
