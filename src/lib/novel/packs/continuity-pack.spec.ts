/**
 * continuity-pack.spec.ts — T24 一致性规则包单测
 *
 * 蓝图 §6 T24 (TASK-P3-24) 收敛面:
 *   - 包结构: id / 7 规则 / 全属 consistency 门;
 *   - combinePacks 冻结组合 + runRuleStack 盖章: taxonomyDimId → finding.dimensionId
 *     透传（T22 37 维一致性校验经 combinePacks 组合期守卫）;
 *   - severity 映射: critical→error / warning→warning / info→info; data_gap info 无维度;
 *   - 共享预计算: 引擎单次求值（findings 快照恒等）+ override 降级接线;
 *   - 空输入安全。
 *
 * 执行纪律: ADR-19 机械层零模型调用（纯函数夹具，无 IO 无模型）。
 */
import { describe, expect, it } from "vitest"
import type { Foreshadowing } from "../foreshadowing-tracker"
import type { Subplot } from "../subplot-board"
import type { CharacterState } from "../character-state"
import type { TimelineDriftEvent } from "../deterministic-continuity-engine"
import { createContinuityPack, EMPTY_CONTINUITY_INPUT, CONTINUITY_PACK_ID } from "./continuity-pack"
import { combinePacks, runRuleStack } from "../rule-stack"

// ============================================================================
// Fixture（镜像 deterministic-continuity-engine.spec 夹具口径）
// ============================================================================

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

function makeForeshadowing(over: Partial<Foreshadowing> = {}): Foreshadowing {
  return {
    id: "F-001",
    name: "旧钥匙",
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

describe("continuity-pack 包结构", () => {
  it("包 id 固定 + 7 条规则全属 consistency 门", () => {
    const pack = createContinuityPack(EMPTY_CONTINUITY_INPUT)
    expect(pack.id).toBe(CONTINUITY_PACK_ID)
    expect(pack.rules.map((r) => r.id)).toEqual([
      "continuity.dormant-thread",
      "continuity.absent-character",
      "continuity.overdue-thread",
      "continuity.unresolved-foreshadowing",
      "continuity.dead-character-state",
      "continuity.timeline-drift",
      "continuity.data-gap",
    ])
    for (const rule of pack.rules) {
      expect(rule.gate).toBe("consistency")
    }
  })

  it("combinePacks 接受本包且 runRuleStack 拒绝未冻栈（冻结语义边界在本包外）", () => {
    const pack = createContinuityPack(EMPTY_CONTINUITY_INPUT)
    const stack = combinePacks([pack])
    expect(stack.packIds).toEqual([CONTINUITY_PACK_ID])
    expect(Object.isFrozen(stack)).toBe(true)
  })
})

describe("continuity-pack finding 投影 + taxonomyDimId 透传", () => {
  it("dormant_thread → subplot_resolution (warning)，经 runRuleStack 盖章后 dimensionId 保留", () => {
    const pack = createContinuityPack({
      foreshadowing: [],
      subplots: [makeSubplot({ lastSeenChapter: 1 })],
      characters: [],
      snapshots: [],
      currentChapter: 20,
    })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    const findings = result.allFindings.filter((f) => f.ruleId === "continuity.dormant-thread")
    expect(findings.length).toBeGreaterThan(0)
    for (const f of findings) {
      expect(f.gate).toBe("consistency")
      expect(f.severity).toBe("warning")
      expect(f.dimensionId).toBe("subplot_resolution")
    }
  })

  it("dead_character_state → character_consistency，critical 映射 error 并触发 P0 短路", () => {
    const pack = createContinuityPack({
      foreshadowing: [],
      subplots: [],
      characters: [makeCharacter({ isAlive: false, deathChapter: 5, lastUpdatedChapter: 20 })],
      snapshots: [],
      currentChapter: 20,
    })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    const dead = result.allFindings.filter((f) => f.ruleId === "continuity.dead-character-state")
    expect(dead.length).toBe(1)
    expect(dead[0]!.severity).toBe("error")
    expect(dead[0]!.dimensionId).toBe("character_consistency")
    // critical→error 命中 consistency 门 fail → hardShortCircuit（P0 先短路）
    expect(result.shortCircuited).toBe(true)
    expect(result.shortCircuitGate).toBe("consistency")
  })

  it("逾期伏笔 → foreshadowing_integrity (critical→error)；结构化逾期 subplot → subplot_resolution", () => {
    const pack = createContinuityPack({
      foreshadowing: [makeForeshadowing()],
      subplots: [makeSubplot({ targetResolutionChapter: 10 })],
      characters: [],
      snapshots: [],
      currentChapter: 20,
    })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    const overdue = result.allFindings.filter((f) => f.ruleId === "continuity.overdue-thread")
    const dims = overdue.map((f) => f.dimensionId).sort()
    expect(dims).toEqual(["foreshadowing_integrity", "subplot_resolution"])
    for (const f of overdue) {
      expect(f.severity).toBe("error")
    }
  })

  it("timeline_drift → timeline_consistency（timelineEvents 透传）", () => {
    const events: TimelineDriftEvent[] = [
      { ref: "character:主角", chapter: 20, referencedChapter: 2 },
    ]
    const pack = createContinuityPack({
      foreshadowing: [],
      subplots: [],
      characters: [],
      snapshots: [],
      currentChapter: 20,
      timelineEvents: events,
    })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    const drift = result.allFindings.filter((f) => f.ruleId === "continuity.timeline-drift")
    expect(drift.length).toBe(1)
    expect(drift[0]!.dimensionId).toBe("timeline_consistency")
  })

  it("data_gap → info 且无 dimensionId（跨维通用槽位，不阻断）", () => {
    const pack = createContinuityPack({
      foreshadowing: [],
      subplots: [makeSubplot()], // 无 lastSeenChapter/targetResolutionChapter/progress
      characters: [],
      snapshots: [],
      currentChapter: 20,
    })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    const gaps = result.allFindings.filter((f) => f.ruleId === "continuity.data-gap")
    expect(gaps.length).toBeGreaterThan(0)
    for (const g of gaps) {
      expect(g.severity).toBe("info")
      expect(g.dimensionId).toBeUndefined()
    }
    // info 不构成 error → 门 pass 不短路
    expect(result.verdicts.consistency).toBe("pass")
  })

  it("override store 降级接线：dismissed finding 降 info 且 message 带 [override] 前缀", () => {
    const pack = createContinuityPack({
      foreshadowing: [makeForeshadowing()],
      subplots: [],
      characters: [],
      snapshots: [],
      currentChapter: 20,
      overrides: {
        overrides: [
          {
            ref: "foreshadowing:F-001",
            reasonCode: "false_positive",
            note: "误报",
            severity: "critical",
          },
        ],
        lastUpdated: "",
      },
    })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    const overdue = result.allFindings.filter((f) => f.ruleId === "continuity.overdue-thread")
    expect(overdue.some((f) => f.severity === "info" && f.message.startsWith("[override]"))).toBe(true)
  })

  it("空输入：全部规则空产出，门 pass", () => {
    const pack = createContinuityPack(EMPTY_CONTINUITY_INPUT)
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    expect(result.allFindings).toEqual([])
    expect(result.verdicts.consistency).toBe("pass")
    expect(result.executedRuleCount).toBe(7)
  })

  it("共享预计算：同包两次运行结果恒等（引擎单次求值快照复用）", () => {
    const input = {
      foreshadowing: [makeForeshadowing()],
      subplots: [makeSubplot({ lastSeenChapter: 1 })],
      characters: [makeCharacter()],
      snapshots: [],
      currentChapter: 20,
    }
    const pack = createContinuityPack(input)
    const stack = combinePacks([pack])
    const r1 = runRuleStack(stack, { isFinale: false })
    const r2 = runRuleStack(stack, { isFinale: false })
    expect(r1.allFindings).toEqual(r2.allFindings)
  })
})
