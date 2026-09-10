import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { Image, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { buildCoverImageTask, runCoverImageGeneration, saveGenerationHistoryEntry } from "@/lib/novel"
import type { CoverAspect, CoverImagePort, BookCoverMeta } from "@/lib/novel"
import { normalizePath } from "@/lib/path-utils"

/**
 * CoverGenerateCard — 封面生成卡（65 号共识 G2 挂载：形态轴 F5 消费侧）。
 *
 * 边界：`CoverImagePort` props 注入（生产适配器由调用方组装，零 llm-client）；
 * 幂等 skip——目标已存在直接报 skipped；M3 生产接线——生成成功记
 * `snapshot-cover` run（快照元数据不含正文）。
 */
export interface CoverGenerateCardProps {
  port?: CoverImagePort
  meta?: BookCoverMeta
  aspect?: CoverAspect
  /** 封面 prompt 文本（由已接线的 cover-brief 产出）。 */
  promptOverride?: string
}

export function CoverGenerateCard({ port, meta, aspect = "portrait", promptOverride }: CoverGenerateCardProps) {
  const { t } = useTranslation()
  const projectPath = useWikiStore((s) => s.project?.path)
  const [running, setRunning] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const run = useCallback(async () => {
    if (!port || !projectPath || !meta) return
    setRunning(true)
    setNotice(null)
    try {
      const task = buildCoverImageTask(meta, {
        subject: meta.protagonistBrief || meta.keyImagery.join("、") || meta.title,
        composition: "竖版人物居中",
        palette: "主题色",
        moodKeywords: [meta.tone],
        titlePlacement: "center",
        constraints: ["无真实人脸特写"],
      }, aspect)
      if (promptOverride) task.prompt = promptOverride
      const result = await runCoverImageGeneration(port, projectPath, task)
      if (result.ok) {
        // M3 生产接线：snapshot-cover run（Draft-first：产物已在 .novel/covers/ pending 区）
        await saveGenerationHistoryEntry(normalizePath(projectPath), {
          kind: "snapshot-cover",
          title: `cover-${task.fileName}`,
          results: [],
          snapshotMeta: { shape: "cover", artifactRef: `.novel/covers/${task.fileName}`, summary: result.message },
        })
      }
      setNotice(`${result.reason ?? "done"}：${result.message ?? ""}`)
    } catch (err) {
      setNotice(`${t("novel.coverGen.failed") ?? "封面生成失败"}：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRunning(false)
    }
  }, [port, projectPath, meta, aspect, promptOverride, t])

  return (
    <div className="cover-generate-card space-y-2" data-testid="cover-generate-card">
      {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
      {!port && <p className="text-xs text-amber-500">{t("novel.coverGen.noPort") ?? "未注入图像端口"}</p>}
      <Button size="sm" onClick={run} disabled={!port || !projectPath || !meta || running}>
        {running ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Image className="mr-1 h-3 w-3" />}
        {t("novel.coverGen.generate") ?? "生成封面图"}
      </Button>
    </div>
  )
}
