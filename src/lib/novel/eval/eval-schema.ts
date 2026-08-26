/**
 * eval-schema.ts — F1 G1 骨架：评测数据契约（zod 真源）。
 *
 * 硬共识（eval-g1-skeleton.md C1-C10）：
 *  - C1: L2≥0.99 > L1≥0.95 > L3<0.01（A 门阈值，eval-gates.ts 消费）
 *  - C2: 三元组 join 键 subject/predicate/object + resolveCanonicalName 归一
 *  - C3: L3 仅计 ContinuityFinding critical 且 subtype=consistency_mechanical
 *  - C4: digest 复用 computeCheckpointDigestOf（eval-adapters.ts）
 *  - C5: L1 命中 = protected 层存在性（非 rank）
 *  - C6: fixture 非运行时真源（仅评测输入）
 *  - C7: synthetic 显式标注（source: "synthetic"）
 *  - C8: 200 case 六场景 + 留出集 15%（eval-corpus-synth.ts）
 *  - C9: replayOnlyFailed 默认 true（eval-harness.ts）
 *  - C10: RejectionSignal 补 negation_active
 *
 * 可接受差异（已采纳）：PoisonType 4+1（P_COGNITION 预留）；AuthorityTier
 * 富集 5 档（protected/compressible/former/draft/crossbook）；expectedTier
 * 拆层（GoldChunk.tier / PoisonChunk.expectedLanding / EvalCase.expectedLayer）。
 */
import { z } from "zod"

/** 权威层 5 档（可接受差异：富集档位，供装配期 tier 判定与 L1/L2 分层断言）。 */
export const authorityTierSchema = z.enum([
  "protected", // canonRules + 有效 temporal 事实（P0 硬护栏层）
  "compressible", // communitySummaries 等可压缩层
  "former", // 曾成立事实（formerFacts 独立分块）
  "draft", // 草稿/未定稿
  "crossbook", // 跨书引用（禁入 protected）
])
export type AuthorityTier = z.infer<typeof authorityTierSchema>

/** 毒化类型 4+1（P_COGNITION 预留，当前不生成）。 */
export const poisonTypeSchema = z.enum([
  "contradiction", // 与 canon 直接矛盾
  "temporal_inversion", // 时序倒置（former 当 current）
  "former_as_current", // 已失效事实当当前真值
  "crossbook_leak", // 跨书泄漏
  "cognition_leak", // 认知泄漏（预留）
])
export type PoisonType = z.infer<typeof poisonTypeSchema>

/** 期望落层（L1/L2 断言目标）。 */
export const expectedLayerSchema = z.enum([
  "protected", // 应出现在 protected 层
  "former", // 应出现在 former 层
  "compressible", // 应出现在 compressible 层
  "excluded", // 不应出现在任何层
])
export type ExpectedLayer = z.infer<typeof expectedLayerSchema>

/** GoldChunk：L1 正例（应被检索/装配到 protected 层的三元组）。 */
export const goldChunkSchema = z.object({
  id: z.string(),
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  tier: authorityTierSchema,
  expectedLayer: expectedLayerSchema,
})
export type GoldChunk = z.infer<typeof goldChunkSchema>

/** PoisonChunk：L2 负例（不得进入 protected 层的三元组）。 */
export const poisonChunkSchema = z.object({
  id: z.string(),
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  poisonType: poisonTypeSchema,
  expectedLanding: expectedLayerSchema,
})
export type PoisonChunk = z.infer<typeof poisonChunkSchema>

/** EvalCase：单场景评测用例。 */
export const evalCaseSchema = z.object({
  id: z.string(),
  chapter: z.number().int().positive(),
  query: z.string(),
  goldChunks: z.array(goldChunkSchema),
  poisonChunks: z.array(poisonChunkSchema),
  expectedLayer: expectedLayerSchema,
  source: z.enum(["synthetic", "real"]).default("synthetic"),
})
export type EvalCase = z.infer<typeof evalCaseSchema>

/** 评测运行配置。 */
export const evalRunConfigSchema = z.object({
  caseIds: z.array(z.string()).optional(),
  replayOnlyFailed: z.boolean().default(true),
  thresholds: z
    .object({
      l1Min: z.number().min(0).max(1).default(0.95),
      l2Min: z.number().min(0).max(1).default(0.99),
      l3Max: z.number().min(0).max(1).default(0.01),
    })
    .default({}),
})
export type EvalRunConfig = z.infer<typeof evalRunConfigSchema>

/** 单层结果。 */
export const layerResultSchema = z.object({
  layer: z.enum(["L1", "L2", "L3"]),
  pass: z.boolean(),
  score: z.number().min(0).max(1),
  detail: z.record(z.string(), z.unknown()),
})
export type LayerResult = z.infer<typeof layerResultSchema>

/** 聚合结果（A 门判定输入）。 */
export const aggregateResultSchema = z.object({
  overall: z.boolean(),
  layers: z.object({
    L1: layerResultSchema,
    L2: layerResultSchema,
    L3: layerResultSchema,
  }),
  verdict: z.string(),
})
export type AggregateResult = z.infer<typeof aggregateResultSchema>

/** 拒绝信号（C10：补 negation_active）。 */
export const rejectionSignalSchema = z.object({
  reason: z.string(),
  negation_active: z.boolean(),
  ref: z.string().optional(),
})
export type RejectionSignal = z.infer<typeof rejectionSignalSchema>

/** 单 case 运行结果。 */
export const evalCaseResultSchema = z.object({
  caseId: z.string(),
  passed: z.boolean(),
  layers: z.object({
    L1: layerResultSchema,
    L2: layerResultSchema,
    L3: layerResultSchema,
  }),
  rejections: z.array(rejectionSignalSchema).default([]),
})
export type EvalCaseResult = z.infer<typeof evalCaseResultSchema>

/** 全套运行结果。 */
export const evalRunResultSchema = z.object({
  config: evalRunConfigSchema,
  cases: z.array(evalCaseResultSchema),
  aggregate: aggregateResultSchema,
})
export type EvalRunResult = z.infer<typeof evalRunResultSchema>

/** 评测清单（fixtures/manifest.json 契约）。 */
export const evalManifestSchema = z.object({
  version: z.string(),
  generatedAt: z.string(),
  totalCases: z.number().int().nonnegative(),
  holdoutRatio: z.number().min(0).max(1).default(0.15),
  scenarios: z.array(z.string()),
  source: z.enum(["synthetic", "real"]).default("synthetic"),
})
export type EvalManifest = z.infer<typeof evalManifestSchema>
