import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  USER_ASSET_EXECUTABLE_EXTENSIONS,
  USER_ASSET_REF_FILE,
  USER_ASSET_REF_SCHEMA_VERSION,
  USER_ASSET_ROOT,
  assertReferenceOnlyAssets,
  findExecutableAssets,
  hasExecutableExtension,
  hasUserAssetRef,
  isProjectLocalAssetPath,
  loadUserAssetRefs,
  normalizeUserAssetRef,
  saveUserAssetRefs,
  upsertUserAssetRef,
  userAssetRefsPath,
  type UserAssetRef,
} from "./user-asset-domain"

// C-007 / C-010：用户资产域（跨项目 / 用户级 / 不可重建 / 机读 / 项目内只存引用）。
// fs 面全 mock，避免真实磁盘 I/O。
const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(async () => {
    throw new Error("ENOENT")
  }),
  writeFileAtomic: vi.fn<(path: string, content: string) => Promise<void>>(async () => {}),
  createDirectory: vi.fn<(path: string) => Promise<void>>(async () => {}),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: fsMocks.readFile,
    writeFileAtomic: fsMocks.writeFileAtomic,
    createDirectory: fsMocks.createDirectory,
  }
})

const validRef: UserAssetRef = {
  id: "bundle-abc123",
  kind: "skill_bundle",
  assetPath: ".qmai/user-assets/skill_bundle/abc123.nbskill.json",
  contentHash: "a".repeat(64),
  trustLevel: "untrusted",
  referencedAt: "2026-09-12T00:00:00.000Z",
}

beforeEach(() => {
  fsMocks.readFile.mockReset()
  fsMocks.readFile.mockImplementation(async () => {
    throw new Error("ENOENT")
  })
  fsMocks.writeFileAtomic.mockReset()
  fsMocks.writeFileAtomic.mockImplementation(async () => {})
  fsMocks.createDirectory.mockReset()
  fsMocks.createDirectory.mockImplementation(async () => {})
})

describe("C-007 用户资产域常量与落位", () => {
  it("域根与项目侧引用文件路径符合裁定（项目内只存引用）", () => {
    expect(USER_ASSET_ROOT).toBe(".qmai/user-assets")
    expect(USER_ASSET_REF_FILE).toBe(".novel/user-asset-refs.json")
    expect(USER_ASSET_REF_SCHEMA_VERSION).toBe(1)
    // 本体落在项目外（用户资产域），项目内只有 .novel 引用文件
    expect(isProjectLocalAssetPath(USER_ASSET_ROOT)).toBe(false)
    expect(isProjectLocalAssetPath(USER_ASSET_REF_FILE)).toBe(true)
  })

  it("userAssetRefsPath 落在 .novel/ 下（不是第三库）", () => {
    expect(userAssetRefsPath("C:/proj")).toBe("C:/proj/.novel/user-asset-refs.json")
    expect(isProjectLocalAssetPath(userAssetRefsPath("C:/proj"))).toBe(true)
  })

  it("项目内路径判定覆盖过程库/资料库/canon", () => {
    expect(isProjectLocalAssetPath(".novel/x.json")).toBe(true)
    expect(isProjectLocalAssetPath("QM/raw/x.json")).toBe(true)
    expect(isProjectLocalAssetPath("canon/x.json")).toBe(true)
    expect(isProjectLocalAssetPath(".qmai/user-assets/x.json")).toBe(false)
  })
})

describe("C-007 可执行扩展名整体否决", () => {
  it("扩展名拒绝表非空且含三平台可执行语义扩展名", () => {
    expect(USER_ASSET_EXECUTABLE_EXTENSIONS.length).toBeGreaterThan(30)
    for (const ext of ["exe", "dll", "bat", "ps1", "sh", "jar", "app", "command", "lnk"]) {
      expect(USER_ASSET_EXECUTABLE_EXTENSIONS).toContain(ext)
    }
  })

  it("hasExecutableExtension 大小写不敏感且认路径", () => {
    expect(hasExecutableExtension("evil.exe")).toBe(true)
    expect(hasExecutableExtension("EVIL.EXE")).toBe(true)
    expect(hasExecutableExtension("dir/sub/run.sh")).toBe(true)
    expect(hasExecutableExtension("windows\\path\\tool.PS1")).toBe(true)
    expect(hasExecutableExtension("bundle.nbskill.json")).toBe(false)
    expect(hasExecutableExtension("notes.md")).toBe(false)
    // 无扩展名 / 点在开头 / 点在末尾 → 不算命中
    expect(hasExecutableExtension("README")).toBe(false)
    expect(hasExecutableExtension(".gitignore")).toBe(false)
    expect(hasExecutableExtension("trailing.")).toBe(false)
  })

  it("findExecutableAssets 一次给出全部命中项（用于一次性报错清单）", () => {
    expect(findExecutableAssets(["a.md", "b.exe", "c.json", "d.sh"])).toEqual(["b.exe", "d.sh"])
    expect(findExecutableAssets(["a.md", "b.json"])).toEqual([])
  })
})

describe("引用条目规范化与校验", () => {
  it("合法引用被接受", () => {
    expect(normalizeUserAssetRef(validRef)).toEqual(validRef)
  })

  it("缺失必填字段返回 null", () => {
    expect(normalizeUserAssetRef({ ...validRef, id: "" })).toBeNull()
    expect(normalizeUserAssetRef({ ...validRef, assetPath: "" })).toBeNull()
    expect(normalizeUserAssetRef({ ...validRef, contentHash: "" })).toBeNull()
    expect(normalizeUserAssetRef(null)).toBeNull()
    expect(normalizeUserAssetRef("x")).toBeNull()
  })

  it("assetPath 指向项目内 → 拒绝（C-007 第 5 项：项目内只存引用）", () => {
    expect(normalizeUserAssetRef({ ...validRef, assetPath: ".novel/skills/a.json" })).toBeNull()
    expect(normalizeUserAssetRef({ ...validRef, assetPath: "QM/skills/a.json" })).toBeNull()
  })

  it("trustLevel 默认 untrusted；未知 kind 归 other", () => {
    const a = normalizeUserAssetRef({ ...validRef, trustLevel: "bogus", kind: "bogus" })
    expect(a?.trustLevel).toBe("untrusted")
    expect(a?.kind).toBe("other")
    expect(normalizeUserAssetRef({ ...validRef, trustLevel: "reviewed" })?.trustLevel).toBe("reviewed")
  })

  it("assertReferenceOnlyAssets 对项目内本体抛错（fail-loud）", () => {
    expect(() => assertReferenceOnlyAssets([validRef])).not.toThrow()
    expect(() =>
      assertReferenceOnlyAssets([{ ...validRef, assetPath: "QM/skills/a.json" }]),
    ).toThrow(/reference-only, C-007/)
  })
})

describe("引用文件读写（容错读 + 原子写）", () => {
  it("文件缺失 → 空引用集（读路径不抛）", async () => {
    const file = await loadUserAssetRefs("C:/proj")
    expect(file).toEqual({ schemaVersion: USER_ASSET_REF_SCHEMA_VERSION, assets: [] })
  })

  it("解析失败 / 结构不符 → 空引用集", async () => {
    fsMocks.readFile.mockResolvedValue("{not json")
    expect((await loadUserAssetRefs("C:/proj")).assets).toEqual([])
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ assets: "nope" }))
    expect((await loadUserAssetRefs("C:/proj")).assets).toEqual([])
  })

  it("读入时逐条规范化并丢弃非法项", async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        assets: [validRef, { ...validRef, id: "b2", assetPath: "QM/x.json" }, null, 42],
      }),
    )
    const file = await loadUserAssetRefs("C:/proj")
    expect(file.assets).toHaveLength(1)
    expect(file.assets[0].id).toBe("bundle-abc123")
  })

  it("保存走 createDirectory + writeFileAtomic 且写 schemaVersion", async () => {
    await saveUserAssetRefs("C:/proj", { schemaVersion: 1, assets: [validRef] })
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("C:/proj/.novel")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const [path, content] = fsMocks.writeFileAtomic.mock.calls[0]
    expect(path).toBe("C:/proj/.novel/user-asset-refs.json")
    const parsed = JSON.parse(content as string) as { schemaVersion: number; assets: UserAssetRef[] }
    expect(parsed.schemaVersion).toBe(USER_ASSET_REF_SCHEMA_VERSION)
    expect(parsed.assets).toHaveLength(1)
  })
})

describe("upsert / 查询（幂等；不做时间戳比较）", () => {
  it("同 id 覆盖而非追加（DA-04：判新旧不用时间戳）", () => {
    const first = upsertUserAssetRef([], validRef)
    expect(first).toHaveLength(1)
    const second = upsertUserAssetRef(first, { ...validRef, contentHash: "b".repeat(64) })
    expect(second).toHaveLength(1)
    expect(second[0].contentHash).toBe("b".repeat(64))
  })

  it("hasUserAssetRef 按 id 判定", () => {
    expect(hasUserAssetRef([validRef], validRef.id)).toBe(true)
    expect(hasUserAssetRef([validRef], "nope")).toBe(false)
  })
})
