// SPDX-License-Identifier: MIT
// review-store 全口径覆盖：ReviewItem 增删改查/去重合并 + NovelReviewEntry 生命周期
import { beforeEach, describe, expect, it } from "vitest"
import { useReviewStore } from "./review-store"
import type { ReviewItem, NovelReviewEntry } from "./review-store"

function makePartial(overrides: Partial<Omit<ReviewItem, "id" | "resolved" | "createdAt">> = {}): Omit<ReviewItem, "id" | "resolved" | "createdAt"> {
  return {
    type: "contradiction",
    title: " 角色 A 与 B 矛盾 ",
    description: "描述",
    options: [{ label: "接受", action: "accept" }],
    ...overrides,
  }
}

function makeEntry(overrides: Partial<NovelReviewEntry> = {}): NovelReviewEntry {
  return {
    id: "entry-1",
    chapterNumber: 3,
    results: [],
    createdAt: "2026-01-01T00:00:00Z",
    resolved: false,
    ...overrides,
  }
}

beforeEach(() => {
  useReviewStore.setState({ items: [], novelReviewEntries: [] })
})

describe("review store — ReviewItem", () => {
  it("addItem 追加条目并生成 id / resolved=false / createdAt", () => {
    useReviewStore.getState().addItem(makePartial({ title: "T1" }))
    useReviewStore.getState().addItem(makePartial({ title: "T2" }))
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(2)
    expect(items[0]!.id).toMatch(/^review-\d+$/)
    expect(items[0]!.resolved).toBe(false)
    expect(items[0]!.createdAt).toBeGreaterThan(0)
    expect(items[0]!.title).toBe("T1")
    expect(items[1]!.title).toBe("T2")
    // 追加而非置顶
    expect(useReviewStore.getState().items[1]!.title).toBe("T2")
  })

  it("addItems 全新条目全部追加", () => {
    useReviewStore.getState().addItems([
      makePartial({ title: "A" }),
      makePartial({ title: "B", type: "suggestion" }),
    ])
    expect(useReviewStore.getState().items).toHaveLength(2)
  })

  it("addItems 对未解决重复项合并 affectedPages/searchQueries/sourcePath/description", () => {
    useReviewStore.getState().addItem(
      makePartial({
        type: "contradiction",
        title: "角色A与B矛盾",
        affectedPages: ["p1.md"],
        searchQueries: ["q1"],
        sourcePath: "/src/a.md",
        description: "旧描述",
      }),
    )
    useReviewStore.getState().addItems([
      makePartial({
        type: "contradiction",
        title: "角色a与b矛盾", // 归一化后同 key（小写 + trim）
        affectedPages: ["p2.md", "p1.md"], // p1 重复 → 去重
        searchQueries: ["q2"],
        sourcePath: "/src/b.md",
        description: "", // falsy → 保留旧描述
      }),
    ])
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(1) // 合并而非新增
    const item = items[0]!
    expect(item.affectedPages).toEqual(["p1.md", "p2.md"])
    expect(item.searchQueries).toEqual(["q1", "q2"])
    expect(item.sourcePath).toBe("/src/b.md")
    expect(item.description).toBe("旧描述")
    expect(item.id).toMatch(/^review-\d+$/)
  })

  it("addItems 合并时 description 优先取非空新值", () => {
    useReviewStore.getState().addItem(makePartial({ title: "重复标题", description: "旧" }))
    useReviewStore.getState().addItems([makePartial({ title: "重复标题", description: "新" })])
    expect(useReviewStore.getState().items[0]!.description).toBe("新")
  })

  it("addItems 对已解决条目不去重（视为新条目）", () => {
    useReviewStore.getState().addItem(makePartial({ title: "已解决项" }))
    const firstId = useReviewStore.getState().items[0]!.id
    useReviewStore.getState().resolveItem(firstId, "accept")
    useReviewStore.getState().addItems([makePartial({ title: "已解决项" })])
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(2)
    expect(items[0]!.resolved).toBe(true)
    expect(items[1]!.resolved).toBe(false)
    expect(items[1]!.id).not.toBe(firstId)
  })

  it("addItems 合并时 existing 无 affectedPages/searchQueries 也能合成", () => {
    useReviewStore.getState().addItem(makePartial({ title: "无页面项", affectedPages: undefined, searchQueries: undefined }))
    useReviewStore.getState().addItems([makePartial({ title: "无页面项", affectedPages: ["x.md"], searchQueries: ["y"] })])
    const item = useReviewStore.getState().items[0]!
    expect(item.affectedPages).toEqual(["x.md"])
    expect(item.searchQueries).toEqual(["y"])
  })

  it("setItems 整体替换列表", () => {
    const items: ReviewItem[] = [
      {
        id: "r1", type: "confirm", title: "C", description: "d",
        options: [], resolved: false, createdAt: 1,
      },
    ]
    useReviewStore.getState().setItems(items)
    expect(useReviewStore.getState().items).toEqual(items)
  })

  it("resolveItem 命中时标记 resolved + resolvedAction", () => {
    useReviewStore.getState().addItem(makePartial({ title: "T" }))
    const id = useReviewStore.getState().items[0]!.id
    useReviewStore.getState().resolveItem(id, "accept")
    const item = useReviewStore.getState().items[0]!
    expect(item.resolved).toBe(true)
    expect(item.resolvedAction).toBe("accept")
  })

  it("resolveItem 未命中时列表不变", () => {
    useReviewStore.getState().addItem(makePartial({ title: "T" }))
    useReviewStore.getState().resolveItem("missing", "accept")
    expect(useReviewStore.getState().items[0]!.resolved).toBe(false)
  })

  it("dismissItem 移除命中条目", () => {
    useReviewStore.getState().addItem(makePartial({ title: "A" }))
    useReviewStore.getState().addItem(makePartial({ title: "B" }))
    const a = useReviewStore.getState().items.find((i) => i.title === "A")!
    useReviewStore.getState().dismissItem(a.id)
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]!.title).toBe("B")
  })

  it("dismissItem 未命中时列表不变", () => {
    useReviewStore.getState().addItem(makePartial({ title: "A" }))
    useReviewStore.getState().dismissItem("missing")
    expect(useReviewStore.getState().items).toHaveLength(1)
  })

  it("clearResolved 只保留未解决条目", () => {
    useReviewStore.getState().addItem(makePartial({ title: "未解决" }))
    useReviewStore.getState().addItem(makePartial({ title: "已解决" }))
    const solved = useReviewStore.getState().items.find((i) => i.title === "已解决")!
    useReviewStore.getState().resolveItem(solved.id, "accept")
    useReviewStore.getState().clearResolved()
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]!.title).toBe("未解决")
    expect(items[0]!.resolved).toBe(false)
  })

  it("clearResolved 全部已解决时清空列表", () => {
    useReviewStore.getState().addItem(makePartial({ title: "A" }))
    const id = useReviewStore.getState().items[0]!.id
    useReviewStore.getState().resolveItem(id, "accept")
    useReviewStore.getState().clearResolved()
    expect(useReviewStore.getState().items).toEqual([])
  })
})

describe("review store — NovelReviewEntry", () => {
  it("addNovelReviewEntry 追加条目", () => {
    useReviewStore.getState().addNovelReviewEntry(makeEntry())
    useReviewStore.getState().addNovelReviewEntry(makeEntry({ id: "entry-2", chapterNumber: 5 }))
    const entries = useReviewStore.getState().novelReviewEntries
    expect(entries).toHaveLength(2)
    expect(entries[0]!.id).toBe("entry-1")
    expect(entries[1]!.chapterNumber).toBe(5)
  })

  it("dismissNovelReviewEntry 命中时标记 resolved", () => {
    useReviewStore.getState().addNovelReviewEntry(makeEntry())
    useReviewStore.getState().dismissNovelReviewEntry("entry-1")
    expect(useReviewStore.getState().novelReviewEntries[0]!.resolved).toBe(true)
  })

  it("dismissNovelReviewEntry 未命中时不变", () => {
    useReviewStore.getState().addNovelReviewEntry(makeEntry())
    useReviewStore.getState().dismissNovelReviewEntry("missing")
    expect(useReviewStore.getState().novelReviewEntries[0]!.resolved).toBe(false)
  })

  it("clearNovelReviewEntries 清空条目", () => {
    useReviewStore.getState().addNovelReviewEntry(makeEntry())
    useReviewStore.getState().clearNovelReviewEntries()
    expect(useReviewStore.getState().novelReviewEntries).toEqual([])
  })
})
