/**
 * technique-compiler.spec.ts — T27b 技法编译器单测（nmem-snapshot + technique-compiler）。
 *
 * 覆盖（任务约束 coverage-100%）：
 *   - nmem-snapshot：入仓快照结构完整性（元数据四值 / 8 memory + 1 skill /
 *     ISO 时点 / importance 值域 / id 唯一）+ validateNmemSnapshot 全违规路径；
 *   - compileTechniques：≥4 规则包（实测 9 包）、确定性 DeepEqual、包结构
 *     四件套非空、非法快照 fail-fast；
 *   - 追溯性（A-04.6）：每包 sourceMemoryIds 可解析至快照、版本一致，
 *     全违规路径（未知 id / 版本不匹配 / packId 重复 / 钩子重复注册）；
 *   - hook 类型开放注册表：11 型章末 + 10 方案开端 = 21 条，挂载点区分
 *     （A-23.1 edges / A-23.2 episodes），同挂载点无重复，string 承载（R8/U-05）；
 *   - canon 字段目标与 T26 契约逐字对齐 + 主角 wish/motive/ghost/arc_stage
 *     填充率 100% 硬门 + buildProtagonistCraftWrite 全 fail-fast 路径；
 *   - 离线降级（蓝图 §8 P3）：探活失败/live 失败优雅回落提交快照，
 *     快照路产物 packs 与离线编译深等价（功能不退化），全程零真实网络。
 *
 * 纯函数契约测试：零 IO / 零 LLM / 零 Tauri invoke / 零真实网络调用。
 */
import { describe, expect, it } from "vitest"

import {
  NMEM_SNAPSHOT,
  NMEM_SNAPSHOT_CAPTURED_AT,
  NMEM_SNAPSHOT_VERSION,
  validateNmemSnapshot,
  type NmemSnapshot,
} from "./nmem-snapshot"
import {
  NMEM_DEFAULT_BASE_URL,
  PROTAGONIST_REQUIRED_CRAFT_FIELDS,
  TECHNIQUE_COMPILER_VERSION,
  buildProtagonistCraftWrite,
  compileFromCommittedSnapshot,
  compileTechniques,
  compileWithFallback,
  fetchLiveSnapshot,
  getHookTypesByMountPoint,
  isRegisteredHookType,
  measureCraftFieldFillRate,
  probeNmemHealth,
  validateRegistryTraceability,
  type CanonFieldTarget,
  type CompiledTechniqueRegistry,
  type TechniqueRulePack,
} from "./technique-compiler"
import type { EdgeCraftFields, EntityCraftFields, EpisodeCraftFields } from "./canon-craft-fields"

/** 构造最小合法快照的工厂（测试违规注入用）。 */
function makeMinimalSnapshot(overrides?: Partial<NmemSnapshot>): NmemSnapshot {
  return {
    snapshotVersion: 7,
    capturedAt: "2026-08-21T15:30:23Z",
    serverVersion: "0.10.67",
    spaceId: "space",
    memories: [
      {
        memoryId: "mem-a",
        title: "记忆 A",
        contentExcerpt: "口径 A",
        createdAt: "2026-07-10T08:41:04+00:00",
        importance: 0.75,
        unitType: "learning",
        labels: ["测试"],
      },
    ],
    skills: [],
    ...overrides,
  }
}

// ============================================================================
// nmem-snapshot — 入仓快照完整性
// ============================================================================

describe("nmem-snapshot 入仓快照完整性", () => {
  it("元数据四值齐备且版本为正整数", () => {
    expect(NMEM_SNAPSHOT.snapshotVersion).toBe(NMEM_SNAPSHOT_VERSION)
    expect(NMEM_SNAPSHOT.snapshotVersion).toBeGreaterThanOrEqual(1)
    expect(NMEM_SNAPSHOT.capturedAt).toBe(NMEM_SNAPSHOT_CAPTURED_AT)
    expect(NMEM_SNAPSHOT.serverVersion.length).toBeGreaterThan(0)
    expect(NMEM_SNAPSHOT.spaceId).toBe("space")
  })

  it("收录 8 条 memory + 1 条 skill 且 id 全局唯一", () => {
    expect(NMEM_SNAPSHOT.memories).toHaveLength(8)
    expect(NMEM_SNAPSHOT.skills).toHaveLength(1)
    const ids = NMEM_SNAPSHOT.memories.map((m) => m.memoryId)
    expect(new Set(ids).size).toBe(ids.length)
    // 蓝图 §5 点名的两条真源记忆必须在快照中
    expect(ids).toContain("20de3c24-0000-4000-8000-000000000000") // 愿望—动机—行动
    expect(ids).toContain("04644331-0000-4000-8000-000000000000") // 爽点循环/危机延宕/结局三戒
  })

  it("validateNmemSnapshot 对入仓快照通过", () => {
    const result = validateNmemSnapshot(NMEM_SNAPSHOT)
    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
  })

  it("validateNmemSnapshot 违规路径：坏版本号/坏时点/空元数据", () => {
    const result = validateNmemSnapshot(
      makeMinimalSnapshot({
        snapshotVersion: 0,
        capturedAt: "not-iso",
        serverVersion: "",
        spaceId: "",
      }),
    )
    expect(result.ok).toBe(false)
    const paths = result.violations.map((v) => v.path)
    expect(paths).toContain("snapshotVersion")
    expect(paths).toContain("capturedAt")
    expect(paths).toContain("serverVersion")
    expect(paths).toContain("spaceId")
  })

  it("validateNmemSnapshot 违规路径：memory 空字段/坏 createdAt/越界 importance/重复 id", () => {
    const badMemory = {
      memoryId: "",
      title: "",
      contentExcerpt: "",
      createdAt: "2026/08/21",
      importance: 1.5,
      unitType: "learning",
      labels: [],
    }
    const result = validateNmemSnapshot(
      makeMinimalSnapshot({
        memories: [
          badMemory, // 空 id → memories[0].memoryId 违规
          { ...badMemory, memoryId: "dup" },
          { ...badMemory, memoryId: "dup" }, // 与上一条重复 → memories[2].memoryId 重复违规
        ],
      }),
    )
    expect(result.ok).toBe(false)
    const paths = result.violations.map((v) => v.path)
    expect(paths).toContain("memories[0].memoryId")
    expect(paths).toContain("memories[0].title")
    expect(paths).toContain("memories[0].contentExcerpt")
    expect(paths).toContain("memories[0].createdAt")
    expect(paths).toContain("memories[0].importance")
    expect(result.violations.some((v) => v.path === "memories[2].memoryId" && v.message.includes("重复"))).toBe(true)
  })

  it("validateNmemSnapshot 违规路径：skill 空 id/坏 version/空 hash", () => {
    const result = validateNmemSnapshot(
      makeMinimalSnapshot({
        skills: [{ skillId: "", title: "", version: 0, contentHash: "", stage: "active" }],
      }),
    )
    expect(result.ok).toBe(false)
    const paths = result.violations.map((v) => v.path)
    expect(paths).toContain("skills[0].skillId")
    expect(paths).toContain("skills[0].title")
    expect(paths).toContain("skills[0].version")
    expect(paths).toContain("skills[0].contentHash")
  })
})

// ============================================================================
// compileTechniques — 编译主入口
// ============================================================================

describe("compileTechniques 编译主入口", () => {
  const registry = compileFromCommittedSnapshot()

  it("编译 ≥4 个规则包（任务下限；实测 9 包）并注册 hook 注册表", () => {
    expect(registry.packs.length).toBeGreaterThanOrEqual(4)
    expect(registry.packs).toHaveLength(9)
    expect(registry.hookTypeRegistry.length).toBeGreaterThan(0)
  })

  it("版本化元数据：compilerVersion + snapshotVersion 入注册表，每包 sourceSnapshotVersion 入包元数据", () => {
    expect(registry.compilerVersion).toBe(TECHNIQUE_COMPILER_VERSION)
    expect(registry.snapshotVersion).toBe(NMEM_SNAPSHOT_VERSION)
    for (const pack of registry.packs) {
      expect(pack.sourceSnapshotVersion).toBe(NMEM_SNAPSHOT_VERSION)
      expect(pack.sourceMemoryIds.length).toBeGreaterThan(0)
    }
  })

  it("纯确定性：同一快照两次编译产物深等价（零时钟/零随机）", () => {
    const again = compileTechniques(NMEM_SNAPSHOT)
    expect(again).toEqual(registry)
  })

  it("每个包四件套非空：canon 字段目标 / 参数 / 提示词块 / 溯源链", () => {
    for (const pack of registry.packs) {
      expect(pack.packId.startsWith("craft.")).toBe(true)
      expect(pack.techniqueName.length).toBeGreaterThan(0)
      expect(pack.canonFieldTargets.length).toBeGreaterThan(0)
      expect(Object.keys(pack.params).length).toBeGreaterThan(0)
      expect(pack.promptBlocks.length).toBeGreaterThan(0)
      for (const block of pack.promptBlocks) {
        expect(block.blockId.length).toBeGreaterThan(0)
        expect(block.body.length).toBeGreaterThan(0)
      }
    }
  })

  it("fail-fast：结构非法的快照抛 TypeError 不产半成品", () => {
    const broken = makeMinimalSnapshot({ capturedAt: "bad" })
    expect(() => compileTechniques(broken)).toThrow(TypeError)
  })

  it("蓝图 §5 点名技法全部成包：愿望动机行动/爽点延宕/结局三戒/八素质/鬼魂/章末钩子/开篇钩子/桥接/显著细节", () => {
    const packIds = registry.packs.map((p) => p.packId)
    expect(packIds).toEqual([
      "craft.wish-motive-action",
      "craft.thrill-loop-crisis-delay",
      "craft.finale-three-precepts",
      "craft.mckee-eight-fundamentals",
      "craft.mckee-ghost-wound",
      "craft.chapter-end-hooks-domino",
      "craft.opening-hook-promise",
      "craft.conflict-caliber-bridge",
      "craft.significant-details",
    ])
  })
})

// ============================================================================
// 追溯性守卫（A-04.6）
// ============================================================================

describe("validateRegistryTraceability 溯源守卫", () => {
  const registry = compileFromCommittedSnapshot()

  it("对入仓快照编译产物通过：每包可追溯 nmem memory id+版本", () => {
    const result = validateRegistryTraceability(registry, NMEM_SNAPSHOT)
    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
  })

  it("违规路径：溯源 id 不在快照中", () => {
    const tainted: CompiledTechniqueRegistry = {
      ...registry,
      packs: registry.packs.map((p, i) =>
        i === 0 ? { ...p, sourceMemoryIds: [...p.sourceMemoryIds, "ghost-memory-not-in-snapshot"] } : p,
      ),
    }
    const result = validateRegistryTraceability(tainted, NMEM_SNAPSHOT)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.message.includes("ghost-memory-not-in-snapshot"))).toBe(true)
  })

  it("违规路径：包级快照版本与来源快照不一致", () => {
    const tainted: CompiledTechniqueRegistry = {
      ...registry,
      packs: registry.packs.map((p, i) => (i === 2 ? { ...p, sourceSnapshotVersion: p.sourceSnapshotVersion + 1 } : p)),
    }
    const result = validateRegistryTraceability(tainted, NMEM_SNAPSHOT)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.path.includes("sourceSnapshotVersion"))).toBe(true)
  })

  it("违规路径：packId 重复 / 空 promptBlocks / 空 canonFieldTargets / 钩子重复注册", () => {
    const dupPack: TechniqueRulePack = { ...registry.packs[0], params: {} }
    const tainted: CompiledTechniqueRegistry = {
      compilerVersion: registry.compilerVersion,
      snapshotVersion: registry.snapshotVersion,
      packs: [
        ...registry.packs,
        dupPack, // packId 与 packs[0] 重复
        { ...registry.packs[1], packId: "craft.x-empty-blocks", promptBlocks: [] },
        { ...registry.packs[2], packId: "craft.y-empty-targets", canonFieldTargets: [] },
        { ...registry.packs[3], packId: "craft.z-no-provenance", sourceMemoryIds: [] },
      ],
      hookTypeRegistry: [...registry.hookTypeRegistry, registry.hookTypeRegistry[0]], // (mountPoint,hookType) 重复
    }
    const result = validateRegistryTraceability(tainted, NMEM_SNAPSHOT)
    expect(result.ok).toBe(false)
    const messages = result.violations.map((v) => v.message)
    expect(messages.some((m) => m.includes(`packId 重复：${registry.packs[0].packId}`))).toBe(true)
    expect(messages.some((m) => m.includes("提示词块不得为空"))).toBe(true)
    expect(messages.some((m) => m.includes("canon 字段目标不得为空"))).toBe(true)
    expect(messages.some((m) => m.includes("溯源 memoryId 列表不得为空"))).toBe(true)
    expect(messages.some((m) => m.includes("钩子型重复注册"))).toBe(true)
  })

  it("skill 溯源：显著细节包同时追溯到 memory 与 skill_f8e81e050000", () => {
    const detailsPack = registry.packs.find((p) => p.packId === "craft.significant-details")
    expect(detailsPack).toBeDefined()
    expect(detailsPack?.sourceMemoryIds).toContain("94a6af29-0000-4000-8000-000000000000")
    expect(detailsPack?.sourceMemoryIds).toContain("skill_f8e81e050000")
    expect(detailsPack?.params.skill_version).toBe(NMEM_SNAPSHOT.skills[0].version)
  })
})

// ============================================================================
// hook 类型开放注册表（R8/U-05）
// ============================================================================

describe("hook 类型开放注册表", () => {
  const registry = compileFromCommittedSnapshot()

  it("11 型章末钩子挂载 episodes（A-23.2），取值即维兰德十一型", () => {
    const chapterEnd = getHookTypesByMountPoint(registry, "episodes")
    expect(chapterEnd).toHaveLength(11)
    expect(chapterEnd.map((e) => e.hookType)).toEqual([
      "foreshadow_conflict",
      "secret",
      "important_decision_or_vow",
      "shocking_announcement",
      "intense_emotion",
      "novel_flipping_twist",
      "new_idea",
      "unanswered_question",
      "mysterious_dialogue",
      "prophecy",
      "turning_point",
    ])
    for (const entry of chapterEnd) {
      expect(entry.sourceMemoryId).toBe("28dc7918-0000-4000-8000-000000000000")
    }
  })

  it("开端钩子方案挂载 edges（A-23.1），共 10 条", () => {
    const opening = getHookTypesByMountPoint(registry, "edges")
    expect(opening).toHaveLength(10)
    for (const entry of opening) {
      expect(entry.sourceMemoryId).toBe("786b0422-0000-4000-8000-000000000000")
    }
    expect(isRegisteredHookType(registry, "strong_first_line", "edges")).toBe(true)
  })

  it("开放注册表以 string 承载（非封闭联合）；同名型在不同挂载点互不影响", () => {
    // turning_point 同时出现在章末（转折点）与开端（转机）——挂载点隔离语义
    expect(isRegisteredHookType(registry, "turning_point", "episodes")).toBe(true)
    expect(isRegisteredHookType(registry, "turning_point", "edges")).toBe(true)
    // 未注册值返回 false 而非编译错误（开放注册表：U-05 定稿前自由字符串）
    const unknown: string = "some_future_hook_from_u05"
    expect(isRegisteredHookType(registry, unknown, "episodes")).toBe(false)
    // 同挂载点内无重复（traceability 守卫已断言；此处双保险）
    const types = registry.hookTypeRegistry.map((e) => `${e.mountPoint}::${e.hookType}`)
    expect(new Set(types).size).toBe(types.length)
  })

  it("总注册数 = 21（11 章末 + 10 开端）", () => {
    expect(registry.hookTypeRegistry).toHaveLength(21)
  })
})

// ============================================================================
// canon 字段枚举与 T26 契约对齐
// ============================================================================

describe("canon 字段目标与 T26 契约对齐", () => {
  /** T26 EntityCraftFields 全字段样本（字段存在性探针）。 */
  const entityProbe: Required<EntityCraftFields> = {
    wish: [],
    motive: [],
    wma_action: [],
    mckee_ghost: null,
    mckee_conscious_desire: null,
    mckee_unconscious_need: null,
    mckee_empathy_core: null,
    arc_stage: null,
    arc_fundamentals: null,
    significant_details: [],
    visible_actions: [],
    craft_meta: null,
  }
  const edgeProbe: Required<EdgeCraftFields> = {
    beat_label: null,
    beat_hit: null,
    foreshadow_planted_at: null,
    hook_type: null,
    payoff_chapter: null,
  }
  const episodeProbe: Required<EpisodeCraftFields> = {
    beat_hits: [],
    tension_curve: [],
    arc_closure: [],
    hook_type: null,
    conflict_caliber: null,
    narrative_mode: null,
    craft_meta: null,
  }

  function probeFor(table: CanonFieldTarget["table"]): Record<string, unknown> {
    if (table === "entities") return entityProbe
    if (table === "edges") return edgeProbe
    // narrative_stage 属蓝图 §3 episodes 基础列（结局三戒终局章载体），
    // 不在 T26 craft 子集 EpisodeCraftFields 内，单独白名单。
    return { ...episodeProbe, narrative_stage: null }
  }

  it("每个 canonFieldTargets 的 field 都是 T26 对应表契约键（或 §3 基础列白名单）", () => {
    const registry = compileFromCommittedSnapshot()
    for (const pack of registry.packs) {
      for (const target of pack.canonFieldTargets) {
        expect(target.field in probeFor(target.table)).toBe(true)
      }
    }
  })

  it("主角硬门四字段（wish/motive/mckee_ghost/arc_stage）均被规则包承接", () => {
    const registry = compileFromCommittedSnapshot()
    const targeted = new Set(registry.packs.flatMap((p) => p.canonFieldTargets.map((t) => `${t.table}.${t.field}`)))
    for (const field of PROTAGONIST_REQUIRED_CRAFT_FIELDS) {
      expect(targeted.has(`entities.${field}`)).toBe(true)
    }
    expect([...PROTAGONIST_REQUIRED_CRAFT_FIELDS]).toEqual(["wish", "motive", "mckee_ghost", "arc_stage"])
  })

  it("八素质槽位参数 slot_count=8 与 T26 上限一致，slot_names 为 U-04 提案 8 键", () => {
    const registry = compileFromCommittedSnapshot()
    const pack = registry.packs.find((p) => p.packId === "craft.mckee-eight-fundamentals")
    expect(pack?.params.slot_count).toBe(8)
    const names = pack?.params.slot_names as readonly string[]
    expect(names).toHaveLength(8)
    expect(new Set(names).size).toBe(8)
  })
})

// ============================================================================
// canon 技法字段真实写入：主角填充率 100% 硬门
// ============================================================================

describe("buildProtagonistCraftWrite 主角技法字段写入", () => {
  const fullProfile = {
    entityId: "entity-protagonist-001",
    wish: ["夺回被侵占的家产"],
    motive: ["父亲临终托付"],
    wmaAction: ["联合旧部搜集罪证"],
    mckeeGhost: "少年时目睹父亲蒙冤却无力阻止",
    arcStage: "commitment" as const,
    arcFundamentals: { willpower: 0.9, empathy_core: 0.8 },
    significantDetails: ["袖口磨白的旧怀表"],
  }

  it("完整画像 → 四硬门字段填充率 100%", () => {
    const write = buildProtagonistCraftWrite(fullProfile)
    const fill = measureCraftFieldFillRate(write.fields)
    expect(fill.rate).toBe(1)
    expect(fill.missing).toEqual([])
    expect(fill.filled).toEqual(["wish", "motive", "mckee_ghost", "arc_stage"])
    expect(write.fields.wish).toEqual(["夺回被侵占的家产"])
    expect(write.fields.motive).toEqual(["父亲临终托付"])
    expect(write.fields.mckee_ghost).toBe(fullProfile.mckeeGhost)
    expect(write.fields.arc_stage).toBe("commitment")
  })

  it("载荷字段级溯源到规则包与 nmem 记忆 id（A-04.6 可追溯）", () => {
    const write = buildProtagonistCraftWrite(fullProfile)
    expect(write.provenance.wish).toEqual({
      packId: "craft.wish-motive-action",
      memoryId: "20de3c24-0000-4000-8000-000000000000",
    })
    expect(write.provenance.mckee_ghost).toEqual({
      packId: "craft.mckee-ghost-wound",
      memoryId: "akers-ghost-concept-char wound",
    })
    expect(write.provenance.arc_stage?.packId).toBe("craft.mckee-eight-fundamentals")
    expect(write.provenance.significant_details?.packId).toBe("craft.significant-details")
    expect(write.provenance.wma_action?.packId).toBe("craft.wish-motive-action")
  })

  it("可选字段缺省时不写入载荷，硬门填充率仍 100%", () => {
    const write = buildProtagonistCraftWrite({
      entityId: "e2",
      wish: ["活下来"],
      motive: ["保护妹妹"],
      mckeeGhost: "洪水夜未能救回母亲",
      arcStage: "active",
    })
    expect(write.fields.wma_action).toBeUndefined()
    expect(write.fields.arc_fundamentals).toBeUndefined()
    expect(measureCraftFieldFillRate(write.fields).rate).toBe(1)
  })

  it("fail-fast 路径：空 entityId / 空 wish / 空 motive / 空白 ghost / 非法 arcStage", () => {
    const base = fullProfile
    expect(() => buildProtagonistCraftWrite({ ...base, entityId: "" })).toThrow(TypeError)
    expect(() => buildProtagonistCraftWrite({ ...base, wish: [] })).toThrow(/wish/)
    expect(() => buildProtagonistCraftWrite({ ...base, motive: [] })).toThrow(/motive/)
    expect(() => buildProtagonistCraftWrite({ ...base, mckeeGhost: "   " })).toThrow(/mckeeGhost/)
    expect(() =>
      buildProtagonistCraftWrite({ ...base, arcStage: "not_a_stage" as never }),
    ).toThrow(/arcStage/)
    expect(() => buildProtagonistCraftWrite({ ...base, wish: ["  "] })).toThrow(/wish/)
    expect(() => buildProtagonistCraftWrite({ ...base, motive: [" "] })).toThrow(/motive/)
  })

  it("fail-fast 路径：arc_fundamentals 越界值经 T26 机械校验拒绝", () => {
    expect(() => buildProtagonistCraftWrite({ ...fullProfile, arcFundamentals: { willpower: 1.5 } })).toThrow(
      /arc_fundamentals/,
    )
    expect(() =>
      buildProtagonistCraftWrite({ ...fullProfile, arcFundamentals: { a: 0.5, b: 0.5, c: 0.5, d: 0.5, e: 0.5, f: 0.5, g: 0.5, h: 0.5, i: 0.5 } }),
    ).toThrow(/超过上限/)
  })
})

describe("measureCraftFieldFillRate 填充率度量", () => {
  it("空字段集 → rate 0 且缺失清单完整", () => {
    const fill = measureCraftFieldFillRate({})
    expect(fill.rate).toBe(0)
    expect(fill.filled).toEqual([])
    expect(fill.missing).toEqual(["wish", "motive", "mckee_ghost", "arc_stage"])
  })

  it("半满画像 → rate 0.5，missing 只含未填项", () => {
    const partial: EntityCraftFields = { wish: ["x"], motive: ["y"] }
    const fill = measureCraftFieldFillRate(partial)
    expect(fill.rate).toBe(0.5)
    expect(fill.missing).toEqual(["mckee_ghost", "arc_stage"])
  })

  it("空白串/空清单判为未填；自定义必填集合生效；空必填集合 rate=1", () => {
    expect(measureCraftFieldFillRate({ wish: ["  "], motive: [], mckee_ghost: null }).filled).toEqual([])
    const custom = measureCraftFieldFillRate({ wish: ["x"] }, ["wish", "wma_action"])
    expect(custom.rate).toBe(0.5)
    expect(measureCraftFieldFillRate({}, []).rate).toBe(1)
  })
})

// ============================================================================
// 离线降级（蓝图 §8 P3：runtime 永不直连；探活失败优雅回落）
// ============================================================================

describe("compileWithFallback 离线降级路径", () => {
  it("基线：compileFromCommittedSnapshot 纯离线可编译且通过溯源守卫（CI 守卫基于提交快照）", () => {
    const registry = compileFromCommittedSnapshot()
    expect(registry.packs.length).toBeGreaterThanOrEqual(4)
    expect(validateRegistryTraceability(registry, NMEM_SNAPSHOT).ok).toBe(true)
  })

  it("探活失败（网络抛错）→ 优雅回落快照，附降级原因", async () => {
    const result = await compileWithFallback({
      fetchJson: () => Promise.reject(new Error("ECONNREFUSED")),
    })
    expect(result.source).toBe("snapshot")
    expect(result.fallbackReason).toContain("健康探活失败")
    // 功能不退化：回落产物与直接离线编译深等价
    expect(result.registry).toEqual(compileFromCommittedSnapshot())
  })

  it("探活返回非 ok（如服务降级态）→ 回落快照", async () => {
    const result = await compileWithFallback({
      fetchJson: (url) => {
        expect(url.startsWith(`${NMEM_DEFAULT_BASE_URL}/health`)).toBe(true)
        return Promise.resolve({ status: "degraded" })
      },
    })
    expect(result.source).toBe("snapshot")
    expect(validateRegistryTraceability(result.registry, NMEM_SNAPSHOT).ok).toBe(true)
  })

  it("探活 ok 但 space 抓取失败 → 回落快照并携带失败原因（fetchLiveSnapshot 内部二次探活，共 3 次调用）", async () => {
    let calls = 0
    const result = await compileWithFallback({
      fetchJson: (url) => {
        calls += 1
        if (url.endsWith("/health")) return Promise.resolve({ status: "ok", version: "0.10.67" })
        return Promise.reject(new Error("search exploded"))
      },
    })
    expect(calls).toBe(3) // probeNmemHealth 1 次 + fetchLiveSnapshot 探活 1 次 + search 1 次
    expect(result.source).toBe("snapshot")
    expect(result.fallbackReason).toContain("search exploded")
  })

  it("live 成功路径：抓取合法空间数据 → live 编译且溯源守卫通过；live/snapshot 两路 packs 功能等价面（包数+包 id 集）不退化", async () => {
    const liveSpaceMemories = NMEM_SNAPSHOT.memories.map((m) => ({
      id: m.memoryId,
      title: m.title,
      content: `live-fresh-${m.contentExcerpt}`,
      created_at: m.createdAt,
      importance: m.importance,
      unit_type: m.unitType,
      labels: [...m.labels],
    }))
    const result = await compileWithFallback({
      fetchJson: (url) => {
        if (url.endsWith("/health")) return Promise.resolve({ status: "ok", version: "9.9.9" })
        return Promise.resolve({ memories: liveSpaceMemories })
      },
    })
    expect(result.source).toBe("live")
    expect(result.registry.snapshotVersion).toBe(NMEM_SNAPSHOT_VERSION + 1)
    expect(result.fallbackReason).toBeUndefined()
    expect(result.registry.compilerVersion).toBe(TECHNIQUE_COMPILER_VERSION)
    // live 快照含同 id 记忆集 → 每包溯源仍可解析
    expect(
      validateRegistryTraceability(result.registry, {
        ...NMEM_SNAPSHOT,
        snapshotVersion: NMEM_SNAPSHOT_VERSION + 1,
      }).ok,
    ).toBe(true)
    // 功能不退化的可观测面：包数量与包 id 集合与离线路一致
    const offline = compileFromCommittedSnapshot()
    expect(result.registry.packs.length).toBe(offline.packs.length)
    expect(result.registry.packs.map((p) => p.packId)).toEqual(offline.packs.map((p) => p.packId))
  })

  it("probeNmemHealth：ok→true / 非 ok→false / 抛错→false（不向上抛）", async () => {
    expect(await probeNmemHealth({ fetchJson: () => Promise.resolve({ status: "ok" }) })).toBe(true)
    expect(await probeNmemHealth({ fetchJson: () => Promise.resolve({ status: "starting" }) })).toBe(false)
    expect(await probeNmemHealth({ fetchJson: () => Promise.resolve(null) })).toBe(false)
    expect(await probeNmemHealth({ fetchJson: () => Promise.reject(new Error("down")) })).toBe(false)
  })

  it("fetchLiveSnapshot：健康未通过时原样抛错（由 compileWithFallback 统一降级）", async () => {
    await expect(
      fetchLiveSnapshot({ fetchJson: () => Promise.resolve({ status: "reindexing" }) }),
    ).rejects.toThrow(/健康探活未通过/)
  })
})
