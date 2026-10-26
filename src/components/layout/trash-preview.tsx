/**
 * 回收站条目预览（Q15-preview-split 第一步：从 preview-panel 抽出的纯展示块）。
 *
 * 零逻辑：不读 store、不发请求、不持状态；全部数据与回调由调用方注入。
 * 抽取目的是把 preview-panel.tsx 的早返回分支从渲染壳里移出，行为不变。
 */
import { X } from "lucide-react"

import { FilePreview } from "@/components/editor/file-preview"
import { WikiReader } from "@/components/editor/wiki-reader"
import type { TrashItem } from "@/lib/trash"

export interface TrashPreviewProps {
  item: TrashItem
  /** 已按分类处理过的正文（markdown 取 frontmatter 之后的 body）。 */
  body: string
  /** 原始文件内容，供非 markdown 预览使用。 */
  fileContent: string
  category: string
  restoring: boolean
  canRestore: boolean
  onRestore: () => void
  onClose: () => void
  t: (key: string, options?: { defaultValue?: string }) => string
}

export function TrashPreview({
  item,
  body,
  fileContent,
  category,
  restoring,
  canRestore,
  onRestore,
  onClose,
  t,
}: TrashPreviewProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-3 py-2 bg-warning dark:bg-warning/30">
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1">
            <div className="flex flex-col min-w-0 flex-1">
              <div className="text-sm font-medium">要留下这条，点恢复</div>
              <div className="text-sm font-medium truncate min-w-0">{item.name}</div>
              <div className="text-xs text-muted-foreground truncate min-w-0">
                {t("trash.deletedItem", { defaultValue: "已删除项目" })} ·{" "}
                {item.kind === "chapter"
                  ? t("trash.kindChapter", { defaultValue: "章节" })
                  : item.kind === "outline"
                    ? t("trash.kindOutline", { defaultValue: "大纲" })
                    : item.kind === "history"
                      ? t("trash.kindHistory", { defaultValue: "历史记录" })
                      : t("trash.kindPage", { defaultValue: "页面" })}
              </div>
              <div className="text-xs text-muted-foreground truncate min-w-0">
                {t("trash.originalPath", { defaultValue: "原路径" })}: {item.originalPath}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onRestore}
            disabled={restoring || !canRestore}
            className="shrink-0 rounded border px-2 py-1 text-xs"
          >
            {restoring ? "正在恢复" : "恢复"}
          </button>
          <button
            onClick={onClose}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
            title={t("preview.close", { defaultValue: "关闭预览" })}
          >
            <X className="h-3.5 w-3.5 shrink-0" />
          </button>
        </div>
      </div>
      <div className="flex-1 min-w-0 overflow-auto">
        {category === "markdown" ? (
          <WikiReader body={body} />
        ) : (
          <FilePreview filePath={item.originalPath} textContent={fileContent} />
        )}
      </div>
    </div>
  )
}
