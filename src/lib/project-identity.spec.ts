import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  storeGet: vi.fn(),
  storeSet: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  isTauri: vi.fn(),
}))

vi.mock("@/lib/web-store", () => ({
  getStore: mocks.getStore,
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
}))

vi.mock("@/lib/platform", () => ({
  isTauri: mocks.isTauri,
}))

import {
  ensureProjectId,
  getProjectIdByPath,
  getProjectPathById,
  loadRegistry,
  upsertProjectInfo,
} from "./project-identity"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getStore.mockResolvedValue({ get: mocks.storeGet, set: mocks.storeSet })
})

describe("ensureProjectId", () => {
  it("returns a web-stable id outside tauri", async () => {
    mocks.isTauri.mockReturnValue(false)
    await expect(ensureProjectId("C:\\我的项目")).resolves.toBe("web-C______")
  })

  it("reads an existing identity file in tauri", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify({ id: "existing-id", createdAt: 1 }))
    await expect(ensureProjectId("/P")).resolves.toBe("existing-id")
  })

  it("creates a new identity when the file is missing or corrupt", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.readFile.mockRejectedValue(new Error("enoent"))
    const uuid = "12345678-1234-1234-1234-123456789abc"
    vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid)
    await expect(ensureProjectId("/P")).resolves.toBe(uuid)
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/P/.qmai/project.json",
      expect.stringContaining('"id": "12345678-1234-1234-1234-123456789abc"'),
    )
  })

  it("logs a warning when writing the identity file fails but still returns the id", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.readFile.mockRejectedValue(new Error("missing"))
    mocks.writeFile.mockRejectedValue(new Error("readonly"))
    vi.spyOn(crypto, "randomUUID").mockReturnValue("abc-1" as ReturnType<typeof crypto.randomUUID>)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(ensureProjectId("/P")).resolves.toBe("abc-1")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to write identity file"), expect.any(Error))
    warn.mockRestore()
  })

  it("creates a new identity when the file contains a non-string id", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify({ id: 42, createdAt: 1 }))
    vi.spyOn(crypto, "randomUUID").mockReturnValue("uuid-2" as ReturnType<typeof crypto.randomUUID>)
    await expect(ensureProjectId("/P")).resolves.toBe("uuid-2")
  })
})

describe("loadRegistry", () => {
  it("returns the stored registry", async () => {
    mocks.storeGet.mockResolvedValue({ a: { id: "a", path: "/A", name: "A", lastOpened: 1 } })
    await expect(loadRegistry()).resolves.toEqual({ a: { id: "a", path: "/A", name: "A", lastOpened: 1 } })
  })

  it("returns an empty registry when nothing is stored", async () => {
    mocks.storeGet.mockResolvedValue(undefined)
    await expect(loadRegistry()).resolves.toEqual({})
  })

  it("returns an empty registry when the store fails", async () => {
    mocks.getStore.mockRejectedValue(new Error("store down"))
    await expect(loadRegistry()).resolves.toEqual({})
  })
})

describe("upsertProjectInfo", () => {
  it("upserts an entry with normalized path and current timestamp", async () => {
    const now = 12345
    vi.spyOn(Date, "now").mockReturnValue(now)
    mocks.storeGet.mockResolvedValue({})
    await upsertProjectInfo("p1", "C:\\proj\\", "My Project")
    expect(mocks.storeSet).toHaveBeenCalledWith("projectRegistry", {
      p1: { id: "p1", path: "C:/proj/", name: "My Project", lastOpened: now },
    })
  })
})

describe("lookups", () => {
  it("finds a path by id and id by path", async () => {
    mocks.storeGet.mockResolvedValue({
      a: { id: "a", path: "/Alpha", name: "A", lastOpened: 1 },
      b: { id: "b", path: "C:/Beta", name: "B", lastOpened: 2 },
    })
    await expect(getProjectPathById("b")).resolves.toBe("C:/Beta")
    await expect(getProjectPathById("ghost")).resolves.toBeNull()
    await expect(getProjectIdByPath("C:\\Beta")).resolves.toBe("b")
    await expect(getProjectIdByPath("/nope")).resolves.toBeNull()
  })
})
