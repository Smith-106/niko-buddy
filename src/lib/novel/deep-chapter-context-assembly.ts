/**
 * deep-chapter-context-assembly.ts — 深章阶段1-3 上下文装配与生成（纯搬迁，零逻辑变更）
 *
 * 从 deep-chapter-generation.ts 抽出（P1 巨文件拆分，swarm ts-bloat-20261017 裁决）。
 * 含：contextPack 装配（失败降级空 pack）、场景拆解/任务书/初稿生成阶段、
 * 智能 skill、大纲注入、社区摘要注入、Track B pre_write hooks、cachePrefix。
 */
import {
  formatStageThinking,
} from "./chapter-utils"
import {
  computeCheckpointDigestOf,
} from "./checkpoint-digest"
import {
} from "./context-engine"
import type {
  ContextPack,
} from "./context-engine"
import {
} from "./control-kernel"
import {
  buildDeepChapterBriefPrompt,
  buildDeepChapterDraftPrompt,
  buildDeepChapterExpansionPrompt,
  buildStableContextPrefix,
} from "./deep-chapter-prompts"
import type {
  ChapterLengthSpec,
} from "./deep-chapter-prompts"
import {
  appendPlanningBlockToTaskBrief,
  appendStructurePlanToTaskBrief,
  buildDraftRecoveryPrompt,
  buildFallbackTaskBrief,
  buildTaskBriefRepairPrompt,
  isMetaDraftContent,
  shouldRepairTaskBrief,
  shouldUseDeterministicTaskBriefFallback,
  taskBriefHasPlanningBlock,
  taskBriefHasStructurePlan,
} from "./deep-chapter-task-brief"
import {
  assertNotAborted,
  countChapterChars,
  formatContextThinking,
} from "./deep-chapter-utils"
import {
  appendStageMetric,
} from "./novel-session-status"
import {
  runNovelSkillHooks,
} from "./novel-skill-hooks"
import {
  persistSceneBreakdownDraft,
  runSceneBreakdown,
} from "./scene-breakdown"
import type {
  SceneBreakdownResult,
} from "./scene-breakdown"
import {
  computeInstructionDigest,
  resolveStageOutput,
} from "./stage-output-journal"
import {
  resolveTaskExtraPrompt,
  resolveTaskSkillNames,
} from "./task-customization"
import type {
  WatchdogState,
} from "./watchdog"
import {
  loadUserMemoryForProject,
} from "@/lib/user-memory/session"
import {
  UserMemoryStore,
} from "@/lib/user-memory/types"
import {
  logger,
} from "@/lib/utils"
import {
  LlmConfig,
  useWikiStore,
} from "@/stores/wiki-store"
import type {
  DeepChapterGenerationCallbacks,
  DeepChapterGenerationDeps,
  DeepChapterGenerationInput,
  DeepChapterGenerationResumeCheckpoint,
} from "./deep-chapter-generation"
import {
  MAX_TASK_BRIEF_REPAIR_ATTEMPTS,
  USER_ABORT_MESSAGE,
  collectModelText,
  createResumeCheckpoint,
  hasCheckpointDraft,
  hasCheckpointTaskBrief,
  resolveStructurePlanForResidual,
  safeBuildChapterContextPack,
} from "./deep-chapter-runtime-support"

// 阶段1：上下文装配（contextPack + 智能skill + 大纲提取 + 社区摘要 + cachePrefix）
// 返回阶段产出的全部上下文对象；customDeAiSkill 经返回值回传给编排器。
interface AssembledContext {
  contextPack: ContextPack
  customDeAiSkill: string | null
  userMemoryStore: UserMemoryStore | null
  outlinePrompt: string
  communitySummaryInjection: string
  contextPrompt: string
  cachePrefix: string
}

export async function assembleContext(
  deps: DeepChapterGenerationDeps,
  input: DeepChapterGenerationInput,
  callbacks: DeepChapterGenerationCallbacks,
  resumeCheckpoint: DeepChapterGenerationResumeCheckpoint | undefined,
  signal: AbortSignal | undefined,
  previousChaptersAnalysis: string,
  loadSmartDeAiSkill: (projectPath: string, userRequest: string, contextPack: ContextPack) => Promise<string | null>,
): Promise<AssembledContext> {
  const contextPack = await safeBuildChapterContextPack(
    deps,
    input.projectPath,
    input.userRequest,
    input.chapterNumber,
  )
  assertNotAborted(signal, USER_ABORT_MESSAGE)

  // 阶段1后：加载智能skill（传递contextPack用于场景检测）
  const customDeAiSkill = await loadSmartDeAiSkill(input.projectPath, input.userRequest, contextPack)

  // 阶段1后：加载用户记忆 store（Wave 1 接线；无文件时返回默认空 store）
  const userMemoryStore = await loadUserMemoryForProject(input.projectPath)

  // 独立提取大纲，不通过contextPackToPrompt
  const outlinePrompt = contextPack.outline
    ? [
        "# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "# 【强制遵守】作品完整大纲",
        "# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "",
        "**重要：以下是本作品的完整大纲，这是强制性要求。**",
        "你必须严格遵守大纲中的情节发展、角色行为、关键事件、故事走向。",
        "大纲内容必须完整体现在生成的章节中，不可偏离。",
        "",
        contextPack.outline,
        "",
        "# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "",
      ].join("\n")
    : ""

  // TASK-003 (ANL-013 S4): pre-generation community-summary generate side.
  // After context assembly, before prose generation: generate (or reuse the
  // cached) narrative summaries for the communities most relevant to the
  // current chapter's task tokens, and inject them into the compressible
  // context tier. This closes the previously-orphaned generate side — only
  // the retrieval side (`searchCommunitySummaries` via graphSearchResults)
  // was wired before. `generateCommunitySummariesForChapter` is the per-chapter
  // lazy-cached entry point; it internally calls `generateSingleCommunitySummary`
  // (community-summary.ts) for each relevant community. Best-effort: failure
  // returns "" and does not block.
  let communitySummaryInjection = ""
  try {
    const { generateCommunitySummariesForChapter } = await import("./community-summary")
    communitySummaryInjection = await generateCommunitySummariesForChapter(
      input.projectPath,
      input.userRequest,
      input.chapterNumber,
      input.llmConfig,
    )
  } catch (err) {
    // F-16 (CWE-532): message-only.
    logger.warn("Deep Chapter", "社区摘要生成失败（非阻断）", { error: err instanceof Error ? err.message : String(err) })
  }

  // Track B skill hooks at pre_write_prompt (soft; empty registry = no-op).
  let skillHookFragments = ""
  try {
    const hookCtx = await runNovelSkillHooks("pre_write_prompt", {
      projectPath: input.projectPath,
      chapterNumber: input.chapterNumber,
    })
    if (hookCtx.bag.promptFragments.length > 0) {
      skillHookFragments = ["## Track B skill hooks (pre_write_prompt · soft)", ...hookCtx.bag.promptFragments].join("\n")
    }
  } catch (err) {
    logger.warn("Deep Chapter", "pre_write skill hooks soft-failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 任务自定义技能（task customization）：用户 taskSkillNames.writing 名单 → 技能内容追加段。
  // 名单为空（默认）时整段不存在，contextPrompt 字节不变；装载失败不阻断生成。
  let userTaskSkillFragments = ""
  const userTaskSkillNames = resolveTaskSkillNames(input.novelConfig, "writing")
  if (userTaskSkillNames.length > 0) {
    try {
      const { loadUserSkillConfig } = await import("./user-skill-store")
      const { resolveAvailableSkillsByNames } = await import("./skill-route-registry")
      const pool = await loadUserSkillConfig(input.projectPath)
      const picked = resolveAvailableSkillsByNames(pool.skills, userTaskSkillNames)
      if (picked.skills.length > 0) {
        userTaskSkillFragments = [
          "## 任务自定义技能（用户配置）",
          ...picked.skills.map((s) => `### ${s.name}\n${s.content}`),
        ].join("\n\n")
      }
    } catch (err) {
      logger.warn("Deep Chapter", "任务自定义技能装载失败（非阻断）", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 其他上下文可以进行token预算管理，但大纲已被排除
  const contextPrompt = [
    previousChaptersAnalysis ? `## 前情分析\n\n${previousChaptersAnalysis}` : "",
    deps.contextPackToPrompt(contextPack, 32000, {
      excludeOutline: true,
      // U4: default layered recall (L2+L3 first; L0 bodies only on full)
      layeredRecall: "default",
      sectionCharBudget: 4000,
      hardInjectEnabled: input.novelConfig.hardInjectEnabled,
    }),
    communitySummaryInjection ? `## 相关社区摘要\n\n${communitySummaryInjection}` : "",
    skillHookFragments,
    userTaskSkillFragments,
    input.dismantlingReferenceDirective,
  ].filter(Boolean).join("\n\n")

  // 稳定上下文前缀：与任务书/初稿/扩写/返修/去AI味各阶段提示词开头逐字节一致。
  // 作为显式 prompt 缓存断点传入（Anthropic/MiniMax 走 cache_control；
  // OpenAI/DeepSeek 该断点被折叠回字符串、由其自动前缀缓存命中）。
  const cachePrefix = buildStableContextPrefix(outlinePrompt, contextPrompt)

  if (!resumeCheckpoint) {
    callbacks.onThinking?.(formatContextThinking(input, contextPack))
    await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_context"))
  }
  assertNotAborted(signal, USER_ABORT_MESSAGE)

  return { contextPack, customDeAiSkill, userMemoryStore, outlinePrompt, communitySummaryInjection, contextPrompt, cachePrefix }
}

// 阶段1.5：Scene Breakdown（ADR-30 / EPIC-002 / TASK-012）。
// 仅当 sceneBreakdownEnabled 开启时，在 contextPack（阶段 1）之后、task_brief
// （阶段 2）之前插入单次 LLM 调用，把章节蓝图拆成 3-8 个连续场景，持久化到
// .novel/chapters/{n}/scenes.pending.json（Draft-first pending，ADR-08），并通过
// ADR-31 工厂 buildNextStatus 写回 status.json evidence_refs（HARD-1 真源不变）。
// 向后兼容（ADR-30）：flag=false 时跳过整段，after_task_brief 恢复序不变。
// resume 时若已过 after_scene_breakdown 也跳过（避免重复拆解已 checkpoint 的章节）。
export async function runSceneBreakdownStage(
  input: DeepChapterGenerationInput,
  novelConfig: ReturnType<typeof useWikiStore.getState>["novelConfig"],
  resumeCheckpoint: DeepChapterGenerationResumeCheckpoint | undefined,
  contextPack: ContextPack,
  callbacks: DeepChapterGenerationCallbacks,
  signal: AbortSignal | undefined,
  notePartial: (reason: string) => void,
): Promise<void> {
  if (
    !novelConfig.sceneBreakdownEnabled
    || resumeCheckpoint
  ) {
    // R4 共识（deepseek+glm）: 原先还写了 `|| checkpointStageAtLeast(resumeCheckpoint, ...)`，
    // 但 resumeCheckpoint 为真时已短路、为假时 checkpointStageAtLeast 必为 false ⇒ 死条件。
    // 删除死条件，语义不变（有 checkpoint 就跳过场景拆解）。
    return
  }
  callbacks.onThinking?.(formatStageThinking("阶段1.5：场景拆解", "正在根据章节蓝图拆解连续场景..."))
  const chapterId = String(input.chapterNumber ?? "")
  let sceneResult: SceneBreakdownResult | null = null
  try {
    // blueprint = 章节原始意图（userRequest）；buildSceneBreakdownPrompt 再补充
    // contextPack 的结构化字段（chapterGoal/outline/mustDo/mustAvoid/...）。
    sceneResult = await runSceneBreakdown(input.userRequest, contextPack, signal)
  } catch (error) {
    // F-16 (CWE-532): message-only. Scene breakdown 是加性中间层（ADR-30），
    // 失败不阻断主链——跳过阶段 1.5 继续到 task_brief（向后兼容降级）。
    logger.error("deep-chapter-generation", "场景拆解失败（非阻断，跳过阶段1.5）", { error: error instanceof Error ? error.message : String(error) })
  }
  assertNotAborted(signal, USER_ABORT_MESSAGE)
  if (sceneResult && sceneResult.scenes.length > 0) {
    // 工厂持久化（ADR-31 硬先决）：persistSceneBreakdownDraft 内部用
    // buildNextStatus + persistCheckpointBase 写 status.json，非手动 const next 块。
    try {
      await persistSceneBreakdownDraft(input.projectPath, chapterId, sceneResult)
    } catch (error) {
      // 持久化失败不阻断主链（加性中间层），仅记日志。
      logger.error("deep-chapter-generation", "场景拆解持久化失败（非阻断）", { error: error instanceof Error ? error.message : String(error) })
    }
    // EPIC-002 / TASK-013 / Story 2.3: 阶段指标溯源写 status.json stage_metrics
    // （HARD-1 真源 additive optional 字段，非新真源）。sceneResult.tokenCost/
    // latencyMs/partial 从 runSceneBreakdown 单次 LLM 调用采集，O-201 成本经验
    // 决策可据。non-fatal — 指标采集失败不阻断主链。
    await appendStageMetric(input.projectPath, {
      stage: "scene_breakdown",
      tokenCost: sceneResult.tokenCost,
      latencyMs: sceneResult.latencyMs,
      partial: sceneResult.partial,
      chapterId,
      timestamp: new Date().toISOString(),
    })
    // spec S-444k typed signal 传播：sceneResult.partial 经 notePartial 进入
    // runDeepChapter 的 partialReason，最终 DeepChapterGenerationResult.partial=true
    // → chat-panel pauseDeepChapterSession（draft_status pending）而非
    // completeDeepChapterSession（ready），防 partial 误标 complete（Draft-first 边界）。
    // first-partial-reason-wins：仅当主链尚未记录 partial 时才记 scene 的 reason
    // （与 collectModelText 的 notePartial 语义一致，:852）。
    if (sceneResult.partial && sceneResult.partialReason) {
      notePartial(`scene-breakdown: ${sceneResult.partialReason}`)
    }
    callbacks.onThinking?.(formatStageThinking(
      "阶段1.5：场景拆解",
      `已完成场景拆解（${sceneResult.scenes.length}个场景${sceneResult.partial ? "，部分保留" : ""}）`,
    ))
  }
  await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_scene_breakdown"))
}

// 阶段2 + 2.5：任务书生成 + 纠偏（含 repair while 循环）。
// resume 时若检查点已有 taskBrief 则短路；否则模型生成，再按需 deterministic
// fallback 或循环纠偏，最终产出可执行 taskBrief。
export async function generateTaskBrief(
  input: DeepChapterGenerationInput,
  writingConfig: LlmConfig,
  deps: DeepChapterGenerationDeps,
  signal: AbortSignal | undefined,
  callbacks: DeepChapterGenerationCallbacks,
  outlinePrompt: string,
  contextPrompt: string,
  lengthSpec: ChapterLengthSpec,
  resumeCheckpoint: DeepChapterGenerationResumeCheckpoint | undefined,
  contextPack: ContextPack,
  cachePrefix: string | undefined,
  watchdog?: WatchdogState,
): Promise<string> {
  const writingTaskExtra = resolveTaskExtraPrompt(input.novelConfig, "writing")
  let taskBrief = hasCheckpointTaskBrief(resumeCheckpoint) ? resumeCheckpoint.taskBrief.trim() : ""
  // F8 journal 接线（默认关闭 → 与改前字节级一致）：stageJournal 缺席时走直调；
  // 传入时经 digest-keyed 缓存：同 digest 崩溃重入即命中跳过 LLM。digest 输入与 briefMessages
  // 实际语义输入对齐（含 goldenThreeChapter；prompt 文本 + 章号 + 长度规格 + 写作附加），
  // 不含 request 覆盖/缓存前缀等传输层字段；checkpoint 短路优先（已有 taskBrief 不查缓存）。
  const stageJournal = input.stageJournal
  const briefMessages = (extra: string) => [{
    role: "user" as const,
    content: buildDeepChapterBriefPrompt(
      outlinePrompt,
      contextPrompt,
      input.userRequest,
      input.chapterNumber,
      input.goldenThreeChapter,
      lengthSpec,
      extra,
    ),
  }]
  if (!taskBrief) {
    if (!stageJournal) {
      taskBrief = await collectModelText(
        writingConfig,
        briefMessages(writingTaskExtra),
        deps,
        signal,
        (partial) => callbacks.onThinking?.(formatStageThinking("阶段2：写作任务书", partial)),
        undefined,
        cachePrefix,
        undefined,
        undefined,
        watchdog,
      )
    } else {
      const journalDeps = stageJournal.deps
      const journalNow = stageJournal.now?.() ?? Date.now()
      // F10-1（Round-10 写作维度整改）：digest 必须与 briefMessages 实际语义输入对齐——
      // briefMessages 经 buildDeepChapterBriefPrompt 消费 input.goldenThreeChapter（金三章指令段），
      // 故 digest 补 goldenThreeChapter（undefined 缺席=稳定 null 语义；stableStringify 键序无关）。
      // 既有缓存行 digest 变更=自然失效重建（TTL 窗内旧行读不到=视同未命中，无脏读）。
      const digest = await computeInstructionDigest({
        stage: "task_brief",
        outlinePrompt,
        contextPrompt,
        userRequest: input.userRequest,
        chapterNumber: input.chapterNumber,
        goldenThreeChapter: input.goldenThreeChapter ?? null,
        lengthSpec,
        writingTaskExtra,
      })
      const lookup = await resolveStageOutput(
        journalDeps,
        stageJournal.projectId,
        digest,
        "task_brief",
        () => collectModelText(
          writingConfig,
          briefMessages(writingTaskExtra),
          deps,
          signal,
          (partial) => callbacks.onThinking?.(formatStageThinking("阶段2：写作任务书", partial)),
          undefined,
          cachePrefix,
          undefined,
          undefined,
          watchdog,
        ),
        journalNow,
        stageJournal.ttlMs,
      )
      taskBrief = String(lookup.record?.payload ?? "")
      if (lookup.hit) {
        callbacks.onThinking?.(formatStageThinking("阶段2：写作任务书（缓存命中）", taskBrief))
      }
    }
    assertNotAborted(signal, USER_ABORT_MESSAGE)
    callbacks.onThinking?.(formatStageThinking("阶段2：写作任务书", taskBrief))
    await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_task_brief", { taskBrief }))
  }

  const taskBriefNeedsDeterministicFallback =
    shouldUseDeterministicTaskBriefFallback(taskBrief)
    || (Boolean(resumeCheckpoint) && shouldRepairTaskBrief(taskBrief))

  if (taskBriefNeedsDeterministicFallback) {
    taskBrief = buildFallbackTaskBrief(
      contextPack,
      input.userRequest,
      input.chapterNumber,
      lengthSpec,
      await computeCheckpointDigestOf(contextPack.canonRules),
    )
    callbacks.onThinking?.(formatStageThinking(
      "阶段2.5：任务书纠偏",
      [
        resumeCheckpoint
          ? "检测到恢复检查点里的任务书已经漂移成正文或元说明。"
          : "检测到任务书已经膨胀成超长章节化说明，继续追加一次模型纠偏只会放大不稳定性。",
        resumeCheckpoint
          ? "为避免恢复链再次卡在一次额外的模型纠偏调用，这次直接切换到本地结构化 fallback 任务书。"
          : "这次直接切换到本地结构化 fallback 任务书，绕过额外的阶段2.5 模型调用。",
        "",
        taskBrief,
      ].join("\n"),
    ))
    await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_task_brief", { taskBrief }))
  } else if (shouldRepairTaskBrief(taskBrief)) {
    let repairAttempt = 0
    while (shouldRepairTaskBrief(taskBrief) && repairAttempt < MAX_TASK_BRIEF_REPAIR_ATTEMPTS) {
      repairAttempt += 1
      callbacks.onThinking?.(formatStageThinking(
        "阶段2.5：任务书纠偏",
        repairAttempt === 1
          ? "检测到任务书不可直接执行，或已经漂移成正文片段，正在改写为可直接开写的结构化任务书。"
          : `上一次纠偏仍未产出可执行任务书，正在进行第 ${repairAttempt} 次重试。`,
      ))
      taskBrief = await collectModelText(
        writingConfig,
        [{
          role: "user",
          content: buildTaskBriefRepairPrompt(
            outlinePrompt,
            contextPrompt,
            taskBrief,
            input.userRequest,
            input.chapterNumber,
            lengthSpec,
          ),
        }],
        deps,
        signal,
        (partial) => callbacks.onThinking?.(formatStageThinking("阶段2.5：任务书纠偏", partial)),
        undefined,
        cachePrefix,
        undefined,
        undefined,
        watchdog,
      )
      assertNotAborted(signal, USER_ABORT_MESSAGE)
      callbacks.onThinking?.(formatStageThinking("阶段2.5：任务书纠偏", taskBrief))
      await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_task_brief", { taskBrief }))
    }

    if (shouldRepairTaskBrief(taskBrief)) {
      taskBrief = buildFallbackTaskBrief(
        contextPack,
        input.userRequest,
        input.chapterNumber,
        lengthSpec,
        await computeCheckpointDigestOf(contextPack.canonRules),
      )
      callbacks.onThinking?.(formatStageThinking(
        "阶段2.5：任务书纠偏",
        [
          `模型连续 ${MAX_TASK_BRIEF_REPAIR_ATTEMPTS} 次仍输出正文型任务书，已切换到本地结构化 fallback，避免阶段3继续使用坏 taskBrief。`,
          "",
          taskBrief,
        ].join("\n"),
      ))
      await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_task_brief", { taskBrief }))
    }
  }

  // Medium-deepen E2: optional structure plan inject (fail-open when residual fields omitted).
  const residualPlan = resolveStructurePlanForResidual(input)
  if (residualPlan && !taskBriefHasStructurePlan(taskBrief)) {
    taskBrief = appendStructurePlanToTaskBrief(taskBrief, residualPlan)
    await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_task_brief", { taskBrief }))
  }

  // Wave 3 (v2.5.0): 计划模式预填注入（fail-open：planningPlan 缺省时根据 autoPlanningEnabled 隐式自动聚合）。
  // marker 守卫防重复（resume 检查点已含预填块时不二次注入）。
  let effectivePlan = input.planningPlan
  if (!effectivePlan && (input.novelConfig?.autoPlanningEnabled ?? true) && input.chapterNumber != null && input.projectPath) {
    try {
      const { buildChapterPlan } = await import("./planning")
      effectivePlan = await buildChapterPlan(input.projectPath, input.chapterNumber)
    } catch {
      // 隐式聚合失败静默降级（fail-open），绝不阻塞生成
    }
  }
  if (effectivePlan && !taskBriefHasPlanningBlock(taskBrief)) {
    taskBrief = appendPlanningBlockToTaskBrief(taskBrief, effectivePlan)
    await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_task_brief", { taskBrief }))
  }

  return taskBrief
}

// 阶段3 + 3.5：正文初稿（+ 长度不足时扩写补足）+ 草稿纠偏（meta 漂移时重写）。
// resume 时若检查点已有 draftContent 则短路。notePartial/clearPartial 闭包由
// 编排器传入，partial 状态机语义不变（first-partial-wins + 成功 clear）。
export async function generateDraft(
  input: DeepChapterGenerationInput,
  writingConfig: LlmConfig,
  deps: DeepChapterGenerationDeps,
  signal: AbortSignal | undefined,
  callbacks: DeepChapterGenerationCallbacks,
  outlinePrompt: string,
  contextPrompt: string,
  taskBrief: string,
  lengthSpec: ChapterLengthSpec,
  resumeCheckpoint: DeepChapterGenerationResumeCheckpoint | undefined,
  cachePrefix: string | undefined,
  notePartial: (reason: string) => void,
  clearPartial: () => void,
  watchdog?: WatchdogState,
): Promise<string> {
  const writingTaskExtra = resolveTaskExtraPrompt(input.novelConfig, "writing")
  let draftContent = hasCheckpointDraft(resumeCheckpoint) ? resumeCheckpoint.draftContent.trim() : ""
  if (!draftContent) {
    draftContent = await collectModelText(
      writingConfig,
      [{
        role: "user",
        content: buildDeepChapterDraftPrompt(
          outlinePrompt,
          contextPrompt,
          taskBrief,
          input.userRequest,
          input.chapterNumber,
          input.goldenThreeChapter,
          lengthSpec,
          writingTaskExtra,
        ),
      }],
      deps,
      signal,
      (partial) => callbacks.onThinking?.(formatStageThinking("阶段3：正文初稿", partial)),
      { max_tokens: lengthSpec.maxOutputTokens },
      cachePrefix,
      notePartial,
      undefined,
      watchdog,
    )
    assertNotAborted(signal, USER_ABORT_MESSAGE)
    if (countChapterChars(draftContent) < lengthSpec.minChars) {
      draftContent = await collectModelText(
        writingConfig,
        [{
          role: "user",
          content: buildDeepChapterExpansionPrompt(
            outlinePrompt,
            contextPrompt,
            taskBrief,
            draftContent,
            input.userRequest,
            input.chapterNumber,
            input.goldenThreeChapter,
            lengthSpec,
            writingTaskExtra,
          ),
        }],
        deps,
        signal,
        (partial) => callbacks.onThinking?.(formatStageThinking("阶段3：正文扩写补足", partial)),
        { max_tokens: lengthSpec.maxOutputTokens },
        cachePrefix,
        notePartial,
        clearPartial,
        watchdog,
      )
      assertNotAborted(signal, USER_ABORT_MESSAGE)
    }
    callbacks.onThinking?.(formatStageThinking("阶段3：正文初稿", [
      draftContent,
      "",
      `初稿生成完成，约 ${countChapterChars(draftContent)} 字。`,
    ].join("\n")))
    await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_draft", { taskBrief, draftContent }))
  }

  if (isMetaDraftContent(draftContent)) {
    callbacks.onThinking?.(formatStageThinking(
      "阶段3.5：草稿纠偏",
      "检测到模型输出了任务说明或追问用户，正在重写为可直接审查的章节正文。",
    ))
    draftContent = await collectModelText(
      writingConfig,
      [{
        role: "user",
        content: buildDraftRecoveryPrompt(
          outlinePrompt,
          contextPrompt,
          taskBrief,
          draftContent,
          input.userRequest,
          input.chapterNumber,
          lengthSpec,
        ),
      }],
      deps,
      signal,
      (partial) => callbacks.onThinking?.(formatStageThinking("阶段3.5：草稿纠偏", partial)),
      { max_tokens: lengthSpec.maxOutputTokens },
      cachePrefix,
      notePartial,
      undefined,
      watchdog,
    )
    assertNotAborted(signal, USER_ABORT_MESSAGE)
    if (countChapterChars(draftContent) < lengthSpec.minChars) {
      draftContent = await collectModelText(
        writingConfig,
        [{
          role: "user",
          content: buildDeepChapterExpansionPrompt(
            outlinePrompt,
            contextPrompt,
            taskBrief,
            draftContent,
            input.userRequest,
            input.chapterNumber,
            input.goldenThreeChapter,
            lengthSpec,
            writingTaskExtra,
          ),
        }],
        deps,
        signal,
        (partial) => callbacks.onThinking?.(formatStageThinking("阶段3：正文扩写补足", partial)),
        { max_tokens: lengthSpec.maxOutputTokens },
        cachePrefix,
        notePartial,
        clearPartial,
        watchdog,
      )
      assertNotAborted(signal, USER_ABORT_MESSAGE)
    }
    callbacks.onThinking?.(formatStageThinking("阶段3.5：草稿纠偏", [
      draftContent,
      "",
      `纠偏后正文约 ${countChapterChars(draftContent)} 字。`,
    ].join("\n")))
    await callbacks.onCheckpoint?.(createResumeCheckpoint(input, "after_draft", { taskBrief, draftContent }))
  }
  return draftContent
}
