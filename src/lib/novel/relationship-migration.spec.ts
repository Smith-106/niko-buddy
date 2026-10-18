/** Wave 3B 迁移：幂等 / 冲突不覆盖 / 空真源不造假产物 / 守恒。 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const fsState = vi.hoisted(() => ({ files: new Map<string, string>() }))

vi.mock("./asset-library-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./asset-library-store")>()
  return {
    ...actual,
    loadAssetLibrarySnapshot: (projectPath: string, libraryId: string, deps: unknown) =>
      actual.loadAssetLibrarySnapshot(projectPath, libraryId as never, {
        readText: async (path: string) => fsState.files.get(path) ?? null,
        writeText: async (path: string, text: string) => void fsState.files.set(path, text),
        ensureDir: async () => undefined,
        ...(deps as object),
      } as never),
    saveAssetLibraryArtifact: (projectPath: string, artifact: never, deps: unknown) =>
      actual.saveAssetLibraryArtifact(projectPath, artifact, {
        readText: async (path: string) => fsState.files.get(path) ?? null,
        writeText: async (path: string, text: string) => void fsState.files.set(path, text),
        ensureDir: async () => undefined,
        ...(deps as object),
      } as never),
  }
})

const { migrateRelationshipLibrary } = await import("./relationship-migration")

const states = (...pairs: Array<[string, Record<string, string>]>) => ({
  characters: pairs.map(([name, relationships]) => ({
    characterName: name,
    currentLocation: "",
    status: "",
    equipment: [],
    abilities: [],
    relationships,
    lastUpdatedChapter: 1,
    lastUpdatedAt: "2026-10-18T00:00:00.000Z",
  })),
})

describe("migrateRelationshipLibrary", () => {
  beforeEach(() => fsState.files.clear())

  it("首次写入 → written，产物可读且守恒", async () => {
    const result = await migrateRelationshipLibrary("C:/proj", { loadStates: async () => states(["林砚", { 苏晚: "师徒" }]) })
    expect(result.status).toBe("written")
    expect(result.entryCount).toBe(1)
    expect([...fsState.files.keys()].some((p) => p.endsWith("relationship_edge.json"))).toBe(true)
  })

  it("第二次调用 → noop（不重写时间戳、不再写文件）", async () => {
    const deps = { loadStates: async () => states(["林砚", { 苏晚: "师徒" }]) }
    await migrateRelationshipLibrary("C:/proj", deps)
    const before = [...fsState.files.values()].join()
    const second = await migrateRelationshipLibrary("C:/proj", deps)
    expect(second.status).toBe("noop")
    expect([...fsState.files.values()].join()).toBe(before)
  })

  it("已存在但内容不同 → conflict，且不覆盖人工补全的产物", async () => {
    await migrateRelationshipLibrary("C:/proj", { loadStates: async () => states(["林砚", { 苏晚: "师徒" }]) })
    const path = [...fsState.files.keys()].find((p) => p.endsWith("relationship_edge.json"))
    expect(path).toBeTruthy()
    const humanEdited = fsState.files.get(path!)!.replace('"unknown"', '"mentor"')
    fsState.files.set(path!, humanEdited)
    const result = await migrateRelationshipLibrary("C:/proj", {
      loadStates: async () => states(["林砚", { 苏晚: "师徒" }]),
    })
    expect(result.status).toBe("conflict")
    expect(fsState.files.get(path!)).toBe(humanEdited)
    // 手改条目但没更新 hash（守恒失配）也必须 conflict，不得被当成 noop 放过
  })

  it("守恒失配（手改 entries 未更新 hash）→ conflict 且保留磁盘内容", async () => {
    const deps = { loadStates: async () => states(["林砚", { 苏晚: "师徒" }]) }
    await migrateRelationshipLibrary("C:/proj", deps)
    const path = [...fsState.files.keys()].find((p) => p.endsWith("relationship_edge.json"))!
    const tampered = fsState.files.get(path)!.replace('"unknown"', '"mentor"')
    fsState.files.set(path, tampered)
    const result = await migrateRelationshipLibrary("C:/proj", deps)
    expect(result.status).toBe("conflict")
    expect(fsState.files.get(path)).toBe(tampered)
  })

  it("真源没有关系 → empty，不写空产物冒充已迁移", async () => {
    const result = await migrateRelationshipLibrary("C:/proj", { loadStates: async () => states(["甲", {}]) })
    expect(result.status).toBe("empty")
    expect([...fsState.files.keys()].filter((p) => p.endsWith("relationship_edge.json"))).toHaveLength(0)
  })
})

describe("Wave 3B 审查回归：坏文件与篡改不得被覆盖", () => {
  beforeEach(() => fsState.files.clear())

  it("已存在但解析失败 → conflict（不覆盖，不静默重写）", async () => {
    const path = "C:/proj/.novel/asset-library/relationship_edge.json"
    fsState.files.set(path, "{ this is not json")
    const result = await migrateRelationshipLibrary("C:/proj", {
      loadStates: async () => states(["林砚", { 苏晚: "师徒" }]),
    })
    expect(result.status).toBe("conflict")
    expect(fsState.files.get(path)).toBe("{ this is not json")
  })
})
