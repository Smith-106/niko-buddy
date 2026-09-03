import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  APP_OWNER_ID,
  OWNER_STALE_MS,
  PROJECT_OWNER_FILE,
  claimProjectOwnership,
  parseOwnerRecord,
  releaseProjectOwnership,
  type ProjectOwnerRecord,
  type OwnerDeps,
} from "./project-owner"

function makeDeps(over: Partial<OwnerDeps> = {}): OwnerDeps {
  const files = new Map<string, string>()
  // 预置初始文件内容 (供 readFile 读取, 与写入共享同一 map)
  if (over.readFile) {
    const seed = over.readFile
    files.set("seed", "") // noop 占位防止读取顺序依赖
  }
  const base: OwnerDeps = {
    readFile: async (p: string) => {
      const content = files.get(p)
      if (content === undefined) throw new Error(`ENOENT: ${p}`)
      return content
    },
    writeFileAtomic: async (p: string, c: string) => {
      files.set(p, c)
    },
    now: () => 1_000_000_000,
    randomToken: () => "inst-test",
    ...over,
  }
  // 若调用方只提供 readFile 覆盖, 把返回值预置进 files map, 保证写入后回读一致
  if (over.readFile && !over.writeFileAtomic) {
    const seed = over.readFile
    let seeded = false
    base.readFile = async (p: string) => {
      if (!seeded && !files.has(p)) {
        try {
          const content = await seed(p)
          files.set(p, content)
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("ENOENT")) throw err
        }
        seeded = true
      }
      const content = files.get(p)
      if (content === undefined) throw new Error(`ENOENT: ${p}`)
      return content
    }
  }
  return base
}

function ownerRec(over: Partial<ProjectOwnerRecord> = {}): ProjectOwnerRecord {
  return {
    schema: "project-owner/1.0",
    app: APP_OWNER_ID,
    instance: "inst-1",
    startedAt: 1_000_000_000,
    ...over,
  }
}

describe("project-owner（54 号设计隐患 1 防御）", () => {
  let deps: OwnerDeps

  beforeEach(() => {
    deps = makeDeps()
  })

  it("首次打开：无 owner.json → 写入并正常打开", async () => {
    const claim = await claimProjectOwnership("P", deps)
    expect(claim.ok).toBe(true)
    expect(claim.conflict).toBe(false)
    expect(claim.tookOver).toBe(false)
    const raw = await deps.readFile(`P/${PROJECT_OWNER_FILE}`)
    const rec = parseOwnerRecord(raw)
    expect(rec!.app).toBe(APP_OWNER_ID)
    expect(rec!.startedAt).toBe(1_000_000_000)
  })

  it("同主记录（崩溃遗留）→ 自愈刷新，不视为冲突", async () => {
    deps = makeDeps({
      readFile: async () => JSON.stringify(ownerRec({ startedAt: 100 })), // 2 周前的本应用记录
    })
    const claim = await claimProjectOwnership("P", deps)
    expect(claim.ok).toBe(true)
    expect(claim.conflict).toBe(false)
    expect(claim.tookOver).toBe(false)
  })

  it("异主且新鲜 → 冲突（ok=false, conflict=true）", async () => {
    deps = makeDeps({
      readFile: async () => JSON.stringify(ownerRec({ app: "qm-write", startedAt: 1_000_000_000 - 60_000 })),
    })
    const claim = await claimProjectOwnership("P", deps)
    expect(claim.ok).toBe(false)
    expect(claim.conflict).toBe(true)
    expect(claim.tookOver).toBe(false)
    expect(claim.occupant!.app).toBe("qm-write")
  })

  it("异主且超过 stale 窗口 → 自动接管", async () => {
    const staleMs = OWNER_STALE_MS + 1_000
    deps = makeDeps({
      readFile: async () => JSON.stringify(ownerRec({ app: "qm-write", startedAt: 1_000_000_000 - staleMs })),
    })
    const claim = await claimProjectOwnership("P", deps)
    expect(claim.ok).toBe(true)
    expect(claim.tookOver).toBe(true)
    // 接管后写入的是本应用记录
    const raw = await deps.readFile(`P/${PROJECT_OWNER_FILE}`)
    expect(parseOwnerRecord(raw)!.app).toBe(APP_OWNER_ID)
  })

  it("异主已释放（released=true）→ 立即接管", async () => {
    deps = makeDeps({
      readFile: async () => JSON.stringify(ownerRec({ app: "qm-write", released: true })),
    })
    const claim = await claimProjectOwnership("P", deps)
    expect(claim.ok).toBe(true)
    expect(claim.conflict).toBe(false)
    expect(claim.tookOver).toBe(true)
  })

  it("畸形 owner.json → 视为无记录，正常接管", async () => {
    deps = makeDeps({ readFile: async () => "not-json{{{" })
    const claim = await claimProjectOwnership("P", deps)
    expect(claim.ok).toBe(true)
    expect(claim.conflict).toBe(false)
  })

  it("release: 仅释放本应用记录，异主记录绝不删改", async () => {
    const released = JSON.stringify(ownerRec({ app: "qm-write" }))
    deps = makeDeps({ readFile: async () => released })
    await releaseProjectOwnership("P", deps)
    expect(await deps.readFile(`P/${PROJECT_OWNER_FILE}`)).toBe(released) // 原样保留

    // 本应用记录 → 置 released
    deps = makeDeps({ readFile: async () => JSON.stringify(ownerRec()) })
    await releaseProjectOwnership("P", deps)
    const rec = parseOwnerRecord(await deps.readFile(`P/${PROJECT_OWNER_FILE}`))
    expect(rec!.released).toBe(true)
    expect(rec!.app).toBe(APP_OWNER_ID)
  })

  it("parseOwnerRecord: 缺 app/startedAt → null", () => {
    expect(parseOwnerRecord(JSON.stringify({ schema: "x" }))).toBeNull()
    expect(parseOwnerRecord(JSON.stringify({ app: "a" }))).toBeNull()
    expect(parseOwnerRecord("")).toBeNull()
    expect(parseOwnerRecord("[[[")).toBeNull()
  })

  it("OWNER_STALE_MS 默认 15 分钟", () => {
    expect(OWNER_STALE_MS).toBe(15 * 60 * 1000)
  })
})
