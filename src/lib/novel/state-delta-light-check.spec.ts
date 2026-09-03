import { describe, expect, it } from "vitest"
import type { CharacterState } from "./character-state"
import {
  extractEmbeddedStateDeltaJson,
  extractStateDeltaHeuristic,
  findCharacter,
  isCharacterDead,
  lightIssuesToReviewResults,
  parseStructuredStateDelta,
  resolveStateDeltaForDraft,
  runLightCheck,
  runStateDeltaLightCheckOnDraft,
  // 48/49 号 §六-②③ 新增符号 (50 号报告 S0 spec 补测)
  resolveStateSettlement,
  markStateDegraded,
  parseStateDeltaStrict,
  deriveHookOps,
  HOOK_OPS,
} from "./state-delta-light-check"

function char(partial: Partial<CharacterState> & { characterName: string }): CharacterState {
  return {
    currentLocation: "京城",
    status: "健康",
    equipment: [],
    abilities: [],
    relationships: {},
    lastUpdatedChapter: 1,
    lastUpdatedAt: "",
    ...partial,
  }
}

describe("runLightCheck", () => {
  it("flags dead character still active", () => {
    const prev = [char({ characterName: "阿宁", status: "已死亡", isAlive: false })]
    const issues = runLightCheck(prev, { chapter: 3, activeMentions: ["阿宁"] })
    expect(issues.some((i) => i.code === "dead_character_active")).toBe(true)
    expect(issues.find((i) => i.code === "dead_character_active")!.severity).toBe("error")
  })

  it("flags location from mismatch", () => {
    const prev = [char({ characterName: "李四", currentLocation: "码头" })]
    const issues = runLightCheck(prev, {
      chapter: 2,
      locationChanges: [{ entity: "李四", from: "皇宫", to: "客栈" }],
    })
    expect(issues.some((i) => i.code === "location_from_mismatch")).toBe(true)
  })

  it("flags inventory lose missing", () => {
    const prev = [char({ characterName: "王五", equipment: ["长剑"] })]
    const issues = runLightCheck(prev, {
      chapter: 2,
      inventoryChanges: [{ entity: "王五", item: "玉佩", op: "lose" }],
    })
    expect(issues.some((i) => i.code === "inventory_lose_missing")).toBe(true)
  })

  it("ok when live character mentioned", () => {
    const prev = [char({ characterName: "阿宁", status: "健康" })]
    const issues = runLightCheck(prev, { chapter: 2, activeMentions: ["阿宁"] })
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0)
  })

  it("dedupes identical issues (same code|entity|message)", () => {
    const prev = [char({ characterName: "阿宁", status: "已死亡", isAlive: false })]
    const issues = runLightCheck(prev, { chapter: 3, activeMentions: ["阿宁", "阿宁", "阿宁"] })
    expect(issues.filter((i) => i.code === "dead_character_active")).toHaveLength(1)
    expect(issues).toHaveLength(1)
  })
})

describe("extractStateDeltaHeuristic", () => {
  it("collects active mentions and weak location", () => {
    const prev = [char({ characterName: "阿宁", currentLocation: "京城" })]
    const draft = "阿宁在客栈门口停下，看了看天色。"
    const delta = extractStateDeltaHeuristic(draft, prev, 4)
    expect(delta.activeMentions).toContain("阿宁")
    expect(delta.locationChanges?.some((c) => c.to.includes("客栈") || c.to === "客栈")).toBe(true)
  })
})

describe("lightIssuesToReviewResults", () => {
  it("demotes error to warning when blocksTrackA false", () => {
    const issues = runLightCheck(
      [char({ characterName: "阿宁", isAlive: false, status: "死" })],
      { chapter: 1, activeMentions: ["阿宁"] },
    )
    const results = lightIssuesToReviewResults(issues, { blocksTrackA: false, chapter: 1 })
    expect(results.every((r) => r.severity !== "error")).toBe(true)
    expect(results[0]!.type).toBe("state_delta_light_check")
  })

  it("keeps error when blocksTrackA true", () => {
    const issues = runLightCheck(
      [char({ characterName: "阿宁", isAlive: false, status: "死" })],
      { chapter: 1, activeMentions: ["阿宁"] },
    )
    const results = lightIssuesToReviewResults(issues, { blocksTrackA: true, chapter: 1 })
    expect(results.some((r) => r.severity === "error")).toBe(true)
  })
})

describe("findCharacter / isCharacterDead", () => {
  it("returns undefined for blank names and resolves exact then fuzzy matches", () => {
    const prev = [
      char({ characterName: "阿宁" }),
      char({ characterName: "白砚·墨" }),
    ]
    expect(findCharacter(prev, "   ")).toBeUndefined()
    expect(findCharacter(prev, "阿宁")?.characterName).toBe("阿宁")
    // fuzzy: 子串双向匹配
    expect(findCharacter(prev, "白砚")?.characterName).toBe("白砚·墨")
    expect(findCharacter(prev, "墨")?.characterName).toBe("白砚·墨")
  })

  it("isCharacterDead: isAlive false, deathChapter, and death status words", () => {
    expect(isCharacterDead(char({ characterName: "a", isAlive: false }))).toBe(true)
    expect(isCharacterDead(char({ characterName: "b", deathChapter: 3 }))).toBe(true)
    expect(isCharacterDead(char({ characterName: "c", status: "阵亡" }))).toBe(true)
    expect(isCharacterDead(char({ characterName: "d", isAlive: true, status: "健康" }))).toBe(false)
  })
})

describe("runLightCheck edge cases", () => {
  it("flags unknown entities in location and inventory changes", () => {
    const issues = runLightCheck([], {
      chapter: 1,
      locationChanges: [{ entity: "路人甲", to: "客栈" }],
      inventoryChanges: [{ entity: "路人乙", item: "剑", op: "gain" }],
    })
    expect(issues.some((i) => i.code === "unknown_entity_location" && i.severity === "info")).toBe(true)
    expect(issues.some((i) => i.code === "unknown_entity_inventory" && i.severity === "info")).toBe(true)
  })

  it("flags dead character location change with status evidence", () => {
    const prev = [char({ characterName: "阿宁", isAlive: false, status: "已死亡", deathChapter: 2 })]
    const issues = runLightCheck(prev, {
      chapter: 3,
      locationChanges: [{ entity: "阿宁", to: "墓园" }],
    })
    const issue = issues.find((i) => i.code === "dead_character_location")!
    expect(issue.severity).toBe("error")
    expect(issue.evidence).toBe("已死亡")
  })

  it("no from-mismatch when from matches the store location", () => {
    const prev = [char({ characterName: "李四", currentLocation: "码头" })]
    const issues = runLightCheck(prev, {
      chapter: 2,
      locationChanges: [{ entity: "李四", from: "码头", to: "客栈" }],
    })
    expect(issues.some((i) => i.code === "location_from_mismatch")).toBe(false)
  })

  it("flags revive attempts without death marker and allows death-consistent status", () => {
    const prev = [char({ characterName: "阿宁", isAlive: false, status: "已死亡" })]
    const revive = runLightCheck(prev, { chapter: 3, statusChanges: [{ entity: "阿宁", status: "重伤" }] })
    expect(revive.some((i) => i.code === "dead_character_status_revive")).toBe(true)
    // 状态含死亡标记时不再告警（DEAD_STATUS_RE 含 死/亡 等）
    const keepDead = runLightCheck(prev, { chapter: 3, statusChanges: [{ entity: "阿宁", status: "已死亡（灵堂安放）" }] })
    expect(keepDead.some((i) => i.code === "dead_character_status_revive")).toBe(false)
    // 存活角色状态变更不报警
    const live = runLightCheck([char({ characterName: "阿宁" })], { chapter: 3, statusChanges: [{ entity: "阿宁", status: "重伤" }] })
    expect(live).toHaveLength(0)
  })

  it("inventory lose is a no-op when the item or a partial match is held", () => {
    const prev = [char({ characterName: "王五", equipment: ["长剑", "玉佩"] })]
    const issues = runLightCheck(prev, {
      chapter: 2,
      inventoryChanges: [
        { entity: "王五", item: "玉佩", op: "lose" },
        { entity: "王五", item: "剑", op: "lose" },
        { entity: "王五", item: "玉佩", op: "gain" },
      ],
    })
    expect(issues.some((i) => i.code === "inventory_lose_missing")).toBe(false)
  })

  it("unknown active mention is ignored and duplicate issues are deduped", () => {
    const prev = [char({ characterName: "阿宁", isAlive: false, status: "死" })]
    const issues = runLightCheck(prev, {
      chapter: 2,
      activeMentions: ["阿宁", "阿宁", "幽灵"],
      locationChanges: [
        { entity: "阿宁", to: "墓园" },
        { entity: "阿宁", to: "墓园" },
      ],
    })
    const deadActive = issues.filter((i) => i.code === "dead_character_active")
    expect(deadActive).toHaveLength(1)
    expect(issues.filter((i) => i.code === "dead_character_location")).toHaveLength(1)
  })

  it("ignores status changes for unknown entities", () => {
    const issues = runLightCheck([], { chapter: 1, statusChanges: [{ entity: "路人甲", status: "重伤" }] })
    expect(issues).toHaveLength(0)
  })

  it("treats a character with no status field as alive (status ?? \"\" fallback)", () => {
    const prev = [char({ characterName: "阿宁", status: undefined as unknown as string, isAlive: true })]
    expect(isCharacterDead(prev[0]!)).toBe(false)
    const issues = runLightCheck(prev, { chapter: 1, locationChanges: [{ entity: "阿宁", to: "客栈" }] })
    expect(issues.filter((i) => i.code === "dead_character_location")).toHaveLength(0)
  })

  it("reports empty equipment list as （空） evidence on lose", () => {
    const prev = [char({ characterName: "王五", equipment: undefined as never })]
    const issues = runLightCheck(prev, {
      chapter: 2,
      inventoryChanges: [{ entity: "王五", item: "玉佩", op: "lose" }],
    })
    const issue = issues.find((i) => i.code === "inventory_lose_missing")!
    expect(issue.evidence).toBe("（空）")
  })

  it("uses deathChapter as evidence when the dead character has an empty status", () => {
    const prev = [char({ characterName: "阿宁", status: "", isAlive: false, deathChapter: 3 })]
    const issues = runLightCheck(prev, { chapter: 4, activeMentions: ["阿宁"] })
    const issue = issues.find((i) => i.code === "dead_character_active")!
    expect(issue.evidence).toBe("deathChapter=3")
  })
})

describe("extractStateDeltaHeuristic edge cases", () => {
  it("skips short names, absent names and short/absent equipment", () => {
    const prev = [
      char({ characterName: "宁", equipment: [] }),
      char({ characterName: "未出场", equipment: ["短", "长弓"] }),
    ]
    const delta = extractStateDeltaHeuristic("正文不含这些名字", prev, 5)
    expect(delta.activeMentions ?? []).toHaveLength(0)
    expect(delta.locationChanges ?? []).toHaveLength(0)
    expect(delta.inventoryChanges ?? []).toHaveLength(0)
  })

  it("records inventory loss only when lose wording appears", () => {
    const prev = [char({ characterName: "王五", equipment: ["长弓"] })]
    const noLose = extractStateDeltaHeuristic("王五带着长弓出门。", prev, 5)
    expect(noLose.inventoryChanges ?? []).toHaveLength(0)
    const lose = extractStateDeltaHeuristic("王五交出了长弓。", prev, 5)
    expect(lose.inventoryChanges).toEqual([{ entity: "王五", item: "长弓", op: "lose" }])
  })

  it("does not record a location change when the place matches the store location", () => {
    const prev = [char({ characterName: "阿宁", currentLocation: "京城" })]
    const delta = extractStateDeltaHeuristic("阿宁在京城的天桥上。", prev, 5)
    expect(delta.locationChanges ?? []).toHaveLength(0)
  })

  it("tolerates a null draft via ?? \"\" fallback", () => {
    const delta = extractStateDeltaHeuristic(undefined as unknown as string, [], 5)
    expect(delta.activeMentions).toEqual([])
    expect(delta.inventoryChanges).toBeUndefined()
  })

  it("skips characters without equipment and short/absent equipment items", () => {
    const prev = [
      char({ characterName: "白砚", equipment: undefined as never }),
      char({ characterName: "王五", equipment: ["长弓", "短", "未装备之物"] }),
    ]
    const delta = extractStateDeltaHeuristic("白砚与王五在城中，王五交出了长弓。", prev, 5)
    // 白砚无 equipment → ?? [] 空循环; 王五: "短" 长度<2 跳过, "未装备之物" 不在正文跳过
    expect(delta.inventoryChanges).toEqual([{ entity: "王五", item: "长弓", op: "lose" }])
  })
})

describe("lightIssuesToReviewResults severities and metadata", () => {
  it("keeps info/warning severities and handles missing entities", () => {
    const issues = [
      { code: "x1", severity: "info" as const, message: "信息" },
      { code: "x2", severity: "warn" as const, message: "警告" },
      { code: "x3", severity: "error" as const, message: "错误", entity: "阿宁", evidence: "e" },
    ]
    const results = lightIssuesToReviewResults(issues, { blocksTrackA: true, chapter: 7 })
    expect(results.map(r => r.severity)).toEqual(["info", "warning", "error"])
    expect(results[0].relatedMemory).toBe("character-states")
    expect(results[2].relatedMemory).toBe("character:阿宁")
    expect(results[2].continuityMeta).toEqual({ subtype: "x3", ref: "state-delta:x3:阿宁", chapter: 7 })
    expect(results[2].suggestion).toContain("核对")

    const demoted = lightIssuesToReviewResults(issues, {})
    expect(demoted[2].severity).toBe("warning")
    expect(demoted[2].suggestion).toContain("warn-only")
  })
})

describe("extractEmbeddedStateDeltaJson / parseStructuredStateDelta", () => {
  it("extracts only deltas from labeled or keyed json fences", () => {
    expect(extractEmbeddedStateDeltaJson("  ")).toBeNull()
    const keyed = extractEmbeddedStateDeltaJson('```json\n{"activeMentions":["李四"]}\n```')
    expect(keyed).toContain("李四")
    expect(extractEmbeddedStateDeltaJson('```json\n{"foo":1}\n```')).toBeNull()
  })

  it("parses all structured sections, fences and op values", () => {
    const raw = JSON.stringify({
      chapter: 9,
      rawNotes: "model",
      locationChanges: [{ entity: "a", from: "x", to: "y" }, { entity: "b" }],
      statusChanges: [{ entity: "c", status: "重伤" }, { entity: "d" }],
      inventoryChanges: [{ entity: "e", item: "剑", op: "gain" }, { entity: "f", item: "盾" }],
      relationshipChanges: [{ a: "g", b: "h", note: "敌对" }, { a: "i" }],
      activeMentions: ["j", "", null],
    })
    const delta = parseStructuredStateDelta(`前后\n\`\`\`json\n${raw}\n\`\`\``, 3)!
    expect(delta.chapter).toBe(9)
    expect(delta.rawNotes).toBe("model")
    expect(delta.locationChanges).toEqual([{ entity: "a", from: "x", to: "y" }])
    expect(delta.statusChanges).toEqual([{ entity: "c", status: "重伤" }])
    expect(delta.inventoryChanges).toEqual([{ entity: "e", item: "剑", op: "gain" }, { entity: "f", item: "盾", op: "lose" }])
    expect(delta.relationshipChanges).toEqual([{ entity: undefined as never, a: "g", b: "h", note: "敌对" }])
    expect(delta.activeMentions).toEqual(["j", "null"])
  })

  it("returns null for empty, invalid, array, or empty-body inputs", () => {
    expect(parseStructuredStateDelta("  ", 1)).toBeNull()
    expect(parseStructuredStateDelta("not-json", 1)).toBeNull()
    expect(parseStructuredStateDelta("[1,2]", 1)).toBeNull()
    expect(parseStructuredStateDelta(JSON.stringify({ chapter: 1, rawNotes: "x" }), 1)).toBeNull()
  })

  it("skips empty json fence bodies when scanning keyed fences", () => {
    expect(extractEmbeddedStateDeltaJson("```json\n\n```")).toBeNull()
    expect(extractEmbeddedStateDeltaJson("```json\n   \n```")).toBeNull()
  })

  it("normalizes structured items missing entity/status/item/a fields and filters them out", () => {
    const raw = JSON.stringify({
      locationChanges: [{ entity: "a", from: "x", to: "y" }, { to: "no-entity" }],
      statusChanges: [{ entity: "c", status: "重伤" }, { status: "orphan" }],
      inventoryChanges: [{ entity: "e", item: "剑", op: "gain" }, { item: "无主物" }, { entity: "无物品" }],
      relationshipChanges: [{ a: "g", b: "h", note: "敌对" }, { b: "only-b" }],
    })
    const delta = parseStructuredStateDelta(raw, 3)!
    expect(delta.locationChanges).toEqual([{ entity: "a", from: "x", to: "y" }])
    expect(delta.statusChanges).toEqual([{ entity: "c", status: "重伤" }])
    expect(delta.inventoryChanges).toEqual([{ entity: "e", item: "剑", op: "gain" }])
    expect(delta.relationshipChanges).toEqual([{ entity: undefined as never, a: "g", b: "h", note: "敌对" }])
  })

  it("resolveStateDeltaForDraft returns empty source for blank drafts", () => {
    const { source } = resolveStateDeltaForDraft("  ", [], 2)
    expect(source).toBe("empty")
  })

  it("resolveStateDeltaForDraft falls back to heuristic when no structured raw is given", () => {
    const prev = [char({ characterName: "阿宁", currentLocation: "京城" })]
    const { source, delta } = resolveStateDeltaForDraft("阿宁在客栈门口停下。", prev, 2)
    expect(source).toBe("heuristic")
    expect(delta.rawNotes).toBe("heuristic")
  })
})

describe("runStateDeltaLightCheckOnDraft", () => {
  it("skips empty draft with info", () => {
    const { issues } = runStateDeltaLightCheckOnDraft("", [], 2)
    expect(issues[0]!.code).toBe("extract_skipped_empty_draft")
  })

  it("prefers structured JSON over heuristic when valid", () => {
    const prev = [char({ characterName: "阿宁", status: "已死亡", isAlive: false })]
    const draft = "阿宁走在街上。```json\n{\"activeMentions\":[\"阿宁\"]}\n```"
    const { source, issues } = runStateDeltaLightCheckOnDraft(draft, prev, 3, {
      structuredRaw: JSON.stringify({ activeMentions: ["阿宁"] }),
    })
    expect(source).toBe("structured")
    expect(issues.some((i) => i.code === "dead_character_active")).toBe(true)
  })

  it("falls back to heuristic when structured invalid", () => {
    const prev = [char({ characterName: "阿宁", currentLocation: "京城" })]
    const draft = "阿宁在客栈门口停下。"
    const { source } = runStateDeltaLightCheckOnDraft(draft, prev, 2, {
      structuredRaw: "not-json",
    })
    expect(source).toBe("heuristic")
  })

  it("extractEmbeddedStateDeltaJson finds labeled fence", async () => {
    const { extractEmbeddedStateDeltaJson } = await import("./state-delta-light-check")
    const draft = '前言\n```state-delta\n{"activeMentions":["李四"]}\n```\n后文'
    expect(extractEmbeddedStateDeltaJson(draft)).toContain("李四")
  })
})

// ============================================================================
// 48/49 号 §六-② REPAIR 三态结算 + §六-③ StateDelta Zod 强校验（50 号 S0 spec 锁定）
// ============================================================================

describe("resolveStateSettlement（§六-② 三态 PASS/REPAIR/FAIL）", () => {
  it("empty source → PASS（无 delta 可结算不阻断）", () => {
    const r = resolveStateSettlement({ chapter: 1, rawNotes: "empty" }, [], "empty")
    expect(r.outcome).toBe("PASS")
    expect(r.degraded).toBe(false)
  })

  it("error 级 issue → FAIL（矛盾阻断）", () => {
    const issues = [{
      code: "dead_character_active",
      severity: "error" as const,
      message: "已故角色仍活跃",
    }]
    const r = resolveStateSettlement({ chapter: 3, activeMentions: ["阿宁"] }, issues, "structured")
    expect(r.outcome).toBe("FAIL")
    expect(r.reason).toContain("阻断")
  })

  it("warn 级 issue → REPAIR（可重结算不重写正文）", () => {
    const issues = [{
      code: "location_from_mismatch",
      severity: "warn" as const,
      message: "位置不匹配",
    }]
    const r = resolveStateSettlement({ chapter: 2, locationChanges: [] }, issues, "structured")
    expect(r.outcome).toBe("REPAIR")
    expect(r.reason).toContain("重结算")
  })

  it("heuristic source → REPAIR（structured 缺失需重结算确认）", () => {
    const r = resolveStateSettlement({ chapter: 2, rawNotes: "h" }, [], "heuristic")
    expect(r.outcome).toBe("REPAIR")
    expect(r.reason).toContain("启发式")
  })

  it("全清 + structured → PASS", () => {
    const r = resolveStateSettlement({ chapter: 2 }, [], "structured")
    expect(r.outcome).toBe("PASS")
  })
})

describe("markStateDegraded（§六-② state-degraded VISIBLE 不静默）", () => {
  it("REPAIR 重结算后仍失败 → degraded=true 且 reason 追加", () => {
    const base = resolveStateSettlement({ chapter: 2 }, [], "heuristic")
    expect(base.outcome).toBe("REPAIR")
    const degraded = markStateDegraded(base)
    expect(degraded.degraded).toBe(true)
    expect(degraded.reason).toContain("degraded")
  })

  it("PASS/FAIL 不受影响（幂等保底）", () => {
    const pass = markStateDegraded(resolveStateSettlement({ chapter: 1 }, [], "empty"))
    expect(pass.degraded).toBe(false)
    const fail = markStateDegraded(resolveStateSettlement(
      { chapter: 1 },
      [{ code: "x", severity: "error" as const, message: "m" }],
      "structured",
    ))
    expect(fail.degraded).toBe(false)
  })
})

describe("parseStateDeltaStrict（§六-③ Zod 强校验）", () => {
  it("合法 delta → 返回同构 StateDelta（与 lenient 解析字节一致）", () => {
    const raw = JSON.stringify({
      chapter: 3,
      activeMentions: ["阿宁"],
      locationChanges: [{ entity: "李四", from: "皇宫", to: "客栈" }],
    })
    const strict = parseStateDeltaStrict(raw, 3)
    expect(strict?.chapter).toBe(3)
    expect(strict?.activeMentions).toEqual(["阿宁"])
  })

  it("空/缺 → null（无 delta 合法）", () => {
    expect(parseStateDeltaStrict("", 3)).toBeNull()
    expect(parseStateDeltaStrict(undefined as unknown as string, 3)).toBeNull()
  })

  it("非法 JSON → 显式抛错（非静默回退）", () => {
    expect(() => parseStateDeltaStrict("not-json{[", 3)).toThrow(/JSON 解析失败/)
  })

  it("根为数组 → 抛错", () => {
    expect(() => parseStateDeltaStrict("[1,2,3]", 3)).toThrow(/根须为对象/)
  })

  it("未知 op 值 → schema 拒收抛错（含字段路径）", () => {
    const raw = JSON.stringify({
      chapter: 3,
      inventoryChanges: [{ entity: "阿宁", item: "剑", op: "steal" }],
    })
    expect(() => parseStateDeltaStrict(raw, 3)).toThrow(/inventoryChanges/)
  })

  it("类型错（entity 非字符串）→ 抛错含字段路径", () => {
    const raw = JSON.stringify({
      chapter: 3,
      locationChanges: [{ entity: 42, to: "客栈" }],
    })
    expect(() => parseStateDeltaStrict(raw, 3)).toThrow(/locationChanges/)
  })
})

describe("deriveHookOps（§六-③ hookOps 四操作语义）", () => {
  it("四操作齐全：relocate/update/add/remove", () => {
    const ops = deriveHookOps({
      chapter: 3,
      locationChanges: [{ entity: "李四", from: "皇宫", to: "客栈" }],
      statusChanges: [{ entity: "阿宁", status: "受伤" }],
      inventoryChanges: [
        { entity: "阿宁", item: "青霜剑", op: "gain" },
        { entity: "李四", item: "旧信", op: "lose" },
      ],
      relationshipChanges: [{ a: "阿宁", b: "李四", note: "结盟" }],
    })
    expect(ops).toContainEqual({ op: "relocate", entity: "李四", detail: "皇宫→客栈" })
    expect(ops).toContainEqual({ op: "update", entity: "阿宁", detail: "受伤" })
    expect(ops).toContainEqual({ op: "add", entity: "阿宁", detail: "gain 青霜剑" })
    expect(ops).toContainEqual({ op: "remove", entity: "李四", detail: "lose 旧信" })
    // relationship → add
    expect(ops).toContainEqual({ op: "add", entity: "阿宁/李四", detail: "结盟" })
  })

  it("HOOK_OPS 常量恰为四操作且顺序稳定", () => {
    expect(HOOK_OPS).toEqual(["add", "remove", "update", "relocate"])
  })
})
