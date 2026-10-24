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
  NAV_ITEMS,
  initialCollapsedGroups,
  isNavPrimaryTier,
  readCollapsedGroups,
  type NavView,
} from "./nav-items"

afterEach(() => {
  localStorage.clear()
})

describe("readCollapsedGroups", () => {
  it("有书且无偏好时只展开写和审", () => {
    expect(readCollapsedGroups()).toEqual(DEFAULT_COLLAPSED_GROUPS)
    expect(initialCollapsedGroups(false)).toEqual(["si", "shen", "maint"])
    expect(DEFAULT_COLLAPSED_GROUPS).not.toContain("ma")
  })

  it("没有书且无偏好时展开开书组", () => {
    expect(initialCollapsedGroups(true)).toEqual(["shen", "maint"])
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

describe("nav tier 分层", () => {
  it("31 项总量（B 波导出收进 More），主次分层 16/15（故事推演提为 si 组 primary）", () => {
    expect(NAV_ITEMS).toHaveLength(31)
    const primary = NAV_ITEMS.filter(isNavPrimaryTier)
    const secondary = NAV_ITEMS.filter((i) => !isNavPrimaryTier(i))
    expect(primary).toHaveLength(16)
    expect(secondary).toHaveLength(15)
  })

  it("主控直达：ma 组 primary，复用 content-area mainControl 分支", () => {
    const entry = NAV_ITEMS.find((i) => i.view === "mainControl")
    expect(entry?.group).toBe("ma")
    expect(entry?.tier).toBe("primary")
  })

  it("高频入口常驻 primary，低频收进 secondary", () => {
    const byView = new Map<NavView, string>(NAV_ITEMS.map((i) => [i.view, i.tier ?? "primary"]))
    const primaryViews: NavView[] = ["wiki", "reviewCenter", "mainControl", "workbench", "sources", "graph", "soul", "creativeHub", "storySimulation"]
    const secondaryViews: NavView[] = ["marketRadar", "antiAiRules", "workflowEditor", "mcpManager", "help", "exportCenter"]
    for (const v of primaryViews) {
      expect(byView.get(v)).toBe("primary")
    }
    for (const v of secondaryViews) {
      expect(byView.get(v)).toBe("secondary")
    }
  })

  it("缺省 tier 按 primary 处理（向后兼容）", () => {
    expect(isNavPrimaryTier({})).toBe(true)
    expect(isNavPrimaryTier({ tier: "primary" })).toBe(true)
    expect(isNavPrimaryTier({ tier: "secondary" })).toBe(false)
  })
})
