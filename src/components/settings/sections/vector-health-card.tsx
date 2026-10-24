import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import {
  countVectorChunks,
  dropLegacyVectorTable,
  legacyVectorRowCount,
  triggerIdleCompaction,
} from "@/lib/embedding"
import { toErrorMessage } from "@/lib/utils"

export function VectorHealthCard() {
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
      setBusy(kind)
      setNote(null)
      try {
        if (kind === "compaction") {
          const r = await triggerIdleCompaction(project.path)
          setNote(r ? `compaction ok chunks=${r.chunks_compacted}` : "compaction ok")
        } else if (kind === "drop") {
          await dropLegacyVectorTable(project.path)
          setNote("drop legacy ok")
        } else {
          const { invoke } = await import("@tauri-apps/api/core")
          const report = await invoke<{ skipped?: boolean; deleted_pages?: string[] }>(
            "vector_run_startup_reconcile",
            { projectPath: project.path, expected: [] },
          )
          setNote(
            report?.skipped === true
              ? "已跳过（无预置索引清单，请先触发索引构建）"
              : "reconcile ok",
          )
        }
        await refresh()
      } catch (err) {
        setNote(toErrorMessage(err))
      } finally {
        setBusy(null)
      }
    },
    [project, busy, refresh],
  )

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-4" data-testid="vector-health-card">
      <div className="text-sm font-semibold">向量库健康</div>
      <p className="text-xs text-muted-foreground">
        Chunk总数 {chunks ?? "—"} · 旧表残留 {legacy ?? "—"}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!project || busy !== null} onClick={() => void run("compaction")}>
          {busy === "compaction" ? "压缩中…" : "立即压缩"}
        </Button>
        <Button size="sm" variant="outline" disabled={!project || busy !== null} onClick={() => void run("reconcile")}>
          {busy === "reconcile" ? "对账中…" : "对账校验"}
        </Button>
        <Button size="sm" variant="outline" disabled={!project || busy !== null} onClick={() => void run("drop")}>
          {busy === "drop" ? "清理中…" : "清理旧版残留"}
        </Button>
        <Button size="sm" variant="ghost" disabled={!project || busy !== null} onClick={() => void refresh()}>
          刷新
        </Button>
      </div>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  )
}
