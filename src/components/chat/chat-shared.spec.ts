// @vitest-environment jsdom
/**
 * chat-shared — useSourceFiles（wiki store + listDirectory 缓存）与 query pages 存取全口径覆盖。
 * wiki-store / commands/fs / path-utils 全部 mock。
 */
import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  getLastQueryPages,
  setLastQueryPages,
  useSourceFiles,
} from "./chat-shared"
import type { FileNode } from "@/types/wiki"

/* eslint-disable @typescript-eslint/no-explicit-any */

const mocks = vi.hoisted(() => {
  const wikiState: { project: { path: string } | null } = { project: null }
  return {
    wikiState,
    listDirectory: vi.fn(async () => []),
    normalizePath: vi.fn((p: string) => p.replace(/\\/g, "/")),
    useWikiStore: (selector: (s: typeof wikiState) => unknown) => selector(wikiState),
  }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: mocks.useWikiStore,
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: mocks.listDirectory,
}))

vi.mock("@/lib/path-utils", () => ({
  normalizePath: mocks.normalizePath,
}))

const TREE: FileNode[] = [
  { name: "dir-a", is_dir: true, children: [
    { name: "nested", is_dir: true, children: [
      { name: "c.md", is_dir: false },
    ] },
    { name: "b.md", is_dir: false },
  ] },
  { name: "empty-dir", is_dir: true, children: [] },
  { name: "no-children-dir", is_dir: true },
  { name: "d.md", is_dir: false },
]

describe("chat-shared", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.wikiState.project = null
    mocks.listDirectory.mockResolvedValue([])
    mocks.normalizePath.mockImplementation((p: string) => p.replace(/\\/g, "/"))
  })

  it("无项目时不发起 listDirectory", () => {
    const { result } = renderHook(() => useSourceFiles())
    expect(result.current).toEqual([])
    expect(mocks.listDirectory).not.toHaveBeenCalled()
  })

  it("有项目时递归展开文件树并缓存扁平文件名", async () => {
    mocks.wikiState.project = { path: "E:\\Novel" }
    mocks.listDirectory.mockResolvedValue(TREE)
    const { result, rerender } = renderHook(() => useSourceFiles())
    await waitFor(() => expect(mocks.listDirectory).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 10))
    rerender()
    expect(result.current).toEqual(["c.md", "b.md", "d.md"])
    expect(mocks.normalizePath).toHaveBeenCalledWith("E:\\Novel")
    expect(mocks.listDirectory).toHaveBeenCalledWith("E:/Novel/raw/sources")
  })

  it("listDirectory 失败时缓存清空（catch 分支）", async () => {
    mocks.wikiState.project = { path: "P" }
    mocks.listDirectory.mockRejectedValue(new Error("io"))
    const { result, rerender } = renderHook(() => useSourceFiles())
    await waitFor(() => expect(mocks.listDirectory).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 10))
    rerender()
    expect(result.current).toEqual([])
  })

  it("project 变化时重新加载", async () => {
    mocks.wikiState.project = { path: "A" }
    mocks.listDirectory.mockResolvedValue([{ name: "a.md", is_dir: false }])
    const { result, rerender } = renderHook(() => useSourceFiles())
    await waitFor(() => expect(mocks.listDirectory).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 10))
    rerender()
    expect(result.current).toEqual(["a.md"])

    mocks.wikiState.project = { path: "B" }
    mocks.listDirectory.mockResolvedValue([{ name: "b.md", is_dir: false }])
    rerender()
    await waitFor(() => expect(mocks.listDirectory).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 10))
    rerender()
    expect(result.current).toEqual(["b.md"])
    expect(mocks.listDirectory).toHaveBeenCalledTimes(2)
  })

  it("getLastQueryPages / setLastQueryPages 读写往返", () => {
    const pages = [{ title: "t1", path: "p1" }, { title: "t2", path: "p2" }]
    expect(getLastQueryPages()).toEqual([])
    setLastQueryPages(pages)
    expect(getLastQueryPages()).toEqual(pages)
    setLastQueryPages([])
    expect(getLastQueryPages()).toEqual([])
  })
})
