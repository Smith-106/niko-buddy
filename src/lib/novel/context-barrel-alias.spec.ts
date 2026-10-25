/**
 * context-barrel-alias.spec.ts — F10-5（Round-10 QA G6 取证面整改）。
 *
 * R9 barrel 5 别名（`index.ts:293` `*FromRetrieval` 字面直出）只有 grep 字面证据，
 * 缺“从 barrel 字面 import 即用”的行为证据。本文件即该证据：
 *   1. 从 `./index`（barrel）字面导入 5 别名（import 本身失败 = 门禁失败）；
 *   2. 断言 5 别名与 `./context-retrieval` 源函数是同一函数对象（`===`，零行为分叉）；
 *   3. 断言 engine 侧 wrapper 同名导出仍在位（并存契约，默认直调原函数）。
 *
 * 零 IO / 零 LLM：只做函数对象同一性断言，不调用检索。
 */
import { describe, expect, it } from "vitest"
import {
  computeIrrelevantRatioFromRetrieval,
  searchRelevantContentFromRetrieval,
  searchRelevantContentUnifiedFromRetrieval,
  runVectorSearchForContextFromRetrieval,
  searchGraphRelevantContentFromRetrieval,
  computeIrrelevantRatio,
  searchRelevantContent,
  searchRelevantContentUnified,
  runVectorSearchForContext,
  searchGraphRelevantContent,
} from "./index"
import {
  computeIrrelevantRatio as computeIrrelevantRatioSource,
  searchRelevantContent as searchRelevantContentSource,
  searchRelevantContentUnified as searchRelevantContentUnifiedSource,
  runVectorSearchForContext as runVectorSearchForContextSource,
  searchGraphRelevantContent as searchGraphRelevantContentSource,
} from "./context-retrieval"

describe("barrel retrieval 别名字面 import（F10-5 G6 行为证据）", () => {
  it("5 别名从 barrel 可导入且为函数", () => {
    for (const fn of [
      computeIrrelevantRatioFromRetrieval,
      searchRelevantContentFromRetrieval,
      searchRelevantContentUnifiedFromRetrieval,
      runVectorSearchForContextFromRetrieval,
      searchGraphRelevantContentFromRetrieval,
    ]) {
      expect(typeof fn).toBe("function")
    }
  })

  it("别名与 context-retrieval 源函数同一对象（零行为分叉）", () => {
    expect(computeIrrelevantRatioFromRetrieval).toBe(computeIrrelevantRatioSource)
    expect(searchRelevantContentFromRetrieval).toBe(searchRelevantContentSource)
    expect(searchRelevantContentUnifiedFromRetrieval).toBe(searchRelevantContentUnifiedSource)
    expect(runVectorSearchForContextFromRetrieval).toBe(runVectorSearchForContextSource)
    expect(searchGraphRelevantContentFromRetrieval).toBe(searchGraphRelevantContentSource)
  })

  it("engine 侧 wrapper 同名导出并存（默认 gap 关闭直调原函数）", () => {
    for (const fn of [
      computeIrrelevantRatio,
      searchRelevantContent,
      searchRelevantContentUnified,
      runVectorSearchForContext,
      searchGraphRelevantContent,
    ]) {
      expect(typeof fn).toBe("function")
    }
  })

  // ISS-20260709-038 去孪生：非 Unified 实现已删，searchRelevantContent* 为 Unified 同一对象。
  it("ISS-20260709-038: searchRelevantContent 已废弃别名（与 Unified 同一对象）", () => {
    expect(searchRelevantContentFromRetrieval).toBe(searchRelevantContentUnifiedFromRetrieval)
    expect(searchRelevantContentFromRetrieval).toBe(searchRelevantContentUnifiedSource)
    expect(searchRelevantContentSource).toBe(searchRelevantContentUnifiedSource)
  })
})
