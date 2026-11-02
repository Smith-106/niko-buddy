/**
 * TASK-007 (PERF-011 + CORR-013): context-budget pure-function tests.
 *
 * computeContextBudget is already exercised indirectly by
 * context-engine.spec.ts ("TASK-003 chapterNumber 自适应预算"). This file
 * adds the TASK-007-specific assertions:
 *   (a) adaptive scaling is live — chapter 500 gets smaller index/page
 *       budgets than chapter 5 (the chapterAdaptiveScale curve is not dead
 *       code now that the read path wires it).
 *   (b) CORR-013 MIN_INDEX_FLOOR — tiny maxContextSize (10K) still yields an
 *       indexBudget >= 2000 so the wiki index summary can list every page
 *       title even on small-context models.
 *   (c) additive / backward compatible — for normal configs (200K) the floor
 *       sits below the scaled value, so the budget is unchanged by the floor.
 */
import { describe, expect, it } from "vitest"
import {
  CJK_CHARS_PER_TOKEN,
  NON_CJK_CHARS_PER_TOKEN,
  charsPerTokenForText,
  computeContextBudget,
  hardInjectionCapChars,
  selectContextStrategy,
  tokenBudgetToCharBudget,
} from "./context-budget"
import {
  estimateChatMessagesTokens,
  trimChatMessagesToBudget,
  trimChatMessagesToTokenBudget,
} from "./chat-request-budget"
import type { ChatMessage } from "./llm-providers"

describe("TASK-007 PERF-011 adaptive scaling on the read path", () => {
  it("(a) chapter 500 returns smaller indexBudget + pageBudget than chapter 5", () => {
    const early = computeContextBudget(204_800, 5)
    const late = computeContextBudget(204_800, 500)
    // chapterAdaptiveScale(5)=1.0, chapterAdaptiveScale(500)≈0.654 — later
    // chapters get strictly smaller index/page budgets (wiki is larger).
    expect(late.indexBudget).toBeLessThan(early.indexBudget)
    expect(late.pageBudget).toBeLessThan(early.pageBudget)
    // Both stay positive (no budget collapses to zero under scaling).
    expect(late.indexBudget).toBeGreaterThan(0)
    expect(late.pageBudget).toBeGreaterThan(0)
  })

  it("responseReserve is NOT scaled by chapterNumber (LLM answer room is constant)", () => {
    // Guards against accidentally scaling the response reserve too.
    const early = computeContextBudget(204_800, 5)
    const late = computeContextBudget(204_800, 500)
    expect(late.responseReserve).toBe(early.responseReserve)
  })
})

describe("TASK-007 CORR-013 MIN_INDEX_FLOOR", () => {
  it("(b) tiny maxContextSize (10K) yields indexBudget >= 2000", () => {
    // Without the floor: 10000 * 0.05 * 1.0 = 500 chars — too small to list
    // every page's title in the wiki index summary. The floor lifts it to
    // 2000 so the index still fits titles.
    const tiny = computeContextBudget(10_000)
    expect(tiny.maxCtx).toBe(10_000)
    expect(tiny.indexBudget).toBeGreaterThanOrEqual(2000)
  })

  it("MIN_INDEX_FLOOR applies AFTER scaling (tiny config + late chapter still >= floor)", () => {
    // chapter 500 on a 10K config: scaled index would be 10000 * 0.05 * 0.654
    // ≈ 327 — the floor must still lift it to 2000 so even a long-form novel
    // on a small-context model lists page titles.
    const tinyLate = computeContextBudget(10_000, 500)
    expect(tinyLate.indexBudget).toBeGreaterThanOrEqual(2000)
  })

  it("(c) normal config (200K) is unaffected by the floor — additive / backward compatible", () => {
    // For a normal 200K config, the scaled indexBudget is 200000 * 0.05 * 1.0
    // = 10000 — well above the 2000 floor, so Math.max(floor, scaled) returns
    // the scaled value unchanged. This proves the floor is additive and does
    // not perturb existing behavior.
    const normal = computeContextBudget(204_800)
    const expectedScaled = Math.floor(204_800 * 0.05)
    expect(normal.indexBudget).toBe(expectedScaled)
    expect(normal.indexBudget).toBeGreaterThan(2000)
  })

  it("normal config + late chapter still above floor (floor invisible at scale)", () => {
    // 200K at chapter 500: scaled = 200000 * 0.05 * 0.654 ≈ 6540 — above floor.
    const normalLate = computeContextBudget(204_800, 500)
    expect(normalLate.indexBudget).toBeGreaterThan(2000)
  })
})

describe("TASK-004 active entities budget (compressible-with-floor)", () => {
  it("activeEntitiesBudget 字段含 rank0Floor/rank1CompressibleCap/rank2CompressibleCap 三子字段", () => {
    const b = computeContextBudget(204_800, 5)
    expect(b.activeEntitiesBudget).toBeDefined()
    expect(typeof b.activeEntitiesBudget.rank0Floor).toBe("number")
    expect(typeof b.activeEntitiesBudget.rank1CompressibleCap).toBe("number")
    expect(typeof b.activeEntitiesBudget.rank2CompressibleCap).toBe("number")
  })

  it("rank0 floor 全保: 任意 config (含 tiny) rank0Floor >= 8, 不受 scale 压缩", () => {
    const tiny = computeContextBudget(10_000)
    const tinyLate = computeContextBudget(10_000, 500)
    const normal = computeContextBudget(204_800, 5)
    const normalLate = computeContextBudget(204_800, 500)
    // rank0 floor 镜像 MIN_INDEX_FLOOR: 永不低于常数下限 (ACTIVE_ENTITY_FLOOR=8)
    expect(tiny.activeEntitiesBudget.rank0Floor).toBeGreaterThanOrEqual(8)
    expect(tinyLate.activeEntitiesBudget.rank0Floor).toBeGreaterThanOrEqual(8)
    expect(normal.activeEntitiesBudget.rank0Floor).toBeGreaterThanOrEqual(8)
    expect(normalLate.activeEntitiesBudget.rank0Floor).toBeGreaterThanOrEqual(8)
    // 正常 config 的 rank0 floor 随 maxCtx 增大而增大 (scale 不降低 floor)
    expect(normal.activeEntitiesBudget.rank0Floor).toBeGreaterThan(tiny.activeEntitiesBudget.rank0Floor)
  })

  it("rank1/rank2 compressible cap 随 rank0 floor 计算 (正整数且 rank1 > rank2)", () => {
    const b = computeContextBudget(204_800, 5)
    expect(b.activeEntitiesBudget.rank1CompressibleCap).toBeGreaterThanOrEqual(2)
    expect(b.activeEntitiesBudget.rank2CompressibleCap).toBeGreaterThanOrEqual(1)
    expect(b.activeEntitiesBudget.rank1CompressibleCap).toBeGreaterThan(b.activeEntitiesBudget.rank2CompressibleCap)
  })

  it("canon baseline 不动: 既有 indexBudget/pageBudget 字段不受新字段影响", () => {
    const withField = computeContextBudget(204_800, 5)
    expect(withField.indexBudget).toBe(Math.floor(204_800 * 0.05))
    expect(withField.pageBudget).toBe(Math.floor(204_800 * 0.5))
  })
})

describe("F-008 ContextStrategy 三态策略枚举", () => {
  it("≤50 返回 full（默认 threshold）", () => {
    expect(selectContextStrategy(1)).toBe("full")
    expect(selectContextStrategy(25)).toBe("full")
    expect(selectContextStrategy(50)).toBe("full")
  })

  it("50-200 返回 sliding", () => {
    expect(selectContextStrategy(51)).toBe("sliding")
    expect(selectContextStrategy(100)).toBe("sliding")
    expect(selectContextStrategy(200)).toBe("sliding")
  })

  it(">200 返回 summary", () => {
    expect(selectContextStrategy(201)).toBe("summary")
    expect(selectContextStrategy(500)).toBe("summary")
    expect(selectContextStrategy(1000)).toBe("summary")
  })

  it("undefined/≤0 返回 full", () => {
    expect(selectContextStrategy(undefined)).toBe("full")
    expect(selectContextStrategy(0)).toBe("full")
    expect(selectContextStrategy(-1)).toBe("full")
  })

  it("自定义阈值覆盖", () => {
    expect(selectContextStrategy(30, { fullThreshold: 20, summaryThreshold: 100 })).toBe("sliding")
    expect(selectContextStrategy(30, { fullThreshold: 40 })).toBe("full")
    expect(selectContextStrategy(150, { summaryThreshold: 100 })).toBe("summary")
  })

  it("边界 50 与 200（默认阈值）", () => {
    // 边界 50: ≤50 为 full
    expect(selectContextStrategy(50)).toBe("full")
    expect(selectContextStrategy(51)).toBe("sliding")
    // 边界 200: ≤200 为 sliding
    expect(selectContextStrategy(200)).toBe("sliding")
    expect(selectContextStrategy(201)).toBe("summary")
  })

  it("computeContextBudget 返回 strategy 字段", () => {
    const full = computeContextBudget(204_800, 5)
    expect(full.strategy).toBe("full")
    const sliding = computeContextBudget(204_800, 100)
    expect(sliding.strategy).toBe("sliding")
    const summary = computeContextBudget(204_800, 500)
    expect(summary.strategy).toBe("summary")
  })

  it("strategy 不替换现有 budget 曲线（adaptiveScale 预算不变）", () => {
    // 保证 strategy 是 additive 上层选择器，不改变 budget 计算
    const ch5 = computeContextBudget(204_800, 5)
    const ch500 = computeContextBudget(204_800, 500)
    expect(ch500.indexBudget).toBeLessThan(ch5.indexBudget)
    expect(ch500.pageBudget).toBeLessThan(ch5.pageBudget)
    // strategy 反映不同态
    expect(ch5.strategy).toBe("full")
    expect(ch500.strategy).toBe("summary")
  })
})

/**
 * G4b (TASK-006) F3: 换算分支化 —— CJK 段保留 1.5，非 CJK 段走 1.0。
 *
 * 旧实现一律 1.5 chars/token，并在文件头声称「误差方向安全」。实测口径
 * （token-estimator：汉字 1.0 token/字符）下这句是错的：CJK 上 1.5 会高估
 * 可填字符（偏危险方向），非 CJK（≈4 chars/token）上 1.5 又少用一半容量。
 * 分支后：CJK 数值不动，非 CJK 走保守下界 1.0。
 */
describe("G4b 换算分支化：CJK 1.5 / 非 CJK 1.0", () => {
  it("纯 CJK 文本沿用 1.5 chars/token", () => {
    const cjk = "第一章城门铜钥匙旧城墙".repeat(10)
    expect(charsPerTokenForText(cjk)).toBeCloseTo(CJK_CHARS_PER_TOKEN, 6)
    expect(CJK_CHARS_PER_TOKEN).toBe(1.5)
  })

  it("纯非 CJK 文本走 1.0 chars/token（不再套 1.5）", () => {
    const ascii = "the old bronze key hangs by the city gate ".repeat(10)
    expect(charsPerTokenForText(ascii)).toBeCloseTo(NON_CJK_CHARS_PER_TOKEN, 6)
    expect(NON_CJK_CHARS_PER_TOKEN).toBe(1.0)
    // 关键回归：非 CJK 不再被 1.5 放大
    expect(charsPerTokenForText(ascii)).toBeLessThan(CJK_CHARS_PER_TOKEN)
  })

  it("混排文本落在 1.0–1.5 之间（按各自 token 消耗加权）", () => {
    const mixed = "第一章 城门 the old bronze key 旧铜钥匙 hang by the gate"
    const factor = charsPerTokenForText(mixed)
    expect(factor).toBeGreaterThan(NON_CJK_CHARS_PER_TOKEN)
    expect(factor).toBeLessThan(CJK_CHARS_PER_TOKEN)
  })

  it("空样本沿用旧口径 1.5（无样本可分类，不凭空改历史数值）", () => {
    expect(charsPerTokenForText("")).toBe(CJK_CHARS_PER_TOKEN)
  })

  it("tokenBudgetToCharBudget 分支换算，非正预算归零", () => {
    // 2048 tokens（硬注入基线）：CJK 3072 chars，非 CJK 2048 chars
    expect(tokenBudgetToCharBudget(2048, "旧铜钥匙")).toBe(3072)
    expect(tokenBudgetToCharBudget(2048, "bronze key")).toBe(2048)
    // 不传样本 = 沿用旧口径（既有调用点数值不变）
    expect(tokenBudgetToCharBudget(2048)).toBe(3072)
    expect(tokenBudgetToCharBudget(0, "旧铜钥匙")).toBe(0)
    expect(tokenBudgetToCharBudget(-1, "旧铜钥匙")).toBe(0)
    expect(tokenBudgetToCharBudget(Number.NaN, "旧铜钥匙")).toBe(0)
  })

  it("配比与 adaptiveScale 数值一字未改（分支只作用在换算层）", () => {
    const early = computeContextBudget(204_800, 5)
    // 既有配比常量：resp 15% / index 5%（floor 2000）/ page 50% / per-page 30%
    expect(early.responseReserve).toBe(Math.floor(204_800 * 0.15))
    expect(early.indexBudget).toBe(Math.max(2_000, Math.floor(204_800 * 0.05)))
    expect(early.pageBudget).toBe(Math.floor(204_800 * 0.5))
    expect(early.maxPageSize).toBe(
      Math.min(early.pageBudget, Math.max(5_000, Math.floor(early.pageBudget * 0.3))),
    )
    // 硬注入基线口径不动（2048 tokens × 1.5 = 3072 chars）
    expect(early.hardInjectionBudget.baselineChars).toBe(3_072)
    expect(early.hardInjectionBudget.capChars).toBe(hardInjectionCapChars(204_800))
    // G5 canonRules 参考线不动
    expect(early.canonRulesReserve?.standardChars).toBe(3_840)
    expect(early.canonRulesReserve?.reservedChars).toBe(3_840)

    // F-006 回归：canonRulesReserve 是**告警阈值，不是额度扣减** ——
    // 三项既有配额之和不受它影响（没有「先扣预留、其它段让位」这条机制）。
    const sum = early.responseReserve + early.indexBudget + early.pageBudget
    expect(sum).toBe(
      Math.floor(204_800 * 0.15)
        + Math.max(2_000, Math.floor(204_800 * 0.05))
        + Math.floor(204_800 * 0.5),
    )
    // 参考线只按「未分配余量」取值：min(3840, maxCtx − 三项之和)，不从三项里扣。
    expect(early.canonRulesReserve!.reservedChars).toBe(
      Math.min(3_840, Math.max(0, 204_800 - sum)),
    )

    // adaptiveScale 曲线不动：chapter 500 → 0.6 + 0.4 / log10(500)
    const scale = 0.6 + 0.4 / Math.log10(500)
    const late = computeContextBudget(204_800, 500)
    expect(late.indexBudget).toBe(Math.floor(204_800 * 0.05 * scale))
    expect(late.pageBudget).toBe(Math.floor(204_800 * 0.5 * scale))
    expect(late.responseReserve).toBe(early.responseReserve)
  })
})

/** 边界回归网用的固定消息组（字符 1800 / token 466）。 */
function boundaryMessages(): ChatMessage[] {
  return [
    { role: "system", content: "s".repeat(400) },
    { role: "user", content: "u".repeat(300) },
    { role: "assistant", content: "a".repeat(900) },
    { role: "user", content: "b".repeat(200) },
  ]
}

function totalTextLength(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => {
    if (typeof message.content === "string") return sum + message.content.length
    return sum + message.content.reduce(
      (inner, block) => inner + (block.type === "text" ? block.text.length : 0),
      0,
    )
  }, 0)
}

/**
 * G4b (TASK-006) F4: trim 预算边界回归网。
 *
 * 三档边界 × 两个入口：空预算（含负数 / NaN）、恰好满（必须原样返回同一个
 * 数组引用，不复制）、超一 token（必须真的裁，且裁后落在预算内）。
 *
 * 这里**只加断言，不改实现**：trimChatMessagesToBudget 的三 pass 语义与
 * runner/llm-client 的调用侧参数一字未动。
 */
describe("G4b trim 预算边界回归（空预算 / 恰好满 / 超一 token）", () => {
  it("空预算：字符入口原样返回（0 / 负数 / NaN）", () => {
    const messages = boundaryMessages()
    expect(trimChatMessagesToBudget(messages, 0)).toBe(messages)
    expect(trimChatMessagesToBudget(messages, -1)).toBe(messages)
    expect(trimChatMessagesToBudget(messages, Number.NaN)).toBe(messages)
  })

  it("空预算：token 入口原样返回（0 / 负数 / NaN）", () => {
    const messages = boundaryMessages()
    expect(trimChatMessagesToTokenBudget(messages, 0)).toBe(messages)
    expect(trimChatMessagesToTokenBudget(messages, -1)).toBe(messages)
    expect(trimChatMessagesToTokenBudget(messages, Number.NaN)).toBe(messages)
  })

  it("恰好满：字符预算 = 实际字符数时原样返回同一引用", () => {
    const messages = boundaryMessages()
    const budget = totalTextLength(messages)
    expect(trimChatMessagesToBudget(messages, budget)).toBe(messages)
  })

  it("恰好满：token 预算 = 实际 token 数时原样返回同一引用", () => {
    const messages = boundaryMessages()
    const budget = estimateChatMessagesTokens(messages)
    expect(trimChatMessagesToTokenBudget(messages, budget)).toBe(messages)
  })

  it("超一 token（字符入口）：预算少 1 字符就真的裁，且裁后不超预算", () => {
    const messages = boundaryMessages()
    const budget = totalTextLength(messages) - 1
    const trimmed = trimChatMessagesToBudget(messages, budget)
    expect(trimmed).not.toBe(messages)
    expect(totalTextLength(trimmed)).toBeLessThanOrEqual(budget)
    // 最后一条（当前意图）永不丢弃
    expect(trimmed[trimmed.length - 1]).toBe(messages[messages.length - 1])
  })

  it("超一 token（token 入口）：预算少 1 token 就真的裁，且裁后落在预算内", () => {
    const messages = boundaryMessages()
    const fullTokens = estimateChatMessagesTokens(messages)
    const trimmed = trimChatMessagesToTokenBudget(messages, fullTokens - 1)
    expect(trimmed).not.toBe(messages)
    expect(estimateChatMessagesTokens(trimmed)).toBeLessThan(fullTokens)
    expect(estimateChatMessagesTokens(trimmed)).toBeLessThanOrEqual(fullTokens - 1)
    expect(trimmed[trimmed.length - 1]).toBe(messages[messages.length - 1])
  })
})
