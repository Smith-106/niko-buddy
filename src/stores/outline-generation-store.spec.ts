// SPDX-License-Identifier: MIT
// outline-generation-store 全口径覆盖：createTask / updateTask / getLatestTaskByProject / removeTask
import { beforeEach, describe, expect, it } from "vitest"
import { useOutlineGenerationStore } from "./outline-generation-store"

beforeEach(() => {
  useOutlineGenerationStore.setState({ tasks: [], panelOpen: false })
})

describe("outline generation store", () => {
  it("初始状态：无任务、面板关闭", () => {
    const s = useOutlineGenerationStore.getState()
    expect(s.tasks).toEqual([])
    expect(s.panelOpen).toBe(false)
  })

  it("setPanelOpen 切换面板可见性", () => {
    useOutlineGenerationStore.getState().setPanelOpen(true)
    expect(useOutlineGenerationStore.getState().panelOpen).toBe(true)
    useOutlineGenerationStore.getState().setPanelOpen(false)
    expect(useOutlineGenerationStore.getState().panelOpen).toBe(false)
  })

  it("createTask 仅传 projectPath 时使用全部默认值", () => {
    const id = useOutlineGenerationStore.getState().createTask({ projectPath: "E:/Novel" })
    expect(id).toMatch(/^outline-task-\d+$/)
    const task = useOutlineGenerationStore.getState().tasks[0]!
    expect(task.id).toBe(id)
    expect(task.projectPath).toBe("E:/Novel")
    expect(task.kind).toBe("outline")
    expect(task.genre).toBe("")
    expect(task.scale).toBe("")
    expect(task.premise).toBe("")
    expect(task.prompt).toBe("")
    expect(task.userRequest).toBe("")
    expect(task.selectedSectionKey).toBeNull()
    expect(task.displayTitle).toBeNull()
    expect(task.writeMode).toBeNull()
    expect(task.targetPath).toBeNull()
    expect(task.outlinePath).toBeNull()
    expect(task.status).toBe("generating")
    expect(task.message).toBe("")
    expect(task.error).toBeNull()
    expect(task.createdAt).toBeGreaterThan(0)
    expect(task.updatedAt).toBeGreaterThan(0)
  })

  it("createTask 完整传入字段时逐项写入，新任务置顶", () => {
    const firstId = useOutlineGenerationStore.getState().createTask({ projectPath: "P1" })
    const fullId = useOutlineGenerationStore.getState().createTask({
      projectPath: "P2",
      kind: "refine",
      genre: "玄幻",
      scale: "中篇",
      premise: "premise",
      prompt: "prompt",
      userRequest: "用户请求",
      selectedSectionKey: "sec-1",
      displayTitle: "第一卷",
      writeMode: "new",
      targetPath: "E:/outline.md",
      outlinePath: "E:/outline.json",
      status: "error",
      message: "失败",
      error: "boom",
    })
    const tasks = useOutlineGenerationStore.getState().tasks
    expect(tasks[0]!.id).toBe(fullId)
    expect(tasks[1]!.id).toBe(firstId)
    const t = tasks[0]!
    expect(t.kind).toBe("refine")
    expect(t.genre).toBe("玄幻")
    expect(t.scale).toBe("中篇")
    expect(t.premise).toBe("premise")
    expect(t.prompt).toBe("prompt")
    expect(t.userRequest).toBe("用户请求")
    expect(t.selectedSectionKey).toBe("sec-1")
    expect(t.displayTitle).toBe("第一卷")
    expect(t.writeMode).toBe("new")
    expect(t.targetPath).toBe("E:/outline.md")
    expect(t.outlinePath).toBe("E:/outline.json")
    expect(t.status).toBe("error")
    expect(t.message).toBe("失败")
    expect(t.error).toBe("boom")
  })

  it("updateTask 命中时合并补丁并刷新 updatedAt", async () => {
    const id = useOutlineGenerationStore.getState().createTask({ projectPath: "E:/Novel" })
    const before = useOutlineGenerationStore.getState().tasks[0]!.updatedAt
    await new Promise((r) => setTimeout(r, 2))
    useOutlineGenerationStore.getState().updateTask(id, {
      status: "done",
      outlinePath: "E:/o.json",
      error: null,
    })
    const task = useOutlineGenerationStore.getState().tasks[0]!
    expect(task.status).toBe("done")
    expect(task.outlinePath).toBe("E:/o.json")
    expect(task.error).toBeNull()
    expect(task.updatedAt).toBeGreaterThanOrEqual(before)
  })

  it("updateTask 未命中时列表不变", () => {
    const id = useOutlineGenerationStore.getState().createTask({ projectPath: "E:/Novel" })
    useOutlineGenerationStore.getState().updateTask("missing", { status: "error" })
    const tasks = useOutlineGenerationStore.getState().tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.id).toBe(id)
    expect(tasks[0]!.status).toBe("generating")
  })

  it("getLatestTaskByProject 返回同项目 updatedAt 最新的任务", async () => {
    const older = useOutlineGenerationStore.getState().createTask({ projectPath: "E:/Novel" })
    const newer = useOutlineGenerationStore.getState().createTask({ projectPath: "E:/Novel" })
    // newer 是最后创建的（updatedAt 更大）；再创建同项目另一个任务并更新使其更新
    useOutlineGenerationStore.getState().updateTask(older, { status: "generated" })
    await new Promise((r) => setTimeout(r, 2))
    useOutlineGenerationStore.getState().updateTask(newer, { status: "ingesting" })
    const latest = useOutlineGenerationStore.getState().getLatestTaskByProject("E:/Novel")
    expect(latest?.id).toBe(newer)
    expect(latest?.status).toBe("ingesting")
  })

  it("getLatestTaskByProject 过滤其他项目、无匹配时返回 null", () => {
    useOutlineGenerationStore.getState().createTask({ projectPath: "E:/Other" })
    expect(useOutlineGenerationStore.getState().getLatestTaskByProject("E:/Novel")).toBeNull()
  })

  it("removeTask 移除指定任务", () => {
    const id1 = useOutlineGenerationStore.getState().createTask({ projectPath: "P1" })
    const id2 = useOutlineGenerationStore.getState().createTask({ projectPath: "P2" })
    useOutlineGenerationStore.getState().removeTask(id1)
    const tasks = useOutlineGenerationStore.getState().tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.id).toBe(id2)
  })
})
