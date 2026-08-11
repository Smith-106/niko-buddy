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
    await expect(loadCognitionState("/proj")).resolves.toBeNull()
    expect(readFile).not.toHaveBeenCalled()
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
