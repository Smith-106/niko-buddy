/**
 * offline-replay-harness.spec.ts — T02 离线回放 harness (F-31 / A-05.2 / A-01.2)
 *
 * 蓝图 §6 P0 T02 收敛条件:
 *   "≥5 真实章节状态序列可重放产出评分；因子权重改动需重跑基线；阈值含候选值+重基线机制"
 *
 * 本 spec 是 T31 `node scripts/offline-replay.js --score` 评分判定的地基 (A-05.2),
 * 断言口径与 runner 同源 (均调用 `replayStates` / `scoreReplay`)。
 *
 * 执行纪律:
 *   - ADR-19 机械层零 LLM: harness + config 全程不调用 LLM / IO / Tauri invoke。
 *   - Draft-first (ADR-08): 本文件是新增 spec, 不触及 .novel/status.json 正式层。
 *   - type-only: ControlState 在 P0 仅作 type 契约, route() (T08) 落地前无运行时依赖。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  buildDecisionLogEntry,
  normalizeWallClock,
  OFFLINE_REPLAY_FACTOR_WEIGHTS,
  OFFLINE_REPLAY_QUALITY_THRESHOLD,
  OFFLINE_REPLAY_THRESHOLDS,
  OFFLINE_REPLAY_WALLCLOCK_REFERENCE_SECONDS,
  OFFLINE_REPLAY_WEIGHT_SUM,
  REBASE_REQUIRED_WHEN_WEIGHT_DRIFTS,
  replayStates,
  scoreReplay,
  type ControlState,
} from "./offline-replay-config"

const NOVEL_DIR = resolve(__dirname)

function readSource(rel: string): string {
  return readFileSync(resolve(NOVEL_DIR, rel), "utf-8")
}

// ============================================================================
// ≥5 真实章节状态序列 (A-01.2 harness ≥5 序列可重放)
// ============================================================================

/**
 * 5 个真实章节状态序列 (A-01.2). 模拟一部 5 章书稿的离线回放:
 *   - 第 1 章: legacy 分支, 人工参照=legacy (一致), 重放=legacy (自一致), 门控过, 90s
 *   - 第 2 章: authoritative 分支, 参照=authoritative (一致), 重放=authoritative (自一致), 门控过, 120s
 *   - 第 3 章: authoritative 分支, 参照=legacy (不一致 — 分支一致率分子减 1), 重放=authoritative (自一致), 门控过, 200s
 *   - 第 4 章: legacy 分支, 参照=legacy (一致), 重放=authoritative (不自一致), 门控不过 (Consistency 硬门失败), 300s
 *   - 第 5 章: premium 分支, 参照=premium (一致), 重放=premium (自一致), 门控过, 500s
 * 覆盖: 一致/不一致, 自一致/不自一致, 门控过/不过, 墙钟 0/低/高/超限 全分支。
 */
const FIVE_CHAPTER_STATES: ControlState[] = [
  { chapterNumber: 1, branchId: "legacy", referenceBranchId: "legacy", replayBranchId: "legacy", gatePassed: true, wallClockSeconds: 90 },
  { chapterNumber: 2, branchId: "authoritative", referenceBranchId: "authoritative", replayBranchId: "authoritative", gatePassed: true, wallClockSeconds: 120 },
  { chapterNumber: 3, branchId: "authoritative", referenceBranchId: "legacy", replayBranchId: "authoritative", gatePassed: true, wallClockSeconds: 200 },
  { chapterNumber: 4, branchId: "legacy", referenceBranchId: "legacy", replayBranchId: "authoritative", gatePassed: false, wallClockSeconds: 300 },
  { chapterNumber: 5, branchId: "premium", referenceBranchId: "premium", replayBranchId: "premium", gatePassed: true, wallClockSeconds: 500 },
]

// 第 6 章: 全部缺失参照/重放 → 因子分母为 0 的边界 (覆盖率: 空参照/空重放分支)。
const SIXTH_STATE_NO_REFS: ControlState = {
  chapterNumber: 6,
  branchId: "legacy",
  gatePassed: true,
  wallClockSeconds: 100,
}

describe("T02 offline-replay-harness (F-31 / A-05.2)", () => {
  describe("config 不变量 (T02 定稿值 + 重基线机制)", () => {
    it("四因子默认权重和 == 1.0 (自检不变量, 漂移则需重基线)", () => {
      expect(OFFLINE_REPLAY_WEIGHT_SUM).toBeCloseTo(1.0, 9)
      expect(OFFLINE_REPLAY_FACTOR_WEIGHTS.branchAgreement).toBe(0.35)
      expect(OFFLINE_REPLAY_FACTOR_WEIGHTS.selfConsistency).toBe(0.3)
      expect(OFFLINE_REPLAY_FACTOR_WEIGHTS.gatePass).toBe(0.25)
      expect(OFFLINE_REPLAY_FACTOR_WEIGHTS.wallClock).toBe(0.1)
    })

    it("达标阈值候选值 (PROVISIONAL — T18 复核): 分支一致率/自一致性/门控/墙钟四值齐备", () => {
      expect(OFFLINE_REPLAY_THRESHOLDS.branchAgreement).toBe(0.9)
      expect(OFFLINE_REPLAY_THRESHOLDS.selfConsistency).toBe(0.95)
      expect(OFFLINE_REPLAY_THRESHOLDS.gatePass).toBe(1.0)
      expect(OFFLINE_REPLAY_THRESHOLDS.wallClockSeconds).toBe(600)
      // 综合达标线候选值齐备。
      expect(OFFLINE_REPLAY_QUALITY_THRESHOLD).toBe(0.9)
      // 墙钟归一参考上限与阈值墙钟同源 (T34 telemetry 校准前)。
      expect(OFFLINE_REPLAY_WALLCLOCK_REFERENCE_SECONDS).toBe(OFFLINE_REPLAY_THRESHOLDS.wallClockSeconds)
    })

    it("重基线机制注记存在 (蓝图 T02: 因子权重改动需重跑基线)", () => {
      expect(REBASE_REQUIRED_WHEN_WEIGHT_DRIFTS).toBe(true)
      // 当前默认权重和 == 1.0, 故当前不需要重基线。
      const score = scoreReplay(FIVE_CHAPTER_STATES)
      expect(score.rebasingRequired).toBe(false)
    })
  })

  describe("normalizeWallClock (ADR-19 纯算术)", () => {
    it("秒数 0 → 归一分 1 (最快); 超过参考上限 → 0; 线性插值中间值", () => {
      expect(normalizeWallClock(0)).toBe(1)
      expect(normalizeWallClock(OFFLINE_REPLAY_WALLCLOCK_REFERENCE_SECONDS)).toBe(0)
      expect(normalizeWallClock(OFFLINE_REPLAY_WALLCLOCK_REFERENCE_SECONDS + 1)).toBe(0)
      // 中点: 300s / 600s → 0.5
      expect(normalizeWallClock(300, 600)).toBeCloseTo(0.5, 5)
    })

    it("参考上限 <= 0 时归一分为 0 (防除零, 机械层防御)", () => {
      expect(normalizeWallClock(10, 0)).toBe(0)
      expect(normalizeWallClock(10, -1)).toBe(0)
    })
  })

  describe("buildDecisionLogEntry (单章决策日志)", () => {
    it("分支一致 / 自一致 / 门控 / 墙钟四信号正确映射", () => {
      const entry = buildDecisionLogEntry(FIVE_CHAPTER_STATES[0])
      expect(entry.chapterNumber).toBe(1)
      expect(entry.branchId).toBe("legacy")
      expect(entry.branchAgreement).toBe(true)
      expect(entry.selfConsistent).toBe(true)
      expect(entry.gatePassed).toBe(true)
      expect(entry.wallClockSeconds).toBe(90)
    })

    it("缺参照 / 缺重放时 branchAgreement / selfConsistent 均为 false (分母不存在的保守判定)", () => {
      const entry = buildDecisionLogEntry(SIXTH_STATE_NO_REFS)
      expect(entry.branchAgreement).toBe(false)
      expect(entry.selfConsistent).toBe(false)
      expect(entry.gatePassed).toBe(true)
    })
  })

  describe("scoreReplay (≥5 真实章节状态序列可重放产出评分 — A-01.2)", () => {
    it("5 章真实序列重放: 四因子实测值与加权综合分正确", () => {
      const q = scoreReplay(FIVE_CHAPTER_STATES)

      // 分支一致率: 一致章数 / 有参照章数 = 4 / 5 = 0.8
      //   (第 3 章 branchId=authoritative vs reference=legacy → 不一致)
      expect(q.branchAgreementRate).toBeCloseTo(0.8, 5)
      // 自一致性: 自一致章数 / 有重放章数 = 4 / 5 = 0.8
      //   (第 4 章 branchId=legacy vs replay=authoritative → 不自一致)
      expect(q.selfConsistencyRate).toBeCloseTo(0.8, 5)
      // 门控通过率: 4 / 5 = 0.8 (第 4 章 gatePassed=false)
      expect(q.gatePassRate).toBeCloseTo(0.8, 5)
      // 墙钟归一均值: (1-90/600 + 1-120/600 + 1-200/600 + 1-300/600 + 1-500/600) / 5
      //   = (0.85 + 0.8 + 0.6667 + 0.5 + 0.1667) / 5 = 2.9833/5 ≈ 0.59667
      const expectedWallNorm =
        (1 - 90 / 600 + 1 - 120 / 600 + 1 - 200 / 600 + 1 - 300 / 600 + 1 - 500 / 600) / 5
      expect(q.wallClockNormalized).toBeCloseTo(expectedWallNorm, 5)

      // 加权综合分: 0.35*0.8 + 0.3*0.8 + 0.25*0.8 + 0.1*wallNorm
      const expectedComposite =
        0.35 * 0.8 + 0.3 * 0.8 + 0.25 * 0.8 + 0.1 * expectedWallNorm
      expect(q.compositeScore).toBeCloseTo(expectedComposite, 5)

      // 默认权重和 == 1.0 → 不需要重基线。
      expect(q.rebasingRequired).toBe(false)
    })

    it("空序列 → 全因子 0, 不达标, 不重基线 (权重未漂移)", () => {
      const q = scoreReplay([])
      expect(q.branchAgreementRate).toBe(0)
      expect(q.selfConsistencyRate).toBe(0)
      expect(q.gatePassRate).toBe(0)
      expect(q.wallClockNormalized).toBe(0)
      expect(q.compositeScore).toBe(0)
      expect(q.meetsThreshold).toBe(false)
      // 默认权重和 == 1.0 → rebasingRequired = false。
      expect(q.rebasingRequired).toBe(false)
    })

    it("含无参照/无重放章的序列: 因子分母按有数据章计数 (保守 0 不计入分母膨胀)", () => {
      const q = scoreReplay([...FIVE_CHAPTER_STATES, SIXTH_STATE_NO_REFS])
      // 分支一致率: 仍 4 一致 / 5 有参照 = 0.8 (第 6 章无参照不计入分母)
      expect(q.branchAgreementRate).toBeCloseTo(0.8, 5)
      // 自一致性: 仍 4 / 5 = 0.8 (第 6 章无重放不计入分母)
      expect(q.selfConsistencyRate).toBeCloseTo(0.8, 5)
      // 门控通过率: 5 过 / 6 总 ≈ 0.8333 (第 6 章门控过, 计入分母)
      expect(q.gatePassRate).toBeCloseTo(5 / 6, 5)
    })
  })

  describe("replayStates (决策日志 + 质量分 同源合成 — T31 --score 口径一致)", () => {
    it("5 章序列重放产出决策日志 (5 条) + 质量分 + stateCount", () => {
      const result = replayStates(FIVE_CHAPTER_STATES)

      expect(result.stateCount).toBe(5)
      expect(result.decisionLog).toHaveLength(5)

      // 决策日志逐章断言: 分支一致 / 自一致 / 门控 信号正确。
      expect(result.decisionLog[0]).toMatchObject({
        chapterNumber: 1,
        branchId: "legacy",
        branchAgreement: true,
        selfConsistent: true,
        gatePassed: true,
        wallClockSeconds: 90,
      })
      expect(result.decisionLog[2]).toMatchObject({
        chapterNumber: 3,
        branchId: "authoritative",
        branchAgreement: false,
        selfConsistent: true,
        gatePassed: true,
      })
      expect(result.decisionLog[3]).toMatchObject({
        chapterNumber: 4,
        branchId: "legacy",
        branchAgreement: true,
        selfConsistent: false,
        gatePassed: false,
      })

      // 质量分与 scoreReplay 单独调用同值 (同源纯函数)。
      const direct = scoreReplay(FIVE_CHAPTER_STATES)
      expect(result.quality.compositeScore).toBeCloseTo(direct.compositeScore, 9)
      expect(result.quality.branchAgreementRate).toBeCloseTo(direct.branchAgreementRate, 9)
    })

    it("重放结果可序列化为决策日志 + 质量分 JSON (T31 runner --score 输出契约)", () => {
      const result = replayStates(FIVE_CHAPTER_STATES)
      const json = JSON.stringify(result)
      const parsed = JSON.parse(json)

      expect(parsed.decisionLog).toHaveLength(5)
      expect(parsed.quality).toHaveProperty("compositeScore")
      expect(parsed.quality).toHaveProperty("meetsThreshold")
      expect(parsed.stateCount).toBe(5)
    })
  })

  describe("ADR-19 机械层零 LLM (与 emotion-ledger.ts 同型态硬验证)", () => {
    it("offline-replay-config.ts 不含任何 LLM / invoke / IO 调用", () => {
      const src = readSource("offline-replay-config.ts")
      expect(src).not.toMatch(/\bstreamChat\b/)
      expect(src).not.toMatch(/from\s+["']@\/lib\/llm-client["']/)
      expect(src).not.toMatch(/\bawait\s+invoke\b/)
      expect(src).not.toMatch(/\bfetch\s*\(/)
      // 不读 .novel/status.json (Draft-first: 不触正式层)。
      expect(src).not.toMatch(/status\.json/)
    })
  })

  describe("Draft-first (ADR-08) — 新增文件不污染正式层", () => {
    it("harness 不引入草稿正式层写回 (pending/ready 草稿机制不动)", () => {
      const src = readSource("offline-replay-config.ts")
      // 本任务是新增 spec/源文件, 不写 draft 目录 / 不写 status.json / 不调写回 API。
      expect(src).not.toMatch(/\.novel\//)
      expect(src).not.toMatch(/writeFileAtomic/)
      expect(src).not.toMatch(/createAtomicJsonStore/)
    })
  })
})
