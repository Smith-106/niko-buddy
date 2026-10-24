import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useWikiStore } from "@/stores/wiki-store";
import { useStorySimulationStore } from "@/stores/story-simulation-store";
import { extractStoryContent, generateStoryFramework, buildAgents, runSimulation, generateDynamicEventPool, generateSimulationReport, generateStoryDraft, saveFramework, saveSimulationResult, loadSimulationResults, resolveDefaultModel, interviewAgent, saveInterview, loadInterviews, exportInterview, serializeSimulationState, deserializeSimulationSnapshot, actionTypeShortLabel, actionTypeIcon } from "@/lib/novel"
import type { SimulationCallbacks, AgentChatMessage, ExtractionResult, NovelAgent, RumorEvent, SimulationDebugTrace, SimulationHistoryEntry, SimulationReport, SimulationResumePoint, SimulationState, StoryBranch, StoryFramework, TimelineEvent } from "@/lib/novel"

import { PROGRESS_PHASES, SimulatingTimelinePanel, ProcessDebugPanel } from "./simulation-debug-panels";
import { SimulationConfigPanel } from "./simulation-config-panel";
import { FrameworkConfirmPanel } from "./framework-confirm-panel";
import { SimulationReportView } from "./simulation-report-view";
import { StoryDraftView } from "./story-draft-view";
import { InterviewHistoryView } from "./interview-history-view";
import { RumorPropagationPanel } from "./rumor-propagation-panel";
import { ClueTimelinePanel } from "./detective-board-panel";
import { BranchManagerPanel } from "./branch-manager-panel";
import { HistoryResultsModal } from "./history-results-modal";
import { BranchCompareView } from "./branch-compare-view";
import { AgentChatPanel } from "./agent-chat-panel";
import { ProgressPanel } from "./progress-panel";
import { formatOperationError } from "@/lib/format-operation-error";
import { toErrorMessage } from "@/lib/utils";


/**
 * 故事推演室主视图（重构后）。
 *
 * 单栏全宽布局：框架列表已迁移到左侧 SidebarPanel。
 * 主区域根据 phase 切换：配置 → 框架确认 → 推演（实时事件流）→ 报告 → 草稿。
 * 报告阶段可弹出 Agent 采访面板与角色对话。
 */
export function StorySimulationView() {
  const { t } = useTranslation();
  const projectPath = useWikiStore((s) => s.project?.path);
  const baseLlmConfig = useWikiStore((s) => s.llmConfig);

  const phase = useStorySimulationStore((s) => s.phase);
  const mode = useStorySimulationStore((s) => s.mode);
  const userIdea = useStorySimulationStore((s) => s.userIdea);
  const targetWords = useStorySimulationStore((s) => s.targetWords);
  const sourceChapters = useStorySimulationStore((s) => s.sourceChapters);
  const simulationRounds = useStorySimulationStore((s) => s.simulationRounds);
  const extractionResult = useStorySimulationStore((s) => s.extractionResult);
  const currentFramework = useStorySimulationStore((s) => s.currentFramework);
  const currentReport = useStorySimulationStore((s) => s.currentReport);
  const currentDraft = useStorySimulationStore((s) => s.currentDraft);
  const error = useStorySimulationStore((s) => s.error);
  const progress = useStorySimulationStore((s) => s.progress);
  const progressLabel = useStorySimulationStore((s) => s.progressLabel);
  const timelineEvents = useStorySimulationStore((s) => s.timelineEvents);
  const debugTraces = useStorySimulationStore((s) => s.debugTraces);
  const activeChatAgent = useStorySimulationStore((s) => s.activeChatAgent);
  const savedResults = useStorySimulationStore((s) => s.savedResults);
  const selectedResultId = useStorySimulationStore((s) => s.selectedResultId);

  const setPhase = useStorySimulationStore((s) => s.setPhase);
  const setExtractionResult = useStorySimulationStore(
    (s) => s.setExtractionResult,
  );
  const setCurrentFramework = useStorySimulationStore(
    (s) => s.setCurrentFramework,
  );
  const setCurrentReport = useStorySimulationStore((s) => s.setCurrentReport);
  const setCurrentDraft = useStorySimulationStore((s) => s.setCurrentDraft);
  const setError = useStorySimulationStore((s) => s.setError);
  const infoMessage = useStorySimulationStore((s) => s.infoMessage);
  const setInfoMessage = useStorySimulationStore((s) => s.setInfoMessage);
  const setProgress = useStorySimulationStore((s) => s.setProgress);
  const setTimelineEvents = useStorySimulationStore((s) => s.setTimelineEvents);
  const addTimelineEvent = useStorySimulationStore((s) => s.addTimelineEvent);
  const setDebugTraces = useStorySimulationStore((s) => s.setDebugTraces);
  const addDebugTrace = useStorySimulationStore((s) => s.addDebugTrace);
  const setActiveChatAgent = useStorySimulationStore(
    (s) => s.setActiveChatAgent,
  );
  const addAgentChatMessage = useStorySimulationStore(
    (s) => s.addAgentChatMessage,
  );
  const agentChatMessages = useStorySimulationStore((s) => s.agentChatMessages);
  const clearAgentChat = useStorySimulationStore((s) => s.clearAgentChat);
  const bumpListRefresh = useStorySimulationStore((s) => s.bumpListRefresh);
  const setSavedResults = useStorySimulationStore((s) => s.setSavedResults);
  const setShowInterviewHistory = useStorySimulationStore(
    (s) => s.setShowInterviewHistory,
  );
  const continuingInterviewId = useStorySimulationStore(
    (s) => s.continuingInterviewId,
  );
  const setContinuingInterviewId = useStorySimulationStore(
    (s) => s.setContinuingInterviewId,
  );
  const dynamicEventPool = useStorySimulationStore((s) => s.dynamicEventPool);
  const setDynamicEventPool = useStorySimulationStore(
    (s) => s.setDynamicEventPool,
  );
  const setCurrentRumors = useStorySimulationStore((s) => s.setCurrentRumors);
  const setCurrentAgents = useStorySimulationStore((s) => s.setCurrentAgents);
  const setSelectedResultId = useStorySimulationStore(
    (s) => s.setSelectedResultId,
  );
  const currentRumors = useStorySimulationStore((s) => s.currentRumors);
  const currentAgents = useStorySimulationStore((s) => s.currentAgents);
  const branches = useStorySimulationStore((s) => s.branches);
  const activeBranchId = useStorySimulationStore((s) => s.activeBranchId);
  const compareBranchIds = useStorySimulationStore((s) => s.compareBranchIds);
  const isCompareMode = useStorySimulationStore((s) => s.isCompareMode);
  const saveCurrentAsBranch = useStorySimulationStore(
    (s) => s.saveCurrentAsBranch,
  );
  const deleteBranch = useStorySimulationStore((s) => s.deleteBranch);
  const renameBranch = useStorySimulationStore((s) => s.renameBranch);
  const switchToBranch = useStorySimulationStore((s) => s.switchToBranch);
  const setCompareMode = useStorySimulationStore((s) => s.setCompareMode);
  const toggleCompareBranch = useStorySimulationStore(
    (s) => s.toggleCompareBranch,
  );
  const clearCompareSelection = useStorySimulationStore(
    (s) => s.clearCompareSelection,
  );
  const addHistoryEntry = useStorySimulationStore((s) => s.addHistoryEntry);
  const clearHistory = useStorySimulationStore((s) => s.clearHistory);

  // 保存仿真后的 agents 和 state 供采访使用
  const lastAgentsRef = useRef<NovelAgent[]>([]);
  const lastSimulationStateRef = useRef<SimulationState | null>(null);
  // 追踪上一轮的 round，确保每轮只加一次历史快照
  const lastHistoryRoundRef = useRef<number>(-1);

  // 取消控制器
  const abortControllerRef = useRef<AbortController | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const resumeSimulationRef = useRef<SimulationResumePoint | null>(null);
  /** 本次推演是否降级（连续 Agent 决策失败） */
  const degradedRef = useRef(false);
  const resumeSnapshotRef = useRef<{
    agentSnapshot?: ReturnType<typeof serializeSimulationState> | null;
    debugTraces?: SimulationDebugTrace[];
    rumors?: RumorEvent[];
  } | null>(null);

  // 历史结果模态框
  const [showHistoryModal, setShowHistoryModal] = useState(false);

  // 报告阶段视图切换
  const [reportViewTab, setReportViewTab] = useState<
    "report" | "timeline" | "overview" | "rumors" | "clues"
  >("report");

  // 草稿阶段视图切换
  const [draftViewTab, setDraftViewTab] = useState<
    "draft" | "report" | "timeline" | "overview" | "rumors" | "clues"
  >("draft");

  // 采访输入框
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [chatExporting, setChatExporting] = useState(false);
  const [chatSaving, setChatSaving] = useState(false);
  const chatStreamRef = useRef("");
  const chatLogRef = useRef<HTMLDivElement | null>(null);

  // 当前阶段的进度基线
  const phaseBaseProgressRef = useRef(0);

  // 采访面板打开时自动滚动到底部
  useEffect(() => {
    if (activeChatAgent && chatLogRef.current) {
      chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
    }
  }, [agentChatMessages, activeChatAgent]);

  // 选择历史结果时，反序列化恢复agent状态，支持采访
  useEffect(() => {
    if (!selectedResultId) return;
    const result = savedResults.find((r) => r.id === selectedResultId);
    if (!result) return;

    if (result.agentSnapshot) {
      try {
        const { agents, state } = deserializeSimulationSnapshot(
          result.agentSnapshot,
        );
        lastAgentsRef.current = agents;
        lastSimulationStateRef.current = state;
        setCurrentAgents(new Map(agents.map((a) => [a.characterId, a])));
      } catch (err) {
        console.error("反序列化历史结果失败:", err);
      }
    }
    if (result.timelineEvents) {
      setTimelineEvents(result.timelineEvents);
    }
    if (result.rumors) {
      setCurrentRumors(result.rumors);
    }
    if (result.debugTraces) {
      setDebugTraces(result.debugTraces);
    }
  }, [
    selectedResultId,
    savedResults,
    setCurrentAgents,
    setTimelineEvents,
    setCurrentRumors,
    setDebugTraces,
  ]);

  // 续聊模式：恢复 agents 和 simulationState 到 ref
  useEffect(() => {
    if (!continuingInterviewId || !projectPath) return;

    // 异步恢复 agents
    const restoreAgents = async () => {
      try {
        // 先尝试从采访记录恢复
        const interviews = await loadInterviews(projectPath);
        const interview = interviews.find(
          (i) => i.id === continuingInterviewId,
        );

        if (interview?.agentSnapshot) {
          const { agents, state } = deserializeSimulationSnapshot(
            interview.agentSnapshot,
          );
          lastAgentsRef.current = agents;
          lastSimulationStateRef.current = state;
          return;
        }

        // 若采访记录无快照，尝试从推演结果恢复
        if (interview?.frameworkId) {
          const results = await loadSimulationResults(
            projectPath,
            interview.frameworkId,
          );
          for (const r of results) {
            if (r.agentSnapshot) {
              const { agents, state } = deserializeSimulationSnapshot(
                r.agentSnapshot,
              );
              lastAgentsRef.current = agents;
              lastSimulationStateRef.current = state;
              return;
            }
          }
        }
      } catch (err) {
        console.error("恢复 agent 状态失败:", err);
      }
    };

    restoreAgents();
  }, [continuingInterviewId, projectPath]);

  // ── 核心流程 ──

  const savePartialSimulationResult = async (partialReason: string) => {
    if (!projectPath || !currentFramework) return;
    const state = useStorySimulationStore.getState();
    const savedTimelineEvents = state.timelineEvents;
    if (savedTimelineEvents.length === 0 && state.debugTraces.length === 0) {
      return;
    }

    const latestEvent = savedTimelineEvents[savedTimelineEvents.length - 1];
    const resume: SimulationResumePoint = {
      nextNodeIndex: latestEvent?.nodeIndex ?? 0,
      nextRound: latestEvent ? latestEvent.round + 1 : 0,
      timelineEvents: savedTimelineEvents,
    };
    const activeAgents =
      state.currentAgents.size > 0
        ? state.currentAgents
        : new Map(
            lastAgentsRef.current.map((agent) => [agent.characterId, agent]),
          );
    const snapshotState: SimulationState = {
      currentRound: latestEvent?.round ?? 0,
      timelineEvents: savedTimelineEvents,
      activeAgents,
      worldState: lastSimulationStateRef.current?.worldState ?? {},
      directorEnabled: false,
      nextNodeInjectionMap: new Map(),
    };
    const agentsForSnapshot =
      activeAgents.size > 0
        ? Array.from(activeAgents.values())
        : lastAgentsRef.current;
    const agentSnapshot =
      agentsForSnapshot.length > 0
        ? serializeSimulationState(snapshotState, agentsForSnapshot)
        : undefined;
    const report: SimulationReport = {
      frameworkId: currentFramework.id,
      mode,
      characterAnalyses: [],
      branches: [],
      recommendation: `推演未完成：${partialReason}。可在历史推演结果中查看已生成内容，并继续推演。`,
      createdAt: new Date().toISOString(),
    };

    await saveSimulationResult(
      projectPath,
      currentFramework.id,
      report,
      undefined,
      savedTimelineEvents,
      agentSnapshot,
      state.currentRumors,
      state.debugTraces,
      {
        status: partialReason.includes("取消") ? "cancelled" : "partial",
        partialReason,
        resume,
      },
    );
    const results = await loadSimulationResults(projectPath, currentFramework.id);
    setSavedResults(
      results.map((r) => ({
        id: r.id,
        frameworkId: currentFramework.id,
        report: r.report,
        draft: r.draft,
        timelineEvents: r.timelineEvents,
        agentSnapshot: r.agentSnapshot,
        rumors: r.rumors,
        debugTraces: r.debugTraces,
        status: r.status,
        partialReason: r.partialReason,
        resume: r.resume,
        createdAt: r.report.createdAt,
      })),
    );
    setInfoMessage(t("storySimulation.partialSavedInfo"));
    setTimeout(() => setInfoMessage(null), 5000);
  };

  /** 取消当前正在进行的操作 */
  const handleCancel = () => {
    if (abortControllerRef.current) {
      setIsCancelling(true);
      setError(t("storySimulation.savingPartial"));
      abortControllerRef.current.abort();
    }
  };

  /** 提取内容并生成故事框架，进入框架确认阶段。 */
  const handleStart = async () => {
    if (!projectPath) {
      setError(t("storySimulation.openProjectFirst"));
      return;
    }
    setError(null);
    setCurrentFramework(null);
    setTimelineEvents([]);
    setDebugTraces([]);
    try {
      const llmConfig = resolveDefaultModel(baseLlmConfig);

      // 1. 提取内容
      setPhase("extracting");
      phaseBaseProgressRef.current = 0;
      setProgress(0, t("storySimulation.extracting"));
      const extraction: ExtractionResult = await extractStoryContent(
        projectPath,
        {
          sourceChapters,
          llmConfig,
          onProgress: (p, label) => setProgress(p, label),
        },
      );
      setExtractionResult(extraction);

      // 1.5 预生成动态事件池
      const characterNames = extraction.characters.map((c) => c.name);
      const eventPool = await generateDynamicEventPool({
        llmConfig,
        worldRules: extraction.worldRules,
        characters: characterNames,
      });
      setDynamicEventPool(eventPool);

      // 2. 生成框架
      setPhase("framework-generating");
      phaseBaseProgressRef.current = 30;
      setProgress(30, t("storySimulation.generatingFramework"));
      const framework: StoryFramework = await generateStoryFramework({
        extraction,
        mode,
        targetWords,
        userIdea: userIdea || undefined,
        llmConfig,
        onProgress: (label) => setProgress(phaseBaseProgressRef.current, label),
      });
      setCurrentFramework(framework);
      setPhase("framework-confirming");
    } catch (err) {
      setError(formatOperationError(t, err));
      setPhase("configuring");
    }
  };

  /** 保存当前框架到磁盘，并刷新侧边栏列表。 */
  const handleSaveFramework = async () => {
    if (!projectPath || !currentFramework) return;
    try {
      await saveFramework(projectPath, currentFramework);
      bumpListRefresh();
    } catch (err) {
      setError(formatOperationError(t, err));
    }
  };

  /** 从历史结果模态框选择结果：反序列化并切换到报告阶段。 */
  const handleSelectHistoryResult = (resultId: string) => {
    const result = savedResults.find((r) => r.id === resultId);
    if (!result) return;

    setCurrentReport(result.report);
    setCurrentDraft(result.draft || null);
    setTimelineEvents(result.timelineEvents || []);
    setCurrentRumors(result.rumors || []);
    setDebugTraces(result.debugTraces || []);
    if (result.agentSnapshot) {
      try {
        const { agents } = deserializeSimulationSnapshot(result.agentSnapshot);
        setCurrentAgents(new Map(agents.map((a) => [a.characterId, a])));
      } catch {
        setCurrentAgents(new Map());
      }
    } else {
      setCurrentAgents(new Map());
    }
    setSelectedResultId(resultId);
    setShowHistoryModal(false);
    if ((result.status ?? "complete") !== "complete") {
      setReportViewTab("timeline");
    }
    setPhase("report-viewing");
  };

  const handleContinuePartialResult = (resultId: string) => {
    const result = savedResults.find((r) => r.id === resultId);
    if (!result?.resume) return;

    setTimelineEvents(result.timelineEvents || []);
    setDebugTraces(result.debugTraces || []);
    setCurrentRumors(result.rumors || []);
    setCurrentReport(null);
    setCurrentDraft(null);
    if (result.agentSnapshot) {
      try {
        const { agents, state } = deserializeSimulationSnapshot(
          result.agentSnapshot,
        );
        lastAgentsRef.current = agents;
        lastSimulationStateRef.current = state;
        setCurrentAgents(new Map(agents.map((a) => [a.characterId, a])));
      } catch {
        setCurrentAgents(new Map());
      }
    }
    resumeSimulationRef.current = result.resume;
    resumeSnapshotRef.current = {
      agentSnapshot: result.agentSnapshot,
      debugTraces: result.debugTraces,
      rumors: result.rumors,
    };
    setSelectedResultId(resultId);
    setShowHistoryModal(false);
    void handleConfirmFramework();
  };

  /** 确认框架：必要时先保存 → 构建角色 → 仿真 → 生成报告。 */
  const handleConfirmFramework = async () => {
    if (!projectPath || !currentFramework) {
      setError(t("storySimulation.missingProjectOrFramework"));
      return;
    }
    const resumePoint = resumeSimulationRef.current;
    const resumeSnapshot = resumeSnapshotRef.current;
    setError(null);
    setTimelineEvents([]);
    setDebugTraces(resumePoint ? resumeSnapshot?.debugTraces || [] : []);
    setCurrentRumors(resumePoint ? resumeSnapshot?.rumors || [] : []);
    setIsCancelling(false);
    degradedRef.current = false;
    const ac = new AbortController();
    abortControllerRef.current = ac;

    try {
      // 若尚无提取结果（如从历史框架进入），先提取
      let extraction = extractionResult;
      if (!extraction) {
        const llmConfig = resolveDefaultModel(baseLlmConfig);
        setPhase("extracting");
        phaseBaseProgressRef.current = 0;
        setProgress(0, t("storySimulation.extracting"));
        extraction = await extractStoryContent(projectPath, {
          sourceChapters,
          llmConfig,
          onProgress: (p, label) => setProgress(p, label),
        });
        setExtractionResult(extraction);
      }

      // 开始推演前，若框架尚未保存到磁盘则先保存
      // 简单判断：检查 frameworks 列表里是否有当前 id
      const existing = useStorySimulationStore
        .getState()
        .frameworks.find((f) => f.id === currentFramework.id);
      if (!existing) {
        await saveFramework(projectPath, currentFramework);
        bumpListRefresh();
      }

      // 构建角色并运行仿真
      setPhase("simulating");
      phaseBaseProgressRef.current = 50;
      setProgress(50, t("storySimulation.simulating"));
      let agents = buildAgents(extraction, currentFramework);
      if (resumePoint && resumeSnapshot?.agentSnapshot) {
        try {
          agents = deserializeSimulationSnapshot(resumeSnapshot.agentSnapshot).agents;
        } catch {
          // 快照损坏时回退为重新构建角色，避免继续推演入口直接失败。
        }
      }
      // 强制校验：没有 Agent 直接中止推演，避免空跑浪费 token
      if (agents.length === 0) {
        throw new Error(
          t("storySimulation.noAgentsExtracted"),
        );
      }
      lastAgentsRef.current = agents;
      const llmConfig = resolveDefaultModel(baseLlmConfig);

      // 清空历史记录
      clearHistory();
      lastHistoryRoundRef.current = -1;

      const collectedTimeline: TimelineEvent[] = [];

      const callbacks: SimulationCallbacks = {
        onEvent: () => {},
        onProgress: (p, label) => setProgress(50 + Math.floor(p / 2), label),
        onComplete: () => {},
        onError: () => {},
        onDegraded: () => {
          degradedRef.current = true;
        },
        onTimelineEvent: (event) => {
          collectedTimeline.push(event);
          addTimelineEvent(event);
        },
        onDebugTrace: (trace) => {
          addDebugTrace(trace);
          setCurrentRumors(trace.rumors);
          setCurrentAgents(trace.activeAgents);
          lastAgentsRef.current = Array.from(trace.activeAgents.values());
          lastSimulationStateRef.current = {
            currentRound: trace.round,
            timelineEvents: useStorySimulationStore.getState().timelineEvents,
            activeAgents: trace.activeAgents,
            worldState: {},
            directorEnabled: false,
            nextNodeInjectionMap: new Map(),
          };

          // 每轮只加一次历史快照（当 round 变化时）
          if (trace.round !== lastHistoryRoundRef.current) {
            lastHistoryRoundRef.current = trace.round;

            const agentStates: SimulationHistoryEntry["agentStates"] = {};
            for (const [id, agent] of trace.activeAgents) {
              agentStates[id] = {
                name: agent.name,
                sentiments: Array.from(agent.memory.sentiments.entries()) as [
                  string,
                  number,
                ][],
                knownSecrets: Array.from(agent.memory.knownSecrets),
                observedEvents: [...agent.memory.observedEvents],
              };
            }

            const entry: SimulationHistoryEntry = {
              round: trace.round,
              nodeIndex: trace.nodeIndex,
              nodeTitle: trace.nodeTitle,
              agentStates,
              eventCount: trace.blackboard.totalEventCount,
              rumorCount: trace.blackboard.rumorCount,
            };

            addHistoryEntry(entry);
          }
        },
      };
      const events = await runSimulation(
        {
          agents,
          framework: currentFramework,
          mode,
          wordBudget: targetWords,
          llmConfig,
          userIdea: userIdea || undefined,
          maxRoundsPerNode: simulationRounds > 0 ? simulationRounds : undefined,
          dynamicEventPool: (
            Array.isArray(dynamicEventPool)
              ? dynamicEventPool.length > 0
              : dynamicEventPool.all.length > 0
          )
            ? dynamicEventPool
            : undefined,
          resume: resumePoint ?? undefined,
        },
        extraction,
        callbacks,
        ac.signal,
      );

      if (ac.signal.aborted) {
        await savePartialSimulationResult("用户取消推演");
        setPhase("framework-confirming");
        setError(t("storySimulation.simulationCancelled"));
        setTimeout(() => setError(null), 3000);
        return;
      }

      // 保存仿真状态供采访使用
      lastSimulationStateRef.current = {
        currentRound: 0,
        timelineEvents: collectedTimeline,
        activeAgents: new Map(agents.map((a) => [a.characterId, a])),
        worldState: {},
        directorEnabled: false,
        nextNodeInjectionMap: new Map(),
      };

      // 生成推演报告
      setPhase("report-generating");
      phaseBaseProgressRef.current = 80;
      setProgress(80, t("storySimulation.generatingReport"));
      const report = await generateSimulationReport({
        events,
        framework: currentFramework,
        mode,
        llmConfig,
        onProgress: (label) => setProgress(phaseBaseProgressRef.current, label),
        signal: ac.signal,
      });

      if (ac.signal.aborted) {
        await savePartialSimulationResult("用户取消推演");
        setPhase("framework-confirming");
        setError(t("storySimulation.cancelled"));
        setTimeout(() => setError(null), 3000);
        return;
      }

      setCurrentReport(report);
      setPhase("report-viewing");

      // 自动保存推演结果（包含时间线事件和agent快照）
      try {
        const agentSnapshot = serializeSimulationState(
          lastSimulationStateRef.current!,
          lastAgentsRef.current,
        );
        await saveSimulationResult(
          projectPath,
          currentFramework.id,
          report,
          undefined,
          collectedTimeline,
          agentSnapshot,
          currentRumors,
          debugTraces,
          degradedRef.current
            ? {
                status: "degraded",
                partialReason:
                  "连续 3 次 Agent 决策失败（可能为离线或 API 错误），推演结果仅含系统事件",
              }
            : undefined,
        );
        // 刷新历史结果列表
        const results = await loadSimulationResults(
          projectPath,
          currentFramework.id,
        );
        setSavedResults(
          results.map((r) => ({
            id: r.id,
            frameworkId: currentFramework.id,
            report: r.report,
            draft: r.draft,
            timelineEvents: r.timelineEvents,
            agentSnapshot: r.agentSnapshot,
            rumors: r.rumors,
            debugTraces: r.debugTraces,
            status: r.status,
            partialReason: r.partialReason,
            resume: r.resume,
            createdAt: r.report.createdAt,
          })),
        );
      } catch (saveErr) {
        console.error("保存推演结果失败:", saveErr);
      }
      if (degradedRef.current) {
        setInfoMessage(t("storySimulation.degradedInfo"));
        setTimeout(() => setInfoMessage(null), 8000);
      }
    } catch (err) {
      if (ac.signal.aborted) {
        await savePartialSimulationResult("用户取消推演");
        setPhase("framework-confirming");
        setError(t("storySimulation.simulationCancelled"));
        setTimeout(() => setError(null), 3000);
      } else {
        setError(formatOperationError(t, err));
        setPhase("framework-confirming");
      }
    } finally {
      setIsCancelling(false);
      abortControllerRef.current = null;
      resumeSimulationRef.current = null;
      resumeSnapshotRef.current = null;
    }
  };

  /** 重新生成框架（重新提取 + 生成）。 */
  const handleRegenerateFramework = () => {
    void handleStart();
  };

  /** 重新推演：回退到框架确认阶段。 */
  const handleResimulate = () => {
    setTimelineEvents([]);
    setDebugTraces([]);
    setCurrentReport(null);
    setPhase("framework-confirming");
  };

  /** 选择走向分支并生成故事草稿。 */
  const handleGenerateDraft = async (branch: StoryBranch) => {
    if (!projectPath || !currentFramework || !currentReport) {
      setError(t("storySimulation.missingDraftInputs"));
      return;
    }
    setError(null);
    setIsCancelling(false);
    const ac = new AbortController();
    abortControllerRef.current = ac;

    try {
      setPhase("draft-generating");
      phaseBaseProgressRef.current = 90;
      setProgress(90, t("storySimulation.generatingDraft"));
      const llmConfig = resolveDefaultModel(baseLlmConfig);
      const draft = await generateStoryDraft({
        framework: currentFramework,
        report: currentReport,
        selectedBranch: branch,
        llmConfig,
        nodeTimelineEvents: timelineEvents,
        onProgress: (label) => setProgress(phaseBaseProgressRef.current, label),
        signal: ac.signal,
      });

      if (ac.signal.aborted) {
        setPhase("report-viewing");
        setError(t("storySimulation.draftCancelled"));
        setTimeout(() => setError(null), 3000);
        return;
      }

      setCurrentDraft(draft);
      setPhase("draft-viewing");

      // 更新保存的推演结果，添加草稿
      try {
        const agentSnapshot = lastSimulationStateRef.current
          ? serializeSimulationState(
              lastSimulationStateRef.current,
              lastAgentsRef.current,
            )
          : undefined;
        await saveSimulationResult(
          projectPath,
          currentFramework.id,
          currentReport,
          draft,
          timelineEvents,
          agentSnapshot,
          currentRumors,
          debugTraces,
        );
        // 刷新历史结果列表
        const results2 = await loadSimulationResults(
          projectPath,
          currentFramework.id,
        );
        setSavedResults(
          results2.map((r) => ({
            id: r.id,
            frameworkId: currentFramework.id,
            report: r.report,
            draft: r.draft,
            timelineEvents: r.timelineEvents,
              agentSnapshot: r.agentSnapshot,
              rumors: r.rumors,
              debugTraces: r.debugTraces,
              status: r.status,
              partialReason: r.partialReason,
              resume: r.resume,
              createdAt: r.report.createdAt,
            })),
          );
      } catch (saveErr) {
        console.error("更新推演结果草稿失败:", saveErr);
      }
    } catch (err) {
      if (ac.signal.aborted) {
        setPhase("report-viewing");
        setError(t("storySimulation.draftCancelled"));
        setTimeout(() => setError(null), 3000);
      } else {
        setError(formatOperationError(t, err));
        setPhase("report-viewing");
      }
    } finally {
      setIsCancelling(false);
      abortControllerRef.current = null;
    }
  };

  /** 草稿视图返回报告视图。 */
  const handleBackToReport = () => {
    setPhase("report-viewing");
  };

  /** 从报告视图进入草稿视图。 */
  const handleViewDraft = () => {
    if (currentDraft) {
      setPhase("draft-viewing");
    }
  };

  /** 打开 Agent 采访面板。 */
  const handleInterviewAgent = (agentId: string, agentName: string) => {
    clearAgentChat();
    setActiveChatAgent({ id: agentId, name: agentName });
  };

  /** 关闭采访面板。 */
  const handleCloseChat = () => {
    clearAgentChat();
  };

  /** 导出对话记录为MD。 */
  const handleExportChat = async () => {
    if (!activeChatAgent || !projectPath || agentChatMessages.length === 0)
      return;
    setChatExporting(true);
    try {
      const filePath = await exportInterview(
        projectPath,
        activeChatAgent.name,
        agentChatMessages,
      );
      setInfoMessage(t("storySimulation.chatExported", { path: filePath }));
      setTimeout(() => setInfoMessage(null), 5000);
    } catch (err) {
      setError(formatOperationError(t, err));
    } finally {
      setChatExporting(false);
    }
  };

  /** 保存采访对话到项目。 */
  const handleSaveChat = async () => {
    if (!activeChatAgent || !projectPath || agentChatMessages.length === 0)
      return;
    setChatSaving(true);
    try {
      const session = {
        agentId: activeChatAgent.id,
        agentName: activeChatAgent.name,
        messages: agentChatMessages,
      };
      const agentSnapshot =
        lastSimulationStateRef.current && lastAgentsRef.current.length > 0
          ? serializeSimulationState(
              lastSimulationStateRef.current,
              lastAgentsRef.current,
            )
          : undefined;
      // 续聊模式下询问覆盖原采访或另存为新采访
      let existingId: string | undefined;
      if (continuingInterviewId) {
        const choice = confirm(
          t("storySimulation.overwriteInterviewConfirm"),
        );
        if (choice) {
          existingId = continuingInterviewId;
        }
      }
      await saveInterview(projectPath, session, {
        frameworkId: currentFramework?.id,
        frameworkTitle: currentFramework?.title,
        agentSnapshot,
        existingId,
      });
      setContinuingInterviewId(null);
      setInfoMessage(t("storySimulation.interviewSaved", { count: agentChatMessages.length }));
      setTimeout(() => setInfoMessage(null), 3000);
    } catch (err) {
      setError(formatOperationError(t, err));
      setTimeout(() => setError(null), 5000);
    } finally {
      setChatSaving(false);
    }
  };

  /** 发送采访消息。 */
  const handleSendChat = async () => {
    const text = chatInput.trim();
    if (!text || chatSending || !activeChatAgent) return;

    // 确保有可用的仿真状态和角色数据
    if (!lastSimulationStateRef.current || lastAgentsRef.current.length === 0) {
      // 尝试从当前选中的历史结果中恢复
      if (selectedResultId) {
        const result = savedResults.find((r) => r.id === selectedResultId);
        if (result?.agentSnapshot) {
          try {
            const { agents, state } = deserializeSimulationSnapshot(
              result.agentSnapshot,
            );
            lastAgentsRef.current = agents;
            lastSimulationStateRef.current = state;
          } catch (err) {
            setError(
              t("storySimulation.restoreAgentFailed", {
                message: toErrorMessage(err),
              }),
            );
            return;
          }
        }
      }
      // 如果还是没有，说明无法采访
      if (
        !lastSimulationStateRef.current ||
        lastAgentsRef.current.length === 0
      ) {
        setError(t("storySimulation.noAgentState"));
        return;
      }
    }

    const llmConfig = resolveDefaultModel(baseLlmConfig);
    let agent = lastAgentsRef.current.find(
      (a) => a.characterId === activeChatAgent.id,
    );
    // 如果按id找不到，按名字找（兼容旧数据）
    if (!agent) {
      agent = lastAgentsRef.current.find(
        (a) => a.name === activeChatAgent.name,
      );
    }
    if (!agent) {
      setError(t("storySimulation.agentNotFound", { name: activeChatAgent.name }));
      return;
    }

    setChatInput("");
    setChatSending(true);
    chatStreamRef.current = "";

    // 先添加一条占位的 agent 消息，流式更新
    const placeholderId = `msg_${Date.now()}_stream`;
    const placeholder: AgentChatMessage = {
      id: placeholderId,
      role: "agent",
      agentId: agent.characterId,
      agentName: agent.name,
      content: "",
      timestamp: new Date().toISOString(),
    };
    // P0-5：末条独立更新（只替换 placeholder 那条，不碰其余消息引用）。
    const flushChatPlaceholder = () => {
      const state = useStorySimulationStore.getState();
      const msgs = [...state.agentChatMessages];
      const lastIdx = msgs.length - 1;
      if (lastIdx >= 0 && msgs[lastIdx].id === placeholderId) {
        msgs[lastIdx] = {
          ...msgs[lastIdx],
          content: chatStreamRef.current,
        };
        useStorySimulationStore.setState({ agentChatMessages: msgs });
      }
    };
    let chatFlushTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      // 把已有消息（除 placeholder）组织成 session
      const existingMessages = agentChatMessages;
      const session = {
        agentId: agent.characterId,
        agentName: agent.name,
        messages: [...existingMessages],
      };

      addAgentChatMessage({
        id: `msg_${Date.now()}_user`,
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      });
      addAgentChatMessage(placeholder);

      await interviewAgent({
        llmConfig,
        agent,
        simulationState: lastSimulationStateRef.current,
        userPrompt: text,
        session,
        onToken: (token) => {
          chatStreamRef.current += token;
          // P0-5：逐 token setState 会全数组拷贝＋整列表重渲染；64ms trailing 节流，onDone/onError 同步 flush。
          if (chatFlushTimer !== null) return;
          chatFlushTimer = setTimeout(() => {
            chatFlushTimer = null;
            flushChatPlaceholder();
          }, 64);
        },
        onDone: () => {
          if (chatFlushTimer !== null) {
            clearTimeout(chatFlushTimer);
            chatFlushTimer = null;
          }
          flushChatPlaceholder();
        },
        onError: (err) => {
          if (chatFlushTimer !== null) {
            clearTimeout(chatFlushTimer);
            chatFlushTimer = null;
          }
          flushChatPlaceholder();
          setError(err.message);
        },
      });
    } catch (err) {
      setError(formatOperationError(t, err));
    } finally {
      setChatSending(false);
    }
  };

  // ── 渲染 ──

  const isProgressPhase = (PROGRESS_PHASES as readonly string[]).includes(
    phase,
  );

  const progressTitle = (() => {
    switch (phase) {
      case "extracting":
        return t("storySimulation.extracting");
      case "framework-generating":
        return t("storySimulation.generatingFramework");
      case "simulating":
        return t("storySimulation.simulating");
      case "report-generating":
        return t("storySimulation.generatingReport");
      case "draft-generating":
        return t("storySimulation.generatingDraft");
      default:
        return "";
    }
  })();

  return (
    <div className="flex h-full">
      {/* 主区域：单栏全宽 */}
      <div className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
        {error && (
          <div className="flex items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive dark:text-destructive">
            <span>
              {t("storySimulation.error")}: {error}
            </span>
            <button
              type="button"
              className="shrink-0 text-xs underline"
              onClick={() => setError(null)}
            >
              {t("storySimulation.back")}
            </button>
          </div>
        )}
        {infoMessage && !error && (
          <div className="flex items-center justify-between gap-3 border-b border-success/30 bg-success/10 px-4 py-2 text-sm text-success dark:text-success">
            <span>{infoMessage}</span>
            <button
              type="button"
              className="shrink-0 text-xs underline"
              onClick={() => setInfoMessage(null)}
            >
              {t("storySimulation.close")}
            </button>
          </div>
        )}

        {isProgressPhase && phase !== "simulating" ? (
          <ProgressPanel
            progress={progress}
            label={progressLabel || progressTitle}
            onCancel={handleCancel}
            cancelling={isCancelling}
          />
        ) : phase === "simulating" ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            {isCompareMode ? (
              <BranchCompareView
                branches={branches}
                compareBranchIds={compareBranchIds}
                onBack={() => setCompareMode(false)}
              />
            ) : (
              <SimulatingTimelinePanel
                progress={progress}
                label={progressLabel || progressTitle}
                events={timelineEvents}
                debugTraces={debugTraces}
                framework={currentFramework}
                onInterviewAgent={(id, name) => handleInterviewAgent(id, name)}
                onCancel={handleCancel}
                cancelling={isCancelling}
                branches={branches}
                activeBranchId={activeBranchId}
                compareBranchIds={compareBranchIds}
                isCompareMode={isCompareMode}
                onSaveBranch={saveCurrentAsBranch}
                onDeleteBranch={deleteBranch}
                onRenameBranch={renameBranch}
                onSwitchBranch={switchToBranch}
                onToggleCompareBranch={toggleCompareBranch}
                onSetCompareMode={setCompareMode}
                onClearCompareSelection={clearCompareSelection}
              />
            )}
          </div>
        ) : phase === "framework-confirming" ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <FrameworkConfirmPanel
              onConfirm={() => void handleConfirmFramework()}
              onRegenerate={handleRegenerateFramework}
              onSave={() => void handleSaveFramework()}
              onViewHistory={() => setShowHistoryModal(true)}
            />
            {/* 历史结果模态框 */}
            <HistoryResultsModal
              open={showHistoryModal}
                projectPath={projectPath}
                frameworkId={currentFramework?.id}
                onSelectResult={handleSelectHistoryResult}
                onContinueResult={handleContinuePartialResult}
                onClose={() => setShowHistoryModal(false)}
              />
          </div>
        ) : phase === "report-viewing" ? (
          <div className="flex min-h-0 flex-1">
            {isCompareMode ? (
              <div className="min-w-0 min-h-0 flex-1 overflow-hidden">
                <BranchCompareView
                  branches={branches}
                  compareBranchIds={compareBranchIds}
                  onBack={() => setCompareMode(false)}
                />
              </div>
            ) : (
              <div className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
                <div className="shrink-0 border-b px-3 py-2">
                  <div className="inline-flex flex-wrap rounded-md border bg-muted/40 p-0.5 text-xs">
                    <button
                      type="button"
                      className={`rounded px-3 py-1.5 ${
                        reportViewTab === "report"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => setReportViewTab("report")}
                    >
                      推演报告
                    </button>
                    <button
                      type="button"
                      className={`rounded px-3 py-1.5 ${
                        reportViewTab === "timeline"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => setReportViewTab("timeline")}
                    >
                      时间线
                    </button>
                    <button
                      type="button"
                      className={`rounded px-3 py-1.5 ${
                        reportViewTab === "overview"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => setReportViewTab("overview")}
                    >
                      概览
                    </button>
                    <button
                      type="button"
                      className={`rounded px-3 py-1.5 ${
                        reportViewTab === "rumors"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => setReportViewTab("rumors")}
                    >
                      传闻
                    </button>
                    <button
                      type="button"
                      className={`rounded px-3 py-1.5 ${
                        reportViewTab === "clues"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => setReportViewTab("clues")}
                    >
                      线索
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  {reportViewTab === "report" ? (
                    <SimulationReportView
                      onResimulate={handleResimulate}
                      onGenerateDraft={(branch) =>
                        void handleGenerateDraft(branch)
                      }
                      onInterviewAgent={(id, name) =>
                        handleInterviewAgent(id, name)
                      }
                      onViewDraft={handleViewDraft}
                      hasDraft={!!currentDraft}
                      onViewInterviewHistory={() =>
                        setShowInterviewHistory(true)
                      }
                    />
                  ) : reportViewTab === "timeline" ? (
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
                  ) : reportViewTab === "overview" ? (
                    <div className="h-full overflow-hidden">
                      <ProcessDebugPanel debugTraces={debugTraces} />
                    </div>
                  ) : reportViewTab === "rumors" ? (
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
            )}
            {activeChatAgent ? (
              <AgentChatPanel
                agentName={activeChatAgent.name}
                messages={agentChatMessages}
                input={chatInput}
                onInputChange={setChatInput}
                onSend={() => void handleSendChat()}
                onClose={handleCloseChat}
                onExport={() => void handleExportChat()}
                onSave={() => void handleSaveChat()}
                sending={chatSending}
                exporting={chatExporting}
                saving={chatSaving}
                chatLogRef={chatLogRef}
              />
            ) : (
              <div className="flex w-80 shrink-0 flex-col border-l p-3">
                <div className="min-h-0 flex-1 overflow-hidden">
                  <BranchManagerPanel
                    branches={branches}
                    activeBranchId={activeBranchId}
                    compareBranchIds={compareBranchIds}
                    isCompareMode={isCompareMode}
                    onSaveBranch={saveCurrentAsBranch}
                    onDeleteBranch={deleteBranch}
                    onRenameBranch={renameBranch}
                    onSwitchBranch={switchToBranch}
                    onToggleCompareBranch={toggleCompareBranch}
                    onSetCompareMode={setCompareMode}
                    onClearCompareSelection={clearCompareSelection}
                  />
                </div>
              </div>
            )}
          </div>
        ) : phase === "draft-viewing" ? (
          <div className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
            <div className="shrink-0 border-b px-3 py-2">
              <div className="inline-flex flex-wrap rounded-md border bg-muted/40 p-0.5 text-xs">
                <button
                  type="button"
                  className={`rounded px-3 py-1.5 ${
                    draftViewTab === "draft"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setDraftViewTab("draft")}
                >
                  故事草稿
                </button>
                <button
                  type="button"
                  className={`rounded px-3 py-1.5 ${
                    draftViewTab === "report"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setDraftViewTab("report")}
                >
                  推演报告
                </button>
                <button
                  type="button"
                  className={`rounded px-3 py-1.5 ${
                    draftViewTab === "timeline"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setDraftViewTab("timeline")}
                >
                  时间线
                </button>
                <button
                  type="button"
                  className={`rounded px-3 py-1.5 ${
                    draftViewTab === "overview"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setDraftViewTab("overview")}
                >
                  过程观察
                </button>
                <button
                  type="button"
                  className={`rounded px-3 py-1.5 ${
                    draftViewTab === "rumors"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setDraftViewTab("rumors")}
                >
                  传闻
                </button>
                <button
                  type="button"
                  className={`rounded px-3 py-1.5 ${
                    draftViewTab === "clues"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setDraftViewTab("clues")}
                >
                  线索
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {draftViewTab === "draft" ? (
                <StoryDraftView onBack={handleBackToReport} />
              ) : draftViewTab === "report" ? (
                <SimulationReportView
                  onResimulate={handleResimulate}
                  onGenerateDraft={(branch) => void handleGenerateDraft(branch)}
                  onInterviewAgent={(id, name) =>
                    handleInterviewAgent(id, name)
                  }
                  onViewDraft={handleViewDraft}
                  hasDraft={!!currentDraft}
                  onViewInterviewHistory={() => setShowInterviewHistory(true)}
                />
              ) : draftViewTab === "timeline" ? (
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
              ) : draftViewTab === "overview" ? (
                <div className="h-full overflow-hidden">
                  <ProcessDebugPanel debugTraces={debugTraces} />
                </div>
              ) : draftViewTab === "rumors" ? (
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
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SimulationConfigPanel onStart={() => void handleStart()} />
          </div>
        )}
      </div>
      <InterviewHistoryView />
    </div>
  );
}

/** 进度展示面板：文字 + 进度条 + 取消按钮。 */






/** Agent 采访对话面板（右侧内联面板）。 */

