/**
 * E-06 (run-execute-1, 双库架构蓝图) 验收⑥⑦ — 三安全不变量 + DimensionCoord spec。
 *
 * 共识 C-9/C-10：三安全不变量（fold_atomic_fsync / tech_visible_to_agent /
 * promotion_require_accept）MUST NOT 可被运行时关闭（冻结常量 + override throw +
 * 无 setter 导出面）；27 格坐标 zod schema + coordIndex 双射 + 注册表完备性
 * （验收 7 机器化）；晋升桥仅沿 Time 轴移动。
 */
import { describe, it, expect } from "vitest"
import {
  SAFETY_INVARIANTS,
  assertInvariantsNotDisabled,
  GOV_INVARIANT_OVERRIDE_SCHEMA,
  coordIndex,
  coordFromIndex,
  DIMENSION_COORD_SCHEMA,
  E06_FEATURE_IDS,
  DIMENSION_COORD_REGISTRY,
  assertBridgeTimeOnlyMove,
  CAPABILITY_KB_COORD,
  PROCESS_KB_COORD,
  type DimensionCoord,
} from "./kb-governance"

describe("E-06 三安全不变量（GOV-OBS-05 / GOV-EVAL-08：MUST NOT 运行时关闭）", () => {
  it("常量冻结（Object.isFrozen）且三键齐备", () => {
    expect(Object.isFrozen(SAFETY_INVARIANTS)).toBe(true)
    expect(SAFETY_INVARIANTS.fold_atomic_fsync).toBe(true)
    expect(SAFETY_INVARIANTS.tech_visible_to_agent).toBe(false)
    expect(SAFETY_INVARIANTS.promotion_require_accept).toBe(true)
  })

  it("任何 override 键（含三不变量名）→ parse throw", () => {
    expect(() => assertInvariantsNotDisabled({})).not.toThrow()
    expect(() => assertInvariantsNotDisabled({ fold_atomic_fsync: false })).toThrow()
    expect(() => assertInvariantsNotDisabled({ tech_visible_to_agent: true })).toThrow()
    expect(() => assertInvariantsNotDisabled({ promotion_require_accept: false })).toThrow()
    expect(() => assertInvariantsNotDisabled({ unknown_key: 1 })).toThrow()
    expect(() => GOV_INVARIANT_OVERRIDE_SCHEMA.parse({ any: "key" })).toThrow()
  })

  it("导出面无 setter/toggle/enable 前缀（无关闭 API）", () => {
    const exported = Object.keys(
      Object.fromEntries(
        Object.entries({
          SAFETY_INVARIANTS,
          assertInvariantsNotDisabled,
          GOV_INVARIANT_OVERRIDE_SCHEMA,
          coordIndex,
          coordFromIndex,
          DIMENSION_COORD_SCHEMA,
          E06_FEATURE_IDS,
          DIMENSION_COORD_REGISTRY,
          assertBridgeTimeOnlyMove,
          CAPABILITY_KB_COORD,
          PROCESS_KB_COORD,
        }),
      ),
    )
    for (const key of exported) {
      expect(key).not.toMatch(/^(set|enable|toggle)/)
    }
  })
})

describe("E-06 DimensionCoord 27 格（GOV-REV-02/06，G-8）", () => {
  it("coordIndex 双射：27 个 index 往返一致", () => {
    for (let i = 0; i < 27; i++) {
      const c = coordFromIndex(i)
      expect(coordIndex(c)).toBe(i)
    }
  })

  it("越界 index → throw", () => {
    expect(() => coordFromIndex(-1)).toThrow()
    expect(() => coordFromIndex(27)).toThrow()
  })

  it("schema 校验合法坐标 + 拒绝非法轴", () => {
    const ok = DIMENSION_COORD_SCHEMA.parse({
      featureId: "test",
      space: "Decoupled",
      time: "Replay",
      trust: "Sovereign",
      reversibility: { mechanism: "replay", rollbackPath: "重放" },
    })
    expect(ok.space).toBe("Decoupled")
    expect(() =>
      DIMENSION_COORD_SCHEMA.parse({
        featureId: "test",
        space: "Sovereign", // 非法空间轴（REQ 枚举无此档）
        time: "Sync",
        trust: "Fixed",
        reversibility: { mechanism: "flag", rollbackPath: "x" },
      }),
    ).toThrow()
  })

  it("注册表完备性：E06_FEATURE_IDS ⊆ registry 键（验收 7 机器化）", () => {
    const registryKeys = new Set(Object.keys(DIMENSION_COORD_REGISTRY))
    for (const id of E06_FEATURE_IDS) {
      expect(registryKeys.has(id)).toBe(true)
    }
    expect(registryKeys.size).toBe(E06_FEATURE_IDS.length)
  })

  it("每坐标 reversibility.rollbackPath 非空（验收 7 强制）", () => {
    for (const id of E06_FEATURE_IDS) {
      const coord = DIMENSION_COORD_REGISTRY[id]
      expect(coord.reversibility.rollbackPath.length).toBeGreaterThan(0)
    }
  })

  it("基线坐标 = REQ GOV-REV-02 原文（能力库=Decoupled/Async/Tunable，过程库=Coupled/Sync/Sovereign）", () => {
    expect(CAPABILITY_KB_COORD).toEqual({ space: "Decoupled", time: "Async", trust: "Tunable" })
    expect(PROCESS_KB_COORD).toEqual({ space: "Coupled", time: "Sync", trust: "Sovereign" })
  })

  it("assertBridgeTimeOnlyMove：仅 Time 轴移动合法；space/trust 变化 throw", () => {
    const prev: DimensionCoord = {
      featureId: "promotion-lifecycle-transition",
      space: "Decoupled",
      time: "Sync",
      trust: "Sovereign",
      reversibility: { mechanism: "replay", rollbackPath: "x" },
    }
    const timeOnly: DimensionCoord = { ...prev, time: "Replay" }
    expect(() => assertBridgeTimeOnlyMove(prev, timeOnly)).not.toThrow()
    const spaceMove: DimensionCoord = { ...prev, space: "Coupled" }
    expect(() => assertBridgeTimeOnlyMove(prev, spaceMove)).toThrow(/Time axis/)
    const trustMove: DimensionCoord = { ...prev, trust: "Fixed" }
    expect(() => assertBridgeTimeOnlyMove(prev, trustMove)).toThrow(/Time axis/)
  })
})
