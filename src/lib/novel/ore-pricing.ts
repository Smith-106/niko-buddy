/**
 * ore-pricing.ts — B4 矿脉管道计价模型骨架（批准计划 r3 §T7）。
 *
 * 定位：**只定模型形状与纯估算口径，不做计价决策**。
 *   - 三候选模型（`per-token` / `per-entry` / `subscription`）均为**候选**：`decided:false`；
 *     `pricing.status` 保持 `pending`、`enabled=false`、`isOrePipelineUsable()===false`；
 *   - 单价**不得写死进代码**：所有费率经入参传入（本模块不内置任何默认价）；
 *   - 纯函数：零 IO / 零网络 / 零时钟 / 零模型调用（计费、供应商对接均不在本层）。
 *
 * 使用方式（认领方）：选定模型 → 传入费率 → `estimateOreCost` 出成本分解 →
 * `checkOreQuota` 出配额判定；**决策与启用是用户保留事项**（ADR-48 gate 判据包）。
 *
 * @license MIT © Niko Buddy
 */
import { z } from "zod"

export class OrePricingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OrePricingError"
  }
}

/** 候选计价模型 id（排序即清单序，冻结）。 */
export const ORE_PRICING_MODEL_IDS = ["per-token", "per-entry", "subscription"] as const

export type OrePricingModelId = (typeof ORE_PRICING_MODEL_IDS)[number]

/** 候选模型元数据（`decided=false`：仅为候选，不代表已拍板）。 */
export const ORE_PRICING_MODEL_CANDIDATES = [
  {
    id: "per-token",
    label: "按 token 计价",
    /** 计量单位。 */
    unit: "token",
    /** 适用面（描述性，不含单价）。 */
    fit: "采集/归一阶段 LLM 成本随文本量线性增长；需先定 token 口径（中英混排分词）。",
    decided: false,
  },
  {
    id: "per-entry",
    label: "按条计价",
    unit: "entry",
    fit: "以矿脉条目为交付单位（去重后计入），与策展闸门口径（条数）同尺度；易审计。",
    decided: false,
  },
  {
    id: "subscription",
    label: "周期订阅",
    unit: "period",
    fit: "长期批量采集/索引运行；与用量解耦，需配配额闸门防滥用。",
    decided: false,
  },
] as const

export const ORE_PRICING_MODEL_SCHEMA = z
  .object({
    id: z.enum(ORE_PRICING_MODEL_IDS),
    /** 费率（由调用方给；单位随模型：token / entry / period）。 */
    rate: z.number().nonnegative(),
    currency: z.string().min(1),
  })
  .strict()

export type OrePricingModel = z.infer<typeof ORE_PRICING_MODEL_SCHEMA>

/** 用量（三模型各自需要的量；缺失量按 0 计，不报错）。 */
export const ORE_USAGE_SCHEMA = z
  .object({
    tokens: z.number().nonnegative().optional(),
    entries: z.number().nonnegative().optional(),
    periods: z.number().nonnegative().optional(),
  })
  .strict()

export type OreUsage = z.infer<typeof ORE_USAGE_SCHEMA>

export const ORE_COST_ESTIMATE_SCHEMA = z
  .object({
    modelId: z.enum(ORE_PRICING_MODEL_IDS),
    currency: z.string().min(1),
    /** 计量量（模型对应单位）。 */
    quantity: z.number().nonnegative(),
    unit: z.string().min(1),
    /** 成本 = quantity × rate（分项可审计）。 */
    cost: z.number().nonnegative(),
    /** 成本分解（可解释：公式 + 入参）。 */
    breakdown: z.string().min(1),
    /** 计价状态声明：骨架阶段恒 false（未拍板）。 */
    pricingDecided: z.literal(false),
  })
  .strict()

export type OreCostEstimate = z.infer<typeof ORE_COST_ESTIMATE_SCHEMA>

/** 配额（由调用方给；未给 = 无上限约束，判定为 within=true 且 note 声明未设配额）。 */
export const ORE_QUOTA_SCHEMA = z
  .object({
    /** 预算上限（同货币）。 */
    budget: z.number().nonnegative(),
    currency: z.string().min(1),
  })
  .strict()

export const ORE_QUOTA_VERDICT_SCHEMA = z
  .object({
    within: z.boolean(),
    currency: z.string().min(1),
    budget: z.number().nonnegative(),
    cost: z.number().nonnegative(),
    remaining: z.number(),
    note: z.string().min(1),
  })
  .strict()

export type OreQuotaVerdict = z.infer<typeof ORE_QUOTA_VERDICT_SCHEMA>

function quantityOf(modelId: OrePricingModelId, usage: OreUsage): { quantity: number; unit: string } {
  switch (modelId) {
    case "per-token":
      return { quantity: usage.tokens ?? 0, unit: "token" }
    case "per-entry":
      return { quantity: usage.entries ?? 0, unit: "entry" }
    case "subscription":
      return { quantity: usage.periods ?? 0, unit: "period" }
  }
}

/**
 * 成本估算（纯函数）：cost = 计量量 × 费率。
 * 费率/货币必须由调用方给出（本模块不内置默认价 → 「单价不得写死」）。
 */
export function estimateOreCost(
  input: z.input<typeof ORE_PRICING_MODEL_SCHEMA>,
  usage: z.input<typeof ORE_USAGE_SCHEMA>,
): OreCostEstimate {
  const model = ORE_PRICING_MODEL_SCHEMA.safeParse(input)
  if (!model.success) throw new OrePricingError(`计价模型非法：${model.error.message}`)
  const parsedUsage = ORE_USAGE_SCHEMA.safeParse(usage)
  if (!parsedUsage.success) throw new OrePricingError(`用量非法：${parsedUsage.error.message}`)
  const { quantity, unit } = quantityOf(model.data.id, parsedUsage.data)
  const cost = quantity * model.data.rate
  return ORE_COST_ESTIMATE_SCHEMA.parse({
    modelId: model.data.id,
    currency: model.data.currency,
    quantity,
    unit,
    cost,
    breakdown: `cost = ${quantity} ${unit} × ${model.data.rate} ${model.data.currency}/${unit}（模型 ${model.data.id}，候选未拍板）`,
    pricingDecided: false,
  })
}

/**
 * 配额判定（纯函数）：预算内 → within=true；超预算 → within=false 且 remaining 为负。
 * 货币不一致 fail-loud（拒绝跨币种静默比较）。
 */
export function checkOreQuota(
  estimate: z.input<typeof ORE_COST_ESTIMATE_SCHEMA>,
  quota: z.input<typeof ORE_QUOTA_SCHEMA>,
): OreQuotaVerdict {
  const parsedEstimate = ORE_COST_ESTIMATE_SCHEMA.safeParse(estimate)
  if (!parsedEstimate.success) throw new OrePricingError(`成本估算非法：${parsedEstimate.error.message}`)
  const parsedQuota = ORE_QUOTA_SCHEMA.safeParse(quota)
  if (!parsedQuota.success) throw new OrePricingError(`配额非法：${parsedQuota.error.message}`)
  const est = parsedEstimate.data
  const q = parsedQuota.data
  if (est.currency !== q.currency) {
    throw new OrePricingError(`货币不一致：估算 ${est.currency} ≠ 配额 ${q.currency}（不得跨币种比较）`)
  }
  const remaining = q.budget - est.cost
  const within = remaining >= 0
  return ORE_QUOTA_VERDICT_SCHEMA.parse({
    within,
    currency: q.currency,
    budget: q.budget,
    cost: est.cost,
    remaining,
    note: within
      ? `预算内：剩余 ${remaining} ${q.currency}（计价未拍板，本判定仅为骨架口径）`
      : `超预算：缺口 ${Math.abs(remaining)} ${q.currency}（计价未拍板；不得据此启用矿脉管道）`,
  })
}

/** 人类可读摘要（可观测输出；零副作用）。 */
export function formatOrePricingSkeleton(): string {
  const lines = [
    `矿脉计价骨架：候选模型 ${ORE_PRICING_MODEL_IDS.length}（${ORE_PRICING_MODEL_IDS.join(" / ")}）`,
    "状态：pricing.status=pending / enabled=false / isOrePipelineUsable()=false —— 单价未拍板，骨架不等于可用",
  ]
  for (const c of ORE_PRICING_MODEL_CANDIDATES) {
    lines.push(`- ${c.id}（${c.label}；单位 ${c.unit}；decided=${c.decided}）：${c.fit}`)
  }
  return lines.join("\n")
}
