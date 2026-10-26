import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useStorySimulationStore } from "@/stores/story-simulation-store";
import { actionTypePhrase, actionTypePhraseOnly, actionTypeShortLabel } from "@/lib/novel"
import type { SimulationDebugTrace, StoryFramework, TimelineEvent } from "@/lib/novel"
import { RumorPropagationPanel } from "./rumor-propagation-panel";
import { ClueTimelinePanel } from "./detective-board-panel";
import { BranchManagerPanel } from "./branch-manager-panel";
import { MultiPovMeshPanel } from "./multi-pov-mesh-panel";
import { Button } from "@/components/ui/button";

export const PROGRESS_PHASES = [
  "extracting",
  "framework-generating",
  "simulating",
  "report-generating",
  "draft-generating",
] as const;

/** 仿真中面板：进度条 + 实时时间线事件流（按节点分组折叠，带筛选）。 */
export function SimulatingTimelinePanel({
  progress,
  label,
  events,
  debugTraces,
  framework,
  onInterviewAgent,
  onCancel,
  cancelling,
  branches,
  activeBranchId,
  compareBranchIds,
  isCompareMode,
  onSaveBranch,
  onDeleteBranch,
  onRenameBranch,
  onSwitchBranch,
  onToggleCompareBranch,
  onSetCompareMode,
  onClearCompareSelection,
}: {
  progress: number;
  label: string;
  events: TimelineEvent[];
  debugTraces: SimulationDebugTrace[];
  framework?: StoryFramework | null;
  onInterviewAgent?: (agentId: string, agentName: string) => void;
  onCancel?: () => void;
  cancelling?: boolean;
  branches: import("@/lib/novel/story-simulation/types").SimulationBranch[];
  activeBranchId: string | null;
  compareBranchIds: string[];
  isCompareMode: boolean;
  onSaveBranch: (name: string) => void;
  onDeleteBranch: (id: string) => void;
  onRenameBranch: (id: string, name: string) => void;
  onSwitchBranch: (id: string) => void;
  onToggleCompareBranch: (branchId: string) => void;
  onSetCompareMode: (enabled: boolean) => void;
  onClearCompareSelection: () => void;
}) {
  const { t } = useTranslation()
  const clamped = Math.min(100, Math.max(0, progress));
  const logRef = useRef<HTMLDivElement | null>(null);
  const [activeStreamView, setActiveStreamView] = useState<
    "timeline" | "overview" | "rumors" | "clues" | "branches" | "multi-pov-mesh"
  >("timeline");

  const currentRumors = useStorySimulationStore((s) => s.currentRumors);
  const currentAgents = useStorySimulationStore((s) => s.currentAgents);
  const timelineEvents = useStorySimulationStore((s) => s.timelineEvents);

  // 筛选状态
  const [filterActor, setFilterActor] = useState<string>("all");
  const [filterType, setFilterType] = useState<string>("all");
  // 折叠状态：key = nodeIndex，value = 是否折叠
  const [collapsedNodes, setCollapsedNodes] = useState<Set<number>>(new Set());

  // 从事件中提取所有角色和行动类型
  const actors = useMemo(
    () => Array.from(new Set(events.map((e) => e.actorName))).sort(),
    [events],
  );
  const actionTypes = useMemo(
    () => Array.from(new Set(events.map((e) => e.actionType))).sort(),
    [events],
  );

  // 构建节点索引映射
  const nodeMap = useMemo(() => {
    const map = new Map<number, { title: string; phase: string }>();
    if (framework) {
      for (const node of framework.nodes) {
        map.set(node.index, { title: node.title, phase: node.phase });
      }
    }
    return map;
  }, [framework]);

  // 阶段中文标签
  const phaseLabel = (phase: string): string => {
    const map: Record<string, string> = {
      起: "起",
      承: "承",
      转: "转",
      合: "合",
    };
    return map[phase] || phase;
  };

  // 按节点分组事件
  const groupedEvents = useMemo(() => {
    // 先过滤事件
    const filtered = events.filter((e) => {
      if (filterActor !== "all" && e.actorName !== filterActor) return false;
      if (filterType !== "all" && e.actionType !== filterType) return false;
      return true;
    });
    // 按 nodeIndex 分组
    const groups = new Map<number, TimelineEvent[]>();
    for (const ev of filtered) {
      const idx = ev.nodeIndex;
      if (!groups.has(idx)) groups.set(idx, []);
      groups.get(idx)!.push(ev);
    }
    // 按节点索引排序
    return Array.from(groups.entries())
      .sort(([a], [b]) => a - b)
      .map(([nodeIndex, evs]) => ({
        nodeIndex,
        nodeInfo: nodeMap.get(nodeIndex),
        events: evs,
      }));
  }, [events, filterActor, filterType, nodeMap]);

  // 计算过滤后的事件总数
  const totalFiltered = groupedEvents.reduce(
    (sum, g) => sum + g.events.length,
    0,
  );

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [totalFiltered]);

  const toggleNode = (idx: number) => {
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  const expandAll = () => setCollapsedNodes(new Set());
  const collapseAll = () => {
    const allNodes = new Set(groupedEvents.map((g) => g.nodeIndex));
    setCollapsedNodes(allNodes);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <div className="mb-4 flex flex-col items-center gap-2">
        <div className="text-base font-medium">{label}</div>
        <div className="h-2 w-64 max-w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${clamped}%` }}
          />
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-muted-foreground">{clamped}%</div>
          {onCancel && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={cancelling}
              className="h-7 text-xs"
            >
              {cancelling ? t("storySimulation.cancelling") : "取消推演"}
            </Button>
          )}
        </div>
      </div>

      <div className="mb-3 flex justify-center">
        <div className="inline-flex flex-wrap rounded-md border bg-muted/40 p-0.5 text-xs">
          <button
            type="button"
            className={`rounded px-3 py-1.5 ${
              activeStreamView === "timeline"
                ? "bg-background text-foreground elevation-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setActiveStreamView("timeline")}
          >
            时间线
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1.5 ${
              activeStreamView === "overview"
                ? "bg-background text-foreground elevation-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setActiveStreamView("overview")}
          >
            过程观察
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1.5 ${
              activeStreamView === "rumors"
                ? "bg-background text-foreground elevation-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setActiveStreamView("rumors")}
          >
            传闻
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1.5 ${
              activeStreamView === "clues"
                ? "bg-background text-foreground elevation-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setActiveStreamView("clues")}
          >
            线索
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1.5 ${
              activeStreamView === "branches"
                ? "bg-background text-foreground elevation-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setActiveStreamView("branches")}
          >
            分支管理
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1.5 ${
              activeStreamView === "multi-pov-mesh"
                ? "bg-background text-foreground elevation-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setActiveStreamView("multi-pov-mesh")}
          >
            多主角织网
          </button>
        </div>
      </div>

      {activeStreamView === "timeline" ? (
        <>
          {/* 筛选栏 */}
          {events.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">{t("storySimulation.filterLabel")}</span>
              <select
                value={filterActor}
                onChange={(e) => setFilterActor(e.target.value)}
                className="h-7 rounded border border-input bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="all">{t("storySimulation.allCharacters")}</option>
                {actors.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                className="h-7 rounded border border-input bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="all">{t("storySimulation.allActions")}</option>
                {actionTypes.map((type) => (
                  <option key={type} value={type}>
                    {actionTypeShortLabel(type)}
                  </option>
                ))}
              </select>
              {(filterActor !== "all" || filterType !== "all") && (
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => {
                    setFilterActor("all");
                    setFilterType("all");
                  }}
                >
                  清除筛选
                </button>
              )}
              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={expandAll}
                >
                  全部展开
                </button>
                <span className="text-muted-foreground">|</span>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={collapseAll}
                >
                  全部折叠
                </button>
                <span className="ml-2 text-muted-foreground">
                  显示 {totalFiltered}/{events.length} 条
                </span>
              </div>
            </div>
          )}

          <div
            ref={logRef}
            className="min-h-0 flex-1 overflow-y-auto rounded-lg border bg-muted/30 p-3 text-sm"
          >
            {groupedEvents.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">
                {events.length === 0
                  ? t("storySimulation.waitForActions")
                  : t("storySimulation.noMatchingEvents")}
              </div>
            ) : (
              <div className="space-y-3">
                {groupedEvents.map(
                  ({ nodeIndex, nodeInfo, events: nodeEvents }) => {
                    const isCollapsed = collapsedNodes.has(nodeIndex);
                    const phase = nodeInfo?.phase || "起";
                    const nodeTitle =
                      nodeInfo?.title || t("storySimulation.nodeTitle", { index: nodeIndex + 1 });
                    return (
                      <div
                        key={nodeIndex}
                        className="rounded-md border bg-background/50"
                      >
                        {/* 节点标题栏 - 可点击折叠 */}
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50"
                          onClick={() => toggleNode(nodeIndex)}
                        >
                          {isCollapsed ? (
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                            {phaseLabel(phase)}
                          </span>
                          <span className="text-sm font-medium">
                            节点 {nodeIndex + 1}：{nodeTitle}
                          </span>
                          <span className="ml-auto text-xs text-muted-foreground">
                            {nodeEvents.length} 条事件
                          </span>
                        </button>
                        {/* 节点事件列表 */}
                        {!isCollapsed && (
                          <div className="space-y-1.5 border-t px-3 py-2">
                            {nodeEvents.map((ev) => (
                              <div key={ev.id} className="leading-relaxed">
                                <span className="mr-1 rounded bg-muted px-1 py-0.5 text-xs text-muted-foreground">
                                  R{ev.round + 1}
                                </span>
                                {onInterviewAgent ? (
                                  <button
                                    type="button"
                                    className="font-medium text-primary hover:underline"
                                    onClick={() =>
                                      onInterviewAgent(ev.actorId, ev.actorName)
                                    }
                                  >
                                    {ev.actorName}
                                  </button>
                                ) : (
                                  <span className="font-medium">
                                    {ev.actorName}
                                  </span>
                                )}
                                <span className="text-muted-foreground">
                                  {" "}
                                  {ev.targetName &&
                                  ev.targetId &&
                                  onInterviewAgent ? (
                                    <>
                                      {actionTypePhraseOnly(ev.actionType)}{" "}
                                      <button
                                        type="button"
                                        className="text-primary hover:underline"
                                        onClick={() =>
                                          onInterviewAgent(
                                            ev.targetId!,
                                            ev.targetName!,
                                          )
                                        }
                                      >
                                        {ev.targetName}
                                      </button>
                                      ：
                                    </>
                                  ) : (
                                    <>
                                      {actionTypePhrase(
                                        ev.actionType,
                                        ev.targetName,
                                      )}
                                      ：
                                    </>
                                  )}
                                </span>
                                <span>{ev.content}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  },
                )}
              </div>
            )}
          </div>
        </>
      ) : activeStreamView === "overview" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <ProcessDebugPanel debugTraces={debugTraces} />
        </div>
      ) : activeStreamView === "rumors" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <RumorPropagationPanel
            rumors={currentRumors}
            agents={currentAgents}
            events={timelineEvents}
          />
        </div>
      ) : activeStreamView === "clues" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <ClueTimelinePanel
            agents={currentAgents}
            rumors={currentRumors}
            events={timelineEvents}
          />
        </div>
      ) : activeStreamView === "branches" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <BranchManagerPanel
            branches={branches}
            activeBranchId={activeBranchId}
            compareBranchIds={compareBranchIds}
            isCompareMode={isCompareMode}
            onSaveBranch={onSaveBranch}
            onDeleteBranch={onDeleteBranch}
            onRenameBranch={onRenameBranch}
            onSwitchBranch={onSwitchBranch}
            onToggleCompareBranch={onToggleCompareBranch}
            onSetCompareMode={onSetCompareMode}
            onClearCompareSelection={onClearCompareSelection}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          <MultiPovMeshPanel
            agents={currentAgents}
            events={timelineEvents}
          />
        </div>
      )}
    </div>
  );
}

export function ProcessDebugPanel({
  debugTraces,
}: {
  debugTraces: SimulationDebugTrace[];
}) {
  const { t } = useTranslation()
  const latestTrace = debugTraces[debugTraces.length - 1];
  const displayTraces = debugTraces.slice(-50).reverse();

  if (!latestTrace) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">
        等待推演过程数据...
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="h-full overflow-y-auto p-3 text-sm">
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          <DebugStat
            label={t("storySimulation.statAllAgents")}
            value={latestTrace.blackboard.allAgentCount}
          />
          <DebugStat
            label={t("storySimulation.statActiveAgents")}
            value={latestTrace.blackboard.activeAgentCount}
          />
          <DebugStat
            label={t("storySimulation.statTotalEvents")}
            value={latestTrace.blackboard.totalEventCount}
          />
          <DebugStat
            label={t("storySimulation.statPublicEvents")}
            value={latestTrace.blackboard.publicEventCount}
          />
        </div>

        {latestTrace.blackboard.allAgentCount === 0 && (
          <div className="mb-3 rounded-md border border-warning bg-warning p-3 text-xs text-warning">
            <div className="mb-1 font-medium">{t("storySimulation.noAgentsWarnTitle")}</div>
            <div className="text-warning">
              {t("storySimulation.noAgentsWarnBody")}
            </div>
          </div>
        )}

        <div className="space-y-3">
          {displayTraces.map((trace) => (
            <div
              key={trace.id}
              className="rounded-md border bg-background/70 p-3"
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                  {trace.type === "round-plan" ? t("storySimulation.traceRoundPlan") : "事件写入"}
                </span>
                <span className="text-xs text-muted-foreground">
                  节点 {trace.nodeIndex + 1}：{trace.nodeTitle}
                </span>
                <span className="text-xs text-muted-foreground">
                  R{trace.round + 1}
                </span>
                {trace.strategy && (
                  <span className="text-xs text-muted-foreground">
                    策略：
                    {trace.strategy === "all-agents"
                      ? t("storySimulation.strategyAll")
                      : trace.strategy === "subset"
                        ? t("storySimulation.strategySubset")
                        : t("storySimulation.strategyNone")}
                  </span>
                )}
              </div>

              <div className="mb-2 grid gap-2 md:grid-cols-2">
                <DebugAgentList
                  title={t("storySimulation.candidateAgents")}
                  agents={trace.candidateAgents}
                />
                <DebugAgentList
                  title={t("storySimulation.actingAgents")}
                  agents={trace.selectedAgents}
                />
              </div>

              {trace.latestEvent && (
                <div className="mb-2 rounded border bg-muted/30 px-2 py-1.5 text-xs">
                  <span className="font-medium">{t("storySimulation.latestEvent")}</span>
                  <span className="text-muted-foreground">
                    {trace.latestEvent.actorName} /{" "}
                    {actionTypeShortLabel(trace.latestEvent.actionType)}
                  </span>
                  <span>：{trace.latestEvent.content}</span>
                </div>
              )}

              <div className="rounded border bg-muted/20 p-2">
                <div className="mb-1 text-xs font-medium">
                  Blackboard 可见事件
                </div>
                <div className="grid gap-1 md:grid-cols-2">
                  {trace.visibilityByAgent.map((agent) => (
                    <div
                      key={agent.agentId}
                      className="text-xs text-muted-foreground"
                    >
                      <span className="font-medium text-foreground">
                        {agent.agentName}
                      </span>
                      <span> 可见事件 {agent.visibleEventCount ?? 0} 条</span>
                      {agent.recentEvents && agent.recentEvents.length > 0 && (
                        <div className="mt-0.5 flex max-h-12 flex-wrap gap-1 overflow-y-auto">
                          {agent.recentEvents.map((event) => (
                            <span
                              key={event.id}
                              title={event.id}
                              className="inline-flex max-w-[160px] items-center truncate rounded-full border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
                            >
                              {event.id}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function DebugStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-background/70 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

export function DebugAgentList({
  title,
  agents,
}: {
  title: string;
  agents: SimulationDebugTrace["candidateAgents"];
}) {
  const { t } = useTranslation()
  return (
    <div className="rounded border bg-muted/20 p-2">
      <div className="mb-1 text-xs font-medium">{title}</div>
      <div className="flex flex-wrap gap-1">
        {agents.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t("storySimulation.none")}</span>
        ) : (
          agents.map((agent) => (
            <span
              key={`${title}-${agent.agentId}`}
              className="max-w-[120px] truncate rounded bg-background px-1.5 py-0.5 text-xs text-muted-foreground"
              title={agent.reason}
            >
              {agent.agentName}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
