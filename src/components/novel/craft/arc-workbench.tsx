/**
 * arc-workbench.tsx — F-06 弧光工作台
 *
 * 通过 arc-tracker 的 detectArcProgression 数据，以视觉化 stepper 展示
 * 七阶段弧光推进 + 置信度指标。
 *
 * 数据源：只读消费 T27 arc-tracker 纯算术输出，不修改上游模块。
 * 分组：与 review-center-view 子面板 tab 集成，不新增 activeView。
 */
import { useMemo, useId } from "react"
import { useTranslation } from "react-i18next"
import { CheckCircle2, Circle, ArrowRight, AlertTriangle } from "lucide-react"
import type { ArcProgressionResult, ArcProgressionInput } from "@/lib/novel/craft/arc-tracker"
import { detectArcProgression } from "@/lib/novel/craft/arc-tracker"
import { ARC_STAGE_VALUES } from "@/lib/novel/craft/canon-craft-fields"
import type { ArcStage } from "@/lib/novel/craft/canon-craft-fields"

// ============================================================================
// 中文化映射
// ============================================================================

const STAGE_LABELS: Record<ArcStage, string> = {
  ghost_exposed: "鬼魂暴露",
  refusal: "拒绝召唤",
  commitment: "承诺行动",
  active: "主动推进",
  crisis: "危机升级",
  climax: "高潮对决",
  resolution: "解决收束",
}

const STAGE_DESCRIPTIONS: Record<ArcStage, string> = {
  ghost_exposed: "主角的过去创伤或未解心结被揭示",
  refusal: "主角犹豫或回避冲突，不愿面对挑战",
  commitment: "主角做出明确承诺，接受内心渴望与需求",
  active: "主角主动推进行动，arc_fundamentals 稳步提升",
  crisis: "冲突升级，主角面临最严峻的考验",
  climax: "主角与核心冲突正面交锋，做出最终抉择",
  resolution: "弧光闭环，主角达成转变或接受结局",
}

// ============================================================================
// Props
// ============================================================================

export interface ArcWorkbenchProps {
  /** arc-tracker 输入数据（原始摄取字段）。缺省时显示空状态。 */
  input?: ArcProgressionInput | null
  /** 可选覆盖检测结果（若已外部计算）。缺省则内部调用 detectArcProgression。 */
  result?: ArcProgressionResult | null
  /** 角色名（可选，用于标题）。 */
  characterName?: string
}

// ============================================================================
// 组件
// ============================================================================

export function ArcWorkbench({ input, result, characterName }: ArcWorkbenchProps) {
  const { t } = useTranslation()
  const headingId = useId()

  // 计算或直接使用检测结果
  const progression = useMemo<ArcProgressionResult | null>(() => {
    if (result) return result
    if (input) return detectArcProgression(input)
    return null
  }, [input, result])

  if (!progression) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center text-sm text-muted-foreground">
        <Circle className="mb-2 h-8 w-8 opacity-40" aria-hidden="true" />
        <p>{t("craft.arcWorkbench.noData", "暂无弧光数据，请先摄取实体技法字段")}</p>
      </div>
    )
  }

  const currentIdx = ARC_STAGE_VALUES.indexOf(progression.currentStage)
  const confidencePct = Math.round(progression.confidence * 100)

  return (
    <div className="flex h-full flex-col gap-4 p-4" role="region" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-sm font-semibold text-foreground">
        {characterName
          ? t("craft.arcWorkbench.titleWithChar", { name: characterName, defaultValue: `弧光工作台 — ${characterName}` })
          : t("craft.arcWorkbench.title", "弧光工作台")}
      </h3>

      {/* 当前阶段与置信度 */}
      <div className="flex items-center gap-3 rounded-lg border bg-muted/20 p-3">
        <div className="flex-1">
          <div className="text-xs text-muted-foreground">
            {t("craft.arcWorkbench.currentStage", "当前阶段")}
          </div>
          <div className="mt-0.5 text-base font-bold text-foreground">
            {STAGE_LABELS[progression.currentStage]}
          </div>
          <div className="mt-1 text-[11px] leading-tight text-muted-foreground">
            {STAGE_DESCRIPTIONS[progression.currentStage]}
          </div>
        </div>
        <div className="flex flex-col items-center gap-1">
          <div
            className="flex h-14 w-14 items-center justify-center rounded-full text-sm font-bold"
            style={{
              background: `conic-gradient(var(--primary) ${confidencePct}%, var(--muted) ${confidencePct}% 100%)`,
            }}
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-background text-foreground">
              {confidencePct}%
            </span>
          </div>
          <span className="text-[10px] text-muted-foreground">
            {t("craft.arcWorkbench.confidence", "置信度")}
          </span>
        </div>
      </div>

      {/* 是否推进 */}
      {progression.progressed && (
        <div className="flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-primary">
          <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            {t("craft.arcWorkbench.progressed", {
              from: STAGE_LABELS[progression.previousStage ?? "ghost_exposed"],
              to: STAGE_LABELS[progression.currentStage],
              defaultValue: `阶段推进：${STAGE_LABELS[progression.previousStage ?? "ghost_exposed"]} → ${STAGE_LABELS[progression.currentStage]}`,
            })}
          </span>
        </div>
      )}

      {/* 七阶段 stepper */}
      <div className="flex-1 overflow-y-auto">
        <div className="relative flex flex-col gap-0">
          {ARC_STAGE_VALUES.map((stage, idx) => {
            const isCurrent = idx === currentIdx
            const isPast = idx < currentIdx
            const isFuture = idx > currentIdx
            const isActive = isCurrent || isPast

            return (
              <div key={stage} className="flex items-start gap-3">
                {/* 连接线 + 图标 */}
                <div className="flex flex-col items-center">
                  <div
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                      isPast
                        ? "bg-primary text-primary-foreground"
                        : isCurrent
                          ? "border-2 border-primary bg-primary/10 text-primary"
                          : "border border-muted-foreground/30 bg-muted/20 text-muted-foreground/50"
                    }`}
                  >
                    {isPast ? (
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    ) : isCurrent ? (
                      <Circle className="h-3 w-3 fill-primary" aria-hidden="true" />
                    ) : (
                      <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
                    )}
                  </div>
                  {idx < ARC_STAGE_VALUES.length - 1 && (
                    <div
                      className={`my-0.5 h-6 w-px ${
                        isPast ? "bg-primary" : "bg-muted-foreground/20"
                      }`}
                    />
                  )}
                </div>

                {/* 阶段标签 */}
                <div className={`min-w-0 pb-4 ${isFuture ? "opacity-40" : ""}`}>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs font-medium ${
                        isActive ? "text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {STAGE_LABELS[stage]}
                    </span>
                    {isCurrent && (
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        {t("craft.arcWorkbench.current", "当前")}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                    {STAGE_DESCRIPTIONS[stage]}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 推进理由 */}
      <div className="rounded-md border bg-muted/10 p-2.5">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-[10px] font-medium text-muted-foreground">
              {t("craft.arcWorkbench.reason", "检测依据")}
            </div>
            <p className="mt-0.5 text-xs leading-relaxed text-foreground">
              {progression.reason}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}