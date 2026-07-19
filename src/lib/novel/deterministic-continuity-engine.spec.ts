/**
 * deterministic-continuity-engine.spec.ts — 确定性连续性引擎测试
 *
 * 覆盖 blueprint BLP-continuity-engine-2026-07-18:
 *   - EPIC-001 (TASK-001/002): 引擎纯函数零 IO 零 LLM + 5 检测三态测试 +
 *     ReadonlyStore 不可变 + 装配薄包装 (formatContinuityFindingsForPrompt /
 *     toConsistencyReviewResult)
 *   - EPIC-004 (TASK-004): DEFAULT_CONTINUITY_CONFIG 缺省值 + max 保底公式 +
 *     缺字段回退 (backward compat additive-only)
 *   - EPIC-003 (TASK-007): override reasonCode 6 值 + 跨检测持久自动降级
 *   - EPIC-004 (TASK-008): UAT 假阳性风暴测试 (200 伏笔 + 30 角色 + 50 线程 + 100 章)
 *
 * ADR-30: 3 级 severity (critical/warning/info) — blueprint 权威, 非 4 级。
 * 守 ADR-29: 引擎模块零 IO 零 LLM (grep 验证无 loadXxx/readFile/streamChat/invoke)。
 */

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Foreshadowing } from "./foreshadowing-tracker"
import type { Subplot } from "./subplot-board"
import type { CharacterState } from "./character-state"
import type { ChapterSnapshot } from "./chapter-ingest"
import {
  checkContinuity,
  runContinuityEngine,
  deriveSubplotLastSeenChapter,
  summarizeContinuityFindings,
  formatContinuityFindingsForPrompt,
  toConsistencyReviewResult,
  isFindingDismissed,
  applyOverrides,
  resolveDormantThreshold,
  resolveUnresolvedForeshadowingThreshold,
  DEFAULT_CONTINUITY_CONFIG,
  type ContinuityFinding,
  type ContinuityInput,
  type ReadonlyStore,
  type ContinuityOverride,
  type ContinuityOverrideReasonCode,
} from "./deterministic-continuity-engine"

const NOVEL_DIR = resolve(__dirname)

function readSource(rel: string): string {
  return readFileSync(resolve(NOVEL_DIR, rel), "utf-8")
}

// ============================================================================
// Fixture 构造 helper
// ============================================================================

function makeForeshadowing(over: Partial<Foreshadowing> = {}): Foreshadowing {
  return {
    id: "F-001",
    name: "伏笔",
    description: "测试伏笔",
    status: "planted",
    plantedChapter: 1,
    advancedChapters: [],
    resolvedChapter: undefined,
    relatedCharacters: [],
    relatedEvents: [],
    notes: "",
    ...over,
  }
}

function makeSubplot(over: Partial<Subplot> = {}): Subplot {
  return {
    id: "S-001",
    title: "复仇线",
    status: "active",
    startChapter: 1,
    resolvedChapter: undefined,
    relatedCharacters: [],
    summary: "",
    progress: [],
    notes: "",
    ...over,
  }
}

function makeCharacter(over: Partial<CharacterState> = {}): CharacterState {
  return {
    characterName: "主角",
    currentLocation: "城",
    status: "存活",
    equipment: [],
    abilities: [],
    relationships: {},
    lastUpdatedChapter: 1,
    lastUpdatedAt: "",
    ...over,
  }
}

function makeSnapshot(over: Partial<ChapterSnapshot> = {}): ChapterSnapshot {
  return {
    chapterId: "ch-1",
    chapterNumber: 1,
    summary: "",
    characters: [],
    locations: [],
    organizations: [],
    items: [],
    events: [],
    characterStateChanges: [],
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    newCanonFacts: [],
    timelineEvents: [],
    conflicts: [],
    endingHook: "",
    graphNodes: [],
    graphEdges: [],
    ...over,
  }
}

function buildStore(
  over: Partial<ReadonlyStore> = {},
): ReadonlyStore {
  return {
    foreshadowing: [],
    subplots: [],
    characters: [],
    snapshots: [],
    currentChapter: 10,
    ...over,
  }
}

function buildInput(over: Partial<ContinuityInput> = {}): ContinuityInput {
  return {
    foreshadowing: [],
    subplots: [],
    characters: [],
    snapshots: [],
    currentChapter: 10,
    ...over,
  }
}

// ============================================================================
// ADR-29 纯函数零 IO 零 LLM 硬验证
// ============================================================================

describe("ADR-29 引擎纯函数零 IO 零 LLM", () => {
  it("引擎模块不导入任何 store loader / fs / invoke / streamChat", () => {
    const src = readSource("deterministic-continuity-engine.ts")
    expect(src).not.toMatch(/from\s+["']@\/commands\/fs["']/)
    expect(src).not.toMatch(/from\s+["']@\/lib\/llm-client["']/)
    expect(src).not.toMatch(/await\s+streamChat\b/)
    expect(src).not.toMatch(/\bawait\s+invoke\b/)
    // 不直接导入 store loader (loadSubplotBoard/loadCharacterStates/loadForeshadowingTracker)
    expect(src).not.toMatch(/import\s+\{[^}]*loadSubplotBoard/)
    expect(src).not.toMatch(/import\s+\{[^}]*loadCharacterStates/)
    expect(src).not.toMatch(/import\s+\{[^}]*loadForeshadowingTracker/)
    // createAtomicJsonStore 不在引擎模块 import (落 sibling continuity-overrides-store.ts)
    // 注释提及不算 — 只检查实际 import 语句
    expect(src).not.toMatch(/^import\s+\{[^}]*createAtomicJsonStore/m)
  })

  it("checkContinuity 是纯函数无 await (同步签名)", () => {
    const src = readSource("deterministic-continuity-engine.ts")
    // checkContinuity 函数体不应含 await
    const fnStart = src.indexOf("export function checkContinuity")
    const fnEnd = src.indexOf("\n}", fnStart)
    const fnBody = src.slice(fnStart, fnEnd)
    expect(fnBody).not.toMatch(/\bawait\b/)
  })
})

// ============================================================================
// EPIC-001 TASK-001: 5 检测三态测试 (true-positive / true-negative / false-positive)
// ============================================================================

describe("EPIC-001 5 项检测三态 (ADR-30 subtype consistency_mechanical)", () => {
  // --- detectDormantThread ---
  describe("detectDormantThread (subplot 休眠)", () => {
    it("true-positive: subplot 休眠超阈值产 dormant_thread warning", () => {
      const store = buildStore({
        subplots: [makeSubplot({ id: "S1", title: "复仇线", lastSeenChapter: 1, status: "active" })],
        currentChapter: 10,
      })
      const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
      const dormant = findings.find((f) => f.type === "dormant_thread")
      expect(dormant).toBeDefined()
      expect(dormant?.subtype).toBe("consistency_mechanical")
      expect(dormant?.severity).toBe("warning")
      expect(dormant?.ref).toBe("subplot:S1")
    })

    it("true-negative: subplot 近期出现不产 dormant_thread", () => {
      const store = buildStore({
        subplots: [makeSubplot({ id: "S1", title: "复仇线", lastSeenChapter: 8, status: "active" })],
        currentChapter: 10,
      })
      const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
      expect(findings.find((f) => f.type === "dormant_thread")).toBeUndefined()
    })

    it("false-positive guard: resolved subplot 不检测休眠", () => {
      const store = buildStore({
        subplots: [makeSubplot({ id: "S1", title: "复仇线", lastSeenChapter: 1, status: "resolved" })],
        currentChapter: 10,
      })
      const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
      expect(findings.find((f) => f.type === "dormant_thread")).toBeUndefined()
    })

    it("缺 lastSeenChapter 且 fold 无匹配产 data_gap (守 IC-02 不静默)", () => {
      const store = buildStore({
        subplots: [makeSubplot({ id: "S1", title: "复仇线", status: "active" })],
        snapshots: [],
        currentChapter: 10,
      })
      const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
      const gap = findings.find((f) => f.type === "data_gap" && f.ref === "subplot:S1")
      expect(gap).toBeDefined()
      expect(gap?.subtype).toBe("data_gap")
      expect(gap?.severity).toBe("info")
      expect((gap as any)?.missingField).toBe("lastSeenChapter")
    })
  })

  // --- detectAbsentCharacter ---
  describe("detectAbsentCharacter (角色缺席, protagonist-only)", () => {
    it("true-positive: 主角缺席超阈值产 absent_character warning", () => {
      const store = buildStore({
        characters: [makeCharacter({ characterName: "主角", lastUpdatedChapter: 1 })],
        currentChapter: 10,
      })
      const config = { ...DEFAULT_CONTINUITY_CONFIG, protagonistNames: ["主角"] }
      const findings = checkContinuity(store, config)
      const absent = findings.find((f) => f.type === "absent_character")
      expect(absent).toBeDefined()
      expect(absent?.severity).toBe("warning")
    })

    it("配角缺席降级 info (absent_character protagonist-only ADR-31)", () => {
      const store = buildStore({
        characters: [makeCharacter({ characterName: "配角", lastUpdatedChapter: 1 })],
        currentChapter: 10,
      })
      const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
      const absent = findings.find((f) => f.type === "absent_character")
      expect(absent).toBeDefined()
      expect(absent?.severity).toBe("info")
    })

    it("true-negative: 角色近期出场不产 absent_character", () => {
      const store = buildStore({
        characters: [makeCharacter({ characterName: "主角", lastUpdatedChapter: 9 })],
        currentChapter: 10,
      })
      const config = { ...DEFAULT_CONTINUITY_CONFIG, protagonistNames: ["主角"] }
      const findings = checkContinuity(store, config)
      expect(findings.find((f) => f.type === "absent_character")).toBeUndefined()
    })
  })

  // --- detectOverdueThread (复用 analyzeForeshadowingDebt) ---
  describe("detectOverdueThread (复用 analyzeForeshadowingDebt)", () => {
    it("true-positive: 伏笔逾期未回收产 overdue_thread critical", () => {
      const store = buildStore({
        foreshadowing: [makeForeshadowing({ id: "F1", name: "伏笔", status: "planted", plantedChapter: 1 })],
        currentChapter: 50,
      })
      const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
      const overdue = findings.find((f) => f.type === "overdue_thread")
      expect(overdue).toBeDefined()
      expect(overdue?.severity).toBe("critical")
      expect(overdue?.ref).toBe("foreshadowing:F1")
    })

    it("true-negative: 已回收伏笔不产 overdue_thread", () => {
      const store = buildStore({
        foreshadowing: [makeForeshadowing({ id: "F1", status: "resolved", plantedChapter: 1, resolvedChapter: 5 })],
        currentChapter: 50,
      })
      const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
      expect(findings.find((f) => f.type === "overdue_thread")).toBeUndefined()
    })
  })

  // --- detectDeadCharacterState ---
  describe("detectDeadCharacterState (死亡角色活跃态)", () => {
    it("true-positive: 死亡角色近期仍更新产 dead_character_state critical", () => {
      const store = buildStore({
        characters: [makeCharacter({ characterName: "死者", status: "已死亡", lastUpdatedChapter: 8 })],
        currentChapter: 10,
      })
      const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
      const dead = findings.find((f) => f.type === "dead_character_state")
      expect(dead).toBeDefined()
      expect(dead?.severity).toBe("critical")
      expect(dead?.ref).toBe("character:死者")
    })

    it("true-negative: 存活角色不报 dead_character_state", () => {
      const store = buildStore({
        characters: [makeCharacter({ characterName: "主角", status: "存活", lastUpdatedChapter: 8 })],
        currentChapter: 10,
      })
      const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
      expect(findings.find((f) => f.type === "dead_character_state")).toBeUndefined()
    })

    it("false-positive guard: 死亡但长期未更新 (非活跃态) 不报", () => {
      const store = buildStore({
        characters: [makeCharacter({ characterName: "死者", status: "已死亡", lastUpdatedChapter: 1 })],
        currentChapter: 50,
      })
      const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
      expect(findings.find((f) => f.type === "dead_character_state")).toBeUndefined()
    })
  })
})

// ============================================================================
// EPIC-001 TASK-002: 装配薄包装 (formatContinuityFindingsForPrompt / toConsistencyReviewResult)
// ============================================================================

describe("EPIC-001 ADR-32 双层薄包装 (产不同 result type)", () => {
  it("formatContinuityFindingsForPrompt: 生成层文本化注入 (非阻断)", () => {
    const findings: ContinuityFinding[] = [
      {
        type: "dormant_thread", subtype: "consistency_mechanical", severity: "warning",
        ref: "subplot:S1", message: "休眠 5 章", chapter: 10,
      },
      {
        type: "dead_character_state", subtype: "consistency_mechanical", severity: "critical",
        ref: "character:死者", message: "死亡活跃态", chapter: 10,
      },
    ]
    const text = formatContinuityFindingsForPrompt(findings)
    expect(text).toContain("[连续性预检提醒]")
    expect(text).toContain("subplot:S1")
    expect(text).toContain("character:死者")
  })

  it("formatContinuityFindingsForPrompt: 空 findings 返回空串 (不污染 prompt)", () => {
    expect(formatContinuityFindingsForPrompt([])).toBe("")
  })

  it("formatContinuityFindingsForPrompt: data_gap 不注入生成层 (守 context 预算)", () => {
    const findings: ContinuityFinding[] = [
      {
        type: "data_gap", subtype: "data_gap", severity: "info",
        ref: "subplot:S1", message: "缺字段", chapter: 10, missingField: "lastSeenChapter",
      },
    ]
    expect(formatContinuityFindingsForPrompt(findings)).toBe("")
  })

  it("toConsistencyReviewResult: 审查层包装 NovelReviewResult type=consistency_mechanical", () => {
    const findings: ContinuityFinding[] = [
      {
        type: "dead_character_state", subtype: "consistency_mechanical", severity: "critical",
        ref: "character:死者", message: "死亡活跃态", chapter: 10,
      },
      {
        type: "dormant_thread", subtype: "consistency_mechanical", severity: "warning",
        ref: "subplot:S1", message: "休眠 5 章", chapter: 10,
      },
    ]
    const results = toConsistencyReviewResult(findings)
    expect(results).toHaveLength(2)
    expect(results[0].type).toBe("consistency_mechanical")
    expect(results[0].severity).toBe("error") // critical → error
    expect(results[1].severity).toBe("warning") // warning → warning
  })

  it("两薄包装产不同 result type 守 MAINT-1 (文本 vs 对象)", () => {
    const findings: ContinuityFinding[] = [
      {
        type: "dormant_thread", subtype: "consistency_mechanical", severity: "warning",
        ref: "subplot:S1", message: "休眠", chapter: 10,
      },
    ]
    const promptText = formatContinuityFindingsForPrompt(findings)
    const reviewResults = toConsistencyReviewResult(findings)
    // prompt 文本 vs NovelReviewResult 对象 — 不同 result type 职责不同非重复
    expect(typeof promptText).toBe("string")
    expect(Array.isArray(reviewResults)).toBe(true)
    expect(reviewResults[0]).toHaveProperty("suggestion")
  })
})

// ============================================================================
// EPIC-004 TASK-004: DEFAULT_CONTINUITY_CONFIG + max 保底公式 + 缺字段回退
// ============================================================================

describe("EPIC-004 ADR-31 中文阈值校准 + 向后兼容 additive-only", () => {
  it("DEFAULT_CONTINUITY_CONFIG 缺省值落地 (camelCase DA-07)", () => {
    expect(DEFAULT_CONTINUITY_CONFIG.dormantThresholdChapters).toBe(3)
    expect(DEFAULT_CONTINUITY_CONFIG.absentThresholdChapters).toBe(5)
    expect(DEFAULT_CONTINUITY_CONFIG.overdueRatio).toBe(0.02)
    expect(DEFAULT_CONTINUITY_CONFIG.unresolvedForeshadowingRatio).toBe(0.05)
    expect(DEFAULT_CONTINUITY_CONFIG.deadCharacterPatterns).toEqual(["死", "亡", "殒", "逝", "毙"])
    expect(DEFAULT_CONTINUITY_CONFIG.protagonistNames).toEqual([])
  })

  it("resolveDormantThreshold: max(N, floor(total*0.02)) 保底公式 — 小章数保底 3", () => {
    expect(resolveDormantThreshold(10, DEFAULT_CONTINUITY_CONFIG)).toBe(3) // max(3, 0) = 3
    expect(resolveDormantThreshold(100, DEFAULT_CONTINUITY_CONFIG)).toBe(3) // max(3, 2) = 3
    expect(resolveDormantThreshold(200, DEFAULT_CONTINUITY_CONFIG)).toBe(4) // max(3, 4) = 4
  })

  it("resolveUnresolvedForeshadowingThreshold: max(10, floor(total*0.05)) 保底 10 (独立 ratio)", () => {
    expect(resolveUnresolvedForeshadowingThreshold(50, DEFAULT_CONTINUITY_CONFIG)).toBe(10) // max(10, 2) = 10
    expect(resolveUnresolvedForeshadowingThreshold(200, DEFAULT_CONTINUITY_CONFIG)).toBe(10) // max(10, 10) = 10
    expect(resolveUnresolvedForeshadowingThreshold(300, DEFAULT_CONTINUITY_CONFIG)).toBe(15) // max(10, 15) = 15
  })

  it("缺字段回退: 旧 character-states.json (无 isAlive/deathChapter/lastSeenChapter) 引擎不抛错", () => {
    const store = buildStore({
      characters: [makeCharacter({ characterName: "主角", status: "存活", lastUpdatedChapter: 9 })],
        // 无 isAlive / deathChapter / lastSeenChapter 字段
      currentChapter: 10,
    })
    expect(() => checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)).not.toThrow()
  })

  it("缺字段回退: 旧 subplot-board.json (无 targetResolutionChapter) 不抛错", () => {
    const store = buildStore({
      subplots: [makeSubplot({ id: "S1", status: "active", lastSeenChapter: 8 })],
      currentChapter: 10,
    })
    expect(() => checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)).not.toThrow()
  })
})

// ============================================================================
// EPIC-003 TASK-007: override reasonCode 6 值 + 跨检测持久自动降级
// ============================================================================

describe("EPIC-003 ADR-34 override 双轨 + reasonCode 6 值合并集", () => {
  it("ContinuityOverrideReasonCode 6 值合并集 (ADR-34 C-002)", () => {
    const codes: ContinuityOverrideReasonCode[] = [
      "intentional_death",
      "intentional_absence",
      "intentional_flashback",
      "posthumous_by_design",
      "false_positive",
      "state_layer_fix",
    ]
    expect(codes).toHaveLength(6)
    // 枚举不可自由文本 (守可统计可审计追溯)
    expect(new Set(codes).size).toBe(6)
  })

  it("isFindingDismissed: ref+severity 匹配返回 true (跨检测自动降级 AC-006.5)", () => {
    const finding: ContinuityFinding = {
      type: "dead_character_state", subtype: "consistency_mechanical", severity: "critical",
      ref: "character:死者", message: "死亡活跃态", chapter: 10,
    }
    const overrides: ContinuityOverride[] = [{
      ref: "character:死者", reasonCode: "intentional_death", note: "鬼魂视角",
      severity: "critical", dismissedAtChapter: 10,
    }]
    expect(isFindingDismissed(finding, overrides)).toBe(true)
  })

  it("isFindingDismissed: severity 升级 (warning→critical) 不匹配重新提示 (守 ADR-34)", () => {
    const finding: ContinuityFinding = {
      type: "dead_character_state", subtype: "consistency_mechanical", severity: "critical",
      ref: "character:死者", message: "死亡活跃态", chapter: 10,
    }
    const overrides: ContinuityOverride[] = [{
      ref: "character:死者", reasonCode: "false_positive", note: "",
      severity: "warning", // override 是 warning, finding 升级为 critical — 不匹配
      dismissedAtChapter: 5,
    }]
    expect(isFindingDismissed(finding, overrides)).toBe(false)
  })

  it("applyOverrides: 匹配 finding severity 降级 info (跨检测持久自动降级)", () => {
    const findings: ContinuityFinding[] = [
      {
        type: "dead_character_state", subtype: "consistency_mechanical", severity: "critical",
        ref: "character:死者", message: "死亡活跃态", chapter: 10,
      },
      {
        type: "dormant_thread", subtype: "consistency_mechanical", severity: "warning",
        ref: "subplot:S1", message: "休眠", chapter: 10,
      },
    ]
    const overrides: ContinuityOverride[] = [{
      ref: "character:死者", reasonCode: "intentional_death", note: "",
      severity: "critical", dismissedAtChapter: 10,
    }]
    const result = applyOverrides(findings, overrides)
    expect(result[0].severity).toBe("info") // 降级
    expect(result[1].severity).toBe("warning") // 不匹配, 保持
    expect(result[0].message).toContain("[override]") // 标注 override
  })

  it("applyOverrides: 空 overrides 返回原数组 (不修改)", () => {
    const findings: ContinuityFinding[] = [
      {
        type: "dormant_thread", subtype: "consistency_mechanical", severity: "warning",
        ref: "subplot:S1", message: "休眠", chapter: 10,
      },
    ]
    const result = applyOverrides(findings, [])
    expect(result).toHaveLength(1)
    expect(result[0].severity).toBe("warning")
  })
})

// ============================================================================
// deriveSubplotLastSeenChapter fold 反推
// ============================================================================

describe("deriveSubplotLastSeenChapter fold 反推 (纯函数)", () => {
  it("从 snapshots 反向遍历找最新匹配章号", () => {
    const subplot = makeSubplot({ title: "复仇线" })
    const snapshots: ChapterSnapshot[] = [
      makeSnapshot({ chapterNumber: 1, summary: "复仇线启动" }),
      makeSnapshot({ chapterNumber: 5, summary: "复仇线推进" }),
      makeSnapshot({ chapterNumber: 8, summary: "其他剧情" }),
    ]
    expect(deriveSubplotLastSeenChapter(subplot, snapshots)).toBe(5)
  })

  it("无匹配返回 undefined (调用方产 data_gap)", () => {
    const subplot = makeSubplot({ title: "复仇线" })
    const snapshots: ChapterSnapshot[] = [
      makeSnapshot({ chapterNumber: 1, summary: "无关剧情" }),
    ]
    expect(deriveSubplotLastSeenChapter(subplot, snapshots)).toBeUndefined()
  })
})

// ============================================================================
// runContinuityEngine legacy 别名 (委托 checkContinuity)
// ============================================================================

describe("runContinuityEngine legacy 别名 (ADR-29 backward compat)", () => {
  it("接受 ContinuityInput 产 ContinuityFinding[] (委托 checkContinuity)", () => {
    const input = buildInput({
      subplots: [makeSubplot({ id: "S1", lastSeenChapter: 1, status: "active" })],
      currentChapter: 10,
    })
    const findings = runContinuityEngine(input)
    expect(findings.some((f) => f.type === "dormant_thread")).toBe(true)
  })

  it("与 checkContinuity 结果一致 (委托零行为变更)", () => {
    const input = buildInput({
      subplots: [makeSubplot({ id: "S1", lastSeenChapter: 1, status: "active" })],
      currentChapter: 10,
    })
    const legacy = runContinuityEngine(input)
    const store: ReadonlyStore = {
      foreshadowing: input.foreshadowing,
      subplots: input.subplots,
      characters: input.characters,
      snapshots: input.snapshots,
      currentChapter: input.currentChapter,
    }
    const canonical = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
    expect(legacy).toEqual(canonical)
  })
})

// ============================================================================
// EPIC-004 TASK-008: UAT 假阳性风暴测试 + 性能 <10ms
// [需校准] 本测试是预校准 fixture, 真实样本调参需 Claude-Book 中文样本
// ============================================================================

describe("EPIC-004 ADR-31 AC-007.6 UAT 假阳性风暴测试 ([需校准] 预校准 fixture)", () => {
  function generateLargeBookFixture(): {
    store: ReadonlyStore
    config: typeof DEFAULT_CONTINUITY_CONFIG
  } {
    // 200 伏笔: 大部分已回收 (resolved) 或近期埋设 (planted recent), 仅少数真正逾期。
    // [需校准] 真实大书伏笔分布按合理估计 (resolved 60% / advanced recent 25% /
    // planted recent 13% / planted stale 2% 真 critical 真阳性)。plantedStale=5 章:
    // planted 章号 >= currentChapter-5 不算 critical, 避免 fixture 假阳性风暴。
    const foreshadowing: Foreshadowing[] = []
    for (let i = 0; i < 200; i++) {
      const mod = i % 20
      let status: Foreshadowing["status"]
      let plantedChapter: number
      if (mod < 12) {
        // 60% resolved (已回收, 不产 overdue)
        status = "resolved"
        plantedChapter = (i % 90) + 1
      } else if (mod < 17) {
        // 25% advanced recent (近期推进, 不算 stale)
        status = "advanced"
        plantedChapter = (i % 90) + 1
      } else if (mod < 19) {
        // 10% planted recent (近 3 章埋设, 未超 plantedStale=5)
        status = "planted"
        plantedChapter = 98 + (i % 3) // 98-100, currentChapter=100, gap < 5
      } else {
        // 5% planted stale (真逾期真阳性, 产 critical overdue)
        status = "planted"
        plantedChapter = (i % 50) + 1 // 1-50, gap >= 50
      }
      foreshadowing.push(
        makeForeshadowing({
          id: `F-${String(i).padStart(3, "0")}`,
          name: `伏笔${i}`,
          status,
          plantedChapter,
          resolvedChapter: status === "resolved" ? plantedChapter + 5 : undefined,
        }),
      )
    }
    // 30 角色 (lastUpdatedChapter 分布 1-100), 含 1 个死亡活跃态真阳性
    const characters: CharacterState[] = []
    for (let i = 0; i < 30; i++) {
      characters.push(
        makeCharacter({
          characterName: `角色${i}`,
          lastUpdatedChapter: (i % 50) + 1,
          status: i === 5 ? "已死亡" : "存活",
        }),
      )
    }
    // 死亡活跃态真阳性: 角色 5 死亡但 lastUpdatedChapter=98 接近 currentChapter=100
    characters[5] = makeCharacter({
      characterName: "死者",
      lastUpdatedChapter: 98,
      status: "已死亡",
    })
    // 50 线程 (status 分布 proposed/active/paused/resolved)
    const subplots: Subplot[] = []
    for (let i = 0; i < 50; i++) {
      const mod = i % 4
      const status = mod === 0 ? "proposed" : mod === 1 ? "active" : mod === 2 ? "paused" : "resolved"
      subplots.push(
        makeSubplot({
          id: `S-${i}`,
          title: `支线${i}`,
          status: status as Subplot["status"],
          lastSeenChapter: (i % 100) + 1,
          startChapter: (i % 100) + 1,
        }),
      )
    }
    // 100 章 snapshot (chapterNumber 1-100, characters 随机分布)
    const snapshots: ChapterSnapshot[] = []
    for (let i = 0; i < 100; i++) {
      snapshots.push(
        makeSnapshot({
          chapterNumber: i + 1,
          summary: `第${i + 1}章摘要`,
          characters: [`角色${i % 30}`],
        }),
      )
    }
    const store: ReadonlyStore = {
      foreshadowing,
      subplots,
      characters,
      snapshots,
      currentChapter: 100,
    }
    const config = {
      ...DEFAULT_CONTINUITY_CONFIG,
      protagonistNames: ["角色0", "角色1", "角色2"], // 3 主角
    }
    return { store, config }
  }

  it("无假阳性风暴: critical count < 总 findings 的 20% (AC-007.6)", () => {
    const { store, config } = generateLargeBookFixture()
    const findings = checkContinuity(store, config)
    const summary = summarizeContinuityFindings(findings)
    // critical < 总 findings 20%
    expect(summary.critical).toBeLessThan(summary.total * 0.2)
    // critical 主要来自 dead_character_state (fixture 故意构造 1 真阳性)
    expect(summary.critical).toBeGreaterThanOrEqual(1)
  })

  it("大书 100+ 章 fixture 性能 <10ms (NFR-perf-001)", () => {
    const { store, config } = generateLargeBookFixture()
    const start = Date.now()
    checkContinuity(store, config)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(10)
  })

  it("absent_character protagonist-only: 仅主角 warning 配角 info (ADR-31)", () => {
    const { store, config } = generateLargeBookFixture()
    const findings = checkContinuity(store, config)
    const absent = findings.filter((f) => f.type === "absent_character")
    // 主角 (protagonistNames 3 个) 产 warning
    const warning = absent.filter((f) => f.severity === "warning")
    const info = absent.filter((f) => f.severity === "info")
    // warning 应只含 protagonistNames 中的角色
    for (const f of warning) {
      expect(config.protagonistNames.some((n) => f.ref.includes(n))).toBe(true)
    }
    // info 应 >= warning (配角降级)
    expect(info.length).toBeGreaterThanOrEqual(warning.length)
  })

  it("[需校准] 阈值默认值待 UAT 真实样本调参 (守 ADR-31 + blueprint caveats)", () => {
    // 本测试是预校准 fixture, 真实样本调参需 Claude-Book 中文样本跑分布取
    // P75/P90 分位替换 DEFAULT_CONTINUITY_CONFIG 默认值。
    // 标注 [需校准] 守 ADR-31 + blueprint caveats 明确待 UAT 真实样本调参。
    expect(DEFAULT_CONTINUITY_CONFIG.dormantThresholdChapters).toBe(3)
    expect(DEFAULT_CONTINUITY_CONFIG.absentThresholdChapters).toBe(5)
    // [需校准] 待真实样本调参
  })
})

// ============================================================================
// summarizeContinuityFindings 3 级分桶 (ADR-30)
// ============================================================================

describe("summarizeContinuityFindings 3 级分桶 (ADR-30 非 4 级)", () => {
  it("3 级 severity (critical/warning/info) 分桶计数 — 无 high 级", () => {
    const findings: ContinuityFinding[] = [
      { type: "dead_character_state", subtype: "consistency_mechanical", severity: "critical", ref: "c:1", message: "", chapter: 1 },
      { type: "dormant_thread", subtype: "consistency_mechanical", severity: "warning", ref: "s:1", message: "", chapter: 1 },
      { type: "data_gap", subtype: "data_gap", severity: "info", ref: "s:2", message: "", chapter: 1, missingField: "x" },
    ]
    const summary = summarizeContinuityFindings(findings)
    expect(summary.critical).toBe(1)
    expect(summary.warning).toBe(1)
    expect(summary.info).toBe(1)
    expect(summary.data_gap).toBe(1)
    expect(summary.total).toBe(3)
    // ContinuityFindingSummary 不应含 high 字段 (ADR-30 3 级 blueprint 权威)
    expect((summary as any).high).toBeUndefined()
  })
})
