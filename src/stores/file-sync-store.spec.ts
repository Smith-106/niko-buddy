// SPDX-License-Identifier: MIT
// file-sync-store 全口径覆盖：setTasks / setRunning / setLastError / clear
import { beforeEach, describe, expect, it } from "vitest"
import { useFileSyncStore } from "./file-sync-store"
import type { FileChangeTask } from "@/commands/file-sync"

function makeTask(overrides: Partial<FileChangeTask> = {}): FileChangeTask {
  return {
    id: "t1",
    projectId: "p1",
    path: "/a.md",
    kind: "update",
    status: "pending",
    hashBefore: null,
    hashAfter: null,
    size: 10,
    ...overrides,
  }
}

beforeEach(() => {
  useFileSyncStore.setState({ tasks: [], running: false, lastError: null })
})

describe("file sync store", () => {
  it("初始状态为空闲", () => {
    const s = useFileSyncStore.getState()
    expect(s.tasks).toEqual([])
    expect(s.running).toBe(false)
    expect(s.lastError).toBeNull()
  })

  it("setTasks 直接替换任务列表", () => {
    const tasks = [makeTask(), makeTask({ id: "t2", status: "done" })]
    useFileSyncStore.getState().setTasks(tasks)
    expect(useFileSyncStore.getState().tasks).toEqual(tasks)
  })

  it("setRunning 切换运行标志", () => {
    useFileSyncStore.getState().setRunning(true)
    expect(useFileSyncStore.getState().running).toBe(true)
    useFileSyncStore.getState().setRunning(false)
    expect(useFileSyncStore.getState().running).toBe(false)
  })

  it("setLastError 写入 / 清除错误信息", () => {
    useFileSyncStore.getState().setLastError("同步失败")
    expect(useFileSyncStore.getState().lastError).toBe("同步失败")
    useFileSyncStore.getState().setLastError(null)
    expect(useFileSyncStore.getState().lastError).toBeNull()
  })

  it("clear 重置任务/运行/错误三态", () => {
    useFileSyncStore.getState().setTasks([makeTask()])
    useFileSyncStore.getState().setRunning(true)
    useFileSyncStore.getState().setLastError("err")
    useFileSyncStore.getState().clear()
    const s = useFileSyncStore.getState()
    expect(s.tasks).toEqual([])
    expect(s.running).toBe(false)
    expect(s.lastError).toBeNull()
  })
})
