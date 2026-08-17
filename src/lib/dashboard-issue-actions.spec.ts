import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  createDirectory: mocks.createDirectory,
}))

import {
  applyDashboardInsertBeforeToMarkdown,
  applyDashboardRewriteToMarkdown,
  buildDashboardIssueId,
  buildDashboardRewriteMessages,
  buildFactCheckInsertMessages,
  createEmptyDashboardIssueState,
  findChapterSelectionByEvidence,
  getDashboardIssueStorePath,
  loadDashboardIssueState,
  parseFactCheckInsertPlan,
  restoreDashboardRewriteInMarkdown,
  sanitizeDashboardEvidence,
  saveDashboardIssueState,
  type DashboardIssueAnchor,
  type DashboardIssueRewriteBackup,
} from "./dashboard-issue-actions"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readFile.mockResolvedValue("")
  mocks.createDirectory.mockResolvedValue(undefined)
})

describe("state creation and ids", () => {
  it("creates an empty state", () => {
    expect(createEmptyDashboardIssueState()).toEqual({ ignored: {}, rewrites: {} })
  })

  it("builds stable ids from parts, normalizing nulls and whitespace", () => {
    expect(buildDashboardIssueId(["a", "b"])).toBe("a|b")
    expect(buildDashboardIssueId(["a", null, undefined, 3])).toBe("a|||3")
    expect(buildDashboardIssueId([" x  y "])).toBe("x y")
  })

  it("computes the store path from a normalized project path", () => {
    expect(getDashboardIssueStorePath("C:\\proj")).toBe("C:/proj/.qmai/dashboard-issues.json")
  })
})

describe("loadDashboardIssueState", () => {
  it("returns the empty state when the file is missing or unreadable", async () => {
    mocks.readFile.mockRejectedValue(new Error("enoent"))
    await expect(loadDashboardIssueState("/P")).resolves.toEqual({ ignored: {}, rewrites: {} })
  })

  it("returns the empty state when the file is malformed JSON", async () => {
    mocks.readFile.mockResolvedValue("{not json")
    await expect(loadDashboardIssueState("/P")).resolves.toEqual({ ignored: {}, rewrites: {} })
  })

  it("normalizes persisted ignored/rewrites and drops invalid entries", async () => {
    const backup: DashboardIssueRewriteBackup = {
      itemId: "i1",
      targetPath: "ch1.md",
      evidence: "e",
      originalText: "old",
      replacementText: "new",
      updatedAt: "2026-01-01",
    }
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        ignored: { "id-1": true, "id-2": false, "id-3": 1 },
        rewrites: {
          good: backup,
          minimal: { itemId: "i2", targetPath: "p", originalText: "o", replacementText: "r" },
          missingFields: { itemId: "x" },
          wrongType: "nope",
        },
      }),
    )
    const state = await loadDashboardIssueState("/P")
    expect(state.ignored).toEqual({ "id-1": true, "id-3": true })
    expect(state.rewrites.good).toEqual(backup)
    expect(state.rewrites.minimal).toEqual({
      itemId: "i2",
      targetPath: "p",
      evidence: "",
      originalText: "o",
      replacementText: "r",
      updatedAt: "",
    })
  })

  it("handles absent ignored/rewrites sections", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({}))
    await expect(loadDashboardIssueState("/P")).resolves.toEqual({ ignored: {}, rewrites: {} })
  })
})

describe("saveDashboardIssueState", () => {
  it("writes the normalized state after ensuring the .qmai dir", async () => {
    await saveDashboardIssueState("/P", { ignored: { a: true }, rewrites: {} })
    expect(mocks.createDirectory).toHaveBeenCalledWith("/P/.qmai")
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/P/.qmai/dashboard-issues.json",
      expect.stringContaining('"ignored"'),
    )
  })

  it("tolerates createDirectory failures", async () => {
    mocks.createDirectory.mockRejectedValue(new Error("exists"))
    await expect(saveDashboardIssueState("/P", { ignored: {}, rewrites: {} })).resolves.toBeUndefined()
  })
})

describe("sanitizeDashboardEvidence", () => {
  it("strips chapter prefixes, bracket markers, and surrounding quotes", () => {
    expect(sanitizeDashboardEvidence("第 12 章：正文内容")).toBe("正文内容")
    expect(sanitizeDashboardEvidence("[对话] 内容")).toBe("内容")
    expect(sanitizeDashboardEvidence("“引号包裹”")).toBe("引号包裹")
    expect(sanitizeDashboardEvidence("（括号）")).toBe("括号")
    expect(sanitizeDashboardEvidence("  纯文本  ")).toBe("纯文本")
    expect(sanitizeDashboardEvidence("")).toBe("")
  })
})

describe("findChapterSelectionByEvidence", () => {
  const markdown = "# 第一章\n\n甲乙丙丁缓缓走来。\n\n然后甲乙丙丁开口说话。"

  it("finds the first candidate across multiple evidences", () => {
    const anchor = findChapterSelectionByEvidence(markdown, [null, "不存在的内容", "甲乙丙丁缓缓走来。"])
    expect(anchor).not.toBeNull()
    expect(anchor?.selection.text).toBe("甲乙丙丁缓缓走来。")
    expect(anchor?.selection.bodySnapshot).toContain("甲乙丙丁缓缓走来。")
  })

  it("falls back to sentence fragments and prefixes", () => {
    const anchor = findChapterSelectionByEvidence(markdown, ["甲乙丙丁缓缓走来。然后甲乙丙丁开口说话。"])
    expect(anchor?.selection.text.length).toBeGreaterThan(0)
  })

  it("returns null when nothing matches", () => {
    expect(findChapterSelectionByEvidence(markdown, ["完全不存在的句子。"])).toBeNull()
    expect(findChapterSelectionByEvidence(markdown, [""])).toBeNull()
    // evidence that normalizes to empty (ellipsis only) produces no candidates
    expect(findChapterSelectionByEvidence(markdown, ["…"])).toBeNull()
  })
})

describe("message builders", () => {
  it("builds rewrite messages with a default suggestion", () => {
    const messages = buildDashboardRewriteMessages("问题", undefined, "source")
    expect(messages[0].role).toBe("system")
    expect(messages[1].content).toContain("问题说明：问题")
    expect(messages[1].content).toContain("请直接修正这个问题")
    expect(messages[1].content).toContain("source")
  })

  it("builds rewrite messages with a custom suggestion", () => {
    const messages = buildDashboardRewriteMessages("问题", "建议", "source")
    expect(messages[1].content).toContain("修改建议：建议")
  })

  it("builds fact-check messages omitting optional sections", () => {
    const messages = buildFactCheckInsertMessages("事实冲突", "问题", undefined, undefined, undefined, "chapter")
    const content = messages[1].content
    expect(content).toContain("问题类型：事实冲突")
    expect(content).toContain("请补足支撑这次事实变化的中间事件")
    expect(content).not.toContain("上一处证据")
    expect(content).not.toContain("当前证据")
  })

  it("builds fact-check messages with evidences and suggestion", () => {
    const messages = buildFactCheckInsertMessages("t", "m", "s", "A", "B", "chapter")
    const content = messages[1].content
    expect(content).toContain("修改建议：s")
    expect(content).toContain("上一处证据：A")
    expect(content).toContain("当前证据：B")
  })
})

describe("parseFactCheckInsertPlan", () => {
  it("parses fact check insert plan returned with prompt field names", () => {
    const raw = `{
      "anchor_text": "黑玉残镜把手机放到桌上。",
      "insert_text": "在这之前，杨栋把手机交给黑玉残镜，补上了物品转移的过程。"
    }`

    const plan = parseFactCheckInsertPlan(raw)

    expect(plan).toEqual({
      anchorText: "黑玉残镜把手机放到桌上。",
      insertText: "在这之前，杨栋把手机交给黑玉残镜，补上了物品转移的过程。",
    })
  })

  it("returns null for empty, malformed, or incomplete plans", () => {
    expect(parseFactCheckInsertPlan("   ")).toBeNull()
    expect(parseFactCheckInsertPlan("not json")).toBeNull()
    expect(parseFactCheckInsertPlan('{"anchor_text":"a"}')).toBeNull()
    expect(parseFactCheckInsertPlan('{"insert_text":"b"}')).toBeNull()
    expect(parseFactCheckInsertPlan("{broken")).toBeNull()
  })
})

describe("applyDashboardRewriteToMarkdown", () => {
  const markdown = "---\ntitle: 章\n---\n# 第一章\n\n句子甲原文。\n\n句子乙原文。"

  it("replaces the anchored selection and preserves frontmatter and heading", () => {
    const anchor = findChapterSelectionByEvidence(markdown, ["句子甲原文。"])!
    const out = applyDashboardRewriteToMarkdown(markdown, anchor, "句子甲改后。")
    expect(out).toContain("---\ntitle: 章\n---")
    expect(out).toContain("# 第一章")
    expect(out).toContain("句子甲改后。")
    expect(out).not.toContain("句子甲原文。")
  })

  it("returns null when the selection no longer matches the current body", () => {
    const stale: DashboardIssueAnchor = {
      evidence: "句子甲原文。",
      selection: { start: 0, end: 6, text: "句子甲原文。", bodySnapshot: "完全不同了的正文。" },
    }
    expect(applyDashboardRewriteToMarkdown(markdown, stale, "x")).toBeNull()
  })
})

describe("applyDashboardInsertBeforeToMarkdown", () => {
  const markdown = "# 第一章\n\n锚点句。\n\n后续内容。"

  it("inserts text before the anchor", () => {
    const anchor = findChapterSelectionByEvidence(markdown, ["锚点句。"])!
    const out = applyDashboardInsertBeforeToMarkdown(markdown, anchor, " 新增内容 ")
    expect(out).toContain("新增内容\n锚点句。")
  })

  it("returns null for blank insertions", () => {
    const anchor = findChapterSelectionByEvidence(markdown, ["锚点句。"])!
    expect(applyDashboardInsertBeforeToMarkdown(markdown, anchor, "   ")).toBeNull()
  })
})

describe("restoreDashboardRewriteInMarkdown", () => {
  const markdown = "# 第一章\n\n句子甲原文。\n\n后续内容。"
  const backup: DashboardIssueRewriteBackup = {
    itemId: "i1",
    targetPath: "",
    evidence: "句子甲原文。",
    originalText: "句子甲原文。",
    replacementText: "句子甲改后。",
    updatedAt: "2026-01-01",
  }

  it("restores by replacing the backup replacement text", () => {
    const rewritten = "# 第一章\n\n句子甲改后。\n\n后续内容。"
    const out = restoreDashboardRewriteInMarkdown(rewritten, backup)
    expect(out).toContain("句子甲原文。")
    expect(out).not.toContain("句子甲改后。")
  })

  it("restores via evidence anchor when the replacement text is absent", () => {
    const out = restoreDashboardRewriteInMarkdown(markdown, backup)
    expect(out).toContain("句子甲原文。")
  })

  it("returns null when neither replacement nor evidence can be found", () => {
    const other = "# 第二章\n\n完全无关的内容。"
    expect(restoreDashboardRewriteInMarkdown(other, backup)).toBeNull()
  })
})
