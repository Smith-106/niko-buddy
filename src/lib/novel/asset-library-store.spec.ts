/**
 * asset-library-store.spec.ts — 资产库磁盘归口契约。
 *
 * 覆盖（改进计划 B 项验收）：
 *   1. 文件缺失 → present:false（诚实空态，不造条目）；
 *   2. 正常产物 → 守恒通过 + 健康报告无违规；
 *   3. JSON 损坏 / libraryId 不匹配 → present:false + error（不静默降级为 0 条）；
 *   4. 写入侧拦截：schemaVersion 不符 / 守恒失配 → 抛错（禁手写脏产物落盘）；
 *   5. 路径确定性派生（5 库各一文件）。
 */
import { describe, expect, it } from "vitest"
import {
  assetLibraryFilePath,
  loadAllAssetLibrarySnapshots,
  loadAssetLibrarySnapshot,
  saveAssetLibraryArtifact,
  type AssetLibraryStoreDeps,
} from "./asset-library-store"
import { ASSET_LIBRARY_SCHEMA_VERSION, LIBRARY_IDS, buildLibraryArtifact, type LibraryEntry } from "./asset-library"

const genreEntries = [
  { entryId: "g1", name: "玄幻", toneTags: ["热血"], forbidPatterns: [], plotBeats: ["升级"] },
] as unknown as LibraryEntry[]

function memDeps(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  const dirs: string[] = []
  const deps: AssetLibraryStoreDeps = {
    readText: async (path) => files.get(path) ?? null,
    writeText: async (path, text) => {
      files.set(path, text)
    },
    ensureDir: async (dir) => {
      dirs.push(dir)
    },
  }
  return { files, dirs, deps }
}

function artifact() {
  return buildLibraryArtifact({
    libraryId: "genre_base",
    generatorVersion: "1.0.0",
    generatedAt: "2026-10-18T00:00:00.000Z",
    entries: genreEntries,
  })
}

describe("assetLibraryFilePath", () => {
  it("按 libraryId 确定性派生路径，去掉尾部分隔符", () => {
    expect(assetLibraryFilePath("/p/QMAI/", "genre_base")).toBe("/p/QMAI/.novel/asset-library/genre_base.json")
    expect(assetLibraryFilePath("C:\\proj", "world_sample")).toBe("C:\\proj/.novel/asset-library/world_sample.json")
  })
})

describe("loadAssetLibrarySnapshot", () => {
  it("文件缺失 → present:false 且不造条目", async () => {
    const { deps } = memDeps()
    const snap = await loadAssetLibrarySnapshot("/p", "genre_base", deps)
    expect(snap.present).toBe(false)
    expect(snap.entryCount).toBe(0)
    expect(snap.health).toBeNull()
  })

  it("正常产物 → 守恒通过、条目数正确、无违规", async () => {
    const a = artifact()
    const { deps } = memDeps({ [assetLibraryFilePath("/p", "genre_base")]: JSON.stringify(a) })
    const snap = await loadAssetLibrarySnapshot("/p", "genre_base", deps)
    expect(snap.present).toBe(true)
    expect(snap.entryCount).toBe(1)
    expect(snap.conserved).toBe(true)
    expect(snap.schemaVersion).toBe(ASSET_LIBRARY_SCHEMA_VERSION)
    expect(snap.health?.violations).toEqual([])
  })

  it("JSON 损坏 → present:false + error（不静默降级）", async () => {
    const { deps } = memDeps({ [assetLibraryFilePath("/p", "genre_base")]: "{not-json" })
    const snap = await loadAssetLibrarySnapshot("/p", "genre_base", deps)
    expect(snap.present).toBe(false)
    expect(snap.error).toContain("JSON 解析失败")
  })

  it("libraryId 不匹配 → present:false + error", async () => {
    const a = artifact()
    const { deps } = memDeps({ [assetLibraryFilePath("/p", "world_sample")]: JSON.stringify(a) })
    const snap = await loadAssetLibrarySnapshot("/p", "world_sample", deps)
    expect(snap.present).toBe(false)
    expect(snap.error).toContain("libraryId 不匹配")
  })

  it("手工篡改 entries → 守恒失配（conserved:false + 违规）", async () => {
    const a = artifact()
    const tampered = { ...a, entries: [{ entryId: "hacked" }] }
    const { deps } = memDeps({ [assetLibraryFilePath("/p", "genre_base")]: JSON.stringify(tampered) })
    const snap = await loadAssetLibrarySnapshot("/p", "genre_base", deps)
    expect(snap.present).toBe(true)
    expect(snap.conserved).toBe(false)
    expect(snap.health?.violations.some((v) => v.includes("守恒失配"))).toBe(true)
  })
})

describe("loadAllAssetLibrarySnapshots", () => {
  it("5 库顺序固定（LIBRARY_IDS），全缺失时全部 present:false", async () => {
    const { deps } = memDeps()
    const rows = await loadAllAssetLibrarySnapshots("/p", deps)
    expect(rows.map((r) => r.libraryId)).toEqual([...LIBRARY_IDS])
    expect(rows.every((r) => !r.present)).toBe(true)
  })
})

describe("saveAssetLibraryArtifact", () => {
  it("正常产物：原子写入派生路径并建目录", async () => {
    const { files, dirs, deps } = memDeps()
    const res = await saveAssetLibraryArtifact("/p", artifact(), deps)
    expect(res.conserved).toBe(true)
    expect(files.has(assetLibraryFilePath("/p", "genre_base"))).toBe(true)
    expect(dirs.some((d) => d.endsWith("/.novel/asset-library"))).toBe(true)
  })

  it("schemaVersion 不符 → 抛错不落盘", async () => {
    const { files, deps } = memDeps()
    const a = { ...artifact(), schemaVersion: "asset-library/0.9" } as unknown as ReturnType<typeof artifact>
    await expect(saveAssetLibraryArtifact("/p", a, deps)).rejects.toThrow("schemaVersion 不符")
    expect(files.size).toBe(0)
  })

  it("守恒失配 → 抛错不落盘（手写脏产物被拦）", async () => {
    const { files, deps } = memDeps()
    const a = { ...artifact(), contentHash: "deadbeef" }
    await expect(saveAssetLibraryArtifact("/p", a, deps)).rejects.toThrow("守恒失配")
    expect(files.size).toBe(0)
  })
})
