// Copyright (c) 2024 Niko-hub contributors. MIT License.

/**
 * premium-config.spec.ts — T33b 精品模式项目配置 100% 覆盖率测试
 *
 * 覆盖（蓝图 §7 T33b）：
 *   1. 默认值：premium_mode off / 模式开关默认
 *   2. isPremiumEnabled 纯函数
 *   3. getEffectiveTriggers 当前生效开关
 *   4. 一键回退 rollbackToSingleModel
 *   5. 前缀缓存检查 checkPrefixCacheEligibility
 *   6. 硬前置检查 checkHardPreconditions
 *   7. 尝试启用 tryEnablePremium（成功/失败/前缀缓存降级）
 *
 * 机械层约束：纯函数测试，无 IO / 无网络 / 无模型调用。
 *
 * @license MIT © QMAI
 */

import { describe, expect, it } from "vitest"
import {
  DEFAULT_PREMIUM_CONFIG,
  DEFAULT_PREMIUM_MODE_TRIGGERS,
  isPremiumEnabled,
  getEffectiveTriggers,
  rollbackToSingleModel,
  checkPrefixCacheEligibility,
  checkHardPreconditions,
  tryEnablePremium,
  type PremiumConfig,
  type PremiumModeTriggers,
  type HardPreconditionInput,
} from "./premium-config"

// ── 足够长的安全前缀（≥50 字符，用于测试）─────────────────────────────────
const LONG_SAFE_PREFIX =
  "一位资深小说家。请根据以下设定生成第3章正文。故事背景：修仙世界。主角：林动。时间线：第三日。地点：青云峰。"

// ════════════════════════════════════════════════════════════════════════════
// 1. 默认值
// ════════════════════════════════════════════════════════════════════════════
describe("默认值", () => {
  it("DEFAULT_PREMIUM_CONFIG.premiumMode 应为 false", () => {
    expect(DEFAULT_PREMIUM_CONFIG.premiumMode).toBe(false)
  })

  it("DEFAULT_PREMIUM_CONFIG.prefixCacheEnabled 应为 false", () => {
    expect(DEFAULT_PREMIUM_CONFIG.prefixCacheEnabled).toBe(false)
  })

  it("DEFAULT_PREMIUM_CONFIG.fallbackChains 应为空对象", () => {
    expect(DEFAULT_PREMIUM_CONFIG.fallbackChains).toEqual({})
  })

  it("DEFAULT_PREMIUM_CONFIG.requiredZeroDiffChapters 应为 3", () => {
    expect(DEFAULT_PREMIUM_CONFIG.requiredZeroDiffChapters).toBe(3)
  })

  it("DEFAULT_PREMIUM_MODE_TRIGGERS：GCR 开、共识门 开、双提案 off、双判官 off", () => {
    expect(DEFAULT_PREMIUM_MODE_TRIGGERS).toEqual({
      gcr: true,
      consensusGate: true,
      dualProposal: false,
      dualJudge: false,
    } satisfies PremiumModeTriggers)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2. isPremiumEnabled
// ════════════════════════════════════════════════════════════════════════════
describe("isPremiumEnabled", () => {
  it("premiumMode=false 时返回 false", () => {
    expect(isPremiumEnabled(DEFAULT_PREMIUM_CONFIG)).toBe(false)
  })

  it("premiumMode=true 时返回 true", () => {
    const enabled: PremiumConfig = { ...DEFAULT_PREMIUM_CONFIG, premiumMode: true }
    expect(isPremiumEnabled(enabled)).toBe(true)
  })

  it("纯函数：同输入同输出", () => {
    const a = isPremiumEnabled(DEFAULT_PREMIUM_CONFIG)
    const b = isPremiumEnabled(DEFAULT_PREMIUM_CONFIG)
    expect(a).toBe(b)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3. getEffectiveTriggers
// ════════════════════════════════════════════════════════════════════════════
describe("getEffectiveTriggers", () => {
  it("premiumMode=false 时返回默认触发开关", () => {
    const triggers = getEffectiveTriggers(DEFAULT_PREMIUM_CONFIG)
    expect(triggers).toEqual(DEFAULT_PREMIUM_MODE_TRIGGERS)
  })

  it("premiumMode=true 时返回配置的触发开关", () => {
    const customTriggers: PremiumModeTriggers = {
      gcr: false,
      consensusGate: false,
      dualProposal: true,
      dualJudge: true,
    }
    const config: PremiumConfig = {
      ...DEFAULT_PREMIUM_CONFIG,
      premiumMode: true,
      triggers: customTriggers,
    }
    const triggers = getEffectiveTriggers(config)
    expect(triggers).toEqual(customTriggers)
    // 不修改原对象
    expect(config.triggers).toEqual(customTriggers)
  })

  it("返回的 trigger 对象为浅拷贝，修改不影响原配置", () => {
    const triggers = getEffectiveTriggers(DEFAULT_PREMIUM_CONFIG)
    triggers.gcr = false
    expect(DEFAULT_PREMIUM_MODE_TRIGGERS.gcr).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4. 一键回退 rollbackToSingleModel
// ════════════════════════════════════════════════════════════════════════════
describe("rollbackToSingleModel", () => {
  it("从启用状态回退到全部关闭", () => {
    const enabled: PremiumConfig = {
      premiumMode: true,
      triggers: { gcr: true, consensusGate: false, dualProposal: true, dualJudge: true },
      prefixCacheEnabled: true,
      fallbackChains: {
        writer: {
          primary: "model-a",
          fallbacks: ["model-b", "model-c"],
          exhaustedAction: "checkpoint",
          contentFailAction: "manual_review",
        },
      },
      requiredZeroDiffChapters: 5,
    }

    const rolled = rollbackToSingleModel(enabled)
    expect(rolled.premiumMode).toBe(false)
    expect(rolled.prefixCacheEnabled).toBe(false)
    expect(rolled.fallbackChains).toEqual({})
    expect(rolled.triggers).toEqual(DEFAULT_PREMIUM_MODE_TRIGGERS)
    // requiredZeroDiffChapters 保留
    expect(rolled.requiredZeroDiffChapters).toBe(5)
  })

  it("从已关闭状态回退不变", () => {
    const rolled = rollbackToSingleModel(DEFAULT_PREMIUM_CONFIG)
    expect(rolled).toEqual({
      ...DEFAULT_PREMIUM_CONFIG,
      fallbackChains: {},
      prefixCacheEnabled: false,
    })
  })

  it("纯函数：不修改输入", () => {
    const original: PremiumConfig = {
      ...DEFAULT_PREMIUM_CONFIG,
      premiumMode: true,
      prefixCacheEnabled: true,
    }
    const copy = { ...original, triggers: { ...original.triggers } }
    rollbackToSingleModel(original)
    expect(original).toEqual(copy)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5. 前缀缓存检查 checkPrefixCacheEligibility
// ════════════════════════════════════════════════════════════════════════════
describe("checkPrefixCacheEligibility", () => {
  it("安全的固定前缀 → safe", () => {
    expect(LONG_SAFE_PREFIX.length).toBeGreaterThanOrEqual(50)
    const result = checkPrefixCacheEligibility(LONG_SAFE_PREFIX)
    expect(result.safe).toBe(true)
    expect(result.reason).toBeNull()
  })

  it("前缀过短（< 50 字符）→ unsafe", () => {
    const result = checkPrefixCacheEligibility("你好")
    expect(result.safe).toBe(false)
    expect(result.reason).toContain("prefix too short")
  })

  it("空字符串 → unsafe", () => {
    const result = checkPrefixCacheEligibility("")
    expect(result.safe).toBe(false)
    expect(result.reason).toContain("prefix too short")
  })

  it("含日期模式 2026-08-28 → unsafe", () => {
    const prefix = LONG_SAFE_PREFIX + " 2026-08-28 是今天。"
    const result = checkPrefixCacheEligibility(prefix)
    expect(result.safe).toBe(false)
    expect(result.reason).toBe("prefix contains timestamp pattern")
  })

  it("含日期模式 2026/08/28 → unsafe", () => {
    const prefix = LONG_SAFE_PREFIX + " 创建于 2026/08/28。"
    const result = checkPrefixCacheEligibility(prefix)
    expect(result.safe).toBe(false)
    expect(result.reason).toBe("prefix contains timestamp pattern")
  })

  it("含 Unix 时间戳（10+ 数字）→ unsafe", () => {
    const prefix = LONG_SAFE_PREFIX + " 时间戳 1724822400。"
    const result = checkPrefixCacheEligibility(prefix)
    expect(result.safe).toBe(false)
    expect(result.reason).toBe("prefix contains timestamp pattern")
  })

  it("含 ISO 时间 T12:00:00 → unsafe", () => {
    const prefix = LONG_SAFE_PREFIX + " 当前时间 T12:00:00。"
    const result = checkPrefixCacheEligibility(prefix)
    expect(result.safe).toBe(false)
    expect(result.reason).toBe("prefix contains timestamp pattern")
  })

  it("含 UUID 模式 → unsafe", () => {
    const prefix = LONG_SAFE_PREFIX + " 会话 550e8400-e29b-41d4-a716-446655440000。"
    const result = checkPrefixCacheEligibility(prefix)
    expect(result.safe).toBe(false)
    expect(result.reason).toBe("prefix contains random ID pattern")
  })

  it("含 rand_ 模式 → unsafe", () => {
    const prefix = LONG_SAFE_PREFIX + " rand_abc123 是临时标识。"
    const result = checkPrefixCacheEligibility(prefix)
    expect(result.safe).toBe(false)
    expect(result.reason).toBe("prefix contains random ID pattern")
  })

  it("含 tmp_ 模式 → unsafe", () => {
    const prefix = LONG_SAFE_PREFIX + " tmp_xyz789 是临时文件。"
    const result = checkPrefixCacheEligibility(prefix)
    expect(result.safe).toBe(false)
    expect(result.reason).toBe("prefix contains random ID pattern")
  })

  it("含 32 字符 hex → unsafe", () => {
    const prefix = LONG_SAFE_PREFIX + " 摘要 a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6。"
    const result = checkPrefixCacheEligibility(prefix)
    expect(result.safe).toBe(false)
    expect(result.reason).toBe("prefix contains random ID pattern")
  })

  it("含 token 模式（带点分隔的 16+ 字符词）→ unsafe", () => {
    const prefix = LONG_SAFE_PREFIX + " 令牌 abcdefghijklmnop.1234567890abcdef。"
    const result = checkPrefixCacheEligibility(prefix)
    expect(result.safe).toBe(false)
    expect(result.reason).toBe("prefix contains random ID pattern")
  })

  it("纯函数：同输入同输出", () => {
    const a = checkPrefixCacheEligibility(LONG_SAFE_PREFIX)
    const b = checkPrefixCacheEligibility(LONG_SAFE_PREFIX)
    expect(a).toEqual(b)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6. 硬前置检查 checkHardPreconditions
// ════════════════════════════════════════════════════════════════════════════
describe("checkHardPreconditions", () => {
  it("全部满足（dual + 3 章零差异）→ satisfied", () => {
    const input: HardPreconditionInput = {
      canonMigration: "dual",
      zeroDiffChapters: 3,
    }
    const result = checkHardPreconditions(input)
    expect(result.satisfied).toBe(true)
    expect(result.migrationReady).toBe(true)
    expect(result.migrationMode).toBe("dual")
    expect(result.zeroDiffChapters).toBe(3)
    expect(result.requiredChapters).toBe(3)
    expect(result.reasons).toEqual([])
  })

  it("shadow 也满足条件", () => {
    const input: HardPreconditionInput = {
      canonMigration: "shadow",
      zeroDiffChapters: 5,
    }
    const result = checkHardPreconditions(input)
    expect(result.satisfied).toBe(true)
    expect(result.migrationReady).toBe(true)
    expect(result.migrationMode).toBe("shadow")
    expect(result.reasons).toEqual([])
  })

  it("canon_migration=legacy → 不满足", () => {
    const input: HardPreconditionInput = {
      canonMigration: "legacy",
      zeroDiffChapters: 5,
    }
    const result = checkHardPreconditions(input)
    expect(result.satisfied).toBe(false)
    expect(result.migrationReady).toBe(false)
    expect(result.reasons).toHaveLength(1)
    expect(result.reasons[0]).toContain("legacy")
    expect(result.reasons[0]).toContain("dual")
  })

  it("canon_migration=undefined（缺省）→ legacy 不满足", () => {
    const input: HardPreconditionInput = {
      canonMigration: undefined,
      zeroDiffChapters: 3,
    }
    const result = checkHardPreconditions(input)
    expect(result.satisfied).toBe(false)
    expect(result.migrationReady).toBe(false)
    expect(result.migrationMode).toBe("legacy")
  })

  it("零差异章数不足（1 < 3）→ 不满足", () => {
    const input: HardPreconditionInput = {
      canonMigration: "dual",
      zeroDiffChapters: 1,
    }
    const result = checkHardPreconditions(input)
    expect(result.satisfied).toBe(false)
    expect(result.migrationReady).toBe(true)
    expect(result.reasons).toHaveLength(1)
    expect(result.reasons[0]).toContain("zero-diff")
    expect(result.reasons[0]).toContain("1")
    expect(result.reasons[0]).toContain("3")
  })

  it("自定义 requiredChapters=5 → 需要 5 章零差异", () => {
    const input: HardPreconditionInput = {
      canonMigration: "dual",
      zeroDiffChapters: 4,
      requiredChapters: 5,
    }
    const result = checkHardPreconditions(input)
    expect(result.satisfied).toBe(false)
    expect(result.requiredChapters).toBe(5)
    expect(result.reasons).toHaveLength(1)
    expect(result.reasons[0]).toContain("4")
    expect(result.reasons[0]).toContain("5")
  })

  it("双条件不满足 → 两条原因", () => {
    const input: HardPreconditionInput = {
      canonMigration: "legacy",
      zeroDiffChapters: 0,
    }
    const result = checkHardPreconditions(input)
    expect(result.satisfied).toBe(false)
    expect(result.reasons).toHaveLength(2)
  })

  it("零差异章数正好等于 required → 满足", () => {
    const input: HardPreconditionInput = {
      canonMigration: "dual",
      zeroDiffChapters: 7,
      requiredChapters: 7,
    }
    const result = checkHardPreconditions(input)
    expect(result.satisfied).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it("纯函数：同输入同输出", () => {
    const input: HardPreconditionInput = {
      canonMigration: "dual",
      zeroDiffChapters: 3,
    }
    const a = checkHardPreconditions(input)
    const b = checkHardPreconditions(input)
    expect(a).toEqual(b)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 7. 尝试启用 tryEnablePremium
// ════════════════════════════════════════════════════════════════════════════
describe("tryEnablePremium", () => {
  const baseConfig: PremiumConfig = {
    ...DEFAULT_PREMIUM_CONFIG,
    triggers: { ...DEFAULT_PREMIUM_MODE_TRIGGERS },
  }

  const satisfiedInput: HardPreconditionInput = {
    canonMigration: "dual",
    zeroDiffChapters: 3,
  }

  it("前置条件满足 → ok=true, config.premiumMode=true", () => {
    const result = tryEnablePremium(baseConfig, satisfiedInput)
    expect(result.ok).toBe(true)
    expect(result.config).not.toBeNull()
    expect(result.config!.premiumMode).toBe(true)
    expect(result.precondition.satisfied).toBe(true)
  })

  it("前置条件不满足 → ok=false, config=null", () => {
    const input: HardPreconditionInput = {
      canonMigration: "legacy",
      zeroDiffChapters: 0,
    }
    const result = tryEnablePremium(baseConfig, input)
    expect(result.ok).toBe(false)
    expect(result.config).toBeNull()
    expect(result.precondition.satisfied).toBe(false)
  })

  it("启用后保留 triggers 配置", () => {
    const customTriggers: PremiumModeTriggers = {
      gcr: false,
      consensusGate: true,
      dualProposal: true,
      dualJudge: false,
    }
    const config: PremiumConfig = { ...baseConfig, triggers: customTriggers }
    const result = tryEnablePremium(config, satisfiedInput)
    expect(result.ok).toBe(true)
    expect(result.config!.triggers).toEqual(customTriggers)
  })

  it("启用后保留 fallbackChains", () => {
    const config: PremiumConfig = {
      ...baseConfig,
      fallbackChains: {
        writer: {
          primary: "model-a",
          fallbacks: ["model-b"],
          exhaustedAction: "checkpoint",
          contentFailAction: "manual_review",
        },
      },
    }
    const result = tryEnablePremium(config, satisfiedInput)
    expect(result.ok).toBe(true)
    expect(result.config!.fallbackChains).toEqual(config.fallbackChains)
  })

  it("前缀缓存开启且前缀安全 → prefixCacheEnabled=true", () => {
    const config: PremiumConfig = {
      ...baseConfig,
      prefixCacheEnabled: true,
    }
    const result = tryEnablePremium(config, satisfiedInput, LONG_SAFE_PREFIX)
    expect(result.ok).toBe(true)
    expect(result.config!.prefixCacheEnabled).toBe(true)
  })

  it("前缀缓存开启但前缀不安全 → 自动降级关闭前缀缓存（不阻断启用）", () => {
    const config: PremiumConfig = {
      ...baseConfig,
      prefixCacheEnabled: true,
    }
    const unsafePrefix = LONG_SAFE_PREFIX + " 2026-08-28 生成。"
    const result = tryEnablePremium(config, satisfiedInput, unsafePrefix)
    expect(result.ok).toBe(true)
    expect(result.config!.prefixCacheEnabled).toBe(false)
  })

  it("前缀缓存开启但未传入 prefix → 保留原值", () => {
    const config: PremiumConfig = {
      ...baseConfig,
      prefixCacheEnabled: true,
    }
    const result = tryEnablePremium(config, satisfiedInput)
    expect(result.ok).toBe(true)
    expect(result.config!.prefixCacheEnabled).toBe(true)
  })

  it("纯函数：不修改输入", () => {
    const original = { ...baseConfig }
    tryEnablePremium(baseConfig, satisfiedInput)
    expect(baseConfig).toEqual(original)
  })
})