/**
 * retrieval-scale-placeholders.ts — R3-c/d 工程预案占位（契约先行，实现待认领）。
 *
 * 共识来源：批准计划 r2 §R3-c/§R3-d（planHandoffKey 738a75141a5a6b2386f8b38eef21ef600dedf9461eca4972037b2f0b68f55113）；
 * 对应 `docs/p0/eval-matrix-<date>.md` §4 Backlog B3/B4。
 *
 * 定位（**占位，不是实现**）：
 *   - ANN / 分片：无实现（R2 谓词 `ann_no_implementation` 恒 locked）；本模块只冻结契约形状，
 *     使实现方有编译期靶子，且任何「已实现」声称都必须在此把 `implemented` 翻为 true 并同步谓词。
 *   - 矿脉管道（ore pipeline）：契约含 **⓪ 计价待定**（`pricing.status = "pending"`）——
 *     单价/配额模型未拍板前不得冻结版本，也不得默认启用。
 *
 * 机械层（ADR-19）：纯类型 + 冻结常量，零 IO / 零时钟 / 零模型调用。
 *
 * @license MIT © QMAI
 */

import { z } from "zod"

// ============================================================================
// B3 ANN / 分片预案
// ============================================================================

/** ANN 索引类型（选型未定：HNSW / IVF / 其他；实现时须过评测矩阵 §3 裁决 + R0-d 预算账本）。 */
export const ANN_INDEX_KIND_SCHEMA = z.enum(["hnsw", "ivf", "diskann", "unspecified"])

export type AnnIndexKind = z.infer<typeof ANN_INDEX_KIND_SCHEMA>

/** ANN 预案契约（占位；`implemented` 恒 false，翻 true 须同 commit 更新 scale-unlock-gates 谓词）。 */
export const ANN_PLAN_SCHEMA = z
  .object({
    kind: ANN_INDEX_KIND_SCHEMA,
    implemented: z.literal(false),
    /** 生效前提：非同源裁决矩阵（eval-matrix §3）通过 + 预算账本记账接入。 */
    prerequisites: z.array(z.string().min(1)),
    /** 待标定参数量（ef/M/nlist 等），未定 → 空对象。 */
    params: z.record(z.string(), z.number()),
  })
  .strict()

export type AnnPlan = z.infer<typeof ANN_PLAN_SCHEMA>

/** 分片预案契约（占位）。 */
export const SHARD_PLAN_SCHEMA = z
  .object({
    strategy: z.enum(["none", "by-collection", "by-genre", "unspecified"]),
    implemented: z.literal(false),
    /** 分片键候选（collection/genre/lang…）；未定 → 空数组。 */
    shardKeys: z.array(z.string().min(1)),
    /** 跨片归并口径未定 → 留空。 */
    mergePolicy: z.string().optional(),
  })
  .strict()

export type ShardPlan = z.infer<typeof SHARD_PLAN_SCHEMA>

/** 现役占位实例（可被谓词/文档引用；不参与任何运行时路径）。 */
export const ANN_PLAN_PLACEHOLDER: AnnPlan = ANN_PLAN_SCHEMA.parse({
  kind: "unspecified",
  implemented: false,
  prerequisites: [
    "eval-matrix §3 非同源多集裁决（Wilson CI 下界 ≥ 阈值）",
    "R0-d 预算账本接入（ANN 查询路径记账 + 超时回退）",
    "R2 谓词解除 ann_no_implementation（本文件 implemented 翻 true 同步）",
  ],
  params: {},
})

export const SHARD_PLAN_PLACEHOLDER: ShardPlan = SHARD_PLAN_SCHEMA.parse({
  strategy: "unspecified",
  implemented: false,
  shardKeys: [],
})

// ============================================================================
// B4 矿脉管道契约（ore pipeline；⓪ 计价待定）
// ============================================================================

/** 计价状态：⓪ 计价待定（未拍板前管道不得启用）。 */
export const ORE_PRICING_STATUS_SCHEMA = z.enum(["pending", "agreed"])

export type OrePricingStatus = z.infer<typeof ORE_PRICING_STATUS_SCHEMA>

/** 管道阶段（采集 → 归一 → 去重 → 许可校验 → 落盘 → 索引）。 */
export const ORE_PIPELINE_STAGES = [
  "ingest",
  "normalize",
  "dedupe",
  "license-check",
  "persist",
  "index",
] as const

export type OrePipelineStage = (typeof ORE_PIPELINE_STAGES)[number]

/**
 * 矿脉管道契约（占位）：计价未定时 `enabled` 必须为 false 且 `pricing.status="pending"`。
 * 版本冻结条件：计价（单价/成本模型/配额）+ 许可校验口径（CC0/再分发许可）+ 归属登记。
 */
export const ORE_PIPELINE_CONTRACT_SCHEMA = z
  .object({
    contractVersion: z.string().min(1),
    enabled: z.boolean(),
    pricing: z
      .object({
        status: ORE_PRICING_STATUS_SCHEMA,
        /** 单价（未定 → undefined）；⓪ 计价待定期间不得填。 */
        unitPrice: z.number().nonnegative().optional(),
        currency: z.string().optional(),
        note: z.string().min(1),
      })
      .strict(),
    stages: z.array(z.enum(ORE_PIPELINE_STAGES)).min(1),
    /** 许可校验口径（自建 CC0 内容包须带 LICENSE/ADR；上游仓只读不得改写）。 */
    licensePolicy: z.string().min(1),
  })
  .strict()

export type OrePipelineContract = z.infer<typeof ORE_PIPELINE_CONTRACT_SCHEMA>

/** 现役占位契约：⓪ 计价待定 → enabled=false（不得作为启用依据）。 */
export const ORE_PIPELINE_CONTRACT_PLACEHOLDER: OrePipelineContract =
  ORE_PIPELINE_CONTRACT_SCHEMA.parse({
    contractVersion: "0.0.0-pending-pricing",
    enabled: false,
    pricing: {
      status: "pending",
      note: "⓪ 计价待定：单价/成本模型/配额未拍板；未定前管道不得启用，契约版本不得升 minor。",
    },
    stages: [...ORE_PIPELINE_STAGES],
    licensePolicy:
      "自建内容包须 CC0 + LICENSE + ADR.md（detectLicense 走 full）；reference/ 上游仓只读，禁止改写其业务内容",
  })

/** 计价未定即锁：谓词/接线方调用此函数判定（纯函数）。 */
export function isOrePipelineUsable(contract: OrePipelineContract): boolean {
  const parsed = ORE_PIPELINE_CONTRACT_SCHEMA.safeParse(contract)
  if (!parsed.success) return false
  return parsed.data.enabled && parsed.data.pricing.status === "agreed"
}
