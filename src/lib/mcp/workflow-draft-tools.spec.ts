// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest"
import {
  DRAFTS_DIR,
  HARD_FUSE_LIMIT,
  buildNextStatus,
  computeCheckpointDigest,
  createDirectorPipeline,
  emptyDecisionGates,
  externalDraftTargetKey,
  getExternalDraftRevisionCount,
  isActiveChatDeepChapterSession,
  withProjectLock,
  type ChapterDraft,
  type DeepChapterDecisionGates,
  type NovelDraftStatus,
  type NovelSessionStatus,
  type OutlineModel,
} from "@/lib/novel"
import {
  runDraftPatch,
  runDraftRecordReview,
  runWorkflowNext,
} from "./workflow-draft-tools"
import type { MechanicalGateCompactReport } from "./mechanical-gate"

function makeCleanMechanicalReport(): MechanicalGateCompactReport {
  return {
    detailLevel: "compact",
    mechanicalOnly: true,
    semanticReviewCompleted: false,
    verdict: "mechanical_pass_pending_semantic",
    blockingGate: null,
    chapterNumber: 1,
    genre: null,
    bodyStats: {
      rawChars: 100,
      bodyChars: 100,
      nonWhitespaceChars: 100,
      lineCount: 2,
      lengthSpec: { targetChars: 3000, minChars: 2000, draftMaxChars: 4200, maxOutputTokens: 6000 },
      lengthStatus: "ok",
    },
    summary: {
      verdict: "mechanical_pass_pending_semantic",
      blockingGate: null,
      p0ErrorCount: 0,
      p0WarningCount: 0,
      p1ErrorCount: 0,
      p1WarningCount: 0,
      p2Status: "pending",
      nextAction: "proceed_semantic_review",
    },
    issues: [],
    pinpointHits: [],
    pinpointTotalCount: 0,
    pinpointTruncated: false,
    metricsSummary: {
      slopPenalty: 0,
      slopClassification: "clean",
      cavityPatternPenalty: 0,
      humanizerCavityScore: 0,
      overCorrectionFlagCount: 0,
      repeatedActionCount: 0,
      chorusHitCount: 0,
      silentStretchCount: 0,
      statisticalWarningCount: 0,
      avoidWordHitCount: 0,
      bookRulesLoaded: false,
      bookRulesVerdict: "comply",
      bookRulesFindingCount: 0,
    },
    workflowHint: "ok",
    meta: { llmCalls: 0, diskWrites: 0, note: "mock" },
  }
}

function makeStatus(overrides: Partial<NovelSessionStatus> = {}): NovelSessionStatus {
  return {
    schema_version: "1",
    session_id: "novel-20261126-000001",
    source: "deep_chapter_generation",
    created_at: "2026-11-26T00:00:00Z",
    updated_at: "2026-11-26T00:00:00Z",
    status: "running",
    active_step_index: 2,
    current_task: {
      task_id: "tsk-1",
      conversation_id: "conv-1",
      user_request: "写第1章",
      chapter_number: 1,
      checkpoint_stage: "after_draft",
      status: "running",
    },
    draft: {
      draft_id: "draft_1",
      file_path: "/proj/.qm-drafts/draft_1.md",
      draft_status: "pending",
      updated_at: "2026-11-26T00:00:00Z",
    },
    decision_gates: emptyDecisionGates(),
    evidence_refs: [],
    avoid_ai_summary: {
      score: 88,
      label: "clean",
      issueCount: 1,
      issueTypes: ["filler"],
      updatedAt: "2026-11-26T00:00:00Z",
    },
    ...overrides,
  }
}

describe("workflow-draft-tools: workflow.next", () => {
  it("无章且导演规划缺项时路由到 foundation_fill / architect", async () => {
    const res = await runWorkflowNext(
      "/proj",
      {},
      {
        loadStatus: async () => null,
        listChapters: async () => [],
        listDrafts: async () => [],
        hasPersistedDirectorState: async () => true,
        loadDirectorPersisted: async () => ({
          fileVersion: 1,
          state: createDirectorPipeline(),
          ideaInput: { title: "", genre: "悬疑", coreConflict: "" },
        }),
        loadWorldBlueprint: async () => null,
        collectProjectSnapshot: async (_pp, idea) => ({
          idea,
          worldComplete: false,
          protagonistNamed: false,
          antagonistNamed: false,
          frameworkChosen: false,
          volumesPlanned: false,
          firstChapterReady: false,
        }),
      },
    )
    expect(res.instruction.action).toBe("foundation_fill")
    expect(res.recommendedProfile).toBe("architect")
    expect(res.requiresHumanAccept).toBe(false)
    expect(res.meta).toEqual({ readOnly: true, llmCalls: 0, diskWrites: 0 })
  })

  it("草稿未评审 → review；P0 失败 → revise；P0+P1 通过 → judge (requiresHumanAccept=true)；达 HARD_FUSE_LIMIT → arbitrate", async () => {
    const draft: ChapterDraft = {
      id: "draft_1",
      chapterName: "第1章",
      content: "正文",
      createdAt: 100,
      status: "draft",
      revisionRound: 1,
    }
    const commonDeps = {
      listChapters: async () => [],
      listDrafts: async () => [draft],
      hasPersistedDirectorState: async () => false,
      loadDirectorPersisted: async () => ({
        fileVersion: 1 as const,
        state: createDirectorPipeline(),
        ideaInput: { title: "书", genre: "悬疑", coreConflict: "冲突" },
      }),
      loadWorldBlueprint: async () => null,
      collectProjectSnapshot: async (_pp: string, idea: { title: string; genre: string; coreConflict: string }) => ({
        idea,
        worldComplete: true,
        protagonistNamed: true,
        antagonistNamed: true,
        frameworkChosen: true,
        volumesPlanned: true,
        firstChapterReady: true,
      }),
    }

    // 1. 门控未评估 -> review（reviewer profile 仅推荐只读工具，不含 draft.record_review）
    const reviewRes = await runWorkflowNext("/proj", {}, {
      ...commonDeps,
      loadStatus: async () => makeStatus(),
    })
    expect(reviewRes.instruction.action).toBe("review")
    expect(reviewRes.recommendedProfile).toBe("reviewer")
    expect(reviewRes.recommendedTools).toEqual([
      "draft.read",
      "gate.check_mechanical",
      "context.prepare_write",
      "canon.query",
      "foreshadowing.list",
    ])
    expect(reviewRes.recommendedTools).not.toContain("draft.record_review")
    expect(reviewRes.workflowHint).toContain("writer-sub")
    expect(reviewRes.workflowHint).toContain("draft.record_review")
    expect(reviewRes.requiresHumanAccept).toBe(false)

    // 2. P0 consistency fail（即使 P2 quality pass）-> revise + firstFailedGate="consistency"
    const p0FailStatus = makeStatus({
      decision_gates: {
        ...emptyDecisionGates(),
        consistency: { ...emptyDecisionGates().consistency, status: "failed", verdict: "fail" },
        anti_ai: { ...emptyDecisionGates().anti_ai, status: "passed", verdict: "pass" },
        quality: { ...emptyDecisionGates().quality, status: "passed", verdict: "pass" },
        overall: "fail",
      },
    })
    const reviseRes = await runWorkflowNext("/proj", {}, {
      ...commonDeps,
      loadStatus: async () => p0FailStatus,
    })
    expect(reviseRes.instruction.action).toBe("revise")
    expect(reviseRes.firstFailedGate).toBe("consistency")
    expect(reviseRes.recommendedProfile).toBe("writer-sub")
    expect(reviseRes.recommendedTools).toContain("draft.patch")

    // 3. P0+P1 通过 -> judge 且 requiresHumanAccept=true
    const passedStatus = makeStatus({
      decision_gates: {
        ...emptyDecisionGates(),
        consistency: { ...emptyDecisionGates().consistency, status: "passed", verdict: "pass" },
        anti_ai: { ...emptyDecisionGates().anti_ai, status: "passed", verdict: "pass" },
        quality: { ...emptyDecisionGates().quality, status: "passed", verdict: "pass" },
        overall: "pass",
      },
    })
    const judgeRes = await runWorkflowNext("/proj", {}, {
      ...commonDeps,
      loadStatus: async () => passedStatus,
    })
    expect(judgeRes.instruction.action).toBe("judge")
    expect(judgeRes.requiresHumanAccept).toBe(true)

    // 4. 达到 HARD_FUSE_LIMIT -> 强制 arbitrate (manualReviewRequired=true)
    const fuseDraft: ChapterDraft = { ...draft, revisionRound: HARD_FUSE_LIMIT }
    const fuseRes = await runWorkflowNext("/proj", {}, {
      ...commonDeps,
      listDrafts: async () => [fuseDraft],
      loadStatus: async () => p0FailStatus,
    })
    expect(fuseRes.hardFuseTripped).toBe(true)
    expect(fuseRes.instruction.action).toBe("arbitrate")
    expect(fuseRes.requiresHumanAccept).toBe(true)
  })

  it("空白新项目无 director-pipeline.json 且缺设定时路由到 foundation_fill / architect", async () => {
    const res = await runWorkflowNext(
      "/proj",
      {},
      {
        loadStatus: async () => null,
        listChapters: async () => [],
        listDrafts: async () => [],
        hasPersistedDirectorState: async () => false,
        loadDirectorPersisted: async () => ({
          fileVersion: 1,
          state: createDirectorPipeline(),
          ideaInput: { title: "", genre: "", coreConflict: "" },
        }),
        loadWorldBlueprint: async () => null,
        collectProjectSnapshot: async (_pp, idea) => ({
          idea,
          worldComplete: false,
          protagonistNamed: false,
          antagonistNamed: false,
          frameworkChosen: false,
          volumesPlanned: false,
          firstChapterReady: false,
        }),
        loadOutlineModel: async () => ({ model: null, migratedFrom: null }),
        loadSegmentSummaries: async () => ({}),
        loadStoryCompass: async () => ({
          endingDirection: "",
          openThreads: [],
          estimatedScale: "",
          finalVolumeDeclared: false,
          lastUpdated: "",
        }),
        getChapterVolumes: async () => [],
      },
    )
    expect(res.controlState.phase).toBe("planning")
    expect(res.controlState.foundationMissing).toEqual(["world", "protagonist", "outline"])
    expect(res.instruction.action).toBe("foundation_fill")
    expect(res.recommendedProfile).toBe("architect")
  })

  it("接入 pendingRewrites、reviewInterval/lastGlobalReviewChapter、arcBoundary、complete 与 external_draft_states 退出 review 死循环", async () => {
    const baseDeps = {
      listChapters: async () =>
        Array.from({ length: 10 }, (_, idx) => ({
          name: `chapter-${String(idx + 1).padStart(3, "0")}.md`,
          path: `/proj/wiki/chapters/chapter-${String(idx + 1).padStart(3, "0")}.md`,
        })),
      listDrafts: async () => [] as ChapterDraft[],
      hasPersistedDirectorState: async () => false,
      loadDirectorPersisted: async () => ({
        fileVersion: 1 as const,
        state: createDirectorPipeline(),
        ideaInput: { title: "书", genre: "悬疑", coreConflict: "冲突" },
      }),
      loadWorldBlueprint: async () => null,
      collectProjectSnapshot: async (_pp: string, idea: { title: string; genre: string; coreConflict: string }) => ({
        idea,
        worldComplete: true,
        protagonistNamed: true,
        antagonistNamed: true,
        frameworkChosen: true,
        volumesPlanned: true,
        firstChapterReady: true,
      }),
      loadOutlineModel: async () => ({ model: null, migratedFrom: null }),
      loadSegmentSummaries: async () => ({}),
      loadStoryCompass: async () => ({
        endingDirection: "",
        openThreads: [],
        estimatedScale: "",
        finalVolumeDeclared: false,
        lastUpdated: "",
      }),
      getChapterVolumes: async () => [],
    }

    // 1. pendingRewrites -> rewrite
    const rewriteRes = await runWorkflowNext("/proj", {}, {
      ...baseDeps,
      loadStatus: async () => makeStatus({ pending_rewrites: [3, 7] }),
    })
    expect(rewriteRes.instruction.action).toBe("rewrite")
    expect(rewriteRes.instruction.chapter).toBe(3)

    // 2. reviewInterval + lastGlobalReviewChapter -> global_review
    const globalReviewRes = await runWorkflowNext("/proj", {}, {
      ...baseDeps,
      loadStatus: async () => makeStatus({ review_interval: 5, last_global_review_chapter: 5 }),
    })
    expect(globalReviewRes.instruction.action).toBe("global_review")
    expect(globalReviewRes.recommendedProfile).toBe("reviewer")

    // 3. arcBoundary (OutlineModel 卷末第 10 章): arc_review -> arc_summary -> volume_summary -> new_volume
    const outlineAtVolEnd: OutlineModel = {
      schemaVersion: 2,
      updatedAt: "2026-11-27T00:00:00Z",
      volumes: [
        {
          number: 1,
          title: "第一卷",
          arc: "入局",
          chapters: Array.from({ length: 10 }, (_, idx) => ({
            id: `v01c${String(idx + 1).padStart(3, "0")}`,
            volume: 1,
            chapter: idx + 1,
            title: `第${idx + 1}章`,
            pov: "主角",
            arc: "入局",
            entities: [],
            foreshadow: { plant: [], payoff: [] },
            constraints: [],
            prose: { goal: "推进", scenes: ["场景1"], emotion: "紧张" },
            updatedAt: "2026-11-27T00:00:00Z",
          })),
        },
      ],
    }
    const arcReviewRes = await runWorkflowNext("/proj", {}, {
      ...baseDeps,
      loadStatus: async () => makeStatus(),
      loadOutlineModel: async () => ({ model: outlineAtVolEnd, migratedFrom: null }),
    })
    expect(arcReviewRes.instruction.action).toBe("arc_transition")
    expect(arcReviewRes.instruction.arcStep).toBe("arc_review")

    const volSummaryRes = await runWorkflowNext("/proj", {}, {
      ...baseDeps,
      loadStatus: async () =>
        makeStatus({
          arc_settlement_completed: {
            "chapter:10": { arc_review: true },
          },
        }),
      loadOutlineModel: async () => ({ model: outlineAtVolEnd, migratedFrom: null }),
      loadSegmentSummaries: async () => ({ "0": "第1-10章段摘要" }),
    })
    expect(volSummaryRes.instruction.action).toBe("arc_transition")
    expect(volSummaryRes.instruction.arcStep).toBe("volume_summary")

    const newVolRes = await runWorkflowNext("/proj", {}, {
      ...baseDeps,
      loadStatus: async () =>
        makeStatus({
          arc_settlement_completed: {
            "chapter:10": { arc_review: true, arc_summary: true, volume_summary: true },
          },
        }),
      loadOutlineModel: async () => ({ model: outlineAtVolEnd, migratedFrom: null }),
    })
    expect(newVolRes.instruction.action).toBe("arc_transition")
    expect(newVolRes.instruction.arcStep).toBe("new_volume")
    expect(newVolRes.recommendedProfile).toBe("architect")

    // 4. phase: "complete" via storyCompass + checkFinaleAutoComplete AND via status.book_completed
    const finaleAutoRes = await runWorkflowNext("/proj", {}, {
      ...baseDeps,
      loadStatus: async () => makeStatus(),
      loadOutlineModel: async () => ({ model: outlineAtVolEnd, migratedFrom: null }),
      loadStoryCompass: async () => ({
        endingDirection: "终局收束",
        openThreads: [],
        estimatedScale: "1卷",
        finalVolumeDeclared: true,
        finalVolumeNumber: 1,
        lastUpdated: "2026-11-27T00:00:00Z",
      }),
    })
    expect(finaleAutoRes.controlState.phase).toBe("complete")
    expect(finaleAutoRes.instruction.action).toBe("halt")

    const explicitCompleteRes = await runWorkflowNext("/proj", {}, {
      ...baseDeps,
      loadStatus: async () => makeStatus({ book_completed: true }),
    })
    expect(explicitCompleteRes.controlState.phase).toBe("complete")
    expect(explicitCompleteRes.instruction.action).toBe("halt")

    // 5. 运行中 Chat 会话占主槽时，从 external_draft_states[activeDraft.id] 识别已 ready 草稿并退出 review 死循环
    const extDraft: ChapterDraft = {
      id: "draft_ext_11",
      chapterName: "第11章",
      content: "第十一章正文",
      createdAt: 500,
      status: "draft",
    }
    const chatPrimaryWithExternalReady = makeStatus({
      status: "running",
      draft: {
        draft_id: "conv-chat-live",
        file_path: "/proj/.novel/drafts/conv-chat-live.json",
        draft_status: "pending",
        updated_at: "2026-11-27T00:00:00Z",
      },
      external_draft_states: {
        draft_ext_11: {
          draft_id: "draft_ext_11",
          file_path: "/proj/.qm-drafts/draft_ext_11.md",
          chapter_name: "第11章",
          chapter_number: 11,
          target_key: "chapter:11",
          draft_status: "ready",
          decision_gates: {
            ...emptyDecisionGates(),
            consistency: { ...emptyDecisionGates().consistency, status: "passed", verdict: "pass" },
            anti_ai: { ...emptyDecisionGates().anti_ai, status: "passed", verdict: "pass" },
            quality: { ...emptyDecisionGates().quality, status: "passed", verdict: "pass" },
            overall: "pass",
          },
          draft_auto_arm: {
            armed: true,
            target: "ready",
            reason: "all_required_gates_pass",
            decidedAt: "2026-11-27T00:00:00Z",
            gateSnapshot: { consistency: "pass", anti_ai: "pass", quality: "pass" },
          },
          updated_at: "2026-11-27T00:00:00Z",
        },
      },
    })
    expect(isActiveChatDeepChapterSession(chatPrimaryWithExternalReady)).toBe(true)
    const exitLoopRes = await runWorkflowNext("/proj", { draftId: "draft_ext_11" }, {
      ...baseDeps,
      listDrafts: async () => [extDraft],
      loadStatus: async () => chatPrimaryWithExternalReady,
    })
    expect(exitLoopRes.instruction.action).toBe("judge")
    expect(exitLoopRes.requiresHumanAccept).toBe(true)
    expect(exitLoopRes.summary.draftStatus).toBe("ready")
  })

  it("REV1-001：主槽为无关 ready 草稿时，全新未登记草稿绝不继承 ready 跳到 judge，必须路由 review", async () => {
    const brandNewDraft: ChapterDraft = {
      id: "draft_brand_new_12",
      chapterName: "第12章",
      content: "第十二章初稿正文",
      createdAt: 900,
      status: "draft",
    }
    const unrelatedReadyPrimaryStatus = makeStatus({
      status: "completed",
      draft: {
        draft_id: "conv-unrelated-chat-old",
        file_path: "/proj/.novel/drafts/conv-unrelated-chat-old.json",
        draft_status: "ready",
        updated_at: "2026-11-27T00:00:00Z",
      },
      decision_gates: {
        ...emptyDecisionGates(),
        consistency: { ...emptyDecisionGates().consistency, status: "passed", verdict: "pass" },
        anti_ai: { ...emptyDecisionGates().anti_ai, status: "passed", verdict: "pass" },
        quality: { ...emptyDecisionGates().quality, status: "passed", verdict: "pass" },
        overall: "pass",
      },
      draft_auto_arm: {
        armed: true,
        target: "ready",
        reason: "all_required_gates_pass",
        decidedAt: "2026-11-27T00:00:00Z",
        gateSnapshot: { consistency: "pass", anti_ai: "pass", quality: "pass" },
      },
      external_draft_states: {},
    })

    const res = await runWorkflowNext("/proj", {}, {
      listChapters: async () => Array.from({ length: 11 }, (_, i) => ({
        name: `第${i + 1}章.md`,
        path: `/proj/wiki/chapters/第${i + 1}章.md`,
      })),
      listDrafts: async () => [brandNewDraft],
      loadStatus: async () => unrelatedReadyPrimaryStatus,
      hasPersistedDirectorState: async () => false,
      loadDirectorPersisted: async () => ({
        fileVersion: 1 as const,
        state: createDirectorPipeline(),
        ideaInput: { title: "书", genre: "悬疑", coreConflict: "冲突" },
      }),
      loadWorldBlueprint: async () => null,
      loadOutlineModel: async () => ({ model: null, migratedFrom: null }),
      loadSegmentSummaries: async () => ({}),
      loadStoryCompass: async () => ({
        endingDirection: "",
        openThreads: [],
        estimatedScale: "",
        finalVolumeDeclared: false,
        lastUpdated: "",
      }),
      getChapterVolumes: async () => [],
      collectProjectSnapshot: async (_pp, idea) => ({
        idea,
        worldComplete: true,
        protagonistNamed: true,
        antagonistNamed: true,
        frameworkChosen: true,
        volumesPlanned: true,
        firstChapterReady: true,
      }),
    })

    expect(res.activeDraftId).toBe("draft_brand_new_12")
    expect(res.summary.draftStatus).toBeNull()
    expect(res.instruction.action).toBe("review")
    expect(res.recommendedProfile).toBe("reviewer")
    expect(res.requiresHumanAccept).toBe(false)
    expect(res.controlState.gates).toEqual({
      consistency: "pending",
      anti_ai: "pending",
      quality: "pending",
    })
  })

  it("REV1-002：部分评审态（任一强制门 P0 consistency / P1 anti_ai 为 not_evaluated）均不得早跳 judge，必须路由 review 且保留真实门控摘要", async () => {
    const draft: ChapterDraft = {
      id: "draft_partial_review",
      chapterName: "第2章",
      content: "第二章草稿正文",
      createdAt: 300,
      status: "draft",
    }
    const baseDeps = {
      listChapters: async () => [{ name: "第1章.md", path: "/proj/wiki/chapters/第1章.md" }],
      listDrafts: async () => [draft],
      hasPersistedDirectorState: async () => false,
      loadDirectorPersisted: async () => ({
        fileVersion: 1 as const,
        state: createDirectorPipeline(),
        ideaInput: { title: "书", genre: "悬疑", coreConflict: "冲突" },
      }),
      loadWorldBlueprint: async () => null,
      loadOutlineModel: async () => ({ model: null, migratedFrom: null }),
      loadSegmentSummaries: async () => ({}),
      loadStoryCompass: async () => ({
        endingDirection: "",
        openThreads: [],
        estimatedScale: "",
        finalVolumeDeclared: false,
        lastUpdated: "",
      }),
      getChapterVolumes: async () => [],
      collectProjectSnapshot: async (_pp: string, idea: { title: string; genre: string; coreConflict: string }) => ({
        idea,
        worldComplete: true,
        protagonistNamed: true,
        antagonistNamed: true,
        frameworkChosen: true,
        volumesPlanned: true,
        firstChapterReady: true,
      }),
    }

    const partialCases: Array<{
      label: string
      decisionGates: DeepChapterDecisionGates
      expectedGates: { consistency: "pending" | "pass" | "fail"; anti_ai: "pending" | "pass" | "fail"; quality: "pending" | "pass" | "fail" }
    }> = [
      {
        label: "consistency=not_evaluated & anti_ai=pass",
        decisionGates: {
          ...emptyDecisionGates(),
          consistency: { ...emptyDecisionGates().consistency, status: "pending", verdict: "pending" },
          anti_ai: { ...emptyDecisionGates().anti_ai, status: "passed", verdict: "pass" },
          quality: { ...emptyDecisionGates().quality, status: "pending", verdict: "pending" },
          overall: "pending",
        },
        expectedGates: { consistency: "pending", anti_ai: "pass", quality: "pending" },
      },
      {
        label: "quality=pass only",
        decisionGates: {
          ...emptyDecisionGates(),
          consistency: { ...emptyDecisionGates().consistency, status: "pending", verdict: "pending" },
          anti_ai: { ...emptyDecisionGates().anti_ai, status: "pending", verdict: "pending" },
          quality: { ...emptyDecisionGates().quality, status: "passed", verdict: "pass" },
          overall: "pending",
        },
        expectedGates: { consistency: "pending", anti_ai: "pending", quality: "pass" },
      },
      {
        label: "consistency=pass & anti_ai=not_evaluated",
        decisionGates: {
          ...emptyDecisionGates(),
          consistency: { ...emptyDecisionGates().consistency, status: "passed", verdict: "pass" },
          anti_ai: { ...emptyDecisionGates().anti_ai, status: "pending", verdict: "pending" },
          quality: { ...emptyDecisionGates().quality, status: "pending", verdict: "pending" },
          overall: "pending",
        },
        expectedGates: { consistency: "pass", anti_ai: "pending", quality: "pending" },
      },
    ]

    for (const tc of partialCases) {
      const partialStatus = makeStatus({
        draft: {
          draft_id: draft.id,
          file_path: `/proj/.qm-drafts/${draft.id}.md`,
          draft_status: "pending",
          updated_at: "2026-11-27T00:00:00Z",
        },
        decision_gates: tc.decisionGates,
      })

      const res = await runWorkflowNext("/proj", {}, {
        ...baseDeps,
        loadStatus: async () => partialStatus,
      })

      expect(res.instruction.action, tc.label).toBe("review")
      expect(res.recommendedProfile, tc.label).toBe("reviewer")
      expect(res.requiresHumanAccept, tc.label).toBe(false)
      expect(res.controlState.gates, tc.label).toEqual(tc.expectedGates)
    }
  })
})

describe("workflow-draft-tools: draft.patch", () => {
  it("支持 find/replace（含 occurrence）与 1-based 行号替换（保留 CRLF），派生新草稿并递增 revisionRound 且不带 adoptionGate", async () => {
    const parentContent = "第一行：雨夜。\r\n第二行：旧词出现，旧词再现。\r\n第三行：结尾。"
    const parentSha = await computeCheckpointDigest(parentContent)
    const parent: ChapterDraft = {
      id: "draft_parent_1",
      chapterName: "第3章-雨夜",
      content: parentContent,
      createdAt: 1000,
      status: "draft",
      sourceConversationId: "mcp:chapter.write",
      revisionRound: 1,
    }

    const writeDraftSpy = vi.fn(async (_pp, chapterName, content, meta) => ({
      id: "draft_child_2",
      chapterName,
      content,
      createdAt: 2000,
      status: "draft" as const,
      sourceConversationId: meta?.sourceConversationId,
      parentDraftId: meta?.parentDraftId,
      revisionRound: meta?.revisionRound,
    }))

    const res = await runDraftPatch(
      "/proj",
      {
        draftId: "draft_parent_1",
        expectedSha256: parentSha,
        edits: [
          { find: "旧词", replace: "新词", occurrence: 2 },
          { startLine: 3, endLine: 3, replacement: "第三行：冷峻收尾。" },
        ],
        note: "修复第二处重复词并润色结尾",
      },
      { listDrafts: async () => [parent], writeDraft: writeDraftSpy },
    )

    expect(res.draftId).toBe("draft_child_2")
    expect(res.parentDraftId).toBe("draft_parent_1")
    expect(res.revisionRound).toBe(2)
    expect(res.remainingRounds).toBe(HARD_FUSE_LIMIT - 2)
    expect(res.editsApplied).toBe(2)
    expect(res.parentBodySha256).toBe(parentSha)

    const writtenContent = writeDraftSpy.mock.calls[0]?.[2]
    const writtenMeta = writeDraftSpy.mock.calls[0]?.[3]
    expect(writtenContent).toBe("第一行：雨夜。\r\n第二行：旧词出现，新词再现。\r\n第三行：冷峻收尾。")
    expect(writtenMeta).toEqual({
      sourceConversationId: "mcp:draft.patch",
      parentDraftId: "draft_parent_1",
      revisionRound: 2,
    })
    expect("adoptionGate" in (writtenMeta ?? {})).toBe(false)
    expect(res.bodySha256).toBe(await computeCheckpointDigest(writtenContent!))
  })

  it("拒绝受采纳门保护草稿、HARD_FUSE_LIMIT 越限、SHA 漂移、混用字段、歧义匹配与重叠区间", async () => {
    const content = "甲乙甲乙\n第二行"
    const sha = await computeCheckpointDigest(content)
    const writeDraftSpy = vi.fn()

    // 1. GATED_DRAFT_PATCH_FORBIDDEN
    for (const gatedDraft of [
      { id: "d1", chapterName: "第1章", content, createdAt: 1, status: "draft" as const, adoptionGate: { status: "unassessed" as const } },
      { id: "d1", chapterName: "第1章", content, createdAt: 1, status: "draft" as const, sourceConversationId: "mcp:deep-chapter" },
      { id: "d1", chapterName: "第1章", content, createdAt: 1, status: "draft" as const, sourceConversationId: "mcp:external-agent" },
    ]) {
      await expect(
        runDraftPatch(
          "/proj",
          { draftId: "d1", expectedSha256: sha, edits: [{ find: "第二行", replace: "新行" }] },
          { listDrafts: async () => [gatedDraft], writeDraft: writeDraftSpy },
        ),
      ).rejects.toThrow(/GATED_DRAFT_PATCH_FORBIDDEN/)
    }

    // 2. HARD_FUSE_LIMIT_EXCEEDED
    await expect(
      runDraftPatch(
        "/proj",
        { draftId: "d1", expectedSha256: sha, edits: [{ find: "第二行", replace: "新行" }] },
        {
          listDrafts: async () => [
            { id: "d1", chapterName: "第1章", content, createdAt: 1, status: "draft", revisionRound: HARD_FUSE_LIMIT },
          ],
          writeDraft: writeDraftSpy,
        },
      ),
    ).rejects.toThrow(/HARD_FUSE_LIMIT_EXCEEDED/)

    // 3. DRAFT_SHA256_MISMATCH
    await expect(
      runDraftPatch(
        "/proj",
        { draftId: "d1", expectedSha256: "0".repeat(64), edits: [{ find: "第二行", replace: "新行" }] },
        {
          listDrafts: async () => [
            { id: "d1", chapterName: "第1章", content, createdAt: 1, status: "draft" },
          ],
          writeDraft: writeDraftSpy,
        },
      ),
    ).rejects.toThrow(/DRAFT_SHA256_MISMATCH/)

    // 4. 混用 find 与 startLine
    await expect(
      runDraftPatch("/proj", {
        draftId: "d1",
        expectedSha256: sha,
        edits: [{ find: "甲", replace: "丙", startLine: 1, endLine: 1, replacement: "x" }],
      }),
    ).rejects.toThrow(/不能混用/)

    // 5. 歧义匹配（多处出现且未指定 occurrence）
    await expect(
      runDraftPatch(
        "/proj",
        { draftId: "d1", expectedSha256: sha, edits: [{ find: "甲", replace: "丙" }] },
        {
          listDrafts: async () => [
            { id: "d1", chapterName: "第1章", content, createdAt: 1, status: "draft" },
          ],
          writeDraft: writeDraftSpy,
        },
      ),
    ).rejects.toThrow(/歧义/)

    // 6. 重叠编辑区间
    await expect(
      runDraftPatch(
        "/proj",
        {
          draftId: "d1",
          expectedSha256: sha,
          edits: [
            { find: "甲乙甲", replace: "X" },
            { find: "乙甲乙", replace: "Y" },
          ],
        },
        {
          listDrafts: async () => [
            { id: "d1", chapterName: "第1章", content, createdAt: 1, status: "draft" },
          ],
          writeDraft: writeDraftSpy,
        },
      ),
    ).rejects.toThrow(/DRAFT_PATCH_OVERLAPPING_EDITS/)

    expect(writeDraftSpy).not.toHaveBeenCalled()
  })

  it("B-2：note 长度上限对齐 Rust 1000 字符（600 / 1000 通过，1001 拒绝）", async () => {
    const content = "原始段落内容。"
    const sha = await computeCheckpointDigest(content)
    const parent: ChapterDraft = {
      id: "draft_note_1",
      chapterName: "第2章",
      content,
      createdAt: 1000,
      status: "draft",
    }
    const writeDraftSpy = vi.fn(async (_pp, chapterName, nextContent, meta) => ({
      id: "draft_note_2",
      chapterName,
      content: nextContent,
      createdAt: 2000,
      status: "draft" as const,
      parentDraftId: meta?.parentDraftId,
      revisionRound: meta?.revisionRound,
    }))

    const note600 = "修".repeat(600)
    const ok600 = await runDraftPatch(
      "/proj",
      {
        draftId: "draft_note_1",
        expectedSha256: sha,
        edits: [{ find: "原始", replace: "修订" }],
        note: note600,
      },
      { listDrafts: async () => [parent], writeDraft: writeDraftSpy },
    )
    expect(ok600.note).toBe(note600)

    const note1000 = "注".repeat(1000)
    const ok1000 = await runDraftPatch(
      "/proj",
      {
        draftId: "draft_note_1",
        expectedSha256: sha,
        edits: [{ find: "原始", replace: "修订" }],
        note: note1000,
      },
      { listDrafts: async () => [parent], writeDraft: writeDraftSpy },
    )
    expect(ok1000.note).toBe(note1000)

    await expect(
      runDraftPatch(
        "/proj",
        {
          draftId: "draft_note_1",
          expectedSha256: sha,
          edits: [{ find: "原始", replace: "修订" }],
          note: "超".repeat(1001),
        },
        { listDrafts: async () => [parent], writeDraft: writeDraftSpy },
      ),
    ).rejects.toThrow(/1000/)
  })

  it("R2 Advisory #2：与 draft-manager 共用 draft:<path> 锁键，避免并发采纳/丢弃与修订竞态", async () => {
    const content = "并发锁测试正文。"
    const sha = await computeCheckpointDigest(content)
    const parent: ChapterDraft = {
      id: "draft_lock_1",
      chapterName: "第4章",
      content,
      createdAt: 1000,
      status: "draft",
    }
    const events: string[] = []
    let releaseLock!: () => void
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    let notifyEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve
    })

    const holder = withProjectLock(`draft:/proj/${DRAFTS_DIR}/draft_lock_1.md`, async () => {
      events.push("holder:enter")
      notifyEntered()
      await lockHeld
      events.push("holder:exit")
    })
    await entered

    const patchPromise = runDraftPatch(
      "/proj",
      {
        draftId: "draft_lock_1",
        expectedSha256: sha,
        edits: [{ find: "测试", replace: "通过" }],
      },
      {
        listDrafts: async () => {
          events.push("patch:list")
          return [parent]
        },
        writeDraft: async (_pp, chapterName, nextContent, meta) => {
          events.push("patch:write")
          return {
            id: "draft_lock_2",
            chapterName,
            content: nextContent,
            createdAt: 2000,
            status: "draft",
            parentDraftId: meta?.parentDraftId,
            revisionRound: meta?.revisionRound,
          }
        },
      },
    )

    // 稍等微任务队列，确认 patch 仍阻塞在共享草稿锁外
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(["holder:enter"])

    releaseLock()
    await holder
    const patched = await patchPromise
    expect(patched.draftId).toBe("draft_lock_2")
    expect(events).toEqual(["holder:enter", "holder:exit", "patch:list", "patch:write"])
  })

  it("章节级持久硬熔断：即使父草稿 revisionRound=0，status.json 已达 HARD_FUSE_LIMIT 仍拒绝并阻止写盘；正常 patch 同步 status.json", async () => {
    const content = "持久熔断测试正文。"
    const sha = await computeCheckpointDigest(content)
    const oldParent: ChapterDraft = {
      id: "draft_ch3_root",
      chapterName: "第3章",
      content,
      createdAt: 100,
      status: "draft",
      // 旧根草稿自身无 revisionRound
    }
    const writeDraftSpy = vi.fn()
    const syncSpy = vi.fn(async () => null)

    // 1. status.json 已记录 chapter:3 达 HARD_FUSE_LIMIT=5 -> 禁止通过回退旧 draftId 绕过
    await expect(
      runDraftPatch(
        "/proj",
        { draftId: "draft_ch3_root", expectedSha256: sha, edits: [{ find: "测试", replace: "绕过" }] },
        {
          listDrafts: async () => [oldParent],
          writeDraft: writeDraftSpy,
          loadStatus: async () => makeStatus({ external_draft_revisions: { "chapter:3": HARD_FUSE_LIMIT } }),
          syncExternalDraft: syncSpy,
        },
      ),
    ).rejects.toThrow(/HARD_FUSE_LIMIT_EXCEEDED/)
    expect(writeDraftSpy).not.toHaveBeenCalled()
    expect(syncSpy).not.toHaveBeenCalled()

    // 2. status.json 记录 chapter:3=2 -> 下一轮基于 max(0, 2)+1 = 3 并同步至 status.json
    writeDraftSpy.mockResolvedValueOnce({
      id: "draft_ch3_r3",
      chapterName: "第3章",
      content: "持久熔断更新正文。",
      createdAt: 200,
      status: "draft",
      parentDraftId: "draft_ch3_root",
      revisionRound: 3,
    })
    const patched = await runDraftPatch(
      "/proj",
      { draftId: "draft_ch3_root", expectedSha256: sha, edits: [{ find: "测试", replace: "更新" }] },
      {
        listDrafts: async () => [oldParent],
        writeDraft: writeDraftSpy,
        loadStatus: async () => makeStatus({ external_draft_revisions: { "chapter:3": 2 } }),
        syncExternalDraft: syncSpy,
      },
    )
    expect(patched.revisionRound).toBe(3)
    expect(syncSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/proj",
        draftId: "draft_ch3_r3",
        targetKey: "chapter:3",
        revisionRound: 3,
      }),
    )
  })
})

describe("workflow-draft-tools: draft.record_review (Watchlist #6 P0>P1>P2 & status.json 守恒)", () => {
  const draft: ChapterDraft = {
    id: "draft_1",
    chapterName: "第1章",
    content: "第一章测试正文内容。",
    createdAt: 100,
    status: "draft",
  }

  it("P0+P1 全通过且 quality=warning 时：auto-arm 升匹配草稿 pending→ready，保留 avoid_ai_summary 与 quality.verdict=warning，绝不写 accepted", async () => {
    const sha = await computeCheckpointDigest(draft.content)
    let persisted: NovelSessionStatus | null = makeStatus()

    const res = await runDraftRecordReview(
      "/proj",
      {
        draftId: "draft_1",
        expectedSha256: sha,
        gates: { consistency: "pass", anti_ai: "pass", quality: "warning" },
        overallScore: 8.6,
        dimensionScores: { consistency: 9.2, thrill: 8.0 },
        summary: "逻辑扎实，爽点节奏略缓",
      },
      {
        listDrafts: async () => [draft],
        updateSessionStatus: async (_pp, mutator) => {
          persisted = await mutator(persisted)
          return persisted
        },
        nowIso: () => "2026-11-26T12:00:00Z",
      },
    )

    expect(res.autoArm.armed).toBe(true)
    expect(res.autoArm.target).toBe("ready")
    expect(res.autoArm.gateSnapshot).toEqual({
      consistency: "pass",
      anti_ai: "pass",
      quality: "pass",
    })
    expect(res.statusJsonUpdated).toBe(true)
    expect(res.draftStatusBefore).toBe("pending")
    expect(res.draftStatusAfter).toBe("ready")
    expect(res.requiresHumanAccept).toBe(true)

    expect(persisted?.draft.draft_status).toBe("ready")
    expect(persisted?.decision_gates.quality.verdict).toBe("warning")
    expect(persisted?.draft_auto_arm?.armed).toBe(true)
    expect(persisted?.draft_auto_arm?.target).toBe("ready")
    expect(persisted?.avoid_ai_summary?.score).toBe(88)
    expect(persisted?.dimension_results?.consistency?.score).toBe(9.2)
  })

  it("P0 consistency 失败时即使 quality=pass 且 overallScore=9.9，绝不覆盖失败且绝不升 ready", async () => {
    const sha = await computeCheckpointDigest(draft.content)
    let persisted: NovelSessionStatus | null = makeStatus()

    const res = await runDraftRecordReview(
      "/proj",
      {
        draftId: "draft_1",
        expectedSha256: sha,
        gates: { consistency: "fail", anti_ai: "pass", quality: "pass" },
        overallScore: 9.9,
        blockingIssues: ["已故角色老周再次出现"],
      },
      {
        listDrafts: async () => [draft],
        updateSessionStatus: async (_pp, mutator) => {
          persisted = await mutator(persisted)
          return persisted
        },
      },
    )

    expect(res.overallVerdict).toBe("fail")
    expect(res.blockingGate).toBe("consistency")
    expect(res.autoArm.armed).toBe(false)
    expect(res.autoArm.reason).toBe("gate_failed:consistency")
    expect(res.draftStatusAfter).toBe("pending")
    expect(persisted?.draft.draft_status).toBe("pending")
  })

  it("status.json 未初始化时直接初始化唯一真源；旧 .qm-drafts/ 或空闲会话重绑主槽；运行中 Chat .novel/drafts/ 会话隔离写入 external_draft_states", async () => {
    const sha = await computeCheckpointDigest(draft.content)

    // 1. status.json === null -> 直接初始化 .novel/status.json（绝不另建第二份状态文件）并退出 review 死循环
    const captured: { initialized: NovelSessionStatus | null } = { initialized: null }
    const initRes = await runDraftRecordReview(
      "/proj",
      {
        draftId: "draft_1",
        expectedSha256: sha,
        gates: { consistency: "pass", anti_ai: "pass" },
      },
      {
        listDrafts: async () => [draft],
        runMechanicalGate: async () => makeCleanMechanicalReport(),
        updateSessionStatus: async (_pp, mutator) => {
          captured.initialized = await mutator(null)
          return captured.initialized
        },
        nowIso: () => "2026-11-27T10:00:00Z",
      },
    )
    expect(initRes.statusJsonUpdated).toBe(true)
    expect(initRes.statusJsonReason).toBe("initialized_for_draft")
    expect(initRes.matchingDraftInStatus).toBe(true)
    expect(initRes.draftStatusBefore).toBeNull()
    expect(initRes.draftStatusAfter).toBe("ready")
    expect(captured.initialized?.draft.draft_id).toBe("draft_1")
    expect(captured.initialized?.draft.draft_status).toBe("ready")
    expect(captured.initialized?.external_draft_states?.draft_1?.draft_status).toBe("ready")

    // 2. status.json 指向旧 .qm-drafts/draft_other.md -> 重绑主槽至 draft_1 并保留 additive 字段
    const oldExternalStatus = makeStatus({
      draft: {
        draft_id: "draft_other",
        file_path: "/proj/.qm-drafts/draft_other.md",
        draft_status: "pending",
        updated_at: "2026-11-26T00:00:00Z",
      },
    })
    let reboundStatus: NovelSessionStatus | null = oldExternalStatus
    const reboundRes = await runDraftRecordReview(
      "/proj",
      {
        draftId: "draft_1",
        expectedSha256: sha,
        gates: { consistency: "pass", anti_ai: "pass" },
      },
      {
        listDrafts: async () => [draft],
        runMechanicalGate: async () => makeCleanMechanicalReport(),
        updateSessionStatus: async (_pp, mutator) => {
          reboundStatus = await mutator(reboundStatus)
          return reboundStatus
        },
        nowIso: () => "2026-11-27T10:05:00Z",
      },
    )
    expect(reboundRes.statusJsonUpdated).toBe(true)
    expect(reboundRes.statusJsonReason).toBe("rebound_external_draft")
    expect(reboundRes.matchingDraftInStatus).toBe(true)
    expect(reboundRes.draftStatusAfter).toBe("ready")
    expect(reboundStatus?.draft.draft_id).toBe("draft_1")
    expect(reboundStatus?.avoid_ai_summary?.score).toBe(88)

    // 3. status.json 正被运行中 Chat .novel/drafts/ 会话占用 -> 绝不覆盖主槽，隔离落盘至 external_draft_states[draft.id]
    const existingAutoArm = {
      armed: false,
      target: null,
      reason: "gate_failed:consistency",
      decidedAt: "2026-11-26T01:00:00Z",
      gateSnapshot: {
        consistency: "fail" as const,
        anti_ai: "pass" as const,
        quality: "not_evaluated" as const,
      },
    }
    const liveChatStatus = makeStatus({
      status: "running",
      draft: {
        draft_id: "conv-live-chat",
        file_path: "/proj/.novel/drafts/conv-live-chat.json",
        draft_status: "pending",
        updated_at: "2026-11-26T00:00:00Z",
      },
      draft_auto_arm: existingAutoArm,
    })
    let isolatedStatus: NovelSessionStatus | null = liveChatStatus
    const isolatedRes = await runDraftRecordReview(
      "/proj",
      {
        draftId: "draft_1",
        expectedSha256: sha,
        gates: { consistency: "pass", anti_ai: "pass" },
      },
      {
        listDrafts: async () => [draft],
        runMechanicalGate: async () => makeCleanMechanicalReport(),
        updateSessionStatus: async (_pp, mutator) => {
          isolatedStatus = await mutator(isolatedStatus)
          return isolatedStatus
        },
        nowIso: () => "2026-11-27T10:10:00Z",
      },
    )
    expect(isolatedRes.matchingDraftInStatus).toBe(false)
    expect(isolatedRes.statusJsonUpdated).toBe(true)
    expect(isolatedRes.statusJsonReason).toBe("updated_external_draft_state")
    expect(isolatedRes.draftStatusAfter).toBe("ready")
    expect(isolatedStatus?.draft.draft_id).toBe("conv-live-chat")
    expect(isolatedStatus?.draft.draft_status).toBe("pending")
    expect(isolatedStatus?.draft_auto_arm).toEqual(existingAutoArm)
    expect(isolatedStatus?.external_draft_states?.draft_1?.draft_status).toBe("ready")
    expect(isolatedStatus?.external_draft_states?.draft_1?.draft_auto_arm?.armed).toBe(true)
  })

  it("B-2：blockingIssues[i] 长度上限对齐 Rust 1000 字符（600 / 1000 通过，1001 拒绝）", async () => {
    const sha = await computeCheckpointDigest(draft.content)
    const issue600 = "缺".repeat(600)
    const ok600 = await runDraftRecordReview(
      "/proj",
      {
        draftId: "draft_1",
        expectedSha256: sha,
        gates: { consistency: "fail", anti_ai: "pass" },
        blockingIssues: [issue600],
      },
      {
        listDrafts: async () => [draft],
        updateSessionStatus: async (_pp, mutator) => mutator(makeStatus()),
      },
    )
    expect(ok600.blockingIssues).toEqual([issue600])

    const issue1000 = "误".repeat(1000)
    const ok1000 = await runDraftRecordReview(
      "/proj",
      {
        draftId: "draft_1",
        expectedSha256: sha,
        gates: { consistency: "fail", anti_ai: "pass" },
        blockingIssues: [issue1000],
      },
      {
        listDrafts: async () => [draft],
        updateSessionStatus: async (_pp, mutator) => mutator(makeStatus()),
      },
    )
    expect(ok1000.blockingIssues).toEqual([issue1000])

    await expect(
      runDraftRecordReview(
        "/proj",
        {
          draftId: "draft_1",
          expectedSha256: sha,
          gates: { consistency: "fail", anti_ai: "pass" },
          blockingIssues: ["超".repeat(1001)],
        },
        { listDrafts: async () => [draft] },
      ),
    ).rejects.toThrow(/1000/)
  })

  it("consistency 或 anti_ai 为 not_evaluated 时 autoArm.armed=false 且 draft_status 保持 pending", async () => {
    const sha = await computeCheckpointDigest(draft.content)
    for (const gates of [
      { consistency: "not_evaluated" as const, anti_ai: "pass" as const },
      { consistency: "pass" as const, anti_ai: "not_evaluated" as const },
    ]) {
      let persisted: NovelSessionStatus | null = makeStatus()
      const res = await runDraftRecordReview(
        "/proj",
        {
          draftId: "draft_1",
          expectedSha256: sha,
          gates,
        },
        {
          listDrafts: async () => [draft],
          updateSessionStatus: async (_pp, mutator) => {
            persisted = await mutator(persisted)
            return persisted
          },
        },
      )
      expect(res.autoArm.armed).toBe(false)
      expect(res.requiresHumanAccept).toBe(false)
      expect(res.draftStatusBefore).toBe("pending")
      expect(res.draftStatusAfter).toBe("pending")
      expect(persisted?.draft.draft_status).toBe("pending")
    }
  })

  it("status.json 已有 ready/accepted/rejected/superseded 时，draft.record_review 绝不覆盖 draft.draft_status", async () => {
    const sha = await computeCheckpointDigest(draft.content)
    const protectedStatuses: NovelDraftStatus[] = ["ready", "accepted", "rejected", "superseded"]

    for (const initialStatus of protectedStatuses) {
      let persisted: NovelSessionStatus | null = makeStatus({
        draft: {
          draft_id: "draft_1",
          file_path: "/proj/.qm-drafts/draft_1.md",
          draft_status: initialStatus,
          updated_at: "2026-11-26T00:00:00Z",
        },
      })
      const res = await runDraftRecordReview(
        "/proj",
        {
          draftId: "draft_1",
          expectedSha256: sha,
          gates: { consistency: "pass", anti_ai: "pass", quality: "pass" },
        },
        {
          listDrafts: async () => [draft],
          updateSessionStatus: async (_pp, mutator) => {
            persisted = await mutator(persisted)
            return persisted
          },
        },
      )
      expect(res.draftStatusBefore).toBe(initialStatus)
      expect(res.draftStatusAfter).toBe(initialStatus)
      expect(persisted?.draft.draft_status).toBe(initialStatus)
    }
  })

  it("R2 Advisory #3：草稿 status !== 'draft' 时直接拒绝 DRAFT_NOT_REVIEWABLE 且不触碰 status.json", async () => {
    const sha = await computeCheckpointDigest(draft.content)
    const updateSpy = vi.fn()

    for (const status of ["saved", "failed", "saving", "confirming"] as const) {
      const nonDraft: ChapterDraft = { ...draft, status }
      await expect(
        runDraftRecordReview(
          "/proj",
          {
            draftId: "draft_1",
            expectedSha256: sha,
            gates: { consistency: "pass", anti_ai: "pass" },
          },
          {
            listDrafts: async () => [nonDraft],
            updateSessionStatus: updateSpy,
          },
        ),
      ).rejects.toThrow(/DRAFT_NOT_REVIEWABLE/)
    }

    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("严格校验非法 dimensionScores 键与 SHA 不匹配", async () => {
    const sha = await computeCheckpointDigest(draft.content)

    await expect(
      runDraftRecordReview("/proj", {
        draftId: "draft_1",
        expectedSha256: sha,
        gates: { consistency: "pass", anti_ai: "pass" },
        dimensionScores: { thril: 9.0 },
      }),
    ).rejects.toThrow(/SIX_REVIEW_DIMENSION_ORDER/)

    await expect(
      runDraftRecordReview(
        "/proj",
        {
          draftId: "draft_1",
          expectedSha256: "f".repeat(64),
          gates: { consistency: "pass", anti_ai: "pass" },
        },
        { listDrafts: async () => [draft] },
      ),
    ).rejects.toThrow(/DRAFT_SHA256_MISMATCH/)
  })

  it("反自证机械守卫：调用方自称 pass 但 runMechanicalGate 检出 P0/P1 错误时强制覆写 fail 且绝不升 ready", async () => {
    const sha = await computeCheckpointDigest(draft.content)

    // P0 机械错误覆写 consistency -> fail
    let persistedP0: NovelSessionStatus | null = makeStatus()
    const p0Report = makeCleanMechanicalReport()
    p0Report.verdict = "fail"
    p0Report.blockingGate = "consistency"
    p0Report.summary.verdict = "fail"
    p0Report.summary.blockingGate = "consistency"
    p0Report.summary.p0ErrorCount = 1
    p0Report.issues = [
      {
        priority: "P0",
        gate: "consistency",
        severity: "error",
        type: "consistency_mechanical",
        message: "已死亡角色陈伯重新出场",
        evidence: "陈伯推门而入",
        suggestion: "删除陈伯复活情节",
      },
    ]
    const p0Res = await runDraftRecordReview(
      "/proj",
      {
        draftId: "draft_1",
        expectedSha256: sha,
        gates: { consistency: "pass", anti_ai: "pass", quality: "pass" },
      },
      {
        listDrafts: async () => [draft],
        runMechanicalGate: async () => p0Report,
        updateSessionStatus: async (_pp, mutator) => {
          persistedP0 = await mutator(persistedP0)
          return persistedP0
        },
      },
    )
    expect(p0Res.gates.consistency).toBe("fail")
    expect(p0Res.overallVerdict).toBe("fail")
    expect(p0Res.blockingGate).toBe("consistency")
    expect(p0Res.autoArm.armed).toBe(false)
    expect(p0Res.draftStatusAfter).toBe("pending")
    expect(p0Res.blockingIssues).toEqual(expect.arrayContaining([expect.stringContaining("已死亡角色陈伯重新出场")]))
    expect(persistedP0?.decision_gates.consistency.findings).toHaveLength(1)

    // P1 机械错误覆写 anti_ai -> fail
    let persistedP1: NovelSessionStatus | null = makeStatus()
    const p1Report = makeCleanMechanicalReport()
    p1Report.verdict = "fail"
    p1Report.blockingGate = "anti_ai"
    p1Report.summary.verdict = "fail"
    p1Report.summary.blockingGate = "anti_ai"
    p1Report.summary.p1ErrorCount = 1
    p1Report.issues = [
      {
        priority: "P1",
        gate: "anti_ai",
        severity: "error",
        type: "anti_ai",
        message: "机械 slop 阻断: penalty 8.5/10",
        evidence: "penalty 8.5/10",
        suggestion: "删除总结腔",
      },
    ]
    const p1Res = await runDraftRecordReview(
      "/proj",
      {
        draftId: "draft_1",
        expectedSha256: sha,
        gates: { consistency: "pass", anti_ai: "pass", quality: "pass" },
      },
      {
        listDrafts: async () => [draft],
        runMechanicalGate: async () => p1Report,
        updateSessionStatus: async (_pp, mutator) => {
          persistedP1 = await mutator(persistedP1)
          return persistedP1
        },
      },
    )
    expect(p1Res.gates.consistency).toBe("pass")
    expect(p1Res.gates.anti_ai).toBe("fail")
    expect(p1Res.blockingGate).toBe("anti_ai")
    expect(p1Res.autoArm.armed).toBe(false)
    expect(p1Res.draftStatusAfter).toBe("pending")
  })

  it("quality === 'fail'（overallVerdict === 'fail'）绝不升格为 ready，且 pass/warning 清理旧 findings 与 repair_suggestions", async () => {
    const sha = await computeCheckpointDigest(draft.content)

    // 1. quality=fail 禁止 auto-arm ready
    let persistedFail: NovelSessionStatus | null = makeStatus()
    const qualityFailRes = await runDraftRecordReview(
      "/proj",
      {
        draftId: "draft_1",
        expectedSha256: sha,
        gates: { consistency: "pass", anti_ai: "pass", quality: "fail" },
        blockingIssues: ["高潮推进失速，钩子缺失"],
      },
      {
        listDrafts: async () => [draft],
        runMechanicalGate: async () => makeCleanMechanicalReport(),
        updateSessionStatus: async (_pp, mutator) => {
          persistedFail = await mutator(persistedFail)
          return persistedFail
        },
      },
    )
    expect(qualityFailRes.overallVerdict).toBe("fail")
    expect(qualityFailRes.autoArm.armed).toBe(false)
    expect(qualityFailRes.autoArm.reason).toBe("gate_failed:quality")
    expect(qualityFailRes.draftStatusAfter).toBe("pending")
    expect(qualityFailRes.requiresHumanAccept).toBe(false)
    expect(persistedFail?.draft.draft_status).toBe("pending")

    // 2. 从旧失败态转 pass/warning：清空 pass 门旧 findings 与 repair_suggestions，warning 门剔除旧 error finding
    let persistedWithStale: NovelSessionStatus | null = makeStatus({
      decision_gates: {
        consistency: {
          status: "failed",
          verdict: "fail",
          findings: [
            {
              severity: "error",
              type: "consistency_mechanical",
              message: "旧错误",
              evidence: "e",
              relatedMemory: "",
              suggestion: "s",
            },
          ],
          repair_suggestions: ["旧修复建议"],
          retry_count: 1,
        },
        anti_ai: {
          status: "failed",
          verdict: "fail",
          findings: [
            {
              severity: "error",
              type: "anti_ai",
              message: "旧AI味错误",
              evidence: "e",
              relatedMemory: "",
              suggestion: "s",
            },
          ],
          repair_suggestions: ["旧去AI建议"],
          retry_count: 1,
        },
        quality: {
          status: "failed",
          verdict: "fail",
          findings: [
            {
              severity: "error",
              type: "quality",
              message: "旧质量严重错误",
              evidence: "e",
              relatedMemory: "",
              suggestion: "s",
            },
            {
              severity: "warning",
              type: "quality",
              message: "保留的质量提示",
              evidence: "e2",
              relatedMemory: "",
              suggestion: "s2",
            },
          ],
          repair_suggestions: ["旧质量修复建议"],
          retry_count: 1,
        },
        overall: "fail",
      },
    })
    await runDraftRecordReview(
      "/proj",
      {
        draftId: "draft_1",
        expectedSha256: sha,
        gates: { consistency: "pass", anti_ai: "pass", quality: "warning" },
      },
      {
        listDrafts: async () => [draft],
        runMechanicalGate: async () => makeCleanMechanicalReport(),
        updateSessionStatus: async (_pp, mutator) => {
          persistedWithStale = await mutator(persistedWithStale)
          return persistedWithStale
        },
      },
    )
    expect(persistedWithStale?.decision_gates.consistency.findings).toEqual([])
    expect(persistedWithStale?.decision_gates.consistency.repair_suggestions).toEqual([])
    expect(persistedWithStale?.decision_gates.anti_ai.findings).toEqual([])
    expect(persistedWithStale?.decision_gates.anti_ai.repair_suggestions).toEqual([])
    expect(persistedWithStale?.decision_gates.quality.findings.map((f) => f.message)).toEqual(["保留的质量提示"])
    expect(persistedWithStale?.decision_gates.quality.repair_suggestions).toEqual([])
  })

  it("辅助导出契约：externalDraftTargetKey 归一与 buildNextStatus 7 项 additive 字段透传", () => {
    expect(externalDraftTargetKey("/proj", "第1章")).toBe("chapter:1")
    expect(externalDraftTargetKey("C:\\proj\\", "第一章-重来")).toBe("chapter:1")
    expect(externalDraftTargetKey("/proj", "chapter-001")).toBe("chapter:1")
    expect(externalDraftTargetKey("/proj", "序章")).toBe("path:wiki/chapters/序章.md")

    const base = makeStatus({
      external_draft_revisions: { "chapter:1": 3 },
      pending_rewrites: [2],
      review_interval: 5,
      last_global_review_chapter: 5,
      arc_settlement_completed: { "chapter:10": { arc_review: true } },
      book_completed: false,
    })
    expect(getExternalDraftRevisionCount(base, "chapter:1")).toBe(3)
    expect(getExternalDraftRevisionCount(base, "chapter:9")).toBe(0)
    const next = buildNextStatus(base, {
      updated_at: "2026-11-27T12:00:00Z",
      status: "running",
    })
    expect(next.external_draft_revisions).toEqual({ "chapter:1": 3 })
    expect(next.pending_rewrites).toEqual([2])
    expect(next.review_interval).toBe(5)
    expect(next.last_global_review_chapter).toBe(5)
    expect(next.arc_settlement_completed).toEqual({ "chapter:10": { arc_review: true } })
    expect(next.book_completed).toBe(false)
  })
})
