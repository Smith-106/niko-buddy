/**
 * ISS-20260709-031：context-engine ↔ context-data-sources 双向 import 改单向。
 *
 * 结构断言：context-data-sources.ts 不再经由 ./context-engine 中转，
 * 直接引用各 helper 的定义源模块（detection：文件文本 import 关系）。
 * 等价断言：对外兼容面不变 —— engine 仍 re-export helper + 数据源注册完整。
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  joinNonEmpty,
  readChapterOutlineContent,
  readOutlineContent,
  searchGraphRelevantContent,
  searchRelevantContentUnified,
  selectLookbackChapterNumbers,
} from "./context-engine"
import { getAllDataSources } from "./context-data-sources"

const dataSourcesSource = readFileSync(new URL("./context-data-sources.ts", import.meta.url), "utf8")

describe("ISS-20260709-031 context-engine/context-data-sources 单向依赖", () => {
  it("context-data-sources 不再从 ./context-engine 导入（运行时双向边消除）", () => {
    expect(dataSourcesSource).not.toMatch(/from\s+["']\.\/context-engine["']/)
  })

  it("helper 直连定义源模块：大纲/检索/纯组装各归其位", () => {
    expect(dataSourcesSource).toMatch(/from\s+["']\.\/context-engine-outline["']/)
    expect(dataSourcesSource).toMatch(/from\s+["']\.\/context-retrieval["']/)
    expect(dataSourcesSource).toMatch(/from\s+["']\.\/context-task-brief-builders["']/)
  })

  it("对外兼容面不变：engine re-export 的 helper 仍可用（行为等价）", () => {
    for (const fn of [
      readOutlineContent,
      readChapterOutlineContent,
      searchRelevantContentUnified,
      searchGraphRelevantContent,
      selectLookbackChapterNumbers,
      joinNonEmpty,
    ]) {
      expect(typeof fn).toBe("function")
    }
    expect(joinNonEmpty(["a", "", "b"], "\n")).toBe("a\nb")
    expect(selectLookbackChapterNumbers(3, 2)).toEqual([2, 1])
  })

  it("数据源注册完整：getAllDataSources 仍产出全部已知源（行为等价）", () => {
    const names = getAllDataSources().map((s) => s.name)
    for (const expected of [
      "outline",
      "chapterOutline",
      "snapshots",
      "revisionFeedback",
      "cognitionText",
      "soulDoc",
      "searchResults",
      "graphSearchResults",
    ]) {
      expect(names).toContain(expected)
    }
    expect(names.length).toBeGreaterThan(10)
  })
})
