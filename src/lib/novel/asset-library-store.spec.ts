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
import { describe, expect, it, vi } from "vitest"
import {
  assetLibraryFilePath,
  loadAllAssetLibrarySnapshots,
  loadAssetLibraryArtifact,
  loadAssetLibrarySnapshot,
  saveAssetLibraryArtifact,
  type AssetLibraryStoreDeps,
} from "./asset-library-store"
import {
  ASSET_LIBRARY_SCHEMA_VERSION,
  LIBRARY_IDS,
  buildLibraryArtifact,
  computeLibraryHash,
  stableStringify,
  type LibraryEntry,
} from "./asset-library"

// 覆盖补齐：默认 fs deps（生产接线）经 `@/commands/fs` 读/建目录/原子写。
// 既有用例全部注入 memDeps，从不落到真实 fs，因此本 mock 不影响它们。
vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: vi.fn(async () => ""),
    writeFileAtomic: vi.fn(async () => {}),
    createDirectory: vi.fn(async () => {}),
  }
})

import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"

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

describe("loadAssetLibraryArtifact（读路径信任边界）", () => {
  const relEdge = () =>
    buildLibraryArtifact({
      libraryId: "relationship_edge",
      entries: [{ entryId: "rel:A->B", from: "A", to: "B", kind: "unknown" }],
      generatedAt: "2026-10-18T00:00:00.000Z",
      generatorVersion: "t/1",
    }) as unknown as Record<string, unknown> & { contentHash: string }
  const path = assetLibraryFilePath("/p", "relationship_edge")

  it("守恒且合 schema → 返回条目", async () => {
    const { deps } = memDeps({ [path]: JSON.stringify(relEdge()) })
    const artifact = await loadAssetLibraryArtifact("/p", "relationship_edge", deps)
    expect(artifact?.entries).toHaveLength(1)
  })

  it("手改 entries 未更新 hash（守恒失配）→ null，不把篡改内容当真源", async () => {
    const tampered = JSON.parse(JSON.stringify(relEdge())) as { entries: Array<Record<string, unknown>> }
    tampered.entries[0]!.kind = "mentor"
    const { deps } = memDeps({ [path]: JSON.stringify(tampered) })
    expect(await loadAssetLibraryArtifact("/p", "relationship_edge", deps)).toBeNull()
  })

  it("条目不合 schema（越界强度）→ null", async () => {
    const bad = buildLibraryArtifact({
      libraryId: "relationship_edge",
      entries: [{ entryId: "rel:A->B", from: "A", to: "B", kind: "unknown" }],
      generatedAt: "2026-10-18T00:00:00.000Z",
      generatorVersion: "t/1",
    })
    const mutated = JSON.parse(JSON.stringify(bad)) as {
      entries: Array<Record<string, unknown>>
      contentHash: string
    }
    mutated.entries[0]!.strength = 999
    // 重新计算 hash 让守恒成立，只有 schema 能拦住
    mutated.contentHash = computeLibraryHash(`relationship_edge:${stableStringify(mutated.entries)}`)
    const { deps } = memDeps({ [path]: JSON.stringify(mutated) })
    expect(await loadAssetLibraryArtifact("/p", "relationship_edge", deps)).toBeNull()
  })

  it("文件缺失 / 解析失败 / libraryId 不符 → null", async () => {
    expect(await loadAssetLibraryArtifact("/p", "relationship_edge", memDeps().deps)).toBeNull()
    expect(
      await loadAssetLibraryArtifact("/p", "relationship_edge", memDeps({ [path]: "{ bad" }).deps),
    ).toBeNull()
    const other = buildLibraryArtifact({
      libraryId: "title_seed",
      entries: [{ entryId: "t1", pattern: "题", constraints: [], examples: [] }],
      generatedAt: "2026-10-18T00:00:00.000Z",
      generatorVersion: "t/1",
    })
    expect(
      await loadAssetLibraryArtifact("/p", "relationship_edge", memDeps({ [path]: JSON.stringify(other) }).deps),
    ).toBeNull()
  })
})

describe("默认 fs deps（生产接线，不注入 deps）", () => {
  it("读：默认 readText 读到内容 → 正常解析（生产路径不是恒空）", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(artifact()))
    const snap = await loadAssetLibrarySnapshot("/p", "genre_base")
    expect(readFile).toHaveBeenCalledWith("/p/.novel/asset-library/genre_base.json")
    expect(snap.present).toBe(true)
    expect(snap.entryCount).toBe(1)
    expect(snap.conserved).toBe(true)
  })

  it("读：文件不存在（readFile 抛错）→ 当缺失（present:false，不带 error）", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error("ENOENT"))
    const snap = await loadAssetLibrarySnapshot("/p", "genre_base")
    expect(snap.present).toBe(false)
    expect(snap.entryCount).toBe(0)
    expect(snap.error).toBeUndefined()
  })

  it("写入：先建 .novel/asset-library 目录，再原子写派生路径（落盘内容即产物）", async () => {
    vi.mocked(writeFileAtomic).mockClear()
    vi.mocked(createDirectory).mockClear()
    const a = artifact()
    const res = await saveAssetLibraryArtifact("/p/", a)
    expect(res).toEqual({ path: "/p/.novel/asset-library/genre_base.json", conserved: true })
    expect(createDirectory).toHaveBeenCalledTimes(1)
    expect(createDirectory).toHaveBeenCalledWith("/p/.novel/asset-library")
    expect(writeFileAtomic).toHaveBeenCalledTimes(1)
    const [writtenPath, writtenText] = vi.mocked(writeFileAtomic).mock.calls[0]!
    expect(writtenPath).toBe("/p/.novel/asset-library/genre_base.json")
    expect(JSON.parse(writtenText)).toEqual(a)
    // 写入顺序：目录先于文件（原子写不会落进不存在的目录）。
    expect(vi.mocked(createDirectory).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(writeFileAtomic).mock.invocationCallOrder[0]!,
    )
  })
})

describe("坏形状产物（entries 非数组）不崩、不当真源", () => {
  const path = assetLibraryFilePath("/p", "relationship_edge")
  const badShape = () =>
    JSON.stringify({
      libraryId: "relationship_edge",
      schemaVersion: ASSET_LIBRARY_SCHEMA_VERSION,
      generatorVersion: "t/1",
      generatedAt: "2026-10-18T00:00:00.000Z",
      entries: "oops",
      contentHash: "deadbeef",
    })

  it("快照：entries 非数组 → 条数记 0（不臆造、不抛），守恒仍按原值判失配", async () => {
    const { deps } = memDeps({ [path]: badShape() })
    const snap = await loadAssetLibrarySnapshot("/p", "relationship_edge", deps)
    expect(snap.present).toBe(true)
    expect(snap.entryCount).toBe(0)
    expect(snap.conserved).toBe(false)
  })

  it("原始条目回显：entries 非数组 → null（不把坏形状当真源）", async () => {
    const { deps } = memDeps({ [path]: badShape() })
    expect(await loadAssetLibraryArtifact("/p", "relationship_edge", deps)).toBeNull()
  })

  it("缺 contentHash/schemaVersion 字段 → 快照记 null（不伪造校验通过）", async () => {
    const { deps } = memDeps({
      [path]: JSON.stringify({ libraryId: "relationship_edge", entries: [] }),
    })
    const snap = await loadAssetLibrarySnapshot("/p", "relationship_edge", deps)
    expect(snap.present).toBe(true)
    expect(snap.contentHash).toBeNull()
    expect(snap.schemaVersion).toBeNull()
  })
})
