// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { RECENT_VIEWS_KEY, RECENT_VIEWS_LIMIT, nextStepRecommendations, readRecentViews, recordRecentView } from "./workbench-helpers"

afterEach(() => localStorage.clear())

describe("workbench-helpers 最近使用", () => {
  it("新访问排最前、去重、截断到上限", () => {
    recordRecentView("wiki")
    recordRecentView("reviewCenter")
    recordRecentView("wiki")
    expect(readRecentViews()).toEqual(["wiki", "reviewCenter"])
    for (const v of ["graph", "soul", "sources", "lint", "director", "bookshelf"] as const) recordRecentView(v)
    expect(readRecentViews()).toHaveLength(RECENT_VIEWS_LIMIT)
    expect(readRecentViews()[0]).toBe("bookshelf")
  })

  it("工作台、设置与开发视图不计入", () => {
    recordRecentView("workbench")
    recordRecentView("settings")
    recordRecentView("moduleHeatmap")
    expect(readRecentViews()).toEqual([])
  })

  it("存储脏数据回退空列表", () => {
    localStorage.setItem(RECENT_VIEWS_KEY, "{bad")
    expect(readRecentViews()).toEqual([])
    localStorage.setItem(RECENT_VIEWS_KEY, JSON.stringify({ a: 1 }))
    expect(readRecentViews()).toEqual([])
  })

  it("无 localStorage（非浏览器宿主）时读取返回空列表，写入只返回内存列表不抛错", () => {
    const saved = (globalThis as Record<string, unknown>)["localStorage"]
    try {
      vi.stubGlobal("localStorage", undefined)
      expect(readRecentViews()).toEqual([])
      // recordRecentView 内还有第二处 typeof 守卫：同一环境下也不得抛错，
      // 且仍返回本次会话的偏好列表（只是不落盘）。
      expect(recordRecentView("wiki")).toEqual(["wiki"])
      expect(readRecentViews()).toEqual([])
    } finally {
      if (saved === undefined) vi.unstubAllGlobals()
      else vi.stubGlobal("localStorage", saved)
    }
  })
})

describe("workbench-helpers 下一步推荐", () => {
  it("没有书时推荐开书路径", () => {
    expect(nextStepRecommendations(false).map((i) => i.view)).toEqual(["director", "bookAnalysis", "bookshelf"])
  })
  it("有书时推荐写作、审稿、跟进", () => {
    expect(nextStepRecommendations(true).map((i) => i.view)).toEqual(["wiki", "reviewCenter", "followUpCenter"])
  })
})
