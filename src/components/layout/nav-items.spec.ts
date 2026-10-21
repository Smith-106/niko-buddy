// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// Spec for src/components/layout/nav-items.ts — 批5入口收敛：
// 首刷默认只展开「码字」组；用户动过分组后存储优先不再回退。

import { afterEach, describe, expect, it } from "vitest"
import {
  DEFAULT_COLLAPSED_GROUPS,
  NAV_COLLAPSED_GROUPS_KEY,
  readCollapsedGroups,
} from "./nav-items"

afterEach(() => {
  localStorage.clear()
})

describe("readCollapsedGroups", () => {
  it("首刷无偏好时只展开码字组", () => {
    expect(readCollapsedGroups()).toEqual(DEFAULT_COLLAPSED_GROUPS)
    expect(DEFAULT_COLLAPSED_GROUPS).not.toContain("ma")
    expect(DEFAULT_COLLAPSED_GROUPS).toEqual(["si", "shen", "maint"])
  })

  it("用户存过偏好（含全展开）后不再回退默认", () => {
    localStorage.setItem(NAV_COLLAPSED_GROUPS_KEY, JSON.stringify([]))
    expect(readCollapsedGroups()).toEqual([])
    localStorage.setItem(NAV_COLLAPSED_GROUPS_KEY, JSON.stringify(["ma"]))
    expect(readCollapsedGroups()).toEqual(["ma"])
  })

  it("脏数据回退空数组不崩", () => {
    localStorage.setItem(NAV_COLLAPSED_GROUPS_KEY, "not-json")
    expect(readCollapsedGroups()).toEqual([])
  })
})
