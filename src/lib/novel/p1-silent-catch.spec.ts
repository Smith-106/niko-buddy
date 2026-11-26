// ISS-20260709-025 PAT-IM2 + E5-06: 全项目静默 catch 7 文件加诊断（日志或 gap 记录，不改控制流）。
// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(async (_p: string): Promise<string> => ""),
  writeFile: vi.fn(async (_p: string, _c: string): Promise<void> => {}),
  createDirectory: vi.fn(async (_p: string): Promise<void> => {}),
  getFileModifiedTime: vi.fn(async (): Promise<number> => 0),
}))

const llmMocks = vi.hoisted(() => ({
  streamChat: vi.fn(
    async (
      _cfg: unknown,
      _msgs: unknown,
      cbs: { onToken: (t: string) => void; onDone: () => void; onError: (e: Error) => void },
    ) => {
      cbs.onToken("补充角色小传正文")
      cbs.onDone()
    },
  ),
}))

const contextMocks = vi.hoisted(() => ({
  buildContextPack: vi.fn(async () => ({
    task: "t",
    chapterGoal: "",
    outline: "# 总大纲\n主线剧情",
    recentSummaries: [],
    previousChapterEnding: "",
    characterStates: "",
    soulDoc: "",
    characterAuras: "",
    cognitionStates: "",
    foreshadowingStates: "",
    timeline: "",
    relatedSettings: "",
    canonRules: "",
    writingStyle: "",
    searchResults: "",
    graphSearchResults: "",
    mustDo: "",
    mustAvoid: "",
    nextChapterAdvice: "",
    revisionDirectives: "",
  })),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: fsMocks.readFile,
    writeFile: fsMocks.writeFile,
    createDirectory: fsMocks.createDirectory,
    getFileModifiedTime: fsMocks.getFileModifiedTime,
    listDirectory: vi.fn(async () => []),
    fileExists: vi.fn(async () => false),
  }
})

vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
    streamChat: (...args: Parameters<typeof llmMocks.streamChat>) => llmMocks.streamChat(...args),
  }
})

vi.mock("./context-engine", () => ({
  buildContextPack: () => contextMocks.buildContextPack(),
}))

import { queryInspectorState } from "./inspector-query"
import { generateOutlineRefinementSectionFile } from "./outline-generation"

/** 字符级剥离注释（跟踪字符串引号与转义，避免字面量里的 `//` 或 `/*` 误裁真实代码）。 */
function stripComments(source: string): string {
  let out = ""
  let i = 0
  let quote: string | null = null
  while (i < source.length) {
    const ch = source[i]!
    const next = source[i + 1]
    if (quote) {
      out += ch
      if (ch === "\\" && i + 1 < source.length) {
        out += source[i + 1]!
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i)
      i = end === -1 ? source.length : end
      continue
    }
    out += ch
    i += 1
  }
  return out
}

describe("ISS-20260709-025 PAT-IM2 静默 catch 诊断收敛（控制流不变）", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.writeFile.mockReset()
    fsMocks.createDirectory.mockReset()
    fsMocks.getFileModifiedTime.mockReset()
    llmMocks.streamChat.mockClear()
    contextMocks.buildContextPack.mockClear()
  })

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
      // 控制流不变：缺失仍为空预览 + 元数据保留，且诊断 warn 必须触发
      expect(snap.draft.contentPreview).toBe("")
      expect(snap.draft.draftId).toBe("c")
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("read draft preview failed"))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("Inspector scene provider 失败：记 warn 后仍降级空场景（控制流不变）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
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
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("scene provider failed"))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("outline-generation appendCurrent 读目标大纲失败：记 logger.warn 后仍降级空串并写入", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const targetPath = "/P/wiki/outlines/总大纲.md"
      fsMocks.readFile.mockRejectedValueOnce(new Error("EACCES: cannot read outline"))
      fsMocks.writeFile.mockResolvedValue(undefined)
      fsMocks.createDirectory.mockResolvedValue(undefined)

      const written = await generateOutlineRefinementSectionFile(
        "/P",
        { provider: "openai", apiKey: "sk-test", model: "gpt-4o" } as never,
        "细化人物小传",
        "characterBriefs",
        { mode: "appendCurrent", targetPath },
      )

      expect(written).toBe(targetPath)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[Outline Generation]"))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("EACCES: cannot read outline"))
      expect(fsMocks.writeFile).toHaveBeenCalledWith(
        targetPath,
        expect.stringContaining("补充角色小传正文"),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("源码结构断言：七文件去注释后 0 处空 catch 块、0 处裸 catch、0 处静默 .catch(() => 空字面量)", async () => {
    const { readFile } = await import("node:fs/promises")
    const targets: Array<{ file: string; mustContain: string }> = [
      { file: "src/lib/novel/inspector-query.ts", mustContain: "PAT-IM2" },
      { file: "src/lib/novel/novel-session-status.ts", mustContain: "PAT-IM2" },
      { file: "src/lib/novel/projection-status-ledger.ts", mustContain: "corrupt JSON; original ledger left unchanged" },
      { file: "src/lib/novel/chapter-ingest.ts", mustContain: "PAT-IM2" },
      { file: "src/lib/novel/outline-generation.ts", mustContain: "PAT-IM2" },
      { file: "src/lib/novel/dimension-review-adapter.ts", mustContain: "PAT-IM2" },
      { file: "src/lib/novel/delete-source-memory.ts", mustContain: "REL-1" },
    ]
    const emptyCatchRe = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g
    const bareCatchRe = /\bcatch\s*\{/g
    const silentPromiseCatchRe =
      /\.catch\s*\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:\{\s*\}|\(\s*\{\s*\}\s*\)|""|''|``|null|undefined|false|0|\[\])\s*\)/g

    for (const t of targets) {
      const text = await readFile(t.file, "utf8")
      expect(text, `${t.file} should retain diagnostic marker`).toContain(t.mustContain)
      const stripped = stripComments(text)
      expect(stripped.match(emptyCatchRe) ?? [], `${t.file} has empty catch block`).toEqual([])
      expect(stripped.match(bareCatchRe) ?? [], `${t.file} has bare catch without error binding`).toEqual([])
      expect(stripped.match(silentPromiseCatchRe) ?? [], `${t.file} has silent .catch(() => literal)`).toEqual([])
    }
  })
})
