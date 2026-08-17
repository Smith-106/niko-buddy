import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
}))

import { readSoulDoc, writeSoulDoc, SOUL_DOC_FILENAME } from "./soul-doc"

describe("soul-doc", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.writeFileAtomic.mockReset()
  })

  it("exposes the soul.md filename constant", () => {
    expect(SOUL_DOC_FILENAME).toBe("soul.md")
  })

  it("reads the soul doc at <project>/soul.md", async () => {
    fsMocks.readFile.mockResolvedValue("# 小晴的灵魂\n\n性格坚韧。")
    const content = await readSoulDoc("E:\\Novel")
    expect(content).toContain("小晴")
    expect(fsMocks.readFile).toHaveBeenCalledWith("E:/Novel/soul.md")
  })

  it("returns an empty string when the file does not exist", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
    expect(await readSoulDoc("/P")).toBe("")
  })

  it("returns an empty string on any read error", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("permission denied"))
    expect(await readSoulDoc("/P")).toBe("")
  })

  it("writes the soul doc atomically", async () => {
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)
    await writeSoulDoc("/P", "# 新灵魂")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith("/P/soul.md", "# 新灵魂")
  })
})
