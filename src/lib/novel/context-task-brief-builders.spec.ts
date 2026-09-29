// @vitest-environment node
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// context-task-brief-builders.spec — F4-2（Round-2 评估）拆分产物单测：
// 任务简报组装纯函数簇（与 context-engine 内联实现语义一致）。

import { describe, expect, it } from "vitest"
import {
  buildChapterGoal,
  buildMustAvoid,
  buildMustDo,
  buildNextChapterAdvice,
  extractChapterGoal,
  extractChapterNumberFromTask,
  joinNonEmpty,
  mergeForeshadowingSignals,
  selectLookbackChapterNumbers,
} from "./context-task-brief-builders"

describe("context-task-brief-builders (F4-2 split)", () => {
  it("extractChapterNumberFromTask：中/英章节号 + 越界钳制", () => {
    expect(extractChapterNumberFromTask("生成第 7 章正文")).toBe(7)
    expect(extractChapterNumberFromTask("continue chapter 30")).toBe(30)
    expect(extractChapterNumberFromTask("ch.3 rewrite")).toBe(3)
    expect(extractChapterNumberFromTask("随便聊聊")).toBeUndefined()
    expect(extractChapterNumberFromTask("第999999999章")).toBeUndefined()
  })

  it("selectLookbackChapterNumbers：倒序回看 + 下界 1", () => {
    expect(selectLookbackChapterNumbers(5, 3)).toEqual([4, 3, 2])
    expect(selectLookbackChapterNumbers(2, 5)).toEqual([1])
    expect(selectLookbackChapterNumbers(1, 3)).toEqual([])
  })

  it("mergeForeshadowingSignals：空输入空输出；反复伏笔追加提醒", () => {
    expect(mergeForeshadowingSignals([], "  ")).toBe("")
    const out = mergeForeshadowingSignals(["旧信警告：未回收"], "旧信警告出现多次")
    expect(out).toContain("旧信警告")
    expect(out).toContain("反复出现")
  })

  it("extractChapterGoal：命中章节行 + 无命中空串", () => {
    expect(extractChapterGoal("", 3)).toBe("")
    expect(extractChapterGoal("第3章：雾夜入宅\n第4章：水渍下的字", 3)).toContain("雾夜入宅")
    expect(extractChapterGoal("第4章：水渍下的字", 3)).toBe("")
  })

  it("buildChapterGoal：双源去重合并", () => {
    expect(buildChapterGoal("第3章：A", "第3章：A", 3)).toBe("A")
    const both = buildChapterGoal("第3章：A", "第3章：B", 3)
    expect(both).toContain("A")
    expect(both).toContain("B")
  })

  it("buildMustDo / buildMustAvoid：空输入空输出", () => {
    expect(buildMustDo("", "", "")).toBe("")
    expect(buildMustAvoid("", "", "")).toBe("")
    expect(buildMustDo("A\nB", "", "")).toContain("- A")
  })

  it("buildNextChapterAdvice：空输入空输出；有输入有行", () => {
    expect(
      buildNextChapterAdvice({ chapterGoal: "", recentSummaries: [], previousChapterEnding: "", foreshadowingStates: "", timeline: "", searchResults: "" }),
    ).toBe("")
    const out = buildNextChapterAdvice({
      chapterGoal: "破局", recentSummaries: ["s1"], previousChapterEnding: "",
      foreshadowingStates: "", timeline: "", searchResults: "",
    })
    expect(out.length).toBeGreaterThan(0)
  })

  it("joinNonEmpty：去空拼接", () => {
    expect(joinNonEmpty([" a ", "", "b "], "|")).toBe("a|b")
  })
})
