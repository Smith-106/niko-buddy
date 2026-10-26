/**
 * 人物域覆盖层（Q15-preview-split：从 preview-panel 抽出的纯展示块）。
 *
 * 零逻辑：不读 store、不发请求、不持状态；显隐与数据全部由调用方注入。
 * 原 preview-panel.tsx 内联的 showCognition / showPersona 两个 absolute 遮罩，
 * 逐行搬移至此，行为不变（含 Esc 关闭仍由调用方 effect 负责）。
 */
import { CognitionPanel } from "@/components/novel/cognition-panel"
import { PersonaCritiquePanel } from "@/components/novel/persona-critique-panel"

export interface PreviewCognitionOverlaysProps {
  showCognition: boolean
  showPersona: boolean
  /** 调用方 project.path；null 时两个遮罩均不渲染（与原 `&& project` 等价）。 */
  projectPath: string | null
  onCloseCognition: () => void
  onClosePersona: () => void
  t: (key: string) => string
}

export function PreviewCognitionOverlays({
  showCognition,
  showPersona,
  projectPath,
  onCloseCognition,
  onClosePersona,
  t,
}: PreviewCognitionOverlaysProps) {
  return (
    <>
      {showCognition && projectPath ? (
        <div className="absolute inset-0 z-20 bg-background" role="dialog" aria-modal="true" aria-label={t("preview.cognitionTitle")}>
          <CognitionPanel
            projectPath={projectPath}
            onClose={onCloseCognition}
          />
        </div>
      ) : null}
      {showPersona && projectPath ? (
        <div className="absolute inset-0 z-20 bg-background" role="dialog" aria-modal="true" aria-label={t("novel.persona.title")}>
          <PersonaCritiquePanel
            projectPath={projectPath}
            onClose={onClosePersona}
          />
        </div>
      ) : null}
    </>
  )
}
