import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  createEmptyWorldBlueprint,
  deriveAndSaveWorldBlueprint,
  deriveWorldBlueprint,
  loadWorldBlueprint,
  REQUIRED_WORLD_LAYERS,
  saveWorldBlueprint,
  validateWorldBlueprint,
  worldBlueprintToPromptFragment,
  WORLD_LAYERS,
  type WorldBlueprint,
} from "./world-blueprint"
import { SUBDIR_TO_LAYER_TEST_EXPORT } from "./world-blueprint"
import { listEntityFiles } from "./entity-subdir-resolver"

const mem = vi.hoisted(() => ({ files: new Map<string, string>() }))

vi.mock("@/commands/fs", () => ({
  fileExists: vi.fn(async (path: string) => mem.files.has(path)),
  readFile: vi.fn(async (path: string) => {
    const found = mem.files.get(path)
    if (found === undefined) throw new Error(`ENOENT ${path}`)
    return found
  }),
  writeFile: vi.fn(async (path: string, contents: string) => {
    mem.files.set(path, contents)
  }),
  writeFileAtomic: vi.fn(async (path: string, contents: string) => {
    mem.files.set(path, contents)
  }),
  createDirectory: vi.fn(async () => {}),
  listDirectory: vi.fn(async () => []),
}))

vi.mock("./entity-subdir-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./entity-subdir-resolver")>()
  return { ...actual, listEntityFiles: vi.fn(async () => []) }
})

const mockListEntityFiles = vi.mocked(listEntityFiles)

function completeBlueprint(): WorldBlueprint {
  return {
    version: "1.0",
    worldType: "东方玄幻",
    layers: {
      axioms: ["灵气即资源", "境界决定话语权"],
      background: ["三千年前天倾之战后"],
      geography: ["九州大陆", "北境冰原"],
      cultures: ["中原儒家礼法", "草原部落武统"],
      conflicts: ["正魔两道千年积怨"],
      magicSystem: ["炼气→筑基→金丹"],
      races: ["人族", "妖族"],
    },
    crossRefs: [{ from: "magicSystem", to: "races", term: "人族" }],
  }
}

describe("world-blueprint（吸收自 ANWA services/world 分层结构模式）", () => {
  it("13 层常量与必填层声明", () => {
    expect(WORLD_LAYERS).toHaveLength(13)
    expect(REQUIRED_WORLD_LAYERS).toEqual(["axioms", "background", "geography", "cultures", "conflicts"])
  })

  it("完备蓝图 → complete 无 error", () => {
    const result = validateWorldBlueprint(completeBlueprint())
    expect(result.verdict).toBe("complete")
    expect(result.findings).toEqual([])
  })

  it("缺必填层 → error → incomplete（逐层报缺失）", () => {
    const bp = createEmptyWorldBlueprint("东方玄幻")
    const result = validateWorldBlueprint(bp)
    expect(result.verdict).toBe("incomplete")
    expect(result.findings).toHaveLength(REQUIRED_WORLD_LAYERS.length)
    expect(result.findings.every((f) => f.code === "missing_layer" && f.severity === "error")).toBe(true)
  })

  it("可选层为空合法（稀疏骨架不报错）", () => {
    const bp = completeBlueprint()
    const result = validateWorldBlueprint(bp)
    expect(result.findings.filter((f) => f.layer === "technology")).toHaveLength(0)
  })

  it("悬空交叉引用 → warn 不构成 incomplete", () => {
    const bp = completeBlueprint()
    bp.crossRefs = [{ from: "magicSystem", to: "races", term: "龙族" }]
    const result = validateWorldBlueprint(bp)
    expect(result.findings[0].code).toBe("dangling_cross_ref")
    expect(result.findings[0].severity).toBe("warn")
    expect(result.verdict).toBe("complete")
  })

  it("worldBlueprintToPromptFragment 渲染非空层且层序确定；空蓝图返回空串", () => {
    const frag = worldBlueprintToPromptFragment(completeBlueprint())
    expect(frag).toContain("# 世界观骨架（东方玄幻）")
    expect(frag.indexOf("### axioms")).toBeLessThan(frag.indexOf("### conflicts"))
    expect(worldBlueprintToPromptFragment(createEmptyWorldBlueprint("x"))).toBe("")
  })

  it("确定性：同输入双跑全等", () => {
    expect(JSON.stringify(validateWorldBlueprint(completeBlueprint()))).toBe(
      JSON.stringify(validateWorldBlueprint(completeBlueprint())),
    )
  })

  it("MIG-002: subtype→layer 映射保守——实体子目录正确落骨架层", () => {
    expect(SUBDIR_TO_LAYER_TEST_EXPORT.locations).toBe("geography")
    expect(SUBDIR_TO_LAYER_TEST_EXPORT.organizations).toBe("factions")
    expect(SUBDIR_TO_LAYER_TEST_EXPORT.items).toBe("technology")
    expect(SUBDIR_TO_LAYER_TEST_EXPORT.events).toBe("conflicts")
    expect(SUBDIR_TO_LAYER_TEST_EXPORT.characters).toBe("cultures")
    // 全部映射目标是合法 WORLD_LAYERS 成员
    for (const layer of Object.values(SUBDIR_TO_LAYER_TEST_EXPORT)) {
      expect(WORLD_LAYERS).toContain(layer)
    }
  })
})

describe("world-blueprint · 持久化与推导（MIG-001/MIG-002 增补）", () => {
  beforeEach(() => {
    mem.files.clear()
    mockListEntityFiles.mockReset()
    mockListEntityFiles.mockResolvedValue([])
  })

  it("save→load 往返一致（.novel 原子 store）", async () => {
    const bp = completeBlueprint()
    await saveWorldBlueprint("proj", bp)
    const keys = [...mem.files.keys()].filter((k) => k.endsWith("world-blueprint.json"))
    expect(keys).toHaveLength(1)
    expect(keys[0]).toContain(".novel/")
    const loaded = await loadWorldBlueprint("proj")
    expect(loaded).toEqual(bp)
  })

  it("load 未写过 → null（缺失降级，不抛错）", async () => {
    await expect(loadWorldBlueprint("empty-proj")).resolves.toBeNull()
  })

  it("load 损坏 JSON → null（截断/撕裂降级为空 store）", async () => {
    mem.files.set("proj/.novel/world-blueprint.json", "{截断")
    await expect(loadWorldBlueprint("proj")).resolves.toBeNull()
  })

  it("load 未知新版本 fail-loud → 捕获后返回 null", async () => {
    mem.files.set("proj/.novel/world-blueprint.json", JSON.stringify({ fileVersion: 999, layers: {} }))
    await expect(loadWorldBlueprint("proj")).resolves.toBeNull()
  })

  it("derive 按子目录聚类并排序；未知子目录/顶层散装跳过", async () => {
    mockListEntityFiles.mockResolvedValue([
      { name: "长安城", path: "wiki/entities/locations/长安城.md" },
      { name: "边城", path: "wiki/entities/locations/边城.md" },
      { name: "主角", path: "wiki/entities/characters/主角.md" },
      { name: "大战", path: "wiki/entities/events/大战.md" },
      { name: "散装", path: "wiki/entities/散装.md" },
      { name: "禁咒", path: "wiki/entities/spells/禁咒.md" },
    ])
    const bp = await deriveWorldBlueprint("proj", "东方玄幻")
    expect(bp.version).toBe("1.0")
    expect(bp.worldType).toBe("东方玄幻")
    // 同层多实体按名排序
    expect(bp.layers.geography).toEqual(["边城", "长安城"])
    expect(bp.layers.cultures).toEqual(["主角"])
    expect(bp.layers.conflicts).toEqual(["大战"])
    // 顶层散装与未映射子目录不产生层
    expect(bp.layers.technology).toBeUndefined()
    expect(mockListEntityFiles).toHaveBeenCalledWith("proj")
  })

  it("derive 缺省 worldType 为 fantasy；尾部分隔符被剥离", async () => {
    const bp = await deriveWorldBlueprint("proj///")
    expect(bp.worldType).toBe("fantasy")
    expect(mockListEntityFiles).toHaveBeenCalledWith("proj")
  })

  it("derive 空实体 → 必填层置空数组优雅降级", async () => {
    mockListEntityFiles.mockResolvedValue([])
    const bp = await deriveWorldBlueprint("proj")
    for (const layer of REQUIRED_WORLD_LAYERS) {
      expect(bp.layers[layer]).toEqual([])
    }
    expect(validateWorldBlueprint(bp).verdict).toBe("incomplete")
  })

  it("derive 实体读取失败 → 空骨架不抛错", async () => {
    mockListEntityFiles.mockRejectedValue(new Error("boom"))
    const bp = await deriveWorldBlueprint("proj")
    expect(bp.layers).toEqual(
      Object.fromEntries(REQUIRED_WORLD_LAYERS.map((l) => [l, []])),
    )
  })

  it("deriveAndSave 推导并落盘，返回同一骨架", async () => {
    mockListEntityFiles.mockResolvedValue([
      { name: "长安城", path: "wiki/entities/locations/长安城.md" },
    ])
    const bp = await deriveAndSaveWorldBlueprint("proj", "东方玄幻")
    expect(bp.layers.geography).toEqual(["长安城"])
    const loaded = await loadWorldBlueprint("proj")
    expect(loaded).toEqual(bp)
  })
})
