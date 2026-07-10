import { beforeEach, describe, expect, it, vi } from "vitest"

// fs mocks — appendRewriteRateASample 经 loadCognitionState/saveCognitionState
// 写 cognition-state.json；appendStageMetric 经 loadNovelSessionStatus/
// saveNovelSessionStatus（writeVerifiedJson: writeFileAtomic + readFile 回读）
// 写 status.json stage_metrics。
//
// 用模块级 Map 模拟磁盘：writeFileAtomic 写入 Map，readFile 从 Map 读（支持
// writeVerifiedJson 写入后回读验证）。beforeEach 清空 Map 隔离 test。
const diskStore = new Map<string, string>()
const fsMocks = vi.hoisted(() => ({
  fileExists: vi.fn(async (path: string): Promise<boolean> => diskStore.has(path)),
  readFile: vi.fn(async (path: string): Promise<string> => {
    const content = diskStore.get(path)
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  }),
  writeFileAtomic: vi.fn(async (path: string, contents: string): Promise<void> => {
    diskStore.set(path, contents)
  }),
  createDirectory: vi.fn(async (_path: string): Promise<void> => {}),
  listDirectory: vi.fn(async (_path: string): Promise<any[]> => []),
  getFileModifiedTime: vi.fn(async (_path: string): Promise<number> => 0),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  fileExists: fsMocks.fileExists,
  writeFileAtomic: fsMocks.writeFileAtomic,
  createDirectory: fsMocks.createDirectory,
  listDirectory: fsMocks.listDirectory,
  getFileModifiedTime: fsMocks.getFileModifiedTime,
}))

import {
  appendRewriteRateASample,
  loadCognitionState,
  rewriteRateABStats,
  type CognitionState,
  type RewriteRateABSample,
} from "./character-cognition"
import {
  appendStageMetric,
  loadNovelSessionStatus,
  novelSessionStatusPath,
  type NovelSessionStatus,
  type StageMetricEntry,
} from "./novel-session-status"

/** 构造最小合法 status.json（通过 loadNovelSessionStatus 校验）。 */
function minimalStatus(overrides: Partial<NovelSessionStatus> = {}): NovelSessionStatus {
  return {
    schema_version: "1",
    session_id: "sess-1",
    source: "deep_chapter_generation",
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
    status: "running",
    active_step_index: null,
    current_task: {
      task_id: "task-1",
      conversation_id: "conv-1",
      user_request: "写第1章",
      chapter_number: 1,
      checkpoint_stage: "started",
      status: "running",
    },
    draft: {
      draft_id: "conv-1",
      file_path: "/P/.novel/drafts/conv-1.json",
      draft_status: "pending",
      updated_at: "2026-07-10T00:00:00.000Z",
    },
    decision_gates: {
      consistency: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
      anti_ai: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
      quality: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
      overall: "pending",
    },
    evidence_refs: [],
    ...overrides,
  }
}

/** 预置 status.json 到磁盘 store（loadNovelSessionStatus 可读到）。 */
function seedStatus(projectPath: string, status: NovelSessionStatus): void {
  const statusPath = novelSessionStatusPath(projectPath)
  diskStore.set(statusPath, JSON.stringify(status, null, 2))
}

/** 预置 cognition-state.json 到磁盘 store（loadCognitionState 可读到）。 */
function seedCognition(projectPath: string, state: CognitionState): void {
  // 路径镜像 character-cognition.ts: `${pp}/.novel/cognition-state.json`
  const cognitionPath = `${projectPath}/.novel/cognition-state.json`
  diskStore.set(cognitionPath, JSON.stringify(state, null, 2))
}

describe("EPIC-002 / ADR-30 / TASK-013: scene-breakdown ROI 验证", () => {
  beforeEach(() => {
    fsMocks.fileExists.mockReset()
    fsMocks.readFile.mockReset()
    fsMocks.writeFileAtomic.mockReset()
    fsMocks.createDirectory.mockReset()
    diskStore.clear()
    // 默认实现走 diskStore（模拟磁盘读写）。
    fsMocks.fileExists.mockImplementation(async (p) => diskStore.has(p))
    fsMocks.readFile.mockImplementation(async (p) => {
      const c = diskStore.get(p)
      if (c === undefined) throw new Error(`ENOENT: ${p}`)
      return c
    })
    fsMocks.writeFileAtomic.mockImplementation(async (p, c) => {
      diskStore.set(p, c)
    })
    fsMocks.createDirectory.mockImplementation(async () => {})
  })

  describe("rewriteRateABStats — enabled < disabled（scene-breakdown 降低 rewrite 率）", () => {
    it("enabled 章节 rewrite 率低于 disabled（核心 ROI 断言）", () => {
      // enabled variant: scene 拆解后 rewrite 率低（error findings 少）。
      // disabled variant: 无拆解 rewrite 率高（error findings 多）。
      const state: CognitionState = {
        characters: [],
        readerKnows: [],
        lastUpdatedChapter: 0,
        rewriteRateABuckets: [
          { variant: "enabled", rewriteRate: 0.1, chapterId: "1", timestamp: "2026-07-10T01:00:00Z" },
          { variant: "enabled", rewriteRate: 0.15, chapterId: "2", timestamp: "2026-07-10T02:00:00Z" },
          { variant: "enabled", rewriteRate: 0.05, chapterId: "3", timestamp: "2026-07-10T03:00:00Z" },
          { variant: "disabled", rewriteRate: 0.5, chapterId: "4", timestamp: "2026-07-10T04:00:00Z" },
          { variant: "disabled", rewriteRate: 0.6, chapterId: "5", timestamp: "2026-07-10T05:00:00Z" },
        ],
      }
      const stats = rewriteRateABStats(state)
      // enabled avg ≈ 0.1, disabled avg = 0.55
      expect(stats.enabledAvg).toBeCloseTo(0.1, 2)
      expect(stats.disabledAvg).toBeCloseTo(0.55, 2)
      // 核心断言：scene-breakdown enabled 降低 rewrite 率。
      expect(stats.enabledAvg!).toBeLessThan(stats.disabledAvg!)
    })

    it("zero findings → rewriteRate = 0（无问题不需重写）", () => {
      const state: CognitionState = {
        characters: [],
        readerKnows: [],
        lastUpdatedChapter: 0,
        rewriteRateABuckets: [
          { variant: "enabled", rewriteRate: 0, chapterId: "1", timestamp: "" },
        ],
      }
      const stats = rewriteRateABStats(state)
      expect(stats.enabledAvg).toBe(0)
      expect(stats.disabledAvg).toBeNull()
    })

    it("returns null averages when state is null or empty", () => {
      expect(rewriteRateABStats(null)).toEqual({ enabledAvg: null, disabledAvg: null })
      expect(rewriteRateABStats({ characters: [], readerKnows: [], lastUpdatedChapter: 0 } as CognitionState))
        .toEqual({ enabledAvg: null, disabledAvg: null })
    })
  })

  describe("appendRewriteRateASample — 写 cognition-state.json rewriteRateABuckets（HARD-1 守恒）", () => {
    it("写入 cognition-state.json rewriteRateABuckets 字段（A/B 字段齐全）", async () => {
      // 无预置 cognition-state.json（diskStore 默认 fileExists=false）。

      const sample: RewriteRateABSample = {
        variant: "enabled",
        rewriteRate: 0.25,
        chapterId: "5",
        timestamp: "2026-07-10T03:00:00.000Z",
      }
      await appendRewriteRateASample("/P", sample)

      const state = await loadCognitionState("/P")
      expect(state).not.toBeNull()
      expect(state!.rewriteRateABuckets).toHaveLength(1)
      const written = state!.rewriteRateABuckets![0]
      expect(written.variant).toBe("enabled")
      expect(written.rewriteRate).toBe(0.25)
      expect(written.chapterId).toBe("5")
      expect(written.timestamp).toBe("2026-07-10T03:00:00.000Z")
    })

    it("append 到现有 cognition-state.json（不覆盖 routingROIBuckets/exemplarABuckets）", async () => {
      // 现有 cognition-state.json 已含 TASK-008/005 数据。
      const existing: CognitionState = {
        characters: [{ character: "Alice", knows: ["线索"], doesNotKnow: [] }],
        readerKnows: [],
        lastUpdatedChapter: 5,
        routingROIBuckets: [{ variant: "enabled", irrelevantRatio: 0.2, chapterId: "4", timestamp: "" }],
        exemplarABuckets: [{ variant: "disabled", score: 3, chapterId: "4", timestamp: "" }],
      }
      seedCognition("/P", existing)

      await appendRewriteRateASample("/P", {
        variant: "disabled",
        rewriteRate: 0.7,
        chapterId: "6",
        timestamp: "2026-07-10T04:00:00.000Z",
      })

      const state = await loadCognitionState("/P")
      // 现有 TASK-008/005 数据保留（additive isolation）。
      expect(state!.routingROIBuckets).toHaveLength(1)
      expect(state!.exemplarABuckets).toHaveLength(1)
      // TASK-013 新样本追加。
      expect(state!.rewriteRateABuckets).toHaveLength(1)
      expect(state!.rewriteRateABuckets![0].variant).toBe("disabled")
    })

    it("HARD-1 守恒：ROI 写入路径含 cognition-state.json，MUST NOT 写 status.json", async () => {
      // 无预置 cognition-state.json（diskStore 默认 fileExists=false）。
      await appendRewriteRateASample("/P", {
        variant: "enabled",
        rewriteRate: 0,
        chapterId: "1",
        timestamp: "2026-07-10T05:00:00.000Z",
      })
      // 确认仅写 cognition-state.json，未触碰 status.json（HARD-1 真源隔离）。
      const writtenPaths = (fsMocks.writeFileAtomic as any).mock.calls.map((c: Array<string>) => c[0] as string)
      expect(writtenPaths.some((p: string) => p.includes("cognition-state.json"))).toBe(true)
      expect(writtenPaths.some((p: string) => /status\.json$/i.test(p))).toBe(false)
    })

    it("is non-fatal — swallow errors without throwing", async () => {
      fsMocks.fileExists.mockResolvedValue(true)
      fsMocks.readFile.mockRejectedValue(new Error("disk gone"))
      // 不应 throw（ROI 采集失败不阻断主链）。
      await expect(
        appendRewriteRateASample("/P", {
          variant: "enabled",
          rewriteRate: 0.5,
          chapterId: "ch.md",
          timestamp: "2026-07-10T00:00:00Z",
        }),
      ).resolves.toBeUndefined()
    })

    it("上限保护：超过 1024 条样本时弹最旧（LRU-ish）", async () => {
      const existing: CognitionState = {
        characters: [],
        readerKnows: [],
        lastUpdatedChapter: 0,
        rewriteRateABuckets: Array.from({ length: 1024 }, (_, i) => ({
          variant: "enabled" as const,
          rewriteRate: 0.1,
          chapterId: String(i),
          timestamp: `2026-07-10T00:0${i % 10}:00.000Z`,
        })),
      }
      seedCognition("/P", existing)

      await appendRewriteRateASample("/P", {
        variant: "enabled",
        rewriteRate: 0.5,
        chapterId: "1024",
        timestamp: "2026-07-10T06:00:00.000Z",
      })

      const state = await loadCognitionState("/P")
      expect(state!.rewriteRateABuckets).toHaveLength(1024)
      // 最旧（chapterId "0"）被弹出，最新（"1024"）在末尾。
      expect(state!.rewriteRateABuckets![0].chapterId).toBe("1")
      expect(state!.rewriteRateABuckets![1023].chapterId).toBe("1024")
    })

    it("rewriteRateABuckets 向后兼容：pre-TASK-013 cognition-state.json 无此字段 → undefined", async () => {
      const legacy = {
        characters: [{ character: "Alice", knows: ["x"], doesNotKnow: [] }],
        readerKnows: [],
        lastUpdatedChapter: 3,
      }
      seedCognition("/P", legacy as CognitionState)

      const state = await loadCognitionState("/P")
      expect(state).not.toBeNull()
      expect(state!.rewriteRateABuckets).toBeUndefined()
      expect(state!.characters).toEqual(legacy.characters)
    })
  })

  describe("appendStageMetric — 写 status.json stage_metrics（HARD-1 守恒）", () => {
    it("写入 status.json stage_metrics 条目（scene_breakdown 阶段指标齐全）", async () => {
      // 预置 status.json（loadNovelSessionStatus 校验通过）。
      const status = minimalStatus()
      seedStatus("/P", status)

      const entry: StageMetricEntry = {
        stage: "scene_breakdown",
        tokenCost: 1234,
        latencyMs: 5678,
        partial: false,
        chapterId: "5",
        timestamp: "2026-07-10T03:00:00.000Z",
      }
      await appendStageMetric("/P", entry)

      const loaded = await loadNovelSessionStatus("/P")
      expect(loaded).not.toBeNull()
      expect(loaded!.stage_metrics).toHaveLength(1)
      const metric = loaded!.stage_metrics![0]
      expect(metric.stage).toBe("scene_breakdown")
      expect(metric.tokenCost).toBe(1234)
      expect(metric.latencyMs).toBe(5678)
      expect(metric.partial).toBe(false)
      expect(metric.chapterId).toBe("5")
      expect(metric.timestamp).toBe("2026-07-10T03:00:00.000Z")
    })

    it("append 到现有 stage_metrics（不覆盖 evidence_refs/dimension_results）", async () => {
      const status = minimalStatus({
        evidence_refs: ["/P/.novel/drafts/d1.json"],
        stage_metrics: [
          { stage: "scene_breakdown", tokenCost: 100, latencyMs: 200, partial: false, chapterId: "4", timestamp: "2026-07-10T01:00:00.000Z" },
        ],
      })
      seedStatus("/P", status)

      await appendStageMetric("/P", {
        stage: "scene_breakdown",
        tokenCost: 200,
        latencyMs: 300,
        partial: true,
        chapterId: "5",
        timestamp: "2026-07-10T02:00:00.000Z",
      })

      const loaded = await loadNovelSessionStatus("/P")
      // evidence_refs 保留。
      expect(loaded!.evidence_refs).toEqual(["/P/.novel/drafts/d1.json"])
      // stage_metrics 追加。
      expect(loaded!.stage_metrics).toHaveLength(2)
      expect(loaded!.stage_metrics![1].partial).toBe(true)
    })

    it("partial=true 传播正确（S-444k partial→pause 路径溯源）", async () => {
      const status = minimalStatus()
      seedStatus("/P", status)

      await appendStageMetric("/P", {
        stage: "scene_breakdown",
        partial: true,
        chapterId: "3",
        timestamp: "2026-07-10T00:00:00Z",
      })

      const loaded = await loadNovelSessionStatus("/P")
      expect(loaded!.stage_metrics![0].partial).toBe(true)
    })

    it("no session → no-op（不创建 stub status.json，HARD-1 守恒）", async () => {
      // 无 status.json → loadNovelSessionStatus 返回 null → appendStageMetric 早返。
      // 不创建第二份真源文件（HARD-1）。
      fsMocks.fileExists.mockResolvedValue(false)

      await appendStageMetric("/P", {
        stage: "scene_breakdown",
        chapterId: "1",
        timestamp: "2026-07-10T00:00:00Z",
      })

      // 确认无 writeFileAtomic 调用（未创建 stub status.json）。
      expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    })

    it("is non-fatal — swallow errors without throwing", async () => {
      // status.json 存在但 readFile 抛错 → catch 吞掉。
      const status = minimalStatus()
      seedStatus("/P", status)
      // 让后续 readFile（loadNovelSessionStatus）抛错。
      fsMocks.readFile.mockReset()
      fsMocks.readFile.mockRejectedValue(new Error("disk gone"))

      // 不应 throw（阶段指标采集失败不阻断主链）。
      await expect(
        appendStageMetric("/P", {
          stage: "scene_breakdown",
          chapterId: "1",
          timestamp: "2026-07-10T00:00:00Z",
        }),
      ).resolves.toBeUndefined()
    })

    it("上限保护：stage_metrics 超过 1024 条时弹最旧", async () => {
      const status = minimalStatus({
        stage_metrics: Array.from({ length: 1024 }, (_, i) => ({
          stage: "scene_breakdown" as const,
          tokenCost: i,
          chapterId: String(i),
          timestamp: `2026-07-10T00:0${i % 10}:00.000Z`,
        })),
      })
      seedStatus("/P", status)

      await appendStageMetric("/P", {
        stage: "scene_breakdown",
        tokenCost: 9999,
        chapterId: "1024",
        timestamp: "2026-07-10T06:00:00.000Z",
      })

      const loaded = await loadNovelSessionStatus("/P")
      expect(loaded!.stage_metrics).toHaveLength(1024)
      expect(loaded!.stage_metrics![0].chapterId).toBe("1")
      expect(loaded!.stage_metrics![1023].chapterId).toBe("1024")
    })
  })

  describe("A/B 分组 — sceneBreakdownEnabled true/false（variant 字段值）", () => {
    it("enabled variant 对应 sceneBreakdownEnabled=true", async () => {
      // 无预置 cognition-state.json（diskStore 默认 fileExists=false）。
      await appendRewriteRateASample("/P", {
        variant: "enabled",
        rewriteRate: 0.1,
        chapterId: "1",
        timestamp: "2026-07-10T00:00:00Z",
      })
      const state = await loadCognitionState("/P")
      expect(state!.rewriteRateABuckets![0].variant).toBe("enabled")
    })

    it("disabled variant 对应 sceneBreakdownEnabled=false", async () => {
      // 无预置 cognition-state.json（diskStore 默认 fileExists=false）。
      await appendRewriteRateASample("/P", {
        variant: "disabled",
        rewriteRate: 0.5,
        chapterId: "1",
        timestamp: "2026-07-10T00:00:00Z",
      })
      const state = await loadCognitionState("/P")
      expect(state!.rewriteRateABuckets![0].variant).toBe("disabled")
    })
  })
})
