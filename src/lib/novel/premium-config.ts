// Copyright (c) 2024 Niko-hub contributors. MIT License.

/**
 * premium-config.ts — T33b 精品模式项目配置
 *
 * 蓝图 §7 T33b:
 *   premium_mode 默认 off；角色绑定 + 模式开关（GCR 开/共识门 开/双提案 off/双判官 off）；
 *   一键回退到单模型现状；提示词前缀缓存开关（默认 off；开启前对 golden 重基线，前缀含时间戳/
 *   随机 id 则禁用——T25b 前缀字节稳定不变量可复用为检查器）；
 *   硬前置检查断言：canon_migration ≥ dual 且 reconcile 零差异持续 N 章，不满足则精品模式拒绝启用。
 *
 * 机械层约束:
 *   纯函数 + 类型定义，无 IO / 无网络 / 无模型调用。
 *   硬前置检查需外部传入 status 与 reconcile 数据（由调用方注入，本模块不依赖 Tauri 运行时）。
 *
 * 遵循 QMAI/CLAUDE.md：T33b 新增锚点，落 `src/lib/novel/`。
 *
 * @license MIT © QMAI
 */

import type { FallbackChainConfig } from "@/lib/llm/model-resolver"
import { setJournalTtlMs } from "./stage-output-journal"

// ── 类型定义 ─────────────────────────────────────────────────────────────────────

/**
 * 精品模式角色绑定 + 模式开关。
 *
 * 默认值（DEFAULT_PREMIUM_MODE_TRIGGERS）：
 *   GCR 开（multimodel gate control routing）、
 *   共识门 开（consensus gate requires N≥2 model agreement）、
 *   双提案 off（dual proposal: 两个 writer 独立生成后仲裁）、
 *   双判官 off（dual judge: 两个 judge 独立判定后融合）。
 */
export interface PremiumModeTriggers {
  /** GCR（Gate Control Routing）启用。 */
  gcr: boolean
  /** 共识门（Consensus Gate）启用。 */
  consensusGate: boolean
  /** 双提案模式（Dual Proposal）启用。 */
  dualProposal: boolean
  /** 双判官模式（Dual Judge）启用。 */
  dualJudge: boolean
}

/** 精品模式运行期状态快照（用于编排层跟踪）。 */
export interface PremiumModeState {
  /** 精品模式是否启用。 */
  enabled: boolean
  /** 模式开关绑定。 */
  triggers: PremiumModeTriggers
  /** 提示词前缀缓存是否启用。 */
  prefixCacheEnabled: boolean
  /** 最近一次硬前置检查结果。 */
  lastPreconditionCheck: HardPreconditionResult | null
}

/** 硬前置检查结果。 */
export interface HardPreconditionResult {
  /** 是否满足所有前置条件。 */
  satisfied: boolean
  /** canon_migration 是否 ≥ dual。 */
  migrationReady: boolean
  /** 当前 canon_migration 模式。 */
  migrationMode: string | undefined
  /** reconcile 零差异持续章数。 */
  zeroDiffChapters: number
  /** 需要持续多少章零差异。 */
  requiredChapters: number
  /** 不满足的具体原因（satisfied 时为 []）。 */
  reasons: string[]
}

/**
 * 配置文件最终结构（含精品模式所有字段）。
 *
 * 使用时嵌入项目配置（如 NovelConfig 或 status.json 的 additive 段），
 * 本模块不定义存储位置，只定义结构与操作。
 */
export interface PremiumConfig {
  /** 精品模式总开关（默认 false）。 */
  premiumMode: boolean
  /** 模式开关绑定。 */
  triggers: PremiumModeTriggers
  /** 提示词前缀缓存开关（默认 false）。 */
  prefixCacheEnabled: boolean
  /**
   * 角色 fallback 链配置（精品模式可用多模型 fallback；
   * 一键回退时重置为单模型单条目）。
   */
  fallbackChains: Partial<
    Record<"writer" | "critic" | "reviser" | "arbiter" | "judge", FallbackChainConfig>
  >
  /** 硬前置检查所需最小零差异持续章数（默认 3）。 */
  requiredZeroDiffChapters: number
  /**
   * 编排面 LLM 工件缓存 TTL（ms）。可选；未配置/缺省 → journal 用默认 T+1h（零差异）。
   * 配置加载方应在加载完成后调用 `initJournalTtlFromConfig` 接线到
   * `stage-output-journal` 的 setter（本字段不进 DEFAULT，保证默认零差异）。
   */
  journalTtlMs?: number
}

// ── 默认值 ───────────────────────────────────────────────────────────────────────

/** 默认模式开关：GCR 开、共识门 开、双提案 off、双判官 off。 */
export const DEFAULT_PREMIUM_MODE_TRIGGERS: PremiumModeTriggers = {
  gcr: true,
  consensusGate: true,
  dualProposal: false,
  dualJudge: false,
} as const

/** 默认精品配置（premium_mode 默认 off）。 */
export const DEFAULT_PREMIUM_CONFIG: PremiumConfig = {
  premiumMode: false,
  triggers: { ...DEFAULT_PREMIUM_MODE_TRIGGERS },
  prefixCacheEnabled: false,
  fallbackChains: {},
  requiredZeroDiffChapters: 3,
} as const

// ── 查询函数 ─────────────────────────────────────────────────────────────────────

/**
 * 检查精品模式是否启用。
 * 纯函数。
 */
export function isPremiumEnabled(config: PremiumConfig): boolean {
  return config.premiumMode
}

/**
 * 获取当前生效的模式开关（premium 关闭时返回默认值）。
 * 纯函数。
 */
export function getEffectiveTriggers(config: PremiumConfig): PremiumModeTriggers {
  if (!config.premiumMode) return { ...DEFAULT_PREMIUM_MODE_TRIGGERS }
  return { ...config.triggers }
}

// ── 一键回退 ─────────────────────────────────────────────────────────────────────

/**
 * 一键回退到单模型现状。
 *
 * 回退操作：
 *   - premium_mode 设为 false
 *   - 清空所有角色 fallback 链
 *   - 前缀缓存关闭
 *   - 模式开关全部重置为默认
 *
 * 纯函数：返回新配置对象，不修改输入。
 */
export function rollbackToSingleModel(config: PremiumConfig): PremiumConfig {
  return {
    premiumMode: false,
    triggers: { ...DEFAULT_PREMIUM_MODE_TRIGGERS },
    prefixCacheEnabled: false,
    fallbackChains: {},
    requiredZeroDiffChapters: config.requiredZeroDiffChapters,
  }
}

// ── 前缀缓存检查 ─────────────────────────────────────────────────────────────────

/**
 * 前缀缓存安全状态。
 */
export interface PrefixCacheEligibility {
  /** 前缀是否可安全缓存。 */
  safe: boolean
  /** 不安全的理由（safe 为 true 时为空）。 */
  reason: string | null
}

/**
 * 检查提示词前缀是否可安全用于缓存。
 *
 * 复用 T25b 前缀字节稳定不变量（context-pack-freeze.spec.ts "Invariant 3"）：
 *   - 前缀不可包含时间戳模式（如 `2026-08-`、`\d{4}-\d{2}-\d{2}`）
 *   - 前缀不可包含随机 ID 模式（如 `xyz-`、`rand_`、`uuid` 等）
 *   - 前缀必须是确定性的（同输入同输出）
 *   - 前缀最小字节数 ≥ 50（避免过短前缀频繁冲突）
 *
 * 开启前调用方应确保通过 T25b 稳定性测试（同输入两次 build 前 100 字节一致，
 * 见 context-pack-freeze.spec.ts "Invariant 3" 不变量）。
 *
 * 纯函数。
 */
export function checkPrefixCacheEligibility(prefix: string): PrefixCacheEligibility {
  if (!prefix || prefix.length < 50) {
    return {
      safe: false,
      reason: "prefix too short (< 50 bytes) for cache stability",
    }
  }

  // 随机 ID 模式检测（先于时间戳，避免 UUID 末段 12 位 hex 被误判为时间戳）
  const randomIdPatterns = [
    /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/i, // UUID
    /\b(?:rand_|rnd_|random_|tmp_|temp_)[a-z0-9]+\b/i, // rand_xxx / tmp_xxx
    /\b[0-9a-f]{32}\b/i, // 32-char hex (MD5-like)
    /\b\w{16,}\.\w{16,}\b/, // token-like: abcdefghijklmnop.1234567890abcdef
  ]
  for (const pattern of randomIdPatterns) {
    if (pattern.test(prefix)) {
      return { safe: false, reason: "prefix contains random ID pattern" }
    }
  }

  // 时间戳模式检测
  const timestampPatterns = [
    /\b\d{4}-\d{2}-\d{2}\b/, // 2026-08-28
    /\b\d{4}\/\d{2}\/\d{2}\b/, // 2026/08/28
    /\b\d{8}\b/, // 20260828
    /\b\d{10,}\b/, // Unix timestamp (10+ digits)
    /T\d{2}:\d{2}:\d{2}Z?\b/, // ISO time: T12:00:00Z
  ]
  for (const pattern of timestampPatterns) {
    if (pattern.test(prefix)) {
      return { safe: false, reason: "prefix contains timestamp pattern" }
    }
  }

  return { safe: true, reason: null }
}

// ── 硬前置检查 ──────────────────────────────────────────────────────────────────

/**
 * 硬前置检查输入：canon 迁移状态 + reconcile 对账报告摘要。
 *
 * 调用方（如编排层）负责从 status.json 和 canon-reconcile 模块获取这些数据，
 * 本模块不依赖 Tauri 运行时，纯函数组合检查。
 */
export interface HardPreconditionInput {
  /** canon_migration 模式（来自 status.json）。 */
  canonMigration: string | undefined
  /** reconcile 零差异的持续章数。 */
  zeroDiffChapters: number
  /** 要求最低零差异持续章数（缺省 3）。 */
  requiredChapters?: number
}

/**
 * 检查硬前置条件是否满足。
 *
 * 规则（蓝图 §417）：
 *   1. canon_migration 必须是 "dual" 或 "shadow"（≥ dual）
 *   2. reconcile 零差异持续 ≥ requiredChapters 章（缺省 3）
 *   3. 两者同时满足才返回 satisfied=true
 *
 * 纯函数。
 */
export function checkHardPreconditions(
  input: HardPreconditionInput,
): HardPreconditionResult {
  const reasons: string[] = []
  const required = input.requiredChapters ?? 3
  const migration = input.canonMigration ?? "legacy"

  // 检查 1: canon_migration ≥ dual
  const migrationReady = migration === "dual" || migration === "shadow"
  if (!migrationReady) {
    reasons.push(
      `canon_migration is "${migration}", expected "dual" or "shadow"`,
    )
  }

  // 检查 2: reconcile 零差异持续 N 章
  const zeroDiffChapters = input.zeroDiffChapters
  if (zeroDiffChapters < required) {
    reasons.push(
      `reconcile zero-diff only ${zeroDiffChapters} chapter(s), need ${required}`,
    )
  }

  return {
    satisfied: reasons.length === 0,
    migrationReady,
    migrationMode: migration,
    zeroDiffChapters,
    requiredChapters: required,
    reasons,
  }
}

// ── 尝试启用精品模式 ────────────────────────────────────────────────────────────

/**
 * 尝试启用精品模式：执行硬前置检查，全部满足才返回启用的配置。
 *
 * 纯函数组合：不执行任何 IO，不修改输入。
 *
 * @param currentConfig 当前配置（premium_mode 通常为 false）
 * @param preconditionInput 硬前置检查输入
 * @param prefixCachePrefix 可选：开启前缀缓存时传入前缀字符串校验；
 *   若前缀不符合缓存安全条件，自动降级关闭前缀缓存（不阻断精品模式整体启用）
 * @returns 启用成功 → { ok: true, config, precondition }
 *          启用失败 → { ok: false, config: null, precondition }
 */
export function tryEnablePremium(
  currentConfig: PremiumConfig,
  preconditionInput: HardPreconditionInput,
  prefixCachePrefix?: string,
): {
  ok: boolean
  config: PremiumConfig | null
  precondition: HardPreconditionResult
} {
  // 1. 硬前置检查
  const precondition = checkHardPreconditions(preconditionInput)
  if (!precondition.satisfied) {
    return { ok: false, config: null, precondition }
  }

  // 2. 如果要求开启前缀缓存，检查前缀稳定性
  let prefixCacheEnabled = currentConfig.prefixCacheEnabled
  if (prefixCacheEnabled && prefixCachePrefix !== undefined) {
    const eligibility = checkPrefixCacheEligibility(prefixCachePrefix)
    if (!eligibility.safe) {
      // 前缀不稳定 → 禁用前缀缓存（不阻断精品模式整体启用）
      prefixCacheEnabled = false
    }
  }

  // 3. 构建启用配置
  const config: PremiumConfig = {
    premiumMode: true,
    triggers: { ...(currentConfig.triggers ?? DEFAULT_PREMIUM_MODE_TRIGGERS) },
    prefixCacheEnabled,
    fallbackChains: { ...currentConfig.fallbackChains },
    requiredZeroDiffChapters: currentConfig.requiredZeroDiffChapters,
  }

  return { ok: true, config, precondition }
}

// ── journal TTL 接线 ──────────────────────────────────────────────────────────

/**
 * 将 `PremiumConfig.journalTtlMs` 转发到 `stage-output-journal` 的 TTL setter。
 *
 * 配置加载完成处（编排面配置解析入口）调用一次：
 *   `initJournalTtlFromConfig(config)`
 * 未配置（`undefined`）时转 `null` → journal 回退默认 T+1h（零差异）。
 *
 * ⚠️ 注记：编排面唯一接线段 `deep-chapter-generation.ts` 为他人 WIP 禁区，
 *   故此处不在 WIP 内直接调用，而是导出本接线函数，由未来采用方在非 WIP
 *   加载入口调用一次即可。重复调用幂等（最后一次调用的 config 生效）。
 *
 * @param config 项目精品配置（可直接传 `DEFAULT_PREMIUM_CONFIG`，等价零差异）。
 */
export function initJournalTtlMsFromConfig(config: PremiumConfig): void {
  setJournalTtlMs(config.journalTtlMs ?? null)
}