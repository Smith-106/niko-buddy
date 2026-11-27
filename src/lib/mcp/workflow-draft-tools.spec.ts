// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest"
import {
  DRAFTS_DIR,
  HARD_FUSE_LIMIT,
  computeCheckpointDigest,
  createDirectorPipeline,
  emptyDecisionGates,
  withProjectLock,
  type ChapterDraft,
  type NovelDraftStatus,
  type NovelSessionStatus,
} from "@/lib/novel"
import {
  runDraftPatch,
  runDraftRecordReview,
  runWorkflowNext,
} from "./workflow-draft-tools"

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

  it("status.json 未初始化时返回 null 绝不新建第二份状态文件；草稿 ID 不匹配时不晋升无关草稿", async () => {
    const sha = await computeCheckpointDigest(draft.content)

    // 1. status.json === null
    const noInitRes = await runDraftRecordReview(
      "/proj",
      {
        draftId: "draft_1",
        expectedSha256: sha,
        gates: { consistency: "pass", anti_ai: "pass" },
      },
      {
        listDrafts: async () => [draft],
        updateSessionStatus: async (_pp, mutator) => {
          const out = await mutator(null)
          expect(out).toBeNull()
          return out
        },
      },
    )
    expect(noInitRes.statusJsonUpdated).toBe(false)
    expect(noInitRes.statusJsonReason).toBe("status_json_not_initialized")

    // 2. B-4：status.json 指向其他草稿 draft_other -> 短路返回 null（零写盘），不污染 draft_auto_arm 与 draft_status
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
    const otherStatus = makeStatus({
      draft: {
        draft_id: "draft_other",
        file_path: "/proj/.qm-drafts/draft_other.md",
        draft_status: "pending",
        updated_at: "2026-11-26T00:00:00Z",
      },
      draft_auto_arm: existingAutoArm,
    })
    const diskWriteSpy = vi.fn()
    const nonMatchRes = await runDraftRecordReview(
      "/proj",
      {
        draftId: "draft_1",
        expectedSha256: sha,
        gates: { consistency: "pass", anti_ai: "pass" },
      },
      {
        listDrafts: async () => [draft],
        updateSessionStatus: async (_pp, mutator) => {
          const out = await mutator(otherStatus)
          expect(out).toBeNull()
          if (out !== null) diskWriteSpy(out)
          return out
        },
      },
    )
    expect(diskWriteSpy).not.toHaveBeenCalled()
    expect(nonMatchRes.matchingDraftInStatus).toBe(false)
    expect(nonMatchRes.statusJsonUpdated).toBe(false)
    expect(nonMatchRes.statusJsonReason).toBe("draft_id_mismatch")
    expect(nonMatchRes.draftStatusBefore).toBe("pending")
    expect(nonMatchRes.draftStatusAfter).toBe("pending")
    expect(otherStatus.draft.draft_status).toBe("pending")
    expect(otherStatus.draft_auto_arm).toEqual(existingAutoArm)
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
})
