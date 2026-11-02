/**
 * snapshot-batch-scope_biztest.spec.ts — 业务验收 B4（批量提取范围 + 预算）。
 *
 * 用户视角的问题（一条完整旅程，不是单个纯函数）：
 *
 *   1. 「我点『批量提取』，默认会重跑哪些章？」→ 默认**仅未提取**（待补清单），
 *      已有完整快照的章不进队列（省钱、幂等）。
 *   2. 「我想全量跑一遍，但别把已经提取过的重提一遍？」→ 全量 + skipExisting（默认）
 *      跳过已有完整快照，并把跳过的章如实列出。
 *   3. 「我确实要全部重提（快照口径变了）」→ force 无视 skipExisting，全部入队。
 *   4. 「我全量跑 45 章，会不会一口气把 LLM 预算烧光？」→ 超预算即停：只准入前 N 章，
 *      其余按 `skippedByBudget` **记账跳过**（不是静默丢弃），且硬顶不可绕过。
 *
 * 扫库走真实 `scanSnapshotBackfill`（fs 层打桩），因此「快照 → 待补清单 → 范围 → 预算 →
 * 队列」是同一条生产链路。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: vi.fn(),
    listDirectory: vi.fn(),
  }
})

import { listDirectory, readFile } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import {
  BATCH_EXTRACT_BUDGET_DEFAULT,
  BATCH_EXTRACT_BUDGET_ENFORCED,
  BATCH_EXTRACT_BUDGET_MAX,
  DEFAULT_BATCH_EXTRACT_SCOPE,
  DEFAULT_BATCH_SKIP_EXISTING,
  applyBatchExtractBudget,
  buildBatchBudgetLedger,
  createBatchExtractQueue,
  resolveBatchExtractScope,
  scanSnapshotBackfill,
  type SnapshotScanResult,
} from "./snapshot-scanner"

const PROJECT = "/tmp/qmai-biztest-project"
/** 快照总数：10 章已完整 + 60 章待补 = 70（待补数 > 默认预算 20，且 > 硬顶 60）。 */
const TOTAL_CHAPTERS = 70
const COMPLETE_CHAPTERS = 10

const mockReadFile = vi.mocked(readFile)
const mockListDirectory = vi.mocked(listDirectory)

function snapshotFileName(chapter: number): string {
  return `${String(chapter).padStart(3, "0")}.snapshot.json`
}

function fileNode(chapter: number): FileNode {
  return {
    name: snapshotFileName(chapter),
    path: `${PROJECT}/.novel/snapshots/${snapshotFileName(chapter)}`,
    is_dir: false,
  }
}

function snapshotBody(chapter: number, complete: boolean): string {
  const base = {
    chapterId: `chapter-${chapter}`,
    chapterNumber: chapter,
    summary: `第${chapter}章摘要`,
    characters: [],
    locations: [],
    organizations: [],
    items: [],
    events: [],
    characterStateChanges: [],
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    newCanonFacts: [],
    timelineEvents: [],
    conflicts: [],
    endingHook: "",
    graphNodes: [],
    graphEdges: [],
    revision: 2,
  }
  if (complete) {
    return JSON.stringify({ ...base, beliefFacts: [], hypothesisFacts: [], povCharacter: "林岚" })
  }
  // 待补：旧快照缺认知事实族（最常见的待补形态）。
  // 注意 revision 不参与待补判定（F-008：它是内容修订号，不是字段版本）。
  return JSON.stringify({ ...base, revision: 1 })
}

function chaptersOf(chapters: readonly number[]): number[] {
  return [...chapters]
}

beforeEach(() => {
  vi.clearAllMocks()
  mockListDirectory.mockResolvedValue(
    Array.from({ length: TOTAL_CHAPTERS }, (_, index) => fileNode(index + 1)),
  )
  mockReadFile.mockImplementation(async (path: string) => {
    const name = path.split("/").pop() ?? ""
    const chapter = Number(name.slice(0, 3))
    if (!Number.isFinite(chapter)) throw new Error(`unexpected snapshot path: ${path}`)
    return snapshotBody(chapter, chapter <= COMPLETE_CHAPTERS)
  })
})

async function scan(): Promise<SnapshotScanResult> {
  return scanSnapshotBackfill(PROJECT)
}

describe("B4 批量提取范围（默认仅未提取 → skipExisting → force）", () => {
  it("默认口径：仅未提取（常量即真源）", () => {
    expect(DEFAULT_BATCH_EXTRACT_SCOPE).toBe("missing")
    expect(DEFAULT_BATCH_SKIP_EXISTING).toBe(true)
  })

  it("默认点「批量提取」→ 只有待补章节入队，已完整的章不进队列", async () => {
    const result = await scan()
    expect(result.total).toBe(TOTAL_CHAPTERS)
    expect(result.pending).toHaveLength(TOTAL_CHAPTERS - COMPLETE_CHAPTERS)

    const scope = resolveBatchExtractScope(result)
    expect(scope.mode).toBe("missing")
    expect(scope.chapters).toHaveLength(TOTAL_CHAPTERS - COMPLETE_CHAPTERS)
    expect(scope.chapters[0]).toBe(COMPLETE_CHAPTERS + 1)
    expect(scope.chapters[scope.chapters.length - 1]).toBe(TOTAL_CHAPTERS)
    // 默认口径不涉及「跳过已有」——本来就不在候选域里。
    expect(scope.skippedExisting).toEqual([])
  })

  it("全量模式 + skipExisting（默认）→ 跳过已有完整快照，并如实列出被跳过的章", async () => {
    const result = await scan()
    const scope = resolveBatchExtractScope(result, { mode: "all" })

    expect(scope.chapters).toHaveLength(TOTAL_CHAPTERS - COMPLETE_CHAPTERS)
    expect(scope.skippedExisting).toEqual(
      Array.from({ length: COMPLETE_CHAPTERS }, (_, index) => index + 1),
    )
    // 入队集合 + 跳过集合 = 全部章节（没有章被静默漏掉）。
    expect(scope.chapters.length + scope.skippedExisting.length).toBe(TOTAL_CHAPTERS)
  })

  it("force 重提 → 无视 skipExisting，全部章节重新入队", async () => {
    const result = await scan()
    const scope = resolveBatchExtractScope(result, { mode: "all", force: true })

    expect(scope.force).toBe(true)
    expect(scope.chapters).toEqual(chaptersOf(Array.from({ length: TOTAL_CHAPTERS }, (_, i) => i + 1)))
    expect(scope.skippedExisting).toEqual([])
  })
})

describe("B4 全量模式超预算即停（不先跑再说）", () => {
  it("预算强制开关与默认值来自常量（UI / harness 共用同一口径）", () => {
    expect(BATCH_EXTRACT_BUDGET_ENFORCED).toBe(true)
    expect(BATCH_EXTRACT_BUDGET_DEFAULT).toBe(20)
    expect(BATCH_EXTRACT_BUDGET_MAX).toBe(60)
  })

  it("60 章待补 + 默认预算 20 → 准入 20 章、记账跳过 40 章、触顶标记为真", async () => {
    const result = await scan()
    const scope = resolveBatchExtractScope(result, { mode: "all" })

    const plan = applyBatchExtractBudget(scope.chapters)
    expect(plan.budget).toBe(BATCH_EXTRACT_BUDGET_DEFAULT)
    expect(plan.admitted).toHaveLength(20)
    expect(plan.admitted[0]).toBe(11)
    expect(plan.admitted[plan.admitted.length - 1]).toBe(30)
    expect(plan.skippedByBudget).toHaveLength(40)
    expect(plan.skippedByBudget[0]).toBe(31)
    expect(plan.exhausted).toBe(true)

    // 记账行（进度通道展示的就是这一行）：没有章被静默丢弃。
    expect(buildBatchBudgetLedger(plan)).toEqual({
      budget: 20,
      requested: 60,
      admitted: 20,
      skipped: 40,
      exhausted: true,
    })
  })

  it("调用方想调大预算也过不了硬顶（60 章）", async () => {
    const result = await scan()
    const scope = resolveBatchExtractScope(result, { mode: "all", force: true })
    const plan = applyBatchExtractBudget(scope.chapters, 1000)
    expect(plan.budget).toBe(BATCH_EXTRACT_BUDGET_MAX)
    expect(plan.admitted).toHaveLength(BATCH_EXTRACT_BUDGET_MAX)
    expect(plan.skippedByBudget).toHaveLength(scope.chapters.length - BATCH_EXTRACT_BUDGET_MAX)
    expect(plan.exhausted).toBe(true)
  })

  it("队列只装准入章，超预算章留在 skippedByBudget 里可查（不静默）", async () => {
    const result = await scan()
    const scope = resolveBatchExtractScope(result, { mode: "all" })
    const plan = applyBatchExtractBudget(scope.chapters)
    const queue = createBatchExtractQueue({ projectPath: PROJECT, plan, now: 1_700_000_000_000 })

    expect(queue.status).toBe("idle")
    expect(queue.budget).toBe(20)
    expect(queue.admitted).toHaveLength(20)
    expect(queue.skippedByBudget).toEqual(plan.skippedByBudget)
    expect(queue.drafts).toHaveLength(20)
    expect(queue.drafts.every((draft) => draft.status === "pending")).toBe(true)
    // 超预算的章**没有**草稿（不会被偷偷提取）。
    const draftedChapters = new Set(queue.drafts.map((draft) => draft.chapter))
    for (const chapter of plan.skippedByBudget) {
      expect(draftedChapters.has(chapter)).toBe(false)
    }
  })
})
