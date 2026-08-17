import { beforeEach, describe, expect, it, vi } from "vitest"
import { loadStyleExemplarsViaRust, markStyleExemplarViaRust, type MarkStyleExemplarInput } from "./exemplar"

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  transformCallback: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  transformCallback: mocks.transformCallback,
}))

const MARK: MarkStyleExemplarInput = {
  chapterId: "ch-1",
  text: "示例文本",
  markType: "style",
  note: "note",
}

const RECORDS = [
  {
    exemplarId: "e1",
    chapterId: "ch-1",
    text: "示例文本",
    markType: "style",
    note: "note",
    createdAt: "2026-07-21T00:00:00.000Z",
  },
]

describe("exemplar command wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.invoke.mockResolvedValue(undefined)
  })

  it("markStyleExemplarViaRust 透传 projectPath 与 mark 负载", async () => {
    await expect(markStyleExemplarViaRust("/p", MARK)).resolves.toBeUndefined()
    expect(mocks.invoke).toHaveBeenCalledWith("mark_style_exemplar", { projectPath: "/p", mark: MARK })
  })

  it("loadStyleExemplarsViaRust 返回 exemplar 记录数组", async () => {
    mocks.invoke.mockResolvedValue(RECORDS)
    await expect(loadStyleExemplarsViaRust("/p")).resolves.toBe(RECORDS)
    expect(mocks.invoke).toHaveBeenCalledWith("load_style_exemplars", { projectPath: "/p" })
  })

  it("loadStyleExemplarsViaRust 缺失文件时优雅降级为 []", async () => {
    mocks.invoke.mockResolvedValue([])
    await expect(loadStyleExemplarsViaRust("/p")).resolves.toEqual([])
  })

  it("invoke 拒绝时异常原样传播", async () => {
    const err = new Error("invoke failed")
    mocks.invoke.mockRejectedValue(err)
    await expect(markStyleExemplarViaRust("/p", MARK)).rejects.toBe(err)
    await expect(loadStyleExemplarsViaRust("/p")).rejects.toBe(err)
  })
})
