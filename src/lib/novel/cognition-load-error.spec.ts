import { beforeEach, describe, expect, it, vi } from "vitest"

const { fileExists, readFile } = vi.hoisted(() => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  fileExists,
  readFile,
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
}))

import { loadCognitionState } from "./character-cognition"
import { loadCharacterStates } from "./character-state"

describe("ISS-20260712-010 load error vs empty", () => {
  beforeEach(() => {
    fileExists.mockReset()
    readFile.mockReset()
  })

  it("loadCognitionState returns null when file is missing", async () => {
    fileExists.mockResolvedValue(false)
    // E-03 工厂迁移后 loadCognitionState 走 readFile 直读 (try/catch 降级),
    // 不再先查 fileExists — 缺失语义由 readFile 抛错/空内容经 onMissing:"null" 兑现。
    readFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
    await expect(loadCognitionState("/proj")).resolves.toBeNull()
  })

  it("loadCognitionState returns null for empty file content", async () => {
    fileExists.mockResolvedValue(true)
    readFile.mockResolvedValue("   ")
    await expect(loadCognitionState("/proj")).resolves.toBeNull()
  })

  it("loadCognitionState throws on corrupt JSON (not silent null)", async () => {
    fileExists.mockResolvedValue(true)
    readFile.mockResolvedValue("{not-json")
    await expect(loadCognitionState("/proj")).rejects.toThrow(/Failed to parse cognition-state\.json/)
  })

  it("loadCharacterStates returns empty store for missing file", async () => {
    readFile.mockRejectedValue(new Error("ENOENT: not found"))
    const store = await loadCharacterStates("/proj")
    expect(store.characters).toEqual([])
  })

  it("loadCharacterStates throws on corrupt JSON", async () => {
    readFile.mockResolvedValue("{bad")
    await expect(loadCharacterStates("/proj")).rejects.toThrow(/Failed to parse character-states\.json/)
  })
})
