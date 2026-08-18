import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  ignoreFileChangeTask,
  rescanProjectFiles,
  retryFileChangeTask,
  startProjectFileWatcher,
  stopProjectFileWatcher,
} from "./file-sync"
import type { SourceWatchConfig } from "@/stores/wiki-store"

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  transformCallback: vi.fn(),
  normalizeSourceWatchConfig: vi.fn((config?: unknown) => config ?? { mockNormalized: true }),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  transformCallback: mocks.transformCallback,
}))

vi.mock("@/lib/source-watch-config", () => ({
  normalizeSourceWatchConfig: mocks.normalizeSourceWatchConfig,
}))

const QUEUE = { version: 1, tasks: [] }
const CONFIG: SourceWatchConfig = { extensions: ["md"], ignorePaths: [] }

describe("file-sync command wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.invoke.mockResolvedValue(QUEUE)
    mocks.normalizeSourceWatchConfig.mockImplementation((config?: unknown) => config ?? { mockNormalized: true })
  })

  it("startProjectFileWatcher 透传 projectId/projectPath 并归一化 sourceWatchConfig", async () => {
    await expect(startProjectFileWatcher("pid", "/p", CONFIG)).resolves.toBe(QUEUE)
    expect(mocks.normalizeSourceWatchConfig).toHaveBeenCalledWith(CONFIG)
    expect(mocks.invoke).toHaveBeenCalledWith("start_project_file_watcher", {
      projectId: "pid",
      projectPath: "/p",
      sourceWatchConfig: CONFIG,
    })
  })

  it("startProjectFileWatcher 未传 sourceWatchConfig 时归一化 undefined", async () => {
    await expect(startProjectFileWatcher("pid", "/p")).resolves.toBe(QUEUE)
    expect(mocks.normalizeSourceWatchConfig).toHaveBeenCalledWith(undefined)
    expect(mocks.invoke).toHaveBeenCalledWith("start_project_file_watcher", {
      projectId: "pid",
      projectPath: "/p",
      sourceWatchConfig: { mockNormalized: true },
    })
  })

  it("stopProjectFileWatcher 无参调用 stop_project_file_watcher", async () => {
    await expect(stopProjectFileWatcher()).resolves.toBe(QUEUE)
    expect(mocks.invoke).toHaveBeenCalledWith("stop_project_file_watcher")
  })

  it("rescanProjectFiles 带 sourceWatchConfig 归一化后透传", async () => {
    const result = { queue: QUEUE, changedTasks: [{ id: "t1" }] }
    mocks.invoke.mockResolvedValue(result)
    await expect(rescanProjectFiles("pid", "/p", CONFIG)).resolves.toBe(result)
    expect(mocks.normalizeSourceWatchConfig).toHaveBeenCalledWith(CONFIG)
    expect(mocks.invoke).toHaveBeenCalledWith("rescan_project_files", {
      projectId: "pid",
      projectPath: "/p",
      sourceWatchConfig: CONFIG,
    })
  })

  it("rescanProjectFiles 未传 sourceWatchConfig 时归一化 undefined", async () => {
    await expect(rescanProjectFiles("pid", "/p")).resolves.toBe(QUEUE)
    expect(mocks.normalizeSourceWatchConfig).toHaveBeenCalledWith(undefined)
    expect(mocks.invoke).toHaveBeenCalledWith("rescan_project_files", {
      projectId: "pid",
      projectPath: "/p",
      sourceWatchConfig: { mockNormalized: true },
    })
  })

  it("retryFileChangeTask 透传 projectId/projectPath/taskId", async () => {
    await expect(retryFileChangeTask("pid", "/p", "t1")).resolves.toBe(QUEUE)
    expect(mocks.invoke).toHaveBeenCalledWith("retry_file_change_task", { projectId: "pid", projectPath: "/p", taskId: "t1" })
  })

  it("ignoreFileChangeTask 透传 projectId/projectPath/taskId", async () => {
    await expect(ignoreFileChangeTask("pid", "/p", "t2")).resolves.toBe(QUEUE)
    expect(mocks.invoke).toHaveBeenCalledWith("ignore_file_change_task", { projectId: "pid", projectPath: "/p", taskId: "t2" })
  })

  it("invoke 拒绝时异常原样传播（retryFileChangeTask）", async () => {
    const err = new Error("invoke failed")
    mocks.invoke.mockRejectedValue(err)
    await expect(retryFileChangeTask("pid", "/p", "t1")).rejects.toBe(err)
  })
})
