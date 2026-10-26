/**
 * 大纲域覆盖层（Q15-preview-split：从 preview-panel 抽出的纯展示块）。
 *
 * 零逻辑：不读 store、不发请求、不持状态；显隐与数据全部由调用方注入。
 * 原 preview-panel.tsx 内联的大纲快照 Suspense 块 + UnpackOutlineDialog，
 * 逐行搬移至此，行为不变。
 */
import { Suspense, lazy } from "react"
import { UnpackOutlineDialog } from "@/components/novel/unpack-outline-dialog"

const SnapshotViewer = lazy(async () => {
  const mod = await import("@/components/novel/snapshot-viewer")
  return { default: mod.SnapshotViewer }
})

export interface PreviewOutlineOverlaysProps {
  showOutlineSnapshot: boolean
  /** 调用方 project.path；null 时快照块不渲染（与原 `&& project` 等价）。 */
  projectPath: string | null
  outlineSnapshotNumber: number | null
  unpackOpen: boolean
  onUnpackOpenChange: (open: boolean) => void
  outlineContent: string
  onCloseOutlineSnapshot: () => void
  t: (key: string) => string
}

export function PreviewOutlineOverlays({
  showOutlineSnapshot,
  projectPath,
  outlineSnapshotNumber,
  unpackOpen,
  onUnpackOpenChange,
  outlineContent,
  onCloseOutlineSnapshot,
  t,
}: PreviewOutlineOverlaysProps) {
  return (
    <>
      {showOutlineSnapshot && projectPath && outlineSnapshotNumber !== null ? (
        <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("common.loading")}</div>}>
          <SnapshotViewer
            projectPath={projectPath}
            chapterNumber={outlineSnapshotNumber}
            onClose={onCloseOutlineSnapshot}
          />
        </Suspense>
      ) : null}
      <UnpackOutlineDialog
        open={unpackOpen}
        onOpenChange={onUnpackOpenChange}
        outlineContent={outlineContent}
      />
    </>
  )
}
