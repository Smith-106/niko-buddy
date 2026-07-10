/**
 * EPIC-004 / ADR-33 / TASK-010: Inspector 只读隔离结构测试。
 *
 * 本测试是**源文本正则扫描**结构测试（非行为测试），永久断言 Inspector
 * 模块的只读隔离不变量，防未来破坏：
 * - HARD-1: inspector-query.ts 不写状态（无 status 写入 / 文件原子写）
 * - HARD-3: inspector-query.ts 不写 decision_gates（门控权威不变 C-208）
 * - LLM 隔离: inspector-query.ts + inspector-panel.tsx 不触发 LLM
 *   （无 streamChat / invokeCli / callLLM / callClaude / spawn）
 *
 * 与 inspector.spec.ts Group C（行为级 mock fs 断言）互补：本文件用
 * readFileSync 读源文本 + 正则扫描，覆盖**源文本静态不变量**，不依赖
 * 运行时 mock —— 即使未来有人绕过 mock 注入写操作，本测试仍会捕获
 * 源文本中的写/LLM 调用符号。
 *
 * isStale 行为测试（HARD-2 派生）：验证 queryInspectorState 在草稿 mtime
 * 晚于 cachedAt 时返回 isStale=true（缓存非实时，防误判为门控）。
 */
import { readFileSync } from "fs"
import path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"

// fs mocks — 仅用于 isStale 行为测试（结构断言不依赖 mock）。
const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string): Promise<string> => ""),
  writeFileAtomic: vi.fn(async (_path: string, _contents: string): Promise<void> => {}),
  getFileModifiedTime: vi.fn(async (_path: string): Promise<number> => 0),
  fileExists: vi.fn(async (_path: string): Promise<boolean> => false),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
  getFileModifiedTime: fsMocks.getFileModifiedTime,
  fileExists: fsMocks.fileExists,
  listDirectory: vi.fn(async (_path: string): Promise<any[]> => []),
  createDirectory: vi.fn(async (_path: string): Promise<void> => {}),
}))

import { queryInspectorState } from "./inspector-query"

const INSPECTOR_QUERY_PATH = path.resolve(
  __dirname,
  "inspector-query.ts",
)
const INSPECTOR_PANEL_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "components",
  "inspector",
  "inspector-panel.tsx",
)

function readSource(filePath: string): string {
  return readFileSync(filePath, "utf-8")
}

/** 统计源文本中匹配给定正则的次数（全局匹配，重叠不计）。 */
function countMatches(source: string, pattern: RegExp): number {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)
  const matches = source.match(re)
  return matches ? matches.length : 0
}

describe("EPIC-004 / ADR-33 / TASK-010: Inspector 只读隔离结构断言", () => {
  describe("inspector-query.ts 源文本不变量", () => {
    it("HARD-1: 不调用 writeStatus / saveStatus / persistCheckpoint / writeFileAtomic / writeFile（不写状态）", () => {
      const source = readSource(INSPECTOR_QUERY_PATH)
      const pattern = /writeStatus|saveStatus|persistCheckpoint|writeFileAtomic|writeFile\b/g
      const count = countMatches(source, pattern)
      expect(count).toBe(0)
    })

    it("LLM 隔离: 不调用 streamChat / invokeCli / callLLM / callClaude / spawn（不触 LLM）", () => {
      const source = readSource(INSPECTOR_QUERY_PATH)
      const pattern = /streamChat|invokeCli|callLLM|callClaude|\bspawn\b/g
      const count = countMatches(source, pattern)
      expect(count).toBe(0)
    })

    it("HARD-3: 不写 decision_gates（无赋值 / 对象字面量 key；read 访问允许）", () => {
      const source = readSource(INSPECTOR_QUERY_PATH)
      // 匹配 write/assignment 形式：`decision_gates =` 或 `decision_gates:`（对象字面量 key）。
      // read 形式（status?.decision_gates / status.decision_gates）后跟 . ? ) 或换行，
      // 不匹配 \s*[:=]。
      const pattern = /decision_gates\s*[:=]/g
      const count = countMatches(source, pattern)
      expect(count).toBe(0)
    })

    it("fs import 只读：仅 readFile / getFileModifiedTime，无 writeFile / writeFileAtomic", () => {
      const source = readSource(INSPECTOR_QUERY_PATH)
      // import 行：`import { readFile, getFileModifiedTime } from "@/commands/fs"`
      const importMatch = source.match(/import\s*\{[^}]*\}\s*from\s*["']@\/commands\/fs["']/)
      expect(importMatch).not.toBeNull()
      const importClause = importMatch![0]
      expect(importClause).not.toMatch(/\bwriteFile\b/)
      expect(importClause).not.toMatch(/\bwriteFileAtomic\b/)
      expect(importClause).not.toMatch(/\bcreateDirectory\b/)
    })
  })

  describe("inspector-panel.tsx 源文本不变量", () => {
    it("LLM 隔离: UI 不直接调 streamChat / invokeCli（只通过 queryInspectorState）", () => {
      const source = readSource(INSPECTOR_PANEL_PATH)
      const pattern = /streamChat|invokeCli/g
      const count = countMatches(source, pattern)
      expect(count).toBe(0)
    })

    it("LLM 隔离: UI 不直接调 callLLM / callClaude / spawn", () => {
      const source = readSource(INSPECTOR_PANEL_PATH)
      const pattern = /callLLM|callClaude|\bspawn\b/g
      const count = countMatches(source, pattern)
      expect(count).toBe(0)
    })

    it("HARD-1: UI 不写状态（无 writeStatus / writeFileAtomic / writeFile）", () => {
      const source = readSource(INSPECTOR_PANEL_PATH)
      const pattern = /writeStatus|saveStatus|persistCheckpoint|writeFileAtomic|writeFile\b/g
      const count = countMatches(source, pattern)
      expect(count).toBe(0)
    })
  })

  describe("isStale 行为测试（HARD-2 派生：缓存非实时，防误判为门控）", () => {
    beforeEach(() => {
      fsMocks.readFile.mockReset()
      fsMocks.writeFileAtomic.mockReset()
      fsMocks.getFileModifiedTime.mockReset()
      fsMocks.fileExists.mockReset()
    })

    it("isStale=true: 草稿 mtime 晚于 cachedAt（status.updated_at）→ 缓存已过期", async () => {
      // status 含 stale dimension_results（缓存结果），updated_at = 01:00。
      // 草稿 mtime = 02:00（晚 1 小时）→ computeIsStale 返回 true。
      const status = {
        schema_version: "1",
        session_id: "novel-test",
        source: "deep_chapter_generation",
        created_at: "2026-07-10T00:00:00.000Z",
        updated_at: "2026-07-10T01:00:00.000Z",
        status: "running",
        active_step_index: 2,
        current_task: {
          task_id: "tsk-conv-1",
          conversation_id: "conv-1",
          user_request: "write chapter",
          chapter_number: 1,
          checkpoint_stage: "after_draft",
          status: "running",
        },
        draft: {
          draft_id: "conv-1",
          file_path: "/P/.novel/drafts/conv-1.json",
          draft_status: "ready",
          updated_at: "2026-07-10T01:00:00.000Z",
        },
        decision_gates: {
          consistency: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
          anti_ai: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
          quality: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
          overall: "pending",
        },
        dimension_results: {
          thrill: {
            dimensionKey: "thrill",
            score: 80,
            status: "pass",
            summary: "爽感通过",
            thinking: "thrill thinking",
            issues: [],
          },
        },
      }
      fsMocks.readFile.mockImplementation(async (p: string) => {
        if (p.endsWith("status.json")) return JSON.stringify(status)
        if (p.endsWith("conv-1.json")) return "草稿正文"
        return ""
      })
      fsMocks.fileExists.mockResolvedValue(false)
      // 草稿 mtime = 02:00（晚于 cachedAt 01:00）→ stale。
      fsMocks.getFileModifiedTime.mockResolvedValue(Date.parse("2026-07-10T02:00:00.000Z"))

      const snapshot = await queryInspectorState("/P", "chapter-1")

      expect(snapshot.isStale).toBe(true)
      // 缓存结果仍可读（stale 不等于无数据）— isStale 期间灰显但展示缓存。
      expect(snapshot.review.findings).toHaveLength(1)
      expect(snapshot.review.findings[0].dimensionKey).toBe("thrill")
    })

    it("isStale=false: 草稿 mtime 早于 cachedAt → 缓存新鲜", async () => {
      const status = {
        schema_version: "1",
        session_id: "novel-test",
        source: "deep_chapter_generation",
        created_at: "2026-07-10T00:00:00.000Z",
        updated_at: "2026-07-10T03:00:00.000Z",
        status: "running",
        active_step_index: 2,
        current_task: null,
        draft: {
          draft_id: "conv-1",
          file_path: "/P/.novel/drafts/conv-1.json",
          draft_status: "ready",
          updated_at: "2026-07-10T03:00:00.000Z",
        },
        decision_gates: {
          consistency: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
          anti_ai: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
          quality: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
          overall: "pending",
        },
      }
      fsMocks.readFile.mockImplementation(async (p: string) => {
        if (p.endsWith("status.json")) return JSON.stringify(status)
        if (p.endsWith("conv-1.json")) return "草稿正文"
        return ""
      })
      fsMocks.fileExists.mockResolvedValue(false)
      // 草稿 mtime = 02:00（早于 cachedAt 03:00）→ 非过期。
      fsMocks.getFileModifiedTime.mockResolvedValue(Date.parse("2026-07-10T02:00:00.000Z"))

      const snapshot = await queryInspectorState("/P", "chapter-1")

      expect(snapshot.isStale).toBe(false)
    })
  })
})
