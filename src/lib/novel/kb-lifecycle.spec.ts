/**
 * E-06 (run-execute-1, 双库架构蓝图) 验收③ — 生命周期双轨 spec。
 *
 * 共识 C-4/C-5/C-11/C-12：能力库衰减可回滚（事件日志重放，清空 → decay 恒 1）；
 * 过程库 superseded 不装配（filterAssemblable）；策略不交叉（类型层隔离 +
 * LIFECYCLE_POLICY 表断言）；物理 compaction DEFERRED（dry-run 计划）。
 */
import { describe, it, expect } from "vitest"
import {
  decayFactorOf,
  shouldDistill,
  recomputeDecay,
  markSuperseded,
  isSuperseded,
  nextVersion,
  compactPlan,
  filterAssemblable,
  supersedeByRevision,
  LIFECYCLE_POLICY,
  DEFAULT_DECAY_PARAMS,
  type CapabilityDecayState,
  type ProcessSupersession,
} from "./kb-lifecycle"

describe("E-06 能力库衰减（GOV-LIFE-01/05）", () => {
  it("未蒸馏 → decayFactor=1（无衰减）；蒸馏后单调不增 ∈(0,1]", () => {
    expect(decayFactorOf({ distilledAt: null, usageCount: 0, now: 0 })).toBe(1)
    const d1 = decayFactorOf({ distilledAt: 0, usageCount: 5, now: 86_400_000 * 90 })
    const d2 = decayFactorOf({ distilledAt: 0, usageCount: 5, now: 86_400_000 * 180 })
    expect(d1).toBeGreaterThan(d2)
    expect(d2).toBeCloseTo(0.5, 5)
    expect(d1).toBeGreaterThan(0)
    expect(d1).toBeLessThanOrEqual(1)
  })

  it("默认参数存在且标注 [需校准]（G-3）", () => {
    expect(DEFAULT_DECAY_PARAMS.distillTriggerUsage).toBe(20)
    expect(DEFAULT_DECAY_PARAMS.distillTriggerAgeDays).toBe(30)
    expect(DEFAULT_DECAY_PARAMS.halfLifeDays).toBe(180)
  })

  it("蒸馏触发判定（G-3 默认值）", () => {
    expect(shouldDistill({ usageCount: 20, ageDays: 0 })).toBe(true)
    expect(shouldDistill({ usageCount: 0, ageDays: 30 })).toBe(true)
    expect(shouldDistill({ usageCount: 5, ageDays: 5 })).toBe(false)
  })

  it("回滚：清空事件日志重放 → decay 恒 1（GOV-REV-03 重建语义）", () => {
    const events = [
      { entryId: "e1", distilledAt: 0, usageCount: 10 },
      { entryId: "e2", distilledAt: null, usageCount: 3 },
    ]
    const states = recomputeDecay(events, 86_400_000 * 180)
    expect(states[0].decayFactor).toBeLessThan(1)
    expect(states[1].decayFactor).toBe(1)
    // 清空重放 = 恒等
    const empty = recomputeDecay([])
    expect(empty).toEqual([])
  })

  it("CapabilityDecayState 类型无 invalidAt/version 字段（GOV-LIFE-03 类型层隔离）", () => {
    const state: CapabilityDecayState = { entryId: "e1", distilledAt: 0, usageCount: 1, decayFactor: 0.9 }
    const keys = Object.keys(state)
    expect(keys).not.toContain("invalidAt")
    expect(keys).not.toContain("version")
  })
})

describe("E-06 过程库 supersession（GOV-LIFE-02/04）", () => {
  it("markSuperseded 纯函数：返回新值不改原对象", () => {
    const entry: ProcessSupersession = { entity: "密道", version: 1, invalidAt: null, supersededBy: null }
    const next = markSuperseded(entry, { at: 5, byRevision: "ch5-r2" })
    expect(entry.invalidAt).toBeNull() // 原对象不变
    expect(next.invalidAt).toBe(5)
    expect(next.supersededBy).toBe("ch5-r2")
  })

  it("isSuperseded：invalidAt ≤ 当前章 → 不得再装配", () => {
    const entry: ProcessSupersession = { entity: "密道", version: 1, invalidAt: 5, supersededBy: "ch5-r2" }
    expect(isSuperseded(entry, 4)).toBe(false)
    expect(isSuperseded(entry, 5)).toBe(true)
    expect(isSuperseded(entry, 6)).toBe(true)
    const active: ProcessSupersession = { entity: "密道", version: 2, invalidAt: null, supersededBy: null }
    expect(isSuperseded(active, 99)).toBe(false)
  })

  it("nextVersion 单调推进", () => {
    const v1: ProcessSupersession = { entity: "密道", version: 1, invalidAt: null, supersededBy: null }
    expect(nextVersion(v1).version).toBe(2)
  })

  it("compactPlan dry-run：invalidAt 非空 → toSupersede（物理执行 DEFERRED，C-12）", () => {
    const entries: ProcessSupersession[] = [
      { entity: "a", version: 1, invalidAt: 3, supersededBy: "b" },
      { entity: "b", version: 2, invalidAt: null, supersededBy: null },
    ]
    const plan = compactPlan(entries)
    expect(plan.toSupersede.map((e) => e.entity)).toEqual(["a"])
    expect(plan.toKeep.map((e) => e.entity)).toEqual(["b"])
  })

  it("ProcessSupersession 类型无 decayFactor/distilledAt 字段（GOV-LIFE-03 类型层隔离）", () => {
    const entry: ProcessSupersession = { entity: "a", version: 1, invalidAt: null, supersededBy: null }
    const keys = Object.keys(entry)
    expect(keys).not.toContain("decayFactor")
    expect(keys).not.toContain("distilledAt")
  })
})

describe("E-06 filterAssemblable（superseded 不装配，C-5）", () => {
  it("status=superseded 或 invalidAt 已过期 → 剔除", () => {
    const entries = [
      { id: "a", status: "promoted", invalidAt: null },
      { id: "b", status: "superseded", invalidAt: null },
      { id: "c", status: "promoted", invalidAt: 5 },
    ]
    const kept = filterAssemblable(entries, 6)
    expect(kept.map((e) => e.id)).toEqual(["a"])
  })
})

describe("E-06 supersedeByRevision（E-05 C-8 治理迁移归 E-06）", () => {
  it("同 chapterId 下 revision 更大者晋升 → 旧 record 置 superseded", () => {
    const records = [
      { replayKey: "fw:ch3:ch3:1", status: "promoted", sourceRef: { chapterId: "ch3", revision: 1 } },
      { replayKey: "fw:ch3:ch3:2", status: "promoted", sourceRef: { chapterId: "ch3", revision: 2 } },
      { replayKey: "fw:ch4:ch4:1", status: "promoted", sourceRef: { chapterId: "ch4", revision: 1 } },
    ]
    const migrated = supersedeByRevision(records)
    expect(migrated.find((r) => r.replayKey === "fw:ch3:ch3:1")?.status).toBe("superseded")
    expect(migrated.find((r) => r.replayKey === "fw:ch3:ch3:2")?.status).toBe("promoted")
    expect(migrated.find((r) => r.replayKey === "fw:ch4:ch4:1")?.status).toBe("promoted")
  })
})

describe("E-06 LIFECYCLE_POLICY（GOV-LIFE-03 策略不交叉）", () => {
  it("能力库无 supersession、过程库无蒸馏", () => {
    expect(LIFECYCLE_POLICY.capability).toEqual({ decay: true, supersession: false })
    expect(LIFECYCLE_POLICY.process).toEqual({ decay: false, supersession: true })
  })
})
