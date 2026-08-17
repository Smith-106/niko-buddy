import { beforeEach, describe, expect, it, vi } from "vitest"

const listDirectory = vi.fn()
const setFileTree = vi.fn()
const bumpDataVersion = vi.fn()

vi.mock("@/commands/fs", () => ({
  listDirectory: (...args: unknown[]) => listDirectory(...args),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: {
    getState: () => ({ setFileTree, bumpDataVersion }),
  },
}))

import { refreshProjectState } from "./project-refresh"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("refreshProjectState", () => {
  it("does nothing for undefined or null project paths", async () => {
    await refreshProjectState(undefined)
    await refreshProjectState(null)
    expect(listDirectory).not.toHaveBeenCalled()
  })

  it("reloads the tree and bumps the data version on success", async () => {
    const tree = [{ name: "wiki", path: "E:/Novel/wiki", is_dir: true }]
    listDirectory.mockResolvedValue(tree)

    await refreshProjectState("E:\\Novel")

    expect(listDirectory).toHaveBeenCalledWith("E:/Novel")
    expect(setFileTree).toHaveBeenCalledWith(tree)
    expect(bumpDataVersion).toHaveBeenCalledTimes(1)
  })

  it("bumps the data version and logs when the listing fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    listDirectory.mockRejectedValue(new Error("listing failed"))

    await refreshProjectState("E:\\Novel")

    expect(bumpDataVersion).toHaveBeenCalledTimes(1)
    expect(setFileTree).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      "[refreshProjectState] 刷新文件树失败:",
      expect.any(Error),
    )
    errorSpy.mockRestore()
  })
})
