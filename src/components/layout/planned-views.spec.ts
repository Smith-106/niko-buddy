/**
 * planned-views.spec.ts — 计划态视图登记表的消费契约。
 *
 * WaveC 之后登记表已清空（15 个灰卡视图全部落地）。规范仍是「单一真源」：
 * 空表必须让 isPlannedView 恒 false、getPlannedView 恒 undefined，
 * 使 content-area 的占位分支与 workbench 的置灰逻辑自然退役。
 * 且 table 与 query 必须派生自同一个 PLANNED_VIEWS（新增模块只改一处）。
 */
import { describe, expect, it } from "vitest"
import { PLANNED_VIEWS, getPlannedView, isPlannedView } from "./planned-views"

describe("planned-views 登记表消费契约", () => {
  it("登记表为空（WaveC 毕业后全部落地）", () => {
    expect(PLANNED_VIEWS).toEqual([])
  })

  it("isPlannedView 对任意现存视图恒为 false", () => {
    for (const view of ["chat", "canon", "review-center", "memory-center", "timeline"]) {
      expect(isPlannedView(view)).toBe(false)
    }
    expect(isPlannedView("")).toBe(false)
  })

  it("getPlannedView 对任意现存视图恒为 undefined", () => {
    expect(getPlannedView("chat")).toBeUndefined()
    expect(getPlannedView("not-a-view")).toBeUndefined()
  })

})
