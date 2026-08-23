/**
 * offline-replay-config.ts — T02 离线回放评分因子 config (F-31 / A-05.2)
 *
 * 职责 (T02 蓝图 §6 P0):
 *   定义离线回放评分四因子 (分支一致率 / 自一致性 / 门控通过率 / 墙钟) 的
 *   默认权重 + 达标阈值候选值 + 重基线机制注记。
 *
 * 定位与边界:
 *   - P0 type-only 契约承载者: route() 内核 (T08 control-kernel) 尚未落地,
 *     本模块不引入运行时依赖, 仅导出纯数据常量 + 纯算术评分合成函数。
 *   - 机械层零 LLM (ADR-19): 本模块与 harness 全程不调用任何 LLM / IO / Tauri invoke,
 *     评分合成仅四因子加权算术 (与 emotion-ledger.ts 同型态)。
 *   - Draft-first (ADR-08): harness 是新增 spec/源文件, 不写入运行时会话状态文件,
 *     不回填正式正文 / 记忆, 不触及草稿正式层。
 *
 * 阈值与权重的定稿口径 (蓝图 §6 T02 / §7 A-05.2 原文):
 *   "默认权重=T02 定稿值" + "评分达标阈值候选值" +
 *   "T18 后复核定稿, 不拍脑袋定死"。
 *   → 本文件公布的是 **候选值 (proposed)**, 显式标注 `PROVISIONAL` 与复核阶段 (T18),
 *     任何权重 / 阈值改动必须触发重基线 (`rebasingRequired`)。
 *
 * 评分因子 (A-05.2 两项可测指标 + 配套机械因子):
 *   ① branchAgreementRate — 与人工修订参照的分支选择一致率 (A-05.2 指标①, [0,1])
 *   ② selfConsistencyRate  — 同章重放×2 自一致性 (A-05.2 指标②, [0,1])
 *   ③ gatePassRate         — 机械门控通过率 (Track A: P0>P1>P2, [0,1])
 *   ④ wallClockSeconds     — 单章墙钟 (秒, 越低越好, 下界 0)
 *
 * 默认权重 (T02 定稿值, 提案): branchAgreement=0.35, selfConsistency=0.30,
 *   gatePass=0.25, wallClock=0.10 (四者归一和=1.0)。墙钟因子先归一化到 [0,1]
 *   再加权 (越快越高分), 故加权前需一个参考墙钟上限做归一。
 */

// ============================================================================
// 默认权重 (T02 定稿值, 提案 PROVISIONAL — T18 复核)
// ============================================================================

/**
 * 评分因子默认权重 (T02 定稿值, 提案)。
 * 归一和 == 1.0。任意改动 → rebasingRequired=true, 必须重跑基线。
 */
export const OFFLINE_REPLAY_FACTOR_WEIGHTS = {
  /** 与人工修订参照的分支选择一致率 (A-05.2 ①) */
  branchAgreement: 0.35,
  /** 同章重放×2 自一致性 (A-05.2 ②) */
  selfConsistency: 0.3,
  /** 机械门控通过率 (Track A P0>P1>P2) */
  gatePass: 0.25,
  /** 单章墙钟 (归一化后, 越快越高分) */
  wallClock: 0.1,
} as const

/** 权重归一和 (自检不变量, 测试断言 == 1.0) */
export const OFFLINE_REPLAY_WEIGHT_SUM =
  OFFLINE_REPLAY_FACTOR_WEIGHTS.branchAgreement +
  OFFLINE_REPLAY_FACTOR_WEIGHTS.selfConsistency +
  OFFLINE_REPLAY_FACTOR_WEIGHTS.gatePass +
  OFFLINE_REPLAY_FACTOR_WEIGHTS.wallClock

// ============================================================================
// 达标阈值候选值 (PROVISIONAL — T18 复核定稿)
// ============================================================================

/**
 * 评分达标阈值候选值 (蓝图 A-05.2: "阈值候选值 T02 定、T18 后复核定稿")。
 * 全部标注 PROVISIONAL: T18 复核前不得作为产品硬门; harness 仅作诊断输出。
 */
export const OFFLINE_REPLAY_THRESHOLDS = {
  /** 分支选择一致率达标线 (A-05.2 ①) — 候选, T18 复核 */
  branchAgreement: 0.9,
  /** 同章重放自一致性达标线 (A-05.2 ②) — 候选, T18 复核 */
  selfConsistency: 0.95,
  /** 机械门控通过率达标线 (Track A) — 候选, T18 复核 */
  gatePass: 1.0,
  /** 单章墙钟上限 (秒) — 候选, T18 复核 (T34 telemetry 校准) */
  wallClockSeconds: 600,
} as const

/**
 * 综合质量分达标线 (四因子加权后, [0,1]) — 候选, T18 复核。
 * 注: P0/P1 硬门 (Consistency/Anti-AI) 不可被 Quality 覆盖 (蓝图三硬约束),
 * 本综合分仅作 A-05.2 离线回放评分诊断, 非产品发布硬门。
 */
export const OFFLINE_REPLAY_QUALITY_THRESHOLD = 0.9

// ============================================================================
// 墙钟归一参考上限 (墙钟因子归一化用)
// ============================================================================

/**
 * 墙钟归一参考上限 (秒): wallClockSeconds 超过此值则归一分为 0。
 * 与 OFFLINE_REPLAY_THRESHOLDS.wallClockSeconds 同值 (T34 telemetry 校准前)。
 */
export const OFFLINE_REPLAY_WALLCLOCK_REFERENCE_SECONDS =
  OFFLINE_REPLAY_THRESHOLDS.wallClockSeconds

// ============================================================================
// 重基线机制 (蓝图 T02 原文: "因子权重改动需重跑基线")
// ============================================================================

/**
 * 重基线机制注记 (蓝图 T02 / A-05.2):
 *   - 权重或阈值候选值任意改动 → `rebasingRequired` 必须置 true,
 *     并必须重跑 T31 离线回放基线 (`node scripts/offline-replay.js --score`)。
 *   - 阈值最终值 T18 (P1 垂直切片硬门) 后由实测复核定稿, 复核前为 PROVISIONAL。
 *   - 本常量是 harness 自检信号: 检测到权重和 != 1.0 时强制要求重基线。
 */
export const REBASE_REQUIRED_WHEN_WEIGHT_DRIFTS = true

// ============================================================================
// 类型契约 (P0 type-only — ControlState)
// ============================================================================

/**
 * 控制态 (P0 type-only 契约, 蓝图 T02: "ControlState 类型在 P0 内 type-only 定义")。
 *
 * 这是离线回放 harness 消费的 **状态序列单帧** 契约。route() 内核 (T08
 * control-kernel) 落地前, 这里给出 type-only 契约, 供 harness 与 runner
 * 复用; route() 落地后可由 control-kernel 复用 / 收编此类型, 但 P0 阶段
 * harness 不反向依赖 route() (route() 此刻不存在, ADR-19 机械层零 LLM)。
 *
 * 字段语义 (A-05.2 两指标 + 机械门控 + 墙钟所需的输入信号):
 *   - chapterNumber: 章节序号 (1-based)
 *   - branchId:     该章 route() 选择的分支标识 (legacy / authoritative / premium ...)
 *   - referenceBranchId: 人工修订参照分支 (A-05.2 ① 分支一致率分子用)
 *   - replayBranchId:    同章重放×2 的第二份分支 (A-05.2 ② 自一致性分子用)
 *   - gatePassed:        该章机械门控是否通过 (Track A: Consistency>P0? / Anti-AI? / Quality?)
 *   - wallClockSeconds:  该章生成墙钟 (秒, A-05.2 墙钟因子)
 */
export interface ControlState {
  chapterNumber: number
  branchId: string
  referenceBranchId?: string
  replayBranchId?: string
  gatePassed: boolean
  wallClockSeconds: number
}

/** 回放产出的单章决策日志条目 */
export interface ReplayDecisionLogEntry {
  chapterNumber: number
  branchId: string
  branchAgreement: boolean
  selfConsistent: boolean
  gatePassed: boolean
  wallClockSeconds: number
}

/** 回放产出的质量评分结果 (四因子 + 加权综合分 + 达标判定) */
export interface ReplayQualityScore {
  /** 四因子实测值 (墙钟已归一化到 [0,1]) */
  branchAgreementRate: number
  selfConsistencyRate: number
  gatePassRate: number
  wallClockNormalized: number
  /** 加权综合质量分 [0,1] */
  compositeScore: number
  /** 是否达到 PROVISIONAL 综合达标线 */
  meetsThreshold: boolean
  /** 是否需要重基线 (权重漂移时 true) */
  rebasingRequired: boolean
}

// ============================================================================
// 纯算术评分合成 (ADR-19 机械层零 LLM)
// ============================================================================

/** 墙钟归一化: 越快越高分 [0,1], 超过参考上限截断为 0。 */
export function normalizeWallClock(
  seconds: number,
  referenceSeconds: number = OFFLINE_REPLAY_WALLCLOCK_REFERENCE_SECONDS,
): number {
  if (referenceSeconds <= 0) return 0
  if (seconds <= 0) return 1
  const ratio = seconds / referenceSeconds
  if (ratio >= 1) return 0
  return 1 - ratio
}

/**
 * 从状态序列合成单章决策日志 (A-05.2 ①② + 门控 + 墙钟)。
 * 纯函数, 无 IO / 无 LLM。
 */
export function buildDecisionLogEntry(state: ControlState): ReplayDecisionLogEntry {
  const branchAgreement =
    state.referenceBranchId !== undefined && state.referenceBranchId === state.branchId
  const selfConsistent =
    state.replayBranchId !== undefined && state.replayBranchId === state.branchId
  return {
    chapterNumber: state.chapterNumber,
    branchId: state.branchId,
    branchAgreement,
    selfConsistent,
    gatePassed: state.gatePassed,
    wallClockSeconds: state.wallClockSeconds,
  }
}

/**
 * 从状态序列合成四因子 + 加权综合质量分 (ADR-19 机械层零 LLM 纯算术)。
 *
 * 因子:
 *   branchAgreementRate = 一致章数 / 有参照章数 (无参照章计入分母为 0 → 视为未达标)
 *   selfConsistencyRate  = 自一致章数 / 有重放章数 (无重放章同上)
 *   gatePassRate         = 门控通过章数 / 总章数
 *   wallClockNormalized  = mean(各章墙钟归一分)
 * compositeScore = Σ(权重 * 因子), 权重和漂移 (≠1.0) 时 rebasingRequired=true。
 */
export function scoreReplay(states: ControlState[]): ReplayQualityScore {
  const n = states.length
  if (n === 0) {
    return {
      branchAgreementRate: 0,
      selfConsistencyRate: 0,
      gatePassRate: 0,
      wallClockNormalized: 0,
      compositeScore: 0,
      meetsThreshold: false,
      rebasingRequired: REBASE_REQUIRED_WHEN_WEIGHT_DRIFTS && Math.abs(OFFLINE_REPLAY_WEIGHT_SUM - 1) > 1e-9,
    }
  }

  let branchAgreeCount = 0
  let branchRefCount = 0
  let selfConsistCount = 0
  let replayCount = 0
  let gatePassCount = 0
  let wallClockNormSum = 0

  for (const s of states) {
    if (s.referenceBranchId !== undefined) {
      branchRefCount += 1
      if (s.referenceBranchId === s.branchId) branchAgreeCount += 1
    }
    if (s.replayBranchId !== undefined) {
      replayCount += 1
      if (s.replayBranchId === s.branchId) selfConsistCount += 1
    }
    if (s.gatePassed) gatePassCount += 1
    wallClockNormSum += normalizeWallClock(s.wallClockSeconds)
  }

  const branchAgreementRate = branchRefCount > 0 ? branchAgreeCount / branchRefCount : 0
  const selfConsistencyRate = replayCount > 0 ? selfConsistCount / replayCount : 0
  const gatePassRate = gatePassCount / n
  const wallClockNormalized = wallClockNormSum / n

  const w = OFFLINE_REPLAY_FACTOR_WEIGHTS
  const compositeScore =
    w.branchAgreement * branchAgreementRate +
    w.selfConsistency * selfConsistencyRate +
    w.gatePass * gatePassRate +
    w.wallClock * wallClockNormalized

  const weightDrift = Math.abs(OFFLINE_REPLAY_WEIGHT_SUM - 1) > 1e-9

  return {
    branchAgreementRate,
    selfConsistencyRate,
    gatePassRate,
    wallClockNormalized,
    compositeScore,
    meetsThreshold: compositeScore >= OFFLINE_REPLAY_QUALITY_THRESHOLD,
    rebasingRequired: REBASE_REQUIRED_WHEN_WEIGHT_DRIFTS && weightDrift,
  }
}

/**
 * 从状态序列产出完整回放结果 (决策日志 + 质量分)。
 * harness 与 runner 共用此入口, 保证口径一致 (T31 `--score` 与 spec 断言同源)。
 */
export interface ReplayResult {
  decisionLog: ReplayDecisionLogEntry[]
  quality: ReplayQualityScore
  /** 输入状态序列长度 (诊断用) */
  stateCount: number
}

export function replayStates(states: ControlState[]): ReplayResult {
  const decisionLog = states.map(buildDecisionLogEntry)
  const quality = scoreReplay(states)
  return {
    decisionLog,
    quality,
    stateCount: states.length,
  }
}

// ============================================================================
// T36 A/B 双臂配对统计 (premium-mode-ab 五门槛① 的共享纯算术)
// ============================================================================
//
// 归属 (TASK-P6-36): `scripts/offline-replay.js --ab` 双臂配对验收的门槛①统计量
//   「六维 overall 中位差 (精品臂 − 基线臂) ≥ +0.5 且 bootstrap 95%CI 不含 0」。
// 放在本文件 (而非 driver/spec 各写一份) 的理由: S10 §五.2 禁止出现第二套独立
//   评分实现——driver 与证据 spec 必须同源复算交叉验证 (T31 模式), 本文件同时被
//   两者 import (Node type-stripping 直读, 故保持零 value-import 不变)。
// 口径:
//   - 配对单位 = 同书同章同 task_brief 的双臂各得一个六维等权中位 overall 分;
//   - 统计量 = median(premium_i − baseline_i) (配对中位差);
//   - CI = 配对 bootstrap (有放回重采样配对单位) 百分位法;
//   - 判定 significant = medianDiff ≥ minDiff 且 CI 不含 0。
//   统计判定本身不区分数据来源; fixture/mock 注入评分只能支撑 PENDING 结论,
//   真实 LLM 臂才可 PASS——来源标注由调用方 (evidence.meta.judgeSource) 承载。

/** A/B 统计确定性种子 (LCG; 与 fault-injection.spec 种子化同型态)。 */
export const OFFLINE_REPLAY_AB_SEED = 20260828

/** 配对 bootstrap 重采样次数 (B)。 */
export const OFFLINE_REPLAY_AB_BOOTSTRAP_RESAMPLES = 2000

/** 门槛① 中位差达标线 (精品臂 − 基线臂 ≥ +0.5)。 */
export const OFFLINE_REPLAY_AB_MIN_MEDIAN_DIFF = 0.5

/** 门槛① 置信水平 (95%CI)。 */
export const OFFLINE_REPLAY_AB_CI_CONFIDENCE = 0.95

/** 配对中位差统计结果。 */
export interface PairedMedianDiffStats {
  /** 配对样本数 n */
  pairs: number
  /** observed 统计量: median(premium − baseline) */
  medianDiff: number
  /** bootstrap 百分位 CI 下界 */
  ciLow: number
  /** bootstrap 百分位 CI 上界 */
  ciHigh: number
  /** CI 是否包含 0 (含端点) */
  ciContainsZero: boolean
  /** 中位差是否 ≥ 达标线 */
  meetsMinDiff: boolean
  /** 门槛① 统计判定 = meetsMinDiff && !ciContainsZero */
  significant: boolean
  /** 实际使用的重采样次数 (诊断用) */
  resamples: number
  /** 实际使用的种子 (诊断用) */
  seed: number
}

/**
 * 确定性 LCG 伪随机数 (Park–Miller 型, 与 T18 fault-injection 种子化策略同型态):
 * 返回推进后的 state 与 [0,1) 均匀随机数。纯函数。
 */
export function abLcgNext(state: number): { state: number; u: number } {
  // 48 位精度安全的乘加参数 (Numerical Recipes 常用组合)
  const next = (Math.imul(state, 1664525) + 1013904223) >>> 0
  return { state: next, u: next / 4294967296 }
}

/** 数组中位数 (升序取中; 偶数长度取中间两数均值)。纯函数。 */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * 配对中位差 + bootstrap 95%CI (门槛① 共享纯算术, ADR-19 零 LLM)。
 *
 * @param baseline 基线臂每配对单位的 overall 分 (长度 n)
 * @param premium  精品臂每配对单位的 overall 分 (长度必须等于 baseline)
 * @param options 可选覆盖 (resamples/seed/minDiff/confidence); 缺省走本文件常量
 * @returns 统计量; 输入为空或长度不等时抛错 (fail-fast, 不静默)
 */
export function computePairedMedianDiffStats(
  baseline: readonly number[],
  premium: readonly number[],
  options?: {
    resamples?: number
    seed?: number
    minDiff?: number
    confidence?: number
  },
): PairedMedianDiffStats {
  if (baseline.length === 0) throw new Error("computePairedMedianDiffStats: 输入为空")
  if (baseline.length !== premium.length) {
    throw new Error(
      `computePairedMedianDiffStats: 双臂配对数不等 (${baseline.length} vs ${premium.length})`,
    )
  }
  const resamples = options?.resamples ?? OFFLINE_REPLAY_AB_BOOTSTRAP_RESAMPLES
  const seed = options?.seed ?? OFFLINE_REPLAY_AB_SEED
  const minDiff = options?.minDiff ?? OFFLINE_REPLAY_AB_MIN_MEDIAN_DIFF
  const confidence = options?.confidence ?? OFFLINE_REPLAY_AB_CI_CONFIDENCE

  const diffs = baseline.map((b, i) => premium[i] - b)
  const observedMedian = medianOf(diffs)

  // 有放回重采样配对下标 → 每次重采样的中位差分布
  let state = seed >>> 0
  const bootMedians: number[] = new Array(resamples)
  const n = diffs.length
  for (let b = 0; b < resamples; b++) {
    const sample: number[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const r = abLcgNext(state)
      state = r.state
      sample[i] = diffs[Math.floor(r.u * n) % n]
    }
    bootMedians[b] = medianOf(sample)
  }
  bootMedians.sort((a, b) => a - b)

  const alpha = 1 - confidence
  const loIdx = Math.min(resamples - 1, Math.max(0, Math.floor((alpha / 2) * resamples)))
  const hiIdx = Math.min(resamples - 1, Math.max(0, Math.ceil((1 - alpha / 2) * resamples) - 1))
  const ciLow = bootMedians[loIdx]
  const ciHigh = bootMedians[hiIdx]
  const ciContainsZero = ciLow <= 0 && ciHigh >= 0
  const meetsMinDiff = observedMedian >= minDiff

  return {
    pairs: n,
    medianDiff: observedMedian,
    ciLow,
    ciHigh,
    ciContainsZero,
    meetsMinDiff,
    significant: meetsMinDiff && !ciContainsZero,
    resamples,
    seed,
  }
}
