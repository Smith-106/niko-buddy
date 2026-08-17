import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
}))

import {
  loadRecognizedCharacters,
  saveRecognizedCharacters,
} from "./recognized-character-store"

describe("recognized-character-store", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.writeFile.mockReset()
  })

  it("loads an array and rejects a non-array JSON payload", async () => {
    const characters = [{ id: "c-1", name: "林烬" }]
    fsMocks.readFile.mockResolvedValueOnce(JSON.stringify(characters))
    await expect(loadRecognizedCharacters("E:/Novel/book")).resolves.toEqual(characters)

    fsMocks.readFile.mockResolvedValueOnce(JSON.stringify({ characters }))
    await expect(loadRecognizedCharacters("E:/Novel/book")).resolves.toEqual([])
  })

  it("returns an empty array for unreadable or invalid persisted data", async () => {
    fsMocks.readFile.mockRejectedValueOnce(new Error("ENOENT"))
    await expect(loadRecognizedCharacters("E:/Novel/book")).resolves.toEqual([])

    fsMocks.readFile.mockResolvedValueOnce("not json")
    await expect(loadRecognizedCharacters("E:/Novel/book")).resolves.toEqual([])
  })

  it("writes the formatted recognized-character payload", async () => {
    const characters = [{ id: "c-1", name: "林烬" }]
    await saveRecognizedCharacters("E:\\Novel\\book", characters as never)

    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      "E:/Novel/book/recognized-characters.json",
      JSON.stringify(characters, null, 2),
    )
  })
})
