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
  it("有书且无偏好时只展开写作和审改", () => {
    expect(readCollapsedGroups()).toEqual(DEFAULT_COLLAPSED_GROUPS)
    expect(initialCollapsedGroups(false)).toEqual(["si", "shen", "tools", "maint"])
    expect(DEFAULT_COLLAPSED_GROUPS).not.toContain("review")
    expect(DEFAULT_COLLAPSED_GROUPS).not.toContain("ma")
  })

  it("没有书且无偏好时展开开书组", () => {
    expect(initialCollapsedGroups(true)).toEqual(["shen", "tools", "maint"])
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

describe("nav 六组（批次三·10）", () => {
  it("旧「设置」组拆成创作工具与维护，每组至少一个常驻入口", () => {
    const groups = new Set(NAV_ITEMS.map((i) => i.group))
    expect([...groups].sort()).toEqual(["ma", "maint", "review", "shen", "si", "tools"])
    for (const g of groups) {
      expect(NAV_ITEMS.some((i) => i.group === g && isNavPrimaryTier(i)), g).toBe(true)
    }
    expect(NAV_ITEMS.filter((i) => i.group === "maint").map((i) => i.view)).not.toContain("creativeHub")
  })
})

describe("nav tier 分层", () => {
  it("32 项总量（含 Antigravity ACP 官方交互面板），主次分层 18/14，maint 保持 8 项", () => {
    expect(NAV_ITEMS).toHaveLength(32)
    const primary = NAV_ITEMS.filter(isNavPrimaryTier)
    const secondary = NAV_ITEMS.filter((i) => !isNavPrimaryTier(i))
    expect(primary).toHaveLength(18)
    expect(secondary).toHaveLength(14)
    expect(NAV_ITEMS.some((i) => i.view === "liveExecution")).toBe(false)

    const acpEntry = NAV_ITEMS.find((i) => i.view === "antigravityAcp")
    expect(acpEntry?.group).toBe("tools")
    expect(acpEntry?.tier).toBe("primary")
    expect(NAV_ITEMS.filter((i) => i.group === "maint")).toHaveLength(8)
  })

  it("主控直达：ma 组 primary，复用 content-area mainControl 分支", () => {
    const entry = NAV_ITEMS.find((i) => i.view === "mainControl")
    expect(entry?.group).toBe("ma")
    expect(entry?.tier).toBe("primary")

    const workflowEntry = NAV_ITEMS.find((i) => i.view === "workflowEditor")
    expect(workflowEntry?.group).toBe("maint")
    expect(workflowEntry?.tier).toBe("secondary")
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

describe("readCollapsedGroups 非法存储", () => {
  it("localStorage 里是非数组 JSON → 返回空数组（不抛）", () => {
    localStorage.setItem(NAV_COLLAPSED_GROUPS_KEY, JSON.stringify({ not: "array" }))
    expect(readCollapsedGroups()).toEqual([])
  })
})
