/**
 * v2611.dod.spec.ts — v2.6.11 DoD 断言（蓝图 blueprint-v2611 §3）
 *
 * 迁移自 scripts/archive/verify-dod/verify-dod-v2611.js（2026-09-09）。
 *
 * 迁移注记：原脚本结构性坏死（kappaAgreement 从未导出，加载即 SyntaxError，
 * 全部断言永不执行）。kappaAgreement 已于 2026-09-09 在 gray-zone-review.ts
 * 实现并导出（内联 Cohen κ，与 novel 域 corpus-kappa.ts 同族数学）。
 *
 * 适配说明（① 组 2/3 断言）：原脚本调用 evaluateGrayZone(0.5) 单参愿景 API
 * （inGrayZone / reviewEntry 属性——从未在 src 实现过）。已按真实 API
 * evaluateGrayZone(grayTotal, grayMisjudged, outsideMisjudgeRate) 的语义
 * 适配：灰区 100% 全量人工复审（reviewed === total，无静默丢弃）与边界
 * 稳定判定（误判率比 ≤1.5×）保留原断言意图。其余 11 断言 API 完全匹配，
 * 输入字面量逐字节保留。
 */
import { describe, expect, it } from "vitest"
import { buildFingerprint, detectDrift, verifyAnchorKey } from "../domain-drift-baseline"
import { evaluateCrossDimension } from "../cross-dimension-gate"
import { evaluateFullWindowDrift, verifyZeroFalseKill } from "../full-window-drift-gate"
import { evaluateP0Lock, closeLockedItem, verifyLockScope, verifyNoQualityOverride } from "../p0-lock"
import { monitorFdr } from "../fdr-monitor"
import { evaluateGrayZone, kappaAgreement, GRAY_KAPPA_QUALIFIED } from "../gray-zone-review"

describe("DoD v2.6.11 三闭环断言（blueprint-v2611 §3）", () => {
  // ① D6 漂移→灰区复核（原愿景 API 按真实 3 参 API 语义适配）
  describe("① D6 漂移→灰区复核", () => {
    it("① 灰区 100% 入复核队列（无静默丢弃）", () => {
      const gray = evaluateGrayZone(20, 3, 0.05)
      expect(gray.reviewed).toBe(gray.total)
    })
    it("① 灰区边界不稳→触发复核（误判率比 >1.5×）", () => {
      const gray = evaluateGrayZone(20, 6, 0.1) // 灰区误判率 0.3 > 区间外 1.5×0.1
      expect(gray.boundaryStable).toBe(false)
    })
    it("① Kappa≥0.7 生效", () => {
      expect(kappaAgreement([true, true, false], [true, true, false])).toBeGreaterThanOrEqual(
        GRAY_KAPPA_QUALIFIED,
      )
    })
  })

  // ② D7 P0 失败→锁死：注入 P0 失败 → BLOCK + Quality 不得覆盖
  describe("② D7 P0 失败→锁死", () => {
    const lock = evaluateP0Lock(["consistency"], ["q0-item-1"])

    it("② P0 失败→LOCKED+BLOCK", () => {
      expect(lock.state).toBe("LOCKED")
      expect(lock.blocked).toBe(true)
    })
    it("② 锁触发输出集=P0∪D8 未清（禁止静默清零）", () => {
      expect(lock.lockedItems).toContain("consistency")
      expect(lock.lockedItems).toContain("q0-item-1")
    })
    it("② 显式 close 才缩减（未列名项不清零）", () => {
      const closed = closeLockedItem(
        { p0Failures: ["consistency"], q0Pending: ["q0-item-1"] },
        "consistency",
      )
      expect(closed.q0Pending).toHaveLength(1)
    })
    it("② 锁死严格限定 P0", () => {
      expect(verifyLockScope(["consistency"], ["consistency", "anti_ai"])).toBe(true)
    })
    it("② 对抗性负向：Quality 高分不得解锁", () => {
      expect(verifyNoQualityOverride(lock, 9.5)).toBe(true)
    })
  })

  // ③ D8 漂移门→Q0 重审计：构造跨阈漂移 → 触发重检
  describe("③ D8 漂移门→Q0 重审计", () => {
    it("③ 跨阈漂移→触发重检", () => {
      const drift = evaluateFullWindowDrift([0.5, 0.5, 0.5, 1.0, 1.0, 1.0])
      expect(drift.triggered).toBe(true)
      expect(drift.chaptersToRecheck.length).toBeGreaterThan(0)
    })
    it("③ 合法手法零误杀", () => {
      expect(verifyZeroFalseKill([[0.5, 0.52, 0.48, 0.51, 0.5, 0.49]], evaluateFullWindowDrift)).toBe(true)
    })
  })

  // 硬门 4 补充断言（D1/D4）
  describe("硬门 4 补充（D1/D4）", () => {
    it("D1 三元组锚定", () => {
      expect(verifyAnchorKey({ chapter: 3, model: "m", prompt: "p" })).toBe(true)
    })
    it("D1 同分布无漂移", () => {
      const fp = buildFingerprint([
        [1, 2, 3],
        [1.1, 2.1, 3.1],
        [0.9, 1.9, 2.9],
      ])
      expect(detectDrift(fp, [1, 2, 3]).drifted).toBe(false)
    })
    it("D4 单维矛盾→灰区（不杀）", () => {
      const verdict = evaluateCrossDimension({
        thril: 9.0,
        pacing: 6.0,
        pull: 8.0,
        context: 8.0,
        consistency: 9.0,
        anti_ai: 8.0,
      }).verdict
      expect(verdict).toBe("gray")
    })
  })

  // 观测 2（D2/D6 留痕）
  describe("观测 2（D2/D6 留痕）", () => {
    it("观测 D2 FDR 监控留痕", () => {
      expect(monitorFdr([0.01]).observationOnly).toBe(true)
    })
  })
})
