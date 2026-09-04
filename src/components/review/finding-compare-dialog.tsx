import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { MonacoDiffEditor } from "@/components/novel/monaco-diff-editor"
import {
  generateReviewRewriteEdits,
  type ReviewRewriteEdit,
  type ReviewRewriteIssue,
} from "@/lib/review-rewrite-plan"
import {
  acceptFindingRewriteDraft,
  rejectFindingRewriteDraft,
  writeFindingRewriteDraft,
} from "@/lib/novel/novel-session-status"
import { reviewChapter, type NovelReviewResult } from "@/lib/novel/review-adapter"
import { applyReviewRewriteEditsToMarkdown } from "@/lib/review-rewrite-plan"
import { writeFileAtomic, readFile } from "@/commands/fs"
import type { NovelReviewActionItem } from "@/lib/novel-review-action-items"
import type { LlmConfig } from "@/stores/wiki-store"

export interface FindingCompareDialogProps {
  open: boolean
  finding: NovelReviewActionItem
  chapterContent: string
  llmConfig: LlmConfig
  targetOriginalText?: string
  /** TASK-007 草稿持久化需要（draft artifact 路径 + 状态机 key） */
  projectPath: string
  sessionId: string
  onClose: () => void
  onAccept: () => void
  onReject: () => void
}

/**
 * review finding → LLM 段落改写 → Monaco diff 对比面板（RPC-2 / TASK-006，E3 review 入口 D2/X2）。
 *
 * finding prop 直用 NovelReviewActionItem（evidence/secondaryEvidence/suggestion 字段自带，
 * 不转 NovelReviewResult / 不用 toNovelReviewResult），llmConfig 用 LlmConfig 命名类型（非
 * Parameters<typeof streamChat> 位置耦合）。accept/reject 经 TASK-007 Draft-first 草稿
 * 状态机（write/accept/reject FindingRewriteDraft）闭合，TASK-008 在 accept 前插入门控回检。
 */
export function FindingCompareDialog({
  open,
  finding,
  chapterContent,
  llmConfig,
  targetOriginalText,
  projectPath,
  sessionId,
  onClose,
  onAccept,
  onReject,
}: FindingCompareDialogProps) {
  const [edits, setEdits] = useState<ReviewRewriteEdit[]>([])
  const [loading, setLoading] = useState(false)
  const [modifiedText, setModifiedText] = useState("")
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [gateChecking, setGateChecking] = useState(false)
  const [gateErrors, setGateErrors] = useState<NovelReviewResult[] | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setErrorMsg(null)

    const issue: ReviewRewriteIssue = {
      message: finding.message,
      suggestion: finding.suggestion,
      evidence: finding.evidence,
      secondaryEvidence: finding.secondaryEvidence,
      chapterContent,
    }

    generateReviewRewriteEdits(issue, chapterContent, llmConfig, {
      targetOriginalText,
    })
      .then((eds) => {
        if (cancelled) return
        setEdits(eds)
        setModifiedText(eds[0]?.replacementText ?? "")
        if (eds.length === 0) {
          setErrorMsg("未在正文中定位到证据片段，请手动选择原文后重试")
        } else {
          // TASK-007: 生成成功后暂存 pending draft（Draft-first，不污染正式正文）
          void writeFindingRewriteDraft(projectPath, sessionId, {
            chapterId: finding.targetPath,
            originalText: eds[0].originalText,
            replacementText: eds[0].replacementText,
            findingId: finding.id,
          }).catch((error: unknown) => {
            if (!cancelled) {
              setErrorMsg(error instanceof Error ? error.message : String(error))
            }
          })
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setErrorMsg(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, finding, chapterContent, llmConfig, targetOriginalText, projectPath, sessionId])

  const handleAccept = async () => {
    // TASK-008: 门控回检 — 改写片段回填前 MUST 再过 reviewChapter
    // 跑 Consistency(continuity-engine preflight)+Anti-AI(slopScore)+LLM，
    // filter severity='error' 阻断 (HARD-3: 任意 severity='error' 即 block)
    setGateChecking(true)
    setGateErrors(null)
    try {
      const finalEdits = edits.map((edit, index) =>
        index === 0 ? { ...edit, replacementText: modifiedText } : edit,
      )
      // 56 号 review-1 P0：写回前 MUST 重读 targetPath 最新内容（对话框 chapterContent
      // 是打开时快照，多 finding 连续接受会丢失先前改写；且 fileContent 可能 ≠ targetPath）
      const latestContent = await readFile(finding.targetPath).catch(() => null)
      if (latestContent === null) {
        setErrorMsg("rewrite.readTargetFailed")
        setGateChecking(false)
        return
      }
      const rewritten = applyReviewRewriteEditsToMarkdown(latestContent, finalEdits)
      // 56 号 P0-1 伴生修复：锚点部分失败（rewritten.ok=false）时不得进门控/写回
      if (!rewritten.ok) {
        setGateErrors([
          {
            severity: "error",
            type: "rewrite-apply",
            message: "rewrite.applyFailed",
            evidence: "",
            relatedMemory: "",
            suggestion: "",
            detail: `anchors: ${rewritten.failed.length} failed`,
          } as NovelReviewResult,
        ])
        setGateChecking(false)
        return
      }

      const results = await reviewChapter(projectPath, rewritten.markdown, undefined, {}, undefined)
      const blocking = results.filter((r) => r.severity === "error")
      if (blocking.length > 0) {
        setGateErrors(blocking)
        setGateChecking(false)
        return
      }

      // 56 号 P0-1：门控通过后 MUST 将改写结果写回章节文件（targetPath），
      // 再落 draft_status=accepted；写回失败则提示且不置 accepted（草稿可重试）
      try {
        await writeFileAtomic(finding.targetPath, rewritten.markdown)
      } catch (writeError: unknown) {
        setErrorMsg(
          writeError instanceof Error ? writeError.message : String(writeError),
        )
        setGateChecking(false)
        return
      }

      await acceptFindingRewriteDraft(projectPath, sessionId)
      onAccept()
    } catch (error: unknown) {
      setErrorMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setGateChecking(false)
    }
  }

  const handleReject = async () => {
    await rejectFindingRewriteDraft(projectPath, sessionId)
    onReject()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>对比改写</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            生成改写中…
          </div>
        ) : errorMsg ? (
          <div className="py-10 text-center text-sm text-destructive">
            {errorMsg}
          </div>
        ) : edits.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            暂无改写建议
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <MonacoDiffEditor
              original={edits[0]?.originalText ?? ""}
              modified={modifiedText}
              height={480}
              onModifiedChange={setModifiedText}
            />
          </div>
        )}

        {gateErrors && gateErrors.length > 0 && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <div className="font-medium text-destructive mb-2">
              改写后的内容未通过门控回检（{gateErrors.length} 个阻断问题）：
            </div>
            <ul className="list-disc pl-4 space-y-1 text-destructive/80">
              {gateErrors.map((err, i) => (
                <li key={i}>{err.message}</li>
              ))}
            </ul>
            <div className="mt-2 text-muted-foreground">
              请修改改写内容后重试，或选择拒绝该改写。
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button variant="outline" onClick={handleReject}>拒绝</Button>
          <Button
            disabled={edits.length === 0 || gateChecking}
            onClick={handleAccept}
          >
            {gateChecking ? "门控回检中…" : "接受改写"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
