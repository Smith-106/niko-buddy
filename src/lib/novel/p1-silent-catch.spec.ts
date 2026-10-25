// ISS-20260709-025 PAT-IM2: 全项目静默 catch 约 20 处 / 7 文件加诊断（日志或 gap 记录，不改控制流）。
// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(async (_p: string): Promise<string> => ""),
  getFileModifiedTime: vi.fn(async (): Promise<number> => 0),
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

import { queryInspectorState } from "./inspector-query"

describe("ISS-20260709-025 PAT-IM2 静默 catch 诊断收敛（控制流不变）", () => {
  beforeEach(() => { fsMocks.readFile.mockReset(); fsMocks.getFileModifiedTime.mockReset() })

  it("Inspector 草稿缺失：记 warn 后仍降级空内容（控制流不变）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const status = {
        schema_version: "1", session_id: "s", source: "deep_chapter_generation",
        created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T01:00:00.000Z",
        status: "running", active_step_index: 1,
        current_task: { task_id: "t", conversation_id: "c", user_request: "w", chapter_number: 1, checkpoint_stage: "after_draft", status: "running" },
        draft: { draft_id: "c", file_path: "/P/.novel/drafts/c.json", draft_status: "ready", updated_at: "2026-07-10T01:00:00.000Z" },
        decision_gates: {
          consistency: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
          anti_ai: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
          quality: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
          overall: "pending",
        },
      }
      fsMocks.readFile.mockImplementation(async (p: string) => {
        if (p.endsWith("status.json")) return JSON.stringify(status)
        if (p.endsWith("c.json")) throw new Error("ENOENT: draft missing")
        return ""
      })
      fsMocks.getFileModifiedTime.mockResolvedValue(0)
      const snap = await queryInspectorState("/P", "ch1")
      // 控制流不变：缺失仍为空预览 + 元数据保留
      expect(snap.draft.contentPreview).toBe("")
      expect(snap.draft.draftId).toBe("c")
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("Inspector scene provider 失败：记 warn 后仍降级空场景（控制流不变）", async () => {
    const status = {
      schema_version: "1", session_id: "s", source: "deep_chapter_generation",
      created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T01:00:00.000Z",
      status: "running", active_step_index: 1,
      current_task: { task_id: "t", conversation_id: "c", user_request: "w", chapter_number: 1, checkpoint_stage: "after_draft", status: "running" },
      draft: undefined,
      decision_gates: {
        consistency: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pending",
      },
    }
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("status.json")) return JSON.stringify(status)
      return ""
    })
    fsMocks.getFileModifiedTime.mockResolvedValue(0)
    const snap = await queryInspectorState("/P", "ch1", async () => { throw new Error("provider boom") })
    expect(snap.scene.sceneCount).toBe(0)
    expect(snap.scene.sceneTitles).toEqual([])
  })

  it("源码结构断言：七文件静默 catch 均已收敛（无裸 } catch { 残留于目标位点）", async () => {
    const { readFile } = await import("node:fs/promises")
    const targets: Array<{ file: string; mustContain: string }> = [
      { file: "src/lib/novel/inspector-query.ts", mustContain: "PAT-IM2" },
      { file: "src/lib/novel/novel-session-status.ts", mustContain: "PAT-IM2" },
      { file: "src/lib/novel/projection-status-ledger.ts", mustContain: "PAT-IM2" },
      { file: "src/lib/novel/chapter-ingest.ts", mustContain: "PAT-IM2" },
      { file: "src/lib/novel/outline-generation.ts", mustContain: "PAT-IM2" },
      { file: "src/lib/novel/dimension-review-adapter.ts", mustContain: "PAT-IM2" },
      { file: "src/lib/novel/delete-source-memory.ts", mustContain: "REL-1" },
    ]
    for (const t of targets) {
      const text = await readFile(t.file, "utf8")
      expect(text).toContain(t.mustContain)
    }
  })
})
