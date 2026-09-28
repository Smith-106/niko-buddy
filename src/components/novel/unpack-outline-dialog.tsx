// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import { useMemo, useState } from "react"
import { FileStack, Check, AlertCircle, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { toast } from "@/lib/toast"
import {
  parseOutlineToChapters,
  unpackOutlineToChapterFiles,
  type UnpackOutlineResult,
} from "@/lib/novel"

interface UnpackOutlineDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  outlineContent: string
  onSuccess?: (result: UnpackOutlineResult) => void
}

export function UnpackOutlineDialog({
  open,
  onOpenChange,
  outlineContent,
  onSuccess,
}: UnpackOutlineDialogProps) {
  const project = useWikiStore((s) => s.project)
  const setFileTree = useWikiStore((s) => s.setFileTree)

  const [overwriteExisting, setOverwriteExisting] = useState(false)
  const [isUnpacking, setIsUnpacking] = useState(false)

  const chapters = useMemo(() => {
    return parseOutlineToChapters(outlineContent)
  }, [outlineContent])

  async function handleConfirm() {
    if (!project || chapters.length === 0) return
    setIsUnpacking(true)
    try {
      const result = await unpackOutlineToChapterFiles({
        projectPath: project.path,
        outlineContent,
        overwriteExisting,
      })

      // 刷新项目文件树，确保左侧章节树即时显示
      try {
        const tree = await listDirectory(normalizePath(project.path))
        setFileTree(tree)
      } catch (e) {
        console.warn("刷新文件树失败:", e)
      }

      toast.success(
        `大纲解构完成！成功创建 ${result.createdCount} 个章节骨架${
          result.skippedCount > 0 ? `，跳过 ${result.skippedCount} 个已存在章节` : ""
        }`,
      )
      onSuccess?.(result)
      onOpenChange(false)
    } catch (err) {
      toast.error(`铺排章节失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsUnpacking(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] flex flex-col p-6">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <FileStack className="h-5 w-5 text-primary" />
            <DialogTitle>大纲自动解构分发器</DialogTitle>
          </div>
          <DialogDescription>
            从大纲文本中智能解析出章节结构，自动在 <code>wiki/chapters/</code> 批量生成对应章节的空白草稿骨架。
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex flex-col gap-3 py-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
            <span>
              已识别章节：<strong className="text-foreground">{chapters.length}</strong> 章
            </span>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={overwriteExisting}
                onChange={(e) => setOverwriteExisting(e.target.checked)}
                className="rounded border-border text-primary focus:ring-primary"
              />
              <span>覆盖已存在的同名章节</span>
            </label>
          </div>

          {chapters.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-8 border rounded-lg bg-muted/20 text-center gap-2">
              <AlertCircle className="h-8 w-8 text-amber-500/80" />
              <div className="text-sm font-medium">未能在大纲中识别出章节标题</div>
              <p className="text-xs text-muted-foreground max-w-sm">
                请确保大纲包含类似 <code>## 第1章 标题</code>、<code>### 第十二回 标题</code> 或 <code>Chapter 1</code> 格式的章节划分。
              </p>
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto border rounded-lg divide-y bg-background/50">
              {chapters.map((ch) => (
                <div key={ch.chapterNumber} className="p-3 text-xs flex flex-col gap-1 hover:bg-muted/30">
                  <div className="flex items-center justify-between font-medium text-foreground">
                    <span>
                      第 {ch.chapterNumber} 章 · {ch.title}
                    </span>
                    <span className="text-muted-foreground font-mono text-[11px]">
                      chapter-{String(ch.chapterNumber).padStart(3, "0")}.md
                    </span>
                  </div>
                  {ch.summary ? (
                    <p className="text-muted-foreground line-clamp-2 leading-relaxed">
                      {ch.summary}
                    </p>
                  ) : (
                    <span className="text-muted-foreground/60 italic">（无细纲摘要）</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isUnpacking}>
            取消
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={chapters.length === 0 || isUnpacking}
            className="gap-1.5"
          >
            {isUnpacking ? (
              <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            ) : (
              <Check className="h-4 w-4 shrink-0" />
            )}
            {isUnpacking ? "正在铺排..." : `确认铺排 ${chapters.length} 个章节`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
