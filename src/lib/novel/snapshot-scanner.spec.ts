/**
 * snapshot-scanner.spec.ts — G3 快照扫库 / 范围选择 / 预算 / 队列状态机。
 *
 * 覆盖判据：
 *   D1 扫库待补清单（字段版本 + 可选字段族）
 *   D2 范围选择（默认仅未提取）+ LLM 预算上限（超限即停 + 记账）
 *   D4/D5 队列状态机与 Draft-first 不变量（ready 草稿 → accept 才回填）
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
import type { ChapterSnapshot } from "./chapter-ingest"
import {
  BATCH_DRAFT_REQUIRES_ACCEPT,
  BATCH_EXTRACT_BUDGET_DEFAULT,
  BATCH_EXTRACT_BUDGET_ENFORCED,
  BATCH_EXTRACT_BUDGET_MAX,
  DEFAULT_BATCH_EXTRACT_SCOPE,
  SNAPSHOT_BACKFILL_FIELDS,
  SNAPSHOT_BACKFILL_REASONS,
  acceptBatchDraft,
  applyBatchExtractBudget,
  batchQueueProgress,
  buildBatchBudgetLedger,
  cancelBatchExtractQueue,
  classifySnapshotFields,
  completeBatchChapter,
  createBatchExtractQueue,
  failBatchChapter,
  finishBatchExtractQueue,
  listAcceptableDrafts,
  normalizeBatchExtractBudget,
  resolveBatchExtractScope,
  scanSnapshotBackfill,
  startBatchChapter,
  type BatchExtractBudgetPlan,
  type SnapshotScanResult,
} from "./snapshot-scanner"

const PROJECT = "/tmp/qmai-project"

const mockReadFile = vi.mocked(readFile)
const mockListDirectory = vi.mocked(listDirectory)

function fileNode(name: string): FileNode {
  return { name, path: `${PROJECT}/.novel/snapshots/${name}`, is_dir: false }
}

/** 一份「字段齐」的快照（字段版本 = 当前口径）。 */
function completeSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chapterId: "chapter-1",
    chapterNumber: 1,
    summary: "摘要",
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
    beliefFacts: [],
    hypothesisFacts: [],
    povCharacter: "林岚",
    timelineEvents: [],
    conflicts: [],
    endingHook: "",
    graphNodes: [],
    graphEdges: [],
    revision: 2,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockListDirectory.mockResolvedValue([])
  mockReadFile.mockResolvedValue("{}")
})

describe("D1 常量口径（具名常量，禁止散落字符串）", () => {
  it("待补字段族与主因码是具名常量（不含 revision_stale：revision 不是字段版本）", () => {
    expect(SNAPSHOT_BACKFILL_FIELDS).toEqual(["beliefFacts", "hypothesisFacts", "povCharacter"])
    expect(SNAPSHOT_BACKFILL_REASONS.missingOptionalField).toBe("missing_optional_field")
    expect(SNAPSHOT_BACKFILL_REASONS.revisionMissing).toBe("revision_missing")
    expect(SNAPSHOT_BACKFILL_REASONS.unreadable).toBe("unreadable")
    // F-008：待补判定不得再用 revision 当字段版本（该主因码已删除）。
    expect(Object.values(SNAPSHOT_BACKFILL_REASONS)).not.toContain("revision_stale")
  })

  it("Draft-first 不变量与预算强制开关常量为真", () => {
    expect(BATCH_DRAFT_REQUIRES_ACCEPT).toBe(true)
    expect(BATCH_EXTRACT_BUDGET_ENFORCED).toBe(true)
    expect(DEFAULT_BATCH_EXTRACT_SCOPE).toBe("missing")
    expect(BATCH_EXTRACT_BUDGET_DEFAULT).toBeLessThanOrEqual(BATCH_EXTRACT_BUDGET_MAX)
  })
})

describe("D1 classifySnapshotFields（字段完整性判定）", () => {
  it("字段齐 → complete", () => {
    const verdict = classifySnapshotFields(completeSnapshot())
    expect(verdict.complete).toBe(true)
    expect(verdict.reason).toBeNull()
    expect(verdict.missingFields).toEqual([])
    expect(verdict.revision).toBe(2)
  })

  it("字段齐 + revision=1（只修订过一次的真实快照）→ complete，不得判待补", () => {
    // F-008 回归：revision 是内容修订号，不是字段版本；字段齐就该是 complete。
    const verdict = classifySnapshotFields(completeSnapshot({ revision: 1 }))
    expect(verdict.complete).toBe(true)
    expect(verdict.reason).toBeNull()
    expect(verdict.revision).toBe(1)

    const zero = classifySnapshotFields(completeSnapshot({ revision: 0 }))
    expect(zero.complete).toBe(true)
  })

  it("缺 beliefFacts / hypothesisFacts → missing_optional_field 且列出缺失字段", () => {
    const raw = completeSnapshot()
    delete raw.beliefFacts
    delete raw.hypothesisFacts
    const verdict = classifySnapshotFields(raw)
    expect(verdict.complete).toBe(false)
    expect(verdict.reason).toBe(SNAPSHOT_BACKFILL_REASONS.missingOptionalField)
    expect(verdict.missingFields).toEqual(["beliefFacts", "hypothesisFacts"])
  })

  it("povCharacter 缺字段或空串 → 待补（空数组不算缺）", () => {
    const missingPov = classifySnapshotFields(completeSnapshot({ povCharacter: undefined }))
    expect(missingPov.reason).toBe(SNAPSHOT_BACKFILL_REASONS.missingOptionalField)
    expect(missingPov.missingFields).toEqual(["povCharacter"])

    const emptyPov = classifySnapshotFields(completeSnapshot({ povCharacter: "   " }))
    expect(emptyPov.missingFields).toEqual(["povCharacter"])

    const emptyArrays = classifySnapshotFields(completeSnapshot({ beliefFacts: [], hypothesisFacts: [] }))
    expect(emptyArrays.complete).toBe(true)
  })

  it("revision 字段缺失 → revision_missing（旧格式信号，不与任何字段版本比较）", () => {
    const noRevision = completeSnapshot()
    delete noRevision.revision
    expect(classifySnapshotFields(noRevision).reason).toBe(SNAPSHOT_BACKFILL_REASONS.revisionMissing)
  })

  it("非对象输入 → unreadable", () => {
    expect(classifySnapshotFields(null).reason).toBe(SNAPSHOT_BACKFILL_REASONS.unreadable)
    expect(classifySnapshotFields([1, 2]).reason).toBe(SNAPSHOT_BACKFILL_REASONS.unreadable)
    expect(classifySnapshotFields("x").reason).toBe(SNAPSHOT_BACKFILL_REASONS.unreadable)
  })
})

describe("D1 scanSnapshotBackfill（扫库 → 待补清单）", () => {
  it("扫 .novel/snapshots/*.snapshot.json 输出 [{chapter, reason}]", async () => {
    mockListDirectory.mockResolvedValue([
      fileNode("001.snapshot.json"),
      fileNode("002.snapshot.json"),
      fileNode("003.snapshot.json"),
      fileNode("outline-001.snapshot.json"),
      fileNode("001.snapshot.md"),
    ])
    const byFile: Record<string, string> = {
      "001.snapshot.json": JSON.stringify(completeSnapshot({ chapterNumber: 1 })),
      "002.snapshot.json": JSON.stringify(completeSnapshot({ chapterNumber: 2, povCharacter: undefined })),
      "003.snapshot.json": JSON.stringify({ chapterNumber: 3, summary: "旧快照" }),
    }
    mockReadFile.mockImplementation(async (path: string) => {
      const name = path.split("/").pop() ?? ""
      const hit = byFile[name]
      if (hit === undefined) throw new Error("not found")
      return hit
    })

    const scan = await scanSnapshotBackfill(PROJECT)

    expect(scan.chapters).toEqual([1, 2, 3])
    expect(scan.total).toBe(3)
    expect(scan.pending).toEqual([
      {
        chapter: 2,
        reason: SNAPSHOT_BACKFILL_REASONS.missingOptionalField,
        missingFields: ["povCharacter"],
        revision: 2,
      },
      {
        chapter: 3,
        reason: SNAPSHOT_BACKFILL_REASONS.missingOptionalField,
        missingFields: ["beliefFacts", "hypothesisFacts", "povCharacter"],
        revision: null,
      },
    ])
    expect(scan.errors).toEqual([])
  })

  it("快照目录不存在 → 空结果（不抛）", async () => {
    mockListDirectory.mockRejectedValue(new Error("Path not found: .novel/snapshots"))
    const scan = await scanSnapshotBackfill(PROJECT)
    expect(scan).toEqual({ total: 0, chapters: [], pending: [], errors: [] })
  })

  it("读不出的快照 → unreadable 计入待补 + errors 记账", async () => {
    mockListDirectory.mockResolvedValue([fileNode("001.snapshot.json")])
    mockReadFile.mockRejectedValue(new Error("permission denied"))
    const scan = await scanSnapshotBackfill(PROJECT)
    expect(scan.pending).toEqual([
      { chapter: 1, reason: SNAPSHOT_BACKFILL_REASONS.unreadable, missingFields: [], revision: null },
    ])
    expect(scan.errors).toHaveLength(1)
  })

  it("JSON 解析失败 → unreadable", async () => {
    mockListDirectory.mockResolvedValue([fileNode("001.snapshot.json")])
    mockReadFile.mockResolvedValue("{not json")
    const scan = await scanSnapshotBackfill(PROJECT)
    expect(scan.pending[0]?.reason).toBe(SNAPSHOT_BACKFILL_REASONS.unreadable)
  })

  it("chapters 显式指定时不走目录列举", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(completeSnapshot()))
    const scan = await scanSnapshotBackfill(PROJECT, { chapters: [1, 1, -2] })
    expect(mockListDirectory).not.toHaveBeenCalled()
    expect(scan.chapters).toEqual([1])
    expect(scan.pending).toEqual([])
  })
})

describe("D2 resolveBatchExtractScope（默认仅未提取）", () => {
  const scan: SnapshotScanResult = {
    total: 3,
    chapters: [1, 2, 3],
    pending: [
      { chapter: 2, reason: SNAPSHOT_BACKFILL_REASONS.missingOptionalField, missingFields: ["povCharacter"], revision: 2 },
      { chapter: 3, reason: SNAPSHOT_BACKFILL_REASONS.revisionMissing, missingFields: [], revision: null },
    ],
    errors: [],
  }

  it("默认 = 仅未提取（待补清单）", () => {
    const selection = resolveBatchExtractScope(scan)
    expect(selection.mode).toBe("missing")
    expect(selection.chapters).toEqual([2, 3])
    expect(selection.skippedExisting).toEqual([])
  })

  it("全部 + skipExisting（默认）→ 跳过已完整章节", () => {
    const selection = resolveBatchExtractScope(scan, { mode: "all" })
    expect(selection.chapters).toEqual([2, 3])
    expect(selection.skippedExisting).toEqual([1])
  })

  it("全部 + force → 无视 skipExisting 全量重跑", () => {
    const selection = resolveBatchExtractScope(scan, { mode: "all", force: true })
    expect(selection.chapters).toEqual([1, 2, 3])
    expect(selection.skippedExisting).toEqual([])
  })

  it("全部 + skipExisting=false（不 force）→ 全部章节", () => {
    const selection = resolveBatchExtractScope(scan, { mode: "all", skipExisting: false })
    expect(selection.chapters).toEqual([1, 2, 3])
  })
})

describe("D2 预算上限（超限即停 + 记账，R3 缓解）", () => {
  it("normalizeBatchExtractBudget：非法回落默认、超硬顶截断", () => {
    expect(normalizeBatchExtractBudget(undefined)).toBe(BATCH_EXTRACT_BUDGET_DEFAULT)
    expect(normalizeBatchExtractBudget(0)).toBe(BATCH_EXTRACT_BUDGET_DEFAULT)
    expect(normalizeBatchExtractBudget(Number.NaN)).toBe(BATCH_EXTRACT_BUDGET_DEFAULT)
    expect(normalizeBatchExtractBudget(5)).toBe(5)
    expect(normalizeBatchExtractBudget(9999)).toBe(BATCH_EXTRACT_BUDGET_MAX)
  })

  it("未超预算 → 全部准入、未触顶", () => {
    const plan = applyBatchExtractBudget([1, 2, 3], 5)
    expect(plan).toEqual({ budget: 5, admitted: [1, 2, 3], skippedByBudget: [], exhausted: false })
  })

  it("超预算 → 截断 + 记账 skippedByBudget", () => {
    const plan = applyBatchExtractBudget([1, 2, 3, 4, 5], 2)
    expect(plan.admitted).toEqual([1, 2])
    expect(plan.skippedByBudget).toEqual([3, 4, 5])
    expect(plan.exhausted).toBe(true)

    const ledger = buildBatchBudgetLedger(plan)
    expect(ledger).toEqual({ budget: 2, requested: 5, admitted: 2, skipped: 3, exhausted: true })
  })

  it("预算默认值来自常量（G4 harness 共用口径）", () => {
    const plan = applyBatchExtractBudget(Array.from({ length: BATCH_EXTRACT_BUDGET_DEFAULT + 3 }, (_, i) => i + 1))
    expect(plan.budget).toBe(BATCH_EXTRACT_BUDGET_DEFAULT)
    expect(plan.admitted).toHaveLength(BATCH_EXTRACT_BUDGET_DEFAULT)
    expect(plan.skippedByBudget).toHaveLength(3)
  })
})

describe("D4/D5 队列状态机（Draft-first 硬边界）", () => {
  const plan: BatchExtractBudgetPlan = {
    budget: 3,
    admitted: [1, 2],
    skippedByBudget: [3],
    exhausted: true,
  }
  const snapshot = completeSnapshot({ chapterNumber: 1 }) as unknown as ChapterSnapshot

  it("建队列 → 全部准入章为 pending 草稿", () => {
    const queue = createBatchExtractQueue({ projectPath: PROJECT, plan, now: 1000 })
    expect(queue.status).toBe("idle")
    expect(queue.budget).toBe(3)
    expect(queue.skippedByBudget).toEqual([3])
    expect(queue.drafts.map((draft) => [draft.chapter, draft.status])).toEqual([
      [1, "pending"],
      [2, "pending"],
    ])
  })

  it("提取完成只产出 ready 草稿，绝不自动 accepted（Draft-first）", () => {
    let queue = createBatchExtractQueue({ projectPath: PROJECT, plan, now: 1000 })
    queue = startBatchChapter(queue, 1, 1100)
    expect(queue.status).toBe("running")
    queue = completeBatchChapter(queue, 1, snapshot, 1200)

    const draft = queue.drafts.find((item) => item.chapter === 1)
    expect(draft?.status).toBe("ready")
    expect(draft?.snapshot).toBe(snapshot)
    expect(queue.drafts.some((item) => item.status === "accepted")).toBe(false)
    expect(listAcceptableDrafts(queue).map((item) => item.chapter)).toEqual([1])
    expect(batchQueueProgress(queue)).toMatchObject({ completed: 1, total: 2, percent: 50 })
  })

  it("accept 只接受 ready 草稿；未 ready 的 accept 无效", () => {
    let queue = createBatchExtractQueue({ projectPath: PROJECT, plan, now: 1000 })
    const beforeAccept = acceptBatchDraft(queue, 1, 1100)
    expect(beforeAccept).toBe(queue)

    queue = completeBatchChapter(queue, 1, snapshot, 1200)
    queue = acceptBatchDraft(queue, 1, 1300)
    expect(queue.drafts.find((item) => item.chapter === 1)?.status).toBe("accepted")
    expect(listAcceptableDrafts(queue)).toEqual([])

    // 已 accepted 再 accept → 原样返回（幂等，不重复回填）
    expect(acceptBatchDraft(queue, 1, 1400)).toBe(queue)
  })

  it("null 快照 → failed 记账", () => {
    let queue = createBatchExtractQueue({ projectPath: PROJECT, plan, now: 1000 })
    queue = completeBatchChapter(queue, 1, null, 1100)
    expect(queue.drafts.find((item) => item.chapter === 1)?.status).toBe("failed")
    expect(queue.failed).toBe(1)
  })

  it("failBatchChapter 记录原因；未知章号不改变状态", () => {
    let queue = createBatchExtractQueue({ projectPath: PROJECT, plan, now: 1000 })
    queue = failBatchChapter(queue, 2, "not_final", 1100)
    expect(queue.drafts.find((item) => item.chapter === 2)).toMatchObject({ status: "failed", reason: "not_final" })
    expect(failBatchChapter(queue, 99, "x", 1200)).toBe(queue)
  })

  it("取消走既有 abort 语义：pending → cancelled，ready 草稿保留可 accept", () => {
    let queue = createBatchExtractQueue({ projectPath: PROJECT, plan, now: 1000 })
    queue = completeBatchChapter(queue, 1, snapshot, 1100)
    queue = cancelBatchExtractQueue(queue, 1200)

    expect(queue.status).toBe("cancelled")
    expect(queue.drafts.find((item) => item.chapter === 1)?.status).toBe("ready")
    expect(queue.drafts.find((item) => item.chapter === 2)?.status).toBe("cancelled")
    // cancelled 终态不被 finish 覆盖
    expect(finishBatchExtractQueue(queue).status).toBe("cancelled")
  })

  it("finishBatchExtractQueue → done", () => {
    const queue = finishBatchExtractQueue(createBatchExtractQueue({ projectPath: PROJECT, plan, now: 1000 }))
    expect(queue.status).toBe("done")
  })

  it("空队列进度为 0%", () => {
    const empty = createBatchExtractQueue({
      projectPath: PROJECT,
      plan: { budget: 1, admitted: [], skippedByBudget: [], exhausted: false },
      now: 1000,
    })
    expect(batchQueueProgress(empty).percent).toBe(0)
  })
})
