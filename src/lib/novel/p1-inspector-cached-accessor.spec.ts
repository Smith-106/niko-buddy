// ISS-20260710-001: Inspector execute 缺缓存访问器 → 补 cached accessor（缺失走 execute 现有路径，行为等价）。
// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string): Promise<string> => ""),
  getFileModifiedTime: vi.fn(async (_path: string): Promise<number> => 0),
}))
vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: fsMocks.readFile,
    getFileModifiedTime: fsMocks.getFileModifiedTime,
    listDirectory: vi.fn(async () => []),
    fileExists: vi.fn(async () => false),
  }
})

import {
  queryInspectorState,
  getCachedInspectorFindings,
  getCachedInspectorReviewBlock,
} from "./inspector-query"
import type { DimensionReviewResult, SixReviewDimensionKey } from "./dimension-review-adapter"
import type { NovelSessionStatus } from "./novel-session-status"

function makeDim(key: SixReviewDimensionKey): DimensionReviewResult {
  return { dimensionKey: key, score: 8, status: "pass", summary: `${key} s`, thinking: "", issues: [] }
}

function makeStatus(overrides?: Partial<NovelSessionStatus>): NovelSessionStatus {
  return {
    schema_version: "1",
    session_id: "s",
    source: "deep_chapter_generation",
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T01:00:00.000Z",
    status: "running",
    active_step_index: 2,
    current_task: { task_id: "t", conversation_id: "c", user_request: "w", chapter_number: 1, checkpoint_stage: "after_draft", status: "running" },
    draft: { draft_id: "c", file_path: "/P/.novel/drafts/c.json", draft_status: "ready", updated_at: "2026-07-10T01:00:00.000Z" },
    decision_gates: {
      consistency: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
      anti_ai: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
      quality: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
      overall: "pending",
    },
    resume_checkpoint: undefined,
    evidence_refs: [],
    ...overrides,
  } as NovelSessionStatus
}

describe("ISS-20260710-001 Inspector cached accessor", () => {
  beforeEach(() => { fsMocks.readFile.mockReset(); fsMocks.getFileModifiedTime.mockReset() })

  it("命中：cached accessor 返回规范序 findings（thrill 在 pull 前）", () => {
    const out = getCachedInspectorFindings({ pull: makeDim("pull"), thrill: makeDim("thrill") })
    expect(out).toHaveLength(2)
    expect(out[0].dimensionKey).toBe("thrill")
    expect(out[1].dimensionKey).toBe("pull")
  })

  it("缺失（undefined/空对象）走 execute 现有路径：返回 []，行为等价旧直接调用", () => {
    expect(getCachedInspectorFindings(undefined)).toEqual([])
    expect(getCachedInspectorFindings({})).toEqual([])
    const block = getCachedInspectorReviewBlock(undefined, "2026-07-10T01:00:00.000Z")
    expect(block.findings).toEqual([])
    expect(block.reviewedAt).toBe("2026-07-10T01:00:00.000Z")
  })

  it("纯函数：多次调用返回新数组（无模块级缓存，HARD-1）", () => {
    const src = { thrill: makeDim("thrill") }
    const a = getCachedInspectorFindings(src)
    const b = getCachedInspectorFindings(src)
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })

  it("queryInspectorState 经 accessor 读取：缺失缓存仍走现有派生路径（draft/decision 照常）", async () => {
    const status = makeStatus()
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("status.json")) return JSON.stringify(status)
      return ""
    })
    fsMocks.getFileModifiedTime.mockResolvedValue(0)
    const snap = await queryInspectorState("/P", "ch1")
    expect(snap.review.findings).toEqual([])
    expect(snap.draft.draftId).toBe("c")
    expect(snap.decision.overall).toBe("pending")
  })

  it("queryInspectorState 经 accessor 读取：命中缓存派生 findings", async () => {
    const status = makeStatus({ dimension_results: { thrill: makeDim("thrill") } })
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("status.json")) return JSON.stringify(status)
      if (p.endsWith("c.json")) return "草稿正文"
      return ""
    })
    fsMocks.getFileModifiedTime.mockResolvedValue(0)
    const snap = await queryInspectorState("/P", "ch1")
    expect(snap.review.findings).toHaveLength(1)
    expect(snap.review.findings[0].dimensionKey).toBe("thrill")
  })
})
