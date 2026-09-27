/**
 * U-波1 — EvidenceGateCard 证据链卡片（纯展示；只读派生，断网渲染）。
 *
 * 共识计划 EB-1：卡片字段 = (gate, display 三态, score, evidenceCount,
 * replayId, modelId, promptArtifact 血缘, ts)；R-04：未评估永不渲染为通过；
 * P0 阻塞语义：被 P0 阻塞时顶部显示阻塞条（而非高分高亮）。
 *
 * 数据层（buildEvidenceSnapshot）与渲染解耦：本组件为纯展示，
 * 数据由调用方（首页/列表/章节页）注入，不自行读 status（可测性）。
 *
 * @license MIT © Niko Buddy
 */

import { cn } from "@/lib/utils"
import type { EvidenceSnapshot } from "@/lib/novel"
import { useTranslation } from "react-i18next"

const DISPLAY_STYLES: Record<string, { dot: string; text: string }> = {
  pass: { dot: "bg-success", text: "text-success dark:text-success" },
  fail: { dot: "bg-destructive", text: "text-destructive dark:text-destructive" },
  not_evaluated: { dot: "bg-muted-foreground", text: "text-muted-foreground dark:text-muted-foreground" },
}

function displayClass(display: string): string {
  return DISPLAY_STYLES[display]?.dot ?? DISPLAY_STYLES.not_evaluated.dot
}

function textClass(display: string): string {
  return DISPLAY_STYLES[display]?.text ?? DISPLAY_STYLES.not_evaluated.text
}

/**
 * 三门证据卡组（P0 > P1 > P2）。blocked（任一门 fail）时渲染阻塞条：
 * 「被 P0 阻塞」而非通过率高分——未通过的门优先可见。
 */
export function EvidenceGateCards({ snapshot }: { snapshot: EvidenceSnapshot | null }) {
  const { t } = useTranslation()
  if (!snapshot) return null
  return (
    <div className="space-y-2" data-testid="evidence-gate-cards">
      {snapshot.blocked ? (
        <div
          className="rounded-md border border-destructive bg-destructive px-3 py-2 text-xs text-destructive dark:border-destructive dark:bg-destructive/30 dark:text-destructive"
          data-testid="evidence-blocked-banner"
        >
          被 P{snapshot.blockingGate === "consistency" ? "0" : snapshot.blockingGate === "anti_ai" ? "1" : "2"} 阻塞
        </div>
      ) : null}
      <ul className="grid gap-2">
        {snapshot.cards.map((card) => (
          <li
            key={card.gate}
            data-testid={`evidence-card-${card.gate}`}
            className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
          >
            <span
              aria-hidden="true"
              className={cn("h-2 w-2 shrink-0 rounded-full", displayClass(card.display))}
            />
            <span className={cn("font-medium", textClass(card.display))}>{card.label}</span>
            <span className="text-muted-foreground dark:text-muted-foreground">
              {card.gate === "consistency" ? "一致性 P0" : card.gate === "anti_ai" ? "反AI P1" : "质量 P2"}
            </span>
            {card.score !== null ? <span className="tabular-nums">{card.score}</span> : null}
            {card.promptArtifact ? (
              <span className="text-[10px] text-muted-foreground" title={card.promptArtifact}>
                {card.promptArtifact}
              </span>
            ) : null}
            {card.evidenceCount > 0 ? (
              <span className="ml-auto text-muted-foreground">证据 {card.evidenceCount}</span>
            ) : null}
            {card.replayId ? (
              <span className="text-[10px] text-muted-foreground" title={t("novel.replayable")}>
                replay
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
        <span>事件覆盖率 {Math.round(snapshot.gateEventCoverage * 100)}%</span>
        {snapshot.promptLineageRate !== null ? (
          <span>裁判血缘 {Math.round(snapshot.promptLineageRate * 100)}%</span>
        ) : null}
        {snapshot.budgetCost.tokens > 0 ? <span>token {snapshot.budgetCost.tokens}</span> : null}
      </div>
    </div>
  )
}