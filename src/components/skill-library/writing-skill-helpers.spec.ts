// SPDX-License-Identifier: MIT
// writing-skill-helpers：多选开关（加/减两向）。
import { describe, expect, it } from "vitest"
import { toggleValue } from "./writing-skill-helpers"

describe("toggleValue", () => {
  it("已存在 → 移除该值（filter 分支）", () => {
    expect(toggleValue(["a", "b"], "a")).toEqual(["b"])
  })

  it("不存在 → 追加该值", () => {
    expect(toggleValue(["a"], "b")).toEqual(["a", "b"])
  })
})
