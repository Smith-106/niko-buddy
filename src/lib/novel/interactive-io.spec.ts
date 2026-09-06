import { beforeEach, describe, expect, it, vi } from "vitest"
import type { InteractiveStoryGraph } from "./interactive-film-graph"
import { loadInteractiveGraph, loadPlaySession, savePlaySession } from "./interactive-io"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  fileExists: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  fileExists: mocks.fileExists,
}))

const graph: InteractiveStoryGraph = {
  version: 1,
  startId: "start",
  nodes: [
    { id: "start", kind: "knot", text: "开场", edges: ["e1"] },
    { id: "end", kind: "end", text: "终局", edges: [] },
  ],
  edges: [{ id: "e1", from: "start", to: "end", choiceLabel: "继续" }],
}

describe("interactive-io", () => {
  beforeEach(() => {
    mocks.readFile.mockReset()
    mocks.writeFile.mockReset()
    mocks.fileExists.mockReset()
  })

  it("loadInteractiveGraph 存在且合法时返回解析图", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(graph))
    const result = await loadInteractiveGraph("/p/book")
    expect(mocks.fileExists).toHaveBeenCalledWith("/p/book/.novel/interactive-graph.json")
    expect(result).toEqual(graph)
  })

  it("loadInteractiveGraph 文件缺失时返回 null（优雅降级）", async () => {
    mocks.fileExists.mockResolvedValue(false)
    expect(await loadInteractiveGraph("/p/book")).toBeNull()
  })

  it("loadInteractiveGraph 非法 JSON 时返回 null（不抛）", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue("{broken")
    expect(await loadInteractiveGraph("/p/book")).toBeNull()
  })

  it("loadInteractiveGraph 结构缺失 nodes/edges/startId 时返回 null", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify({ startId: "x" }))
    expect(await loadInteractiveGraph("/p/book")).toBeNull()
  })

  it("savePlaySession 落 choicePath 快照（Draft-first pending 区）", async () => {
    await savePlaySession("/p/book", ["start", "end"])
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/p/book/.novel/play-session.json",
      expect.stringContaining('"start"'),
    )
    expect(mocks.writeFile.mock.calls[0][1]).toContain('"end"')
  })

  it("loadPlaySession 返回合法 choicePath", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify({ choicePath: ["a", "b"], savedAt: "t" }))
    expect(await loadPlaySession("/p/book")).toEqual(["a", "b"])
  })

  it("loadPlaySession 缺失/非法时返回 null", async () => {
    mocks.fileExists.mockResolvedValue(false)
    expect(await loadPlaySession("/p/book")).toBeNull()
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify({ choicePath: "not-array" }))
    expect(await loadPlaySession("/p/book")).toBeNull()
  })
})
