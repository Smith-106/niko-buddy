/**
 * ISS-20260724-002 ARCH-1：巨石残留（ingest.ts 1910 行）叶子缺行为 spec 缺口补齐。
 *
 * 对账（ingest.ts 导出 × ingest.spec.ts describe）：以下 6 叶子零覆盖——
 * writeFileBlocks / stripFencedCodeSegments / parseReviewBlocks /
 * sanitizeBackupRelativePath / buildIngestWritePlan / buildIngestWriteSummary。
 * 本文件逐项补一行为用例（SRP 拆分不动——行为先行锁定，拆分另议）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  buildIngestWritePlan,
  buildIngestWriteSummary,
  parseReviewBlocks,
  sanitizeBackupRelativePath,
  stripFencedCodeSegments,
  writeFileBlocks,
} from "./ingest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(),
  writeFileAtomic: vi.fn<(path: string, content: string) => Promise<void>>(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
  listDirectory: vi.fn(async () => []),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: {
    getState: () => ({ outputLanguage: "auto" as const }),
  },
}))

const LLM = { provider: "custom", apiKey: "k", model: "m", ollamaUrl: "", customEndpoint: "", maxContextSize: 100_000 } as never

beforeEach(() => {
  fsMocks.readFile.mockReset()
  fsMocks.writeFileAtomic.mockReset()
  fsMocks.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
  fsMocks.writeFileAtomic.mockResolvedValue(undefined)
})

describe("ISS-20260724-002 ARCH-1：ingest 叶子行为 spec 缺口补齐", () => {
  it("stripFencedCodeSegments：围栏内 REVIEW 标记被抹除（不解析），围栏外保留", () => {
    const text = [
      "```",
      "---REVIEW: contradiction | 围栏内标题 ---",
      "正文",
      "---END REVIEW---",
      "```",
      "---REVIEW: suggestion | 围栏外标题 ---",
      "请补充来源。",
      "---END REVIEW---",
    ].join("\n")
    const stripped = stripFencedCodeSegments(text)
    expect(stripped).not.toContain("围栏内标题")
    expect(stripped).toContain("围栏外标题")
    // 未闭合围栏不吞噬后续
    const unclosed = stripFencedCodeSegments("```\n---REVIEW: suggestion | 悬空 ---\nx\n---END REVIEW---")
    expect(unclosed).toContain("悬空")
  })

  it("parseReviewBlocks：类型/标题/OPTIONS-PAGES-SEARCH 行解析 + 未知类型回 confirm", () => {
    const text = [
      "---REVIEW: contradiction | 时间线冲突 ---",
      "第三章说林云不会剑法，第五章却用剑。",
      "OPTIONS: 修正第三章 | 修正第五章",
      "PAGES: wiki/timeline.md, wiki/ch5.md",
      "SEARCH: 林云 剑法",
      "---END REVIEW---",
      "---REVIEW: whatever | 未知类型 ---",
      "内容。",
      "---END REVIEW---",
    ].join("\n")
    const items = parseReviewBlocks(text, "wiki/review.md")
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      type: "contradiction",
      title: "时间线冲突",
      sourcePath: "wiki/review.md",
    })
    expect(items[0].options).toEqual([
      { label: "修正第三章", action: "修正第三章" },
      { label: "修正第五章", action: "修正第五章" },
    ])
    expect(items[0].affectedPages).toEqual(["wiki/timeline.md", "wiki/ch5.md"])
    expect(items[0].searchQueries).toEqual(["林云 剑法"])
    expect(items[0].description).toContain("第三章说林云不会剑法")
    expect(items[0].description).not.toContain("OPTIONS:")
    expect(items[1].type).toBe("confirm")
    // 缺省 OPTIONS 回退 Approve/Skip
    expect(items[1].options).toEqual([
      { label: "Approve", action: "Approve" },
      { label: "Skip", action: "Skip" },
    ])
  })

  it("sanitizeBackupRelativePath：路径穿越拍平 + 空/点点映射 unnamed", () => {
    expect(sanitizeBackupRelativePath("wiki/entities/林云.md")).toBe("wiki_entities_林云.md")
    expect(sanitizeBackupRelativePath("C:\\evil\\..\\x.md")).not.toMatch(/[/\\:]/)
    expect(sanitizeBackupRelativePath("")).toBe("unnamed")
    expect(sanitizeBackupRelativePath("..")).toBe("unnamed")
    expect(sanitizeBackupRelativePath("a\0b")).toBe("ab")
  })

  it("buildIngestWritePlan：累积文本 → 写操作计划（log 判定 + 警告透传）", () => {
    const accumulated = [
      "---FILE: wiki/log.md ---",
      "今日进展",
      "---END FILE---",
      "---FILE: wiki/entities/林云.md ---",
      "# 林云",
      "---END FILE---",
    ].join("\n")
    const plan = buildIngestWritePlan("P:/proj", accumulated)
    expect(plan.operations).toHaveLength(2)
    expect(plan.operations[0]).toMatchObject({
      relativePath: "wiki/log.md",
      fullPath: "P:/proj/wiki/log.md",
      isLogAppend: true,
    })
    expect(plan.operations[1]).toMatchObject({
      relativePath: "wiki/entities/林云.md",
      isLogAppend: false,
    })
    expect(plan.operations[1].content).toContain("# 林云")
  })

  it("buildIngestWriteSummary：有落盘列清单，无落盘给空文案", () => {
    expect(buildIngestWriteSummary(["wiki/log.md", "wiki/entities/林云.md"])).toBe(
      "已写入知识库文件：\n- wiki/log.md\n- wiki/entities/林云.md",
    )
    expect(buildIngestWriteSummary([])).toBe("未写入任何文件。LLM 响应中未包含有效的文件块。")
  })

  it("writeFileBlocks：空累积零写盘 + log 块追加写盘（行为等价冒烟）", async () => {
    const empty = await writeFileBlocks("P:/proj", "no blocks here", LLM, "src.md")
    expect(empty).toEqual({ writtenPaths: [], warnings: [], hardFailures: [] })
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()

    const text = ["---FILE: wiki/log.md ---", "今日进展：林云出场。", "---END FILE---"].join("\n")
    const res = await writeFileBlocks("P:/proj", text, LLM, "src.md")
    expect(res.writtenPaths).toEqual(["wiki/log.md"])
    expect(res.hardFailures).toEqual([])
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const [path, content] = fsMocks.writeFileAtomic.mock.calls[0] as [string, string]
    expect(path).toBe("P:/proj/wiki/log.md")
    expect(content).toContain("林云出场")
  })
})
