import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { GitMerge, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useWikiStore } from "@/stores/wiki-store"
import { loadFanficMergeProposal, proposeCanonMerge, saveFanficMergeProposal } from "@/lib/novel"
import type { CanonMergeProposal, BookAnalysisLibraryBook, BookRules } from "@/lib/novel"

/**
 * FanficMergeDialog — 同人正典合并导入器（65 号共识 G2 挂载：形态轴 F3 消费侧）。
 *
 * 边界：`proposeCanonMerge` 纯函数确定性预览（零 LLM 零 IO）；Draft-first——
 * 只落 `.novel/fanfic-merge-pending.json` pending 工件，accept 才回填正式正典
 * （正式回填通道 = 既有 formal-writeback，不开第二条正式写路径）。
 */
export interface FanficMergeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sourceBook?: BookAnalysisLibraryBook
  targetNames?: string[]
  rules?: BookRules
}

export function FanficMergeDialog({ open, onOpenChange, sourceBook, targetNames = [], rules }: FanficMergeDialogProps) {
  const { t } = useTranslation()
  const projectPath = useWikiStore((s) => s.project?.path)
  const [proposal, setProposal] = useState<CanonMergeProposal | null>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const preview = useCallback(async () => {
    if (!sourceBook) return
    setLoading(true)
    setNotice(null)
    try {
      const rulesOrDefault: BookRules = rules ?? {
        version: "1",
        prohibitions: [],
        allowedDeviations: [],
      }
      const p = proposeCanonMerge({
        source: sourceBook,
        targetNames,
        rules: rulesOrDefault,
      })
      setProposal(p)
      setNotice(
        `${p.characters.length} 角色 → bind_existing ${p.characters.filter((c) => c.action === "bind_existing").length} / create_new ${p.characters.filter((c) => c.action === "create_new").length} / skip ${p.characters.filter((c) => c.action === "skip").length}`,
      )
    } catch (err) {
      setNotice(`${t("novel.fanfic.previewFailed") ?? "预览失败"}：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }, [sourceBook, targetNames, rules, t])

  const savePending = useCallback(async () => {
    if (!proposal || !projectPath) return
    await saveFanficMergeProposal(projectPath, proposal)
    setNotice(t("novel.fanfic.pendingSaved") ?? "已保存 pending 工件（.novel/fanfic-merge-pending.json），accept 前不回填正式正典")
  }, [proposal, projectPath, t])

  const loadPending = useCallback(async () => {
    if (!projectPath) return
    const p = await loadFanficMergeProposal(projectPath)
    if (p) {
      setProposal(p)
      setNotice(t("novel.fanfic.pendingLoaded") ?? "已加载既有 pending 提案")
    } else {
      setNotice(t("novel.fanfic.noPending") ?? "无 pending 提案")
    }
  }, [projectPath, t])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="fanfic-merge-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="h-4 w-4" />
            {t("novel.fanfic.title")}
          </DialogTitle>
          <DialogDescription>
            {t("novel.fanfic.hint") ?? "确定性合并预览（重名→bind_existing / 新名→create_new / 冲突→skip），保存为 pending 草稿"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={preview} disabled={!sourceBook || loading}>
              {loading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              {t("novel.fanfic.preview") ?? "生成合并预览"}
            </Button>
            <Button size="sm" variant="outline" onClick={savePending} disabled={!proposal || !projectPath}>
              {t("novel.fanfic.savePending") ?? "保存 pending"}
            </Button>
            <Button size="sm" variant="outline" onClick={loadPending} disabled={!projectPath}>
              {t("novel.fanfic.loadPending") ?? "加载 pending"}
            </Button>
          </div>
          {proposal && (
            <div className="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
              {proposal.characters.map((c) => (
                <p key={c.sourceId} className="text-xs">
                  <span className="font-medium">{c.canonicalName}</span> → {c.action}
                  {c.aliases.length > 0 && <span className="text-muted-foreground">（{c.aliases.join(" / ")}）</span>}
                </p>
              ))}
              {proposal.conflicts.length > 0 && (
                <div className="mt-2 space-y-1 border-t pt-2">
                  {proposal.conflicts.map((cf, i) => (
                    <p key={i} className="text-xs text-amber-600">
                      ⚠ {cf.message}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
