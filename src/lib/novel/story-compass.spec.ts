import { describe, expect, it } from "vitest"
import {
  COMPLETION_CHECKLIST_IDS,
  FINALE_NO_NEW_HOOKS,
  PADDING_TRAP,
  PREMATURE_ENDING_TRAP,
  checkCompleteBookAllowed,
  createEmptyStoryCompass,
  evaluateCompletionChecklist,
  updateCompass,
  type CompletionChecklistInput,
} from "./story-compass"

const BASE_INPUT: CompletionChecklistInput = {
  completedChapters: 40,
  scaleRange: { min: 36, max: 44 },
  endingAnswered: true,
  openThreads: [],
  activeForeshadowCount: 0,
  characterFatesClear: true,
  userExpectationMet: true,
}

describe("story-compass 指南针更新", () => {
  it("updateCompass 收束/新增长线 + 区间调整 immutable", () => {
    const base = {
      ...createEmptyStoryCompass("T0"),
      openThreads: ["长线A", "长线B"],
      estimatedScale: "预计 4-6 卷",
    }
    const next = updateCompass(
      base,
      { resolvedThreads: ["长线A"], newThreads: ["长线C", "长线C"], estimatedScale: "约 38-42 章" },
      { now: "T1" },
    )
    expect(next.openThreads).toEqual(["长线B", "长线C"])
    expect(next.estimatedScale).toBe("约 38-42 章")
    expect(next.lastUpdated).toBe("T1")
    // immutable：原对象不动
    expect(base.openThreads).toEqual(["长线A", "长线B"])
  })

  it("declareFinalVolume 置收官标记 + 卷号", () => {
    const next = updateCompass(createEmptyStoryCompass("T0"), { declareFinalVolume: 6 }, { now: "T1" })
    expect(next.finalVolumeDeclared).toBe(true)
    expect(next.finalVolumeNumber).toBe(6)
  })

  it("空串新长线被忽略", () => {
    const next = updateCompass(createEmptyStoryCompass("T0"), { newThreads: ["  ", "长线X"] })
    expect(next.openThreads).toEqual(["长线X"])
  })
})

describe("story-compass 完结清单 6 条", () => {
  it("清单 id 固定 6 条顺序", () => {
    expect(COMPLETION_CHECKLIST_IDS).toEqual([
      "scale_anchor",
      "threads_closed",
      "foreshadowing_zero",
      "character_fates",
      "user_expectation",
      "ending_achieved",
    ])
  })

  it("六条全过 → complete_book", () => {
    const r = evaluateCompletionChecklist(BASE_INPUT)
    expect(r.items).toHaveLength(6)
    expect(r.allPassed).toBe(true)
    expect(r.recommendation).toBe("complete_book")
  })

  it("规模未达但 2-5 全过 → 仍 complete_book（规模是证据项，非否决项，禁注水）", () => {
    const r = evaluateCompletionChecklist({ ...BASE_INPUT, completedChapters: 20 })
    expect(r.allPassed).toBe(true)
    expect(r.recommendation).toBe("complete_book")
    expect(r.items[0].detail).toContain("禁止为凑规模注水")
  })

  it("1-2 项 blocking 未过 → declare_finale（收官卷收束）", () => {
    const r = evaluateCompletionChecklist({
      ...BASE_INPUT,
      openThreads: ["长线A"],
      activeForeshadowCount: 2,
    })
    expect(r.allPassed).toBe(false)
    expect(r.recommendation).toBe("declare_finale")
  })

  it("3+ 项 blocking 未过 → continue（继续续卷）", () => {
    const r = evaluateCompletionChecklist({
      ...BASE_INPUT,
      endingAnswered: false,
      openThreads: ["A", "B"],
      activeForeshadowCount: 3,
      characterFatesClear: false,
    })
    expect(r.allPassed).toBe(false)
    expect(r.recommendation).toBe("continue")
  })

  it("用户无明确预期 → 第 6 条跳过不否决", () => {
    const r = evaluateCompletionChecklist({ ...BASE_INPUT, userExpectationMet: null })
    expect(r.items[5].passed).toBe(true)
    expect(r.items[5].detail).toContain("跳过对照")
    expect(r.recommendation).toBe("complete_book")
  })

  it("规模区间未解析 → 证据记录不否决", () => {
    const r = evaluateCompletionChecklist({ ...BASE_INPUT, scaleRange: null })
    expect(r.items[0].passed).toBe(true)
    expect(r.items[0].detail).toContain("未解析")
  })
})

describe("story-compass complete_book 硬门", () => {
  it("open_threads 非空 → 拒绝", () => {
    const v = checkCompleteBookAllowed({
      ...createEmptyStoryCompass("T"),
      openThreads: ["长线A"],
    })
    expect(v.allowed).toBe(false)
    expect(v.reason).toContain("open_threads 非空")
  })

  it("收官卷已宣告 → 拒绝重复宣告", () => {
    const v = checkCompleteBookAllowed({
      ...createEmptyStoryCompass("T"),
      finalVolumeDeclared: true,
      finalVolumeNumber: 6,
    })
    expect(v.allowed).toBe(false)
    expect(v.reason).toContain("不要重复宣告")
  })

  it("长线清空 + 未宣告 → 允许", () => {
    const v = checkCompleteBookAllowed(createEmptyStoryCompass("T"))
    expect(v.allowed).toBe(true)
  })
})

describe("story-compass 双向陷阱文案", () => {
  it("过早收笔/拖戏注水/收官禁令文案非空且语义锚定", () => {
    expect(PREMATURE_ENDING_TRAP).toContain("稳态")
    expect(PADDING_TRAP).toContain("注水")
    expect(FINALE_NO_NEW_HOOKS).toContain("不埋新钩子")
  })
})
