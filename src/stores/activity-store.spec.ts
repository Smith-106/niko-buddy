// SPDX-License-Identifier: MIT
// Activity store 全口径覆盖：addItem / updateItem / appendDetail / clearDone
import { beforeEach, describe, expect, it } from "vitest"
import { useActivityStore } from "./activity-store"

beforeEach(() => {
  useActivityStore.setState({ items: [] })
})

describe("activity store", () => {
  it("addItem 创建带 id/createdAt 的条目并置顶，返回 id", () => {
    const id = useActivityStore.getState().addItem({
      type: "ingest",
      title: "导入文件",
      status: "running",
      detail: "读取中",
      filesWritten: [],
    })
    expect(id).toMatch(/^activity-\d+$/)
    const s = useActivityStore.getState()
    expect(s.items).toHaveLength(1)
    expect(s.items[0]!.id).toBe(id)
    expect(s.items[0]!.type).toBe("ingest")
    expect(s.items[0]!.title).toBe("导入文件")
    expect(s.items[0]!.status).toBe("running")
    expect(s.items[0]!.detail).toBe("读取中")
    expect(s.items[0]!.createdAt).toBeGreaterThan(0)
  })

  it("新条目插入列表最前（最新在前）", () => {
    const id1 = useActivityStore.getState().addItem({
      type: "query", title: "搜索 1", status: "done", detail: "", filesWritten: [],
    })
    const id2 = useActivityStore.getState().addItem({
      type: "lint", title: "检查 2", status: "running", detail: "", filesWritten: [],
    })
    const items = useActivityStore.getState().items
    expect(items[0]!.id).toBe(id2)
    expect(items[1]!.id).toBe(id1)
    // id 单调递增（模块级 seqCounter）
    expect(Number(id2.split("-")[1])).toBeGreaterThan(Number(id1.split("-")[1]))
  })

  it("updateItem 命中时合并补丁并保留其他字段", () => {
    const id = useActivityStore.getState().addItem({
      type: "lint", title: "检查", status: "running", detail: "d1", filesWritten: [],
    })
    useActivityStore.getState().updateItem(id, {
      status: "done",
      detail: "d2",
      filesWritten: ["a.md"],
    })
    const item = useActivityStore.getState().items[0]!
    expect(item.status).toBe("done")
    expect(item.detail).toBe("d2")
    expect(item.filesWritten).toEqual(["a.md"])
    expect(item.title).toBe("检查")
  })

  it("updateItem 未命中时列表不变", () => {
    const id = useActivityStore.getState().addItem({
      type: "lint", title: "检查", status: "running", detail: "d1", filesWritten: [],
    })
    useActivityStore.getState().updateItem("missing-id", { status: "error" })
    const items = useActivityStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toBe(id)
    expect(items[0]!.status).toBe("running")
  })

  it("appendDetail 命中时在末尾拼接文本", () => {
    const id = useActivityStore.getState().addItem({
      type: "ingest", title: "导入", status: "running", detail: "step1", filesWritten: [],
    })
    useActivityStore.getState().appendDetail(id, " → step2")
    expect(useActivityStore.getState().items[0]!.detail).toBe("step1 → step2")
  })

  it("appendDetail 未命中时列表不变", () => {
    useActivityStore.getState().addItem({
      type: "ingest", title: "导入", status: "running", detail: "step1", filesWritten: [],
    })
    useActivityStore.getState().appendDetail("missing-id", "x")
    const items = useActivityStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]!.detail).toBe("step1")
  })

  it("clearDone 只保留 running 条目，移除 done/error", () => {
    useActivityStore.getState().addItem({
      type: "ingest", title: "运行中", status: "running", detail: "", filesWritten: [],
    })
    useActivityStore.getState().addItem({
      type: "query", title: "已完成", status: "done", detail: "", filesWritten: [],
    })
    useActivityStore.getState().addItem({
      type: "lint", title: "出错", status: "error", detail: "boom", filesWritten: [],
    })
    useActivityStore.getState().clearDone()
    const items = useActivityStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]!.status).toBe("running")
  })

  it("clearDone 在无 running 条目时清空列表", () => {
    useActivityStore.getState().addItem({
      type: "query", title: "已完成", status: "done", detail: "", filesWritten: [],
    })
    useActivityStore.getState().clearDone()
    expect(useActivityStore.getState().items).toEqual([])
  })
})
