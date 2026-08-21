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
  classifyTimelineDriftSeverity,
  detectTimelineDrift,
  type ContinuityFinding,
  type ContinuityInput,
  type ReadonlyStore,
  type TimelineDriftEvent,
  type ContinuityOverride,
  type ContinuityOverrideStore,
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
        currentChapter: 12,
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

    // 覆盖 line 328 warning 分支 (debtLevel==='warning'): status='advanced' 且距上次推进 >= 10 章
    it("true-positive: advanced 状态伏笔长期未推进产 unresolved_foreshadowing warning (line 328 分支)", () => {
      const store = buildStore({
        foreshadowing: [
          makeForeshadowing({
            id: "F2",
            name: "推进后停滞伏笔",
            status: "advanced",
            plantedChapter: 1,
            advancedChapters: [5],
          }),
        ],
        currentChapter: 20, // 距上次推进 15 章 >= DEFAULT_ADVANCED_STALE(10)
      })
      const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
      const unresolved = findings.find((f) => f.type === "unresolved_foreshadowing")
      expect(unresolved).toBeDefined()
      expect(unresolved?.severity).toBe("warning")
      expect(unresolved?.subtype).toBe("consistency_mechanical")
      expect(unresolved?.ref).toBe("foreshadowing:F2")
      // 不应同时产 overdue_thread critical
      expect(findings.find((f) => f.type === "overdue_thread")).toBeUndefined()
    })

    it("true-negative: advanced 状态伏笔近期已推进不产 unresolved_foreshadowing", () => {
      const store = buildStore({
        foreshadowing: [
          makeForeshadowing({
            id: "F3",
            status: "advanced",
            plantedChapter: 1,
            advancedChapters: [18],
          }),
        ],
        currentChapter: 20, // 距上次推进 2 章 < 10
      })
      const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
      expect(findings.find((f) => f.type === "unresolved_foreshadowing")).toBeUndefined()
    })
  })

  // --- checkContinuity overrideStore 集成分支 (line 648) ---
  describe("checkContinuity overrideStore 集成 (ADR-34 跨检测持久自动降级)", () => {
    it("传入非空 overrideStore 触发 applyOverrides 路径 (line 648 真分支)", () => {
      const store = buildStore({
        subplots: [makeSubplot({ id: "S1", lastSeenChapter: 1, status: "active" })],
        currentChapter: 20,
      })
      // 产 dormant_thread warning (critical 可能也有, 取 warning 降级)
      const rawFindings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
      const dormantWarning = rawFindings.find(
        (f) => f.type === "dormant_thread" && f.severity === "warning",
      )
      expect(dormantWarning).toBeDefined()

      // override 降级匹配的 warning → info
      const overrideStore: ContinuityOverrideStore = {
        overrides: [
          {
            ref: dormantWarning!.ref,
            reasonCode: "false_positive",
            note: "误报, 设计性休眠",
            severity: "warning",
            dismissedAtChapter: 20,
          },
        ],
        lastUpdated: "",
      }
      const withOverrides = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG, overrideStore)
      // 匹配的 finding 应降级为 info
      const overridden = withOverrides.find((f) => f.ref === dormantWarning!.ref)
      expect(overridden?.severity).toBe("info")
    })

    it("空 overrides 数组不触发 applyOverrides 路径 (走 rawFindings 直返)", () => {
      const store = buildStore({
        subplots: [makeSubplot({ id: "S1", lastSeenChapter: 1, status: "active" })],
        currentChapter: 20,
      })
      const emptyOverrideStore: ContinuityOverrideStore = {
        overrides: [],
        lastUpdated: "",
      }
      const withEmpty = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG, emptyOverrideStore)
      const without = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
      // 空 overrides 与不传 overrideStore 行为一致
      expect(withEmpty).toEqual(without)
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

    it("true-positive: deathChapter 结构化字段回退 (非 isAlive/status 路径)", () => {
      const store = buildStore({
        characters: [makeCharacter({ characterName: "逝者", deathChapter: 3, lastUpdatedChapter: 8 })],
        currentChapter: 10,
      })
      const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
      const dead = findings.find((f) => f.type === "dead_character_state")
      expect(dead).toBeDefined()
      expect(dead?.ref).toBe("character:逝者")
    })

    it("true-positive: isAlive=false 且 status 为空串 (结构性死亡, 空 status 回退)", () => {
      const store = buildStore({
        characters: [makeCharacter({ characterName: "死者", status: "", isAlive: false, lastUpdatedChapter: 8 })],
        currentChapter: 10,
      })
      const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
      const dead = findings.find((f) => f.type === "dead_character_state")
      expect(dead).toBeDefined()
      expect(dead?.message).toContain("structural")
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

  it("toConsistencyReviewResult: info 级映射 info 且 data_gap 透传 missingField", () => {
    const findings: ContinuityFinding[] = [
      {
        type: "data_gap", subtype: "data_gap", severity: "info",
        ref: "subplot:S1", message: "缺字段", chapter: 10, missingField: "lastSeenChapter",
      },
    ]
    const results = toConsistencyReviewResult(findings)
    expect(results[0].severity).toBe("info")
    expect(results[0].continuityMeta?.missingField).toBe("lastSeenChapter")
    expect(results[0].continuityMeta?.subtype).toBe("data_gap")
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

  // REV-CE-003: includeChapter 可选参数承载 generation-layer 省略章号的故意差异。
  it("formatContinuityFindingsForPrompt: includeChapter=false 省略章号 (生成层)", () => {
    const findings: ContinuityFinding[] = [
      {
        type: "dormant_thread", subtype: "consistency_mechanical", severity: "warning",
        ref: "subplot:S1", message: "休眠 5 章", chapter: 10,
      },
    ]
    // 默认 true: 带章号后缀
    expect(formatContinuityFindingsForPrompt(findings)).toContain("(章 10)")
    // false: 省略章号 (生成层已在章内上下文无需重复)
    const withoutChapter = formatContinuityFindingsForPrompt(findings, { includeChapter: false })
    expect(withoutChapter).not.toContain("(章 10)")
    expect(withoutChapter).toContain("subplot:S1")
  })
})

// ============================================================================
// EPIC-004 TASK-004: DEFAULT_CONTINUITY_CONFIG + max 保底公式 + 缺字段回退
// ============================================================================

describe("EPIC-004 ADR-31 中文阈值校准 + 向后兼容 additive-only", () => {
  it("DEFAULT_CONTINUITY_CONFIG 缺省值落地 (camelCase DA-07)", () => {
    expect(DEFAULT_CONTINUITY_CONFIG.dormantThresholdChapters).toBe(10)
    expect(DEFAULT_CONTINUITY_CONFIG.absentThresholdChapters).toBe(7)
    expect(DEFAULT_CONTINUITY_CONFIG.overdueRatio).toBe(0.02)
    expect(DEFAULT_CONTINUITY_CONFIG.unresolvedForeshadowingRatio).toBe(0.05)
    expect(DEFAULT_CONTINUITY_CONFIG.deadCharacterPatterns).toEqual(["死", "亡", "殒", "逝", "毙"])
    expect(DEFAULT_CONTINUITY_CONFIG.protagonistNames).toEqual([])
  })

  it("resolveDormantThreshold: max(N, floor(total*0.02)) 保底公式 — 校准后保底 10", () => {
    expect(resolveDormantThreshold(10, DEFAULT_CONTINUITY_CONFIG)).toBe(10) // max(10, 0) = 10
    expect(resolveDormantThreshold(100, DEFAULT_CONTINUITY_CONFIG)).toBe(10) // max(10, 2) = 10
    expect(resolveDormantThreshold(200, DEFAULT_CONTINUITY_CONFIG)).toBe(10) // max(10, 4) = 10
    expect(resolveDormantThreshold(1000, DEFAULT_CONTINUITY_CONFIG)).toBe(20) // max(10, 20) = 20 (大书走比例)
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

  it("isFindingDismissed: info 级 finding 直接返回 false (dismiss guard 拒绝 info 级)", () => {
    const finding: ContinuityFinding = {
      type: "data_gap", subtype: "data_gap", severity: "info",
      ref: "subplot:S1", message: "缺字段", chapter: 10, missingField: "lastSeenChapter",
    }
    const overrides: ContinuityOverride[] = [{
      ref: "subplot:S1", reasonCode: "intentional_death", note: "",
      severity: "warning", dismissedAtChapter: 10,
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
      currentChapter: 12,
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

  it("[已校准] 阈值经 Re0 10 卷 312+753 样本 P75 校准 (守 ADR-31)", () => {
    // [中文校准 2026-07-20] 已用 scripts/calibrate-from-epub.mjs 对 Re0 从零
    // 开始的异世界生活 10 卷 138 章正文跑校准. absent 312 样本 P75=7, dormant
    // 753 样本 P75=10. absentThresholdChapters 5→7, dormantThresholdChapters 3→10
    // (P75 校准值, 保守偏高防假阳性守 GRL-011 Risk 3). 双维度均经真实中文样本
    // 正式校准替换, 校准脚本 calibrate-from-epub.mjs (epub 直校准, 绕过 snapshot
    // chain 依赖) 端到端验证通过.
    expect(DEFAULT_CONTINUITY_CONFIG.dormantThresholdChapters).toBe(10)
    expect(DEFAULT_CONTINUITY_CONFIG.absentThresholdChapters).toBe(7)
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

describe("S2c Quillica 6 状态机合并 (detectThreadArcFinding)", () => {
  function storeWithSubplots(subplots: Subplot[]): ReadonlyStore {
    return {
      foreshadowing: [],
      subplots,
      characters: [],
      snapshots: [],
      currentChapter: 20,
    }
  }

  it("高潮段后断裂: progress≥5 且长期未推进 → dormant_thread finding (弧断裂)", () => {
    const subplot: Subplot = {
      id: "sp-climax",
      title: "朝堂权谋线",
      status: "active",
      startChapter: 1,
      relatedCharacters: [],
      summary: "权谋",
      progress: ["a", "b", "c", "d", "e"],
      lastSeenChapter: 2, // 距 current 20 章 → gap 18 > threshold
      notes: "",
    }
    const findings = checkContinuity(storeWithSubplots([subplot]))
    const arcFindings = findings.filter((f) => f.message.includes("高潮段后断裂"))
    expect(arcFindings.length).toBe(1)
    expect(arcFindings[0]!.ref).toBe("subplot:sp-climax")
  })

  it("状态机转移违反: resolved 后仍有非闭环 progress → finding", () => {
    const subplot: Subplot = {
      id: "sp-resolved",
      title: "恋爱线",
      status: "resolved",
      startChapter: 1,
      relatedCharacters: [],
      summary: "恋爱",
      progress: ["完结", "又出新情节"],
      notes: "",
    }
    const findings = checkContinuity(storeWithSubplots([subplot]))
    const violation = findings.filter((f) => f.message.includes("弧状态违反"))
    expect(violation.length).toBe(1)
  })

  it("resolved 后闭环 progress 不报 (无重复判定)", () => {
    const subplot: Subplot = {
      id: "sp-clean",
      title: "伏笔回收线",
      status: "resolved",
      startChapter: 1,
      relatedCharacters: [],
      summary: "回收",
      progress: ["线索闭环回收"],
      notes: "",
    }
    const findings = checkContinuity(storeWithSubplots([subplot]))
    expect(findings.filter((f) => f.message.includes("弧状态违反"))).toHaveLength(0)
  })

  it("正常 Rising 线不产 threadArc finding (合并非双轨)", () => {
    const subplot: Subplot = {
      id: "sp-rising",
      title: "冒险线",
      status: "active",
      startChapter: 1,
      relatedCharacters: [],
      summary: "冒险",
      progress: ["出发", "遇险"],
      lastSeenChapter: 19, // 刚推进 → 非 Falling
      notes: "",
    }
    const findings = checkContinuity(storeWithSubplots([subplot]))
    expect(findings.filter((f) => f.message.includes("弧"))).toHaveLength(0)
  })

  it("progress 缺失 (旧数据) 按 0 处理不抛错 (progressCount ?? 0)", () => {
    const subplot: Subplot = {
      id: "sp-legacy",
      title: "旧数据线",
      status: "active",
      startChapter: 1,
      relatedCharacters: [],
      summary: "旧数据",
      progress: undefined as unknown as string[],
      notes: "",
    }
    expect(() => checkContinuity(storeWithSubplots([subplot]))).not.toThrow()
  })
})

// ============================================================================
// F-002 第 6 检测项: detectTimelineDrift (timeline_drift)
// ============================================================================

describe("F-002 detectTimelineDrift 第 6 检测项 (timeline_drift, additive)", () => {
  function ev(ref: string, chapter: number, referencedChapter: number): TimelineDriftEvent {
    return { ref, chapter, referencedChapter }
  }

  it("六分支1 事件时序正常: 同 ref 回引章单调递增 + 章号在阈值内不产 timeline_drift", () => {
    const events: TimelineDriftEvent[] = [
      ev("character:主角", 8, 8),
      ev("character:主角", 9, 9),
      ev("character:主角", 10, 10),
    ]
    // current=10, gap=|10-10|=0 / |10-9|=1 / |10-8|=2 均 <= maxGap(3); 单调无逆序
    const findings = detectTimelineDrift(events, 10, DEFAULT_CONTINUITY_CONFIG)
    expect(findings.filter((f) => f.type === "timeline_drift")).toHaveLength(0)
  })

  it("六分支 事件时序逆序: 同角色后录制事件回引早于已发生 → timeline_drift", () => {
    const events: TimelineDriftEvent[] = [
      ev("character:主角", 5, 5),
      ev("character:主角", 6, 4), // 回引 4 < 已发生 5 → 逆序, 幅度 1 → info
    ]
    // current=6, 跳跃 |6-5|=1, |6-4|=2 均 <= 3 → 无跳跃漂移, 只剩时序逆序
    const findings = detectTimelineDrift(events, 6, DEFAULT_CONTINUITY_CONFIG)
    const drift = findings.filter((f) => f.type === "timeline_drift")
    expect(drift).toHaveLength(1)
    expect(drift[0]!.ref).toBe("character:主角")
    expect(drift[0]!.subtype).toBe("consistency_mechanical")
    expect(drift[0]!.severity).toBe("info")
    expect(drift[0]!.message).toContain("时序矛盾")
  })

  it("六分支 章号跳跃: 当前章与事件回引章差 > 阈值 → 严重级(>5) critical", () => {
    const events: TimelineDriftEvent[] = [ev("character:配角", 2, 2)]
    // current=10, gap=|10-2|=8 > 5 → critical
    const findings = detectTimelineDrift(events, 10, DEFAULT_CONTINUITY_CONFIG)
    const drift = findings.filter((f) => f.type === "timeline_drift")
    expect(drift).toHaveLength(1)
    expect(drift[0]!.severity).toBe("critical")
    expect(drift[0]!.message).toContain("章号跳跃")
  })

  it("六分支 多事件漂移: 多事件多条 timeline_drift finding", () => {
    const events: TimelineDriftEvent[] = [
      ev("character:A", 1, 1),
      ev("character:B", 2, 2),
      ev("character:C", 3, 3),
    ]
    // current=10, 三条均为 gap 增大 (9,8,7) 均 >5 → 3 条 critical; 各 ref 独立单调
    const findings = detectTimelineDrift(events, 10, DEFAULT_CONTINUITY_CONFIG)
    const drift = findings.filter((f) => f.type === "timeline_drift")
    expect(drift).toHaveLength(3)
    expect(new Set(drift.map((f) => f.ref)).size).toBe(3)
    expect(drift.every((f) => f.severity === "critical")).toBe(true)
  })

  it("六分支 空列表: 无事件不产 timeline_drift", () => {
    expect(detectTimelineDrift([], 10, DEFAULT_CONTINUITY_CONFIG)).toEqual([])
  })

  it("六分支 阈值边界: gap 等于阈值不产漂移; classify 3 档分级边界", () => {
    // gap == maxGap(3) → 不产 (严格大于才触发)
    const atThreshold = detectTimelineDrift([ev("character:X", 7, 7)], 10, DEFAULT_CONTINUITY_CONFIG)
    expect(atThreshold.filter((f) => f.type === "timeline_drift")).toHaveLength(0)
    // classifyTimelineDriftSeverity 边界: magnitude>5 critical, >3 warning, else info
    expect(classifyTimelineDriftSeverity(6)).toBe("critical")
    expect(classifyTimelineDriftSeverity(5)).toBe("warning")
    expect(classifyTimelineDriftSeverity(4)).toBe("warning")
    expect(classifyTimelineDriftSeverity(3)).toBe("info")
    expect(classifyTimelineDriftSeverity(1)).toBe("info")
  })

  it("集成: checkContinuity store 含 timelineEvents 时合并 timeline_drift findings", () => {
    const store = buildStore({
      currentChapter: 10,
      timelineEvents: [ev("character:某", 2, 2)], // gap=8, while current=10
    })
    const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
    const drift = findings.filter((f) => f.type === "timeline_drift")
    expect(drift.length).toBeGreaterThanOrEqual(1)
    expect(drift[0]!.severity).toBe("critical")
  })

  it("checkContinuity 无 timelineEvents 字段 (旧调用点) 零行为变化不产 timeline_drift", () => {
    const store = buildStore({ currentChapter: 10 })
    const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
    expect(findings.filter((f) => f.type === "timeline_drift")).toHaveLength(0)
  })

  it("DEFAULT_TIMELINE gap 配置落地: config 缺省 timelineDriftMaxChapterGap = 3", () => {
    expect(DEFAULT_CONTINUITY_CONFIG.timelineDriftMaxChapterGap).toBe(3)
  })
})
