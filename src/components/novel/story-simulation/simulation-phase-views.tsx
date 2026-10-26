import { useTranslation } from "react-i18next";

import type { NovelAgent, RumorEvent, SimulationDebugTrace, SimulationReport, StoryBranch, TimelineEvent } from "@/lib/novel";
import { actionTypeIcon, actionTypeShortLabel } from "@/lib/novel";

import { ProcessDebugPanel } from "./simulation-debug-panels";
import { SimulationReportView } from "./simulation-report-view";
import { StoryDraftView } from "./story-draft-view";
import { RumorPropagationPanel } from "./rumor-propagation-panel";
import { ClueTimelinePanel } from "./detective-board-panel";

/** 报告阶段 Tab（与 StorySimulationView 内 reportViewTab 状态同构）。 */
export type ReportViewTab = "report" | "timeline" | "overview" | "rumors" | "clues";

/** 草稿阶段 Tab（与 StorySimulationView 内 draftViewTab 状态同构）。 */
export type DraftViewTab = "draft" | "report" | "timeline" | "overview" | "rumors" | "clues";

/** 0-100 人设一致性评分 → CSS 条宽（钳制越界与 NaN）。 */
export function scoreBarWidth(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, Math.round(score)));
}

/** 推演报告分支概率 → 条宽映射。 */
export function branchProbabilityWidth(p: StoryBranch["probability"]): number {
  return p === "high" ? 100 : p === "medium" ? 60 : 30;
}

export interface ReportPhaseCenterProps {
  tab: ReportViewTab;
  onTabChange: (tab: ReportViewTab) => void;
  currentReport: SimulationReport | null;
  timelineEvents: TimelineEvent[];
  debugTraces: SimulationDebugTrace[];
  currentRumors: RumorEvent[];
  currentAgents: Map<string, NovelAgent>;
  hasDraft: boolean;
  onResimulate: () => void;
  onGenerateDraft: (branch: StoryBranch) => void;
  onInterviewAgent: (agentId: string, agentName: string) => void;
  onViewDraft: () => void;
  onViewInterviewHistory: () => void;
  onExtractConflictsToDraft: () => void;
}

/**
 * 报告阶段中央列：Tab 条 + 各 Tab 内容体（报告/时间线/概览/传闻/线索）。
 * 纯展示组件：数据与回调全由 props 注入，不订阅 store。
 */
export function ReportPhaseCenter({
  tab,
  onTabChange,
  currentReport,
  timelineEvents,
  debugTraces,
  currentRumors,
  currentAgents,
  hasDraft,
  onResimulate,
  onGenerateDraft,
  onInterviewAgent,
  onViewDraft,
  onViewInterviewHistory,
  onExtractConflictsToDraft,
}: ReportPhaseCenterProps) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b px-3 py-2">
        <div className="inline-flex flex-wrap rounded-md border bg-muted/40 p-0.5 text-xs">
          <button
            type="button"
            className={`rounded px-3 py-1.5 ${
              tab === "report"
                ? "bg-background text-foreground elevation-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => onTabChange("report")}
          >
            推演报告
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1.5 ${
              tab === "timeline"
                ? "bg-background text-foreground elevation-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => onTabChange("timeline")}
          >
            时间线
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1.5 ${
              tab === "overview"
                ? "bg-background text-foreground elevation-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => onTabChange("overview")}
          >
            概览
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1.5 ${
              tab === "rumors"
                ? "bg-background text-foreground elevation-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => onTabChange("rumors")}
          >
            传闻
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1.5 ${
              tab === "clues"
                ? "bg-background text-foreground elevation-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => onTabChange("clues")}
          >
            线索
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === "report" ? (
          <>
            {currentReport && currentReport.characterAnalyses.length > 0 && (
              <div className="shrink-0 border-b px-3 py-2" data-testid="sim-score-overview">
                <div className="mb-1 text-xs font-medium">人设一致性评分</div>
                <div className="space-y-1">
                  {currentReport.characterAnalyses.map((ca) => (
                    <div key={ca.characterId} className="flex items-center gap-2 text-xs">
                      <span className="w-16 shrink-0 truncate">{ca.name}</span>
                      <div className="h-2 min-w-0 flex-1 rounded bg-muted">
                        <div
                          className="h-2 rounded bg-primary"
                          data-testid={`sim-score-bar-${ca.characterId}`}
                          style={{ width: `${scoreBarWidth(ca.consistencyScore)}%` }}
                        />
                      </div>
                      <span className="w-8 shrink-0 text-right tabular-nums">{ca.consistencyScore}</span>
                    </div>
                  ))}
                </div>
                {currentReport.branches.length > 0 && (
                  <div className="mt-2">
                    <div className="mb-1 text-xs font-medium">分支走向概率</div>
                    <div className="space-y-1">
                      {currentReport.branches.map((b, i) => (
                        <div key={`${b.title.slice(0, 32)}-${i}`} className="flex items-center gap-2 text-xs">
                          <span className="w-16 shrink-0 truncate">{b.title}</span>
                          <div className="h-2 min-w-0 flex-1 rounded bg-muted">
                            <div
                              className="h-2 rounded bg-primary"
                              data-testid={`sim-branch-bar-${i}`}
                              style={{ width: `${branchProbabilityWidth(b.probability)}%` }}
                            />
                          </div>
                          <span className="w-8 shrink-0 text-right tabular-nums">{b.probability}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
            <SimulationReportView
            onResimulate={onResimulate}
            onGenerateDraft={(branch) =>
              void onGenerateDraft(branch)
            }
            onInterviewAgent={(id, name) =>
              onInterviewAgent(id, name)
            }
            onViewDraft={onViewDraft}
            hasDraft={hasDraft}
            onViewInterviewHistory={onViewInterviewHistory}
            />
            </div>
          </>
        ) : tab === "timeline" ? (
          <div className="h-full overflow-y-auto p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                共 {timelineEvents.length} 条事件
              </span>
              <button
                type="button"
                data-testid="sim-extract-conflicts"
                className="rounded border px-2 py-1 text-xs hover:bg-muted"
                onClick={onExtractConflictsToDraft}
              >
                一键提取冲突动作到草稿
              </button>
            </div>
            <div className="space-y-2">
              {timelineEvents.map((ev) => (
                <div
                  key={ev.id}
                  className="rounded-md border bg-background/70 p-3 text-sm"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
                      节点{ev.nodeIndex + 1} · 第{ev.round}轮
                    </span>
                    <span className="text-muted-foreground">
                      {ev.actorName || t("storySimulation.system")}
                    </span>
                    <span className="text-muted-foreground">·</span>
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      {(() => {
                        const Icon = actionTypeIcon(ev.actionType);
                        return <Icon className="h-3 w-3" />;
                      })()}
                      {actionTypeShortLabel(ev.actionType)}
                    </span>
                  </div>
                  <div className="text-sm">
                    {ev.content || t("storySimulation.noContent")}
                  </div>
                </div>
              ))}
              {timelineEvents.length === 0 && (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  暂无事件
                </div>
              )}
            </div>
          </div>
        ) : tab === "overview" ? (
          <div className="h-full overflow-hidden">
            <ProcessDebugPanel debugTraces={debugTraces} />
          </div>
        ) : tab === "rumors" ? (
          <div className="h-full">
            <RumorPropagationPanel
              rumors={currentRumors}
              agents={currentAgents}
              events={timelineEvents}
            />
          </div>
        ) : (
          <div className="h-full">
            <ClueTimelinePanel
              agents={currentAgents}
              rumors={currentRumors}
              events={timelineEvents}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export interface DraftPhaseViewProps {
  tab: DraftViewTab;
  onTabChange: (tab: DraftViewTab) => void;
  timelineEvents: TimelineEvent[];
  debugTraces: SimulationDebugTrace[];
  currentRumors: RumorEvent[];
  currentAgents: Map<string, NovelAgent>;
  hasDraft: boolean;
  onBack: () => void;
  onResimulate: () => void;
  onGenerateDraft: (branch: StoryBranch) => void;
  onInterviewAgent: (agentId: string, agentName: string) => void;
  onViewDraft: () => void;
  onViewInterviewHistory: () => void;
}

/**
 * 草稿阶段整列：Tab 条 + 各 Tab 内容体（草稿/报告/时间线/过程观察/传闻/线索）。
 * 纯展示组件：数据与回调全由 props 注入，不订阅 store。
 */
export function DraftPhaseView({
  tab,
  onTabChange,
  timelineEvents,
  debugTraces,
  currentRumors,
  currentAgents,
  hasDraft,
  onBack,
  onResimulate,
  onGenerateDraft,
  onInterviewAgent,
  onViewDraft,
  onViewInterviewHistory,
}: DraftPhaseViewProps) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b px-3 py-2">
        <div className="inline-flex flex-wrap rounded-md border bg-muted/40 p-0.5 text-xs">
          <button
            type="button"
            className={`rounded px-3 py-1.5 ${
              tab === "draft"
                ? "bg-background text-foreground elevation-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => onTabChange("draft")}
          >
            故事草稿
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1.5 ${
              tab === "report"
                ? "bg-background text-foreground elevation-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => onTabChange("report")}
          >
            推演报告
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1.5 ${
              tab === "timeline"
                ? "bg-background text-foreground elevation-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => onTabChange("timeline")}
          >
            时间线
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1.5 ${
              tab === "overview"
                ? "bg-background text-foreground elevation-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => onTabChange("overview")}
          >
            过程观察
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1.5 ${
              tab === "rumors"
                ? "bg-background text-foreground elevation-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => onTabChange("rumors")}
          >
            传闻
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1.5 ${
              tab === "clues"
                ? "bg-background text-foreground elevation-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => onTabChange("clues")}
          >
            线索
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "draft" ? (
          <StoryDraftView onBack={onBack} />
        ) : tab === "report" ? (
          <SimulationReportView
            onResimulate={onResimulate}
            onGenerateDraft={(branch) => void onGenerateDraft(branch)}
            onInterviewAgent={(id, name) =>
              onInterviewAgent(id, name)
            }
            onViewDraft={onViewDraft}
            hasDraft={hasDraft}
            onViewInterviewHistory={onViewInterviewHistory}
          />
        ) : tab === "timeline" ? (
          <div className="h-full overflow-y-auto p-3">
            <div className="mb-2 text-xs text-muted-foreground">
              共 {timelineEvents.length} 条事件
            </div>
            <div className="space-y-2">
              {timelineEvents.map((ev) => (
                <div
                  key={ev.id}
                  className="rounded-md border bg-background/70 p-3 text-sm"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
                      节点{ev.nodeIndex + 1} · 第{ev.round}轮
                    </span>
                    <span className="text-muted-foreground">
                      {ev.actorName || t("storySimulation.system")}
                    </span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">
                      {actionTypeShortLabel(ev.actionType)}
                    </span>
                  </div>
                  <div className="text-sm">
                    {ev.content || t("storySimulation.noContent")}
                  </div>
                </div>
              ))}
              {timelineEvents.length === 0 && (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  暂无事件
                </div>
              )}
            </div>
          </div>
        ) : tab === "overview" ? (
          <div className="h-full overflow-hidden">
            <ProcessDebugPanel debugTraces={debugTraces} />
          </div>
        ) : tab === "rumors" ? (
          <div className="h-full">
            <RumorPropagationPanel
              rumors={currentRumors}
              agents={currentAgents}
              events={timelineEvents}
            />
          </div>
        ) : (
          <div className="h-full">
            <ClueTimelinePanel
              agents={currentAgents}
              rumors={currentRumors}
              events={timelineEvents}
            />
          </div>
        )}
      </div>
    </div>
  );
}
