/**
 * visual-lineage.ts — 波3-A：视觉血缘约定（appliesTo=module:visual）。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 波3 + 模块 17 深化）：
 *   - GLM P1 缺口「visual-lineage」：视觉资产生成/采用记录携带
 *     promptArtifactId@version 与来源条目血缘——验收：视觉资产可点开证据链
 *     （提示词工件版本 + 来源条目 id 列表）。
 *
 * 约定口径：
 *   - 视觉血缘 = VisualAssetLineage {assetId, promptArtifactId,
 *     promptArtifactVersion, sourceEntryIds}（strict zod；来源条目 ≥1 条，
 *     无血缘的视觉资产在构建出口 fail-loud）；
 *   - appliesTo 约定：视觉资产的提示词工件 appliesTo 必须 = `module:visual`
 *     （prompt-artifacts 的建议键法之一，128 字符内）；assertVisualAppliesTo
 *     复核挂错面的工件（fail-loud）；
 *   - 事件 kind=stage（payload.visualLineage 显式标记），evidenceRefs =
 *     visual:<assetId> + prompt:<promptArtifactId>@<version> + entry:<id>
 *     ——可点开证据链。
 *
 * 机械层（ADR-19）：纯函数 + zod，零 IO / 零时钟（ts 注入）/ 零模型调用。
 *
 * @license MIT © QMAI
 */

import { z } from "zod"
import type { PromptArtifact } from "./prompt-artifacts"
import type { RunEventAppendInput } from "./run-event-ledger-store"

/** 视觉资产提示词工件的 appliesTo 约定键。 */
export const VISUAL_APPLIES_TO = "module:visual" as const

/** 视觉血缘契约（strict）。 */
export const VISUAL_ASSET_LINEAGE_SCHEMA = z
  .object({
    assetId: z.string().min(1).max(128),
    /** 生成该视觉资产所用的提示词工件 id。 */
    promptArtifactId: z.string().min(1).max(128),
    /** 提示词工件版本（字符串版本号，如 "v3"；与 PROMPT_ARTIFACT_SCHEMA.version 同型）。 */
    promptArtifactVersion: z.string().min(1).max(32),
    /** 来源条目血缘（≥1 条：库条目/世界样本/角色原型等）。 */
    sourceEntryIds: z.array(z.string().min(1).max(128)).min(1),
  })
  .strict()

export type VisualAssetLineage = z.infer<typeof VISUAL_ASSET_LINEAGE_SCHEMA>

/** 视觉血缘错误。 */
export class VisualLineageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "VisualLineageError"
  }
}

/**
 * 断言提示词工件挂视觉面（appliesTo=module:visual）：视觉资产的提示词工件
 * 必须使用视觉约定键（fail-loud 拒绝挂错面的工件）。
 */
export function assertVisualAppliesTo(artifact: PromptArtifact): void {
  if (artifact.appliesTo !== VISUAL_APPLIES_TO) {
    throw new VisualLineageError(
      `提示词工件 ${artifact.artifactId} appliesTo=${artifact.appliesTo} 非 ${VISUAL_APPLIES_TO}：视觉血缘约定要求视觉面工件`,
    )
  }
}

/**
 * 构建视觉血缘记录（生成器出口）：schema 校验 + 资产 id 唯一（重复
 * fail-loud）+ 来源条目强制（≥1）+ 深度冻结。
 */
export function buildVisualLineage(input: { readonly lineages: readonly VisualAssetLineage[] }): readonly VisualAssetLineage[] {
  const parsed = input.lineages.map((lineage) => VISUAL_ASSET_LINEAGE_SCHEMA.parse(lineage))
  const seen = new Set<string>()
  for (const lineage of parsed) {
    if (seen.has(lineage.assetId)) throw new VisualLineageError(`视觉资产 id 重复: ${lineage.assetId}`)
    seen.add(lineage.assetId)
  }
  return parsed.map((lineage) => Object.freeze({ ...lineage }) as VisualAssetLineage)
}

/** 血缘 → 可点开证据链（visual + prompt@version + entry 逐条）。 */
export function visualLineageEvidenceRefs(lineage: VisualAssetLineage): string[] {
  return [
    `visual:${lineage.assetId}`,
    `prompt:${lineage.promptArtifactId}@${lineage.promptArtifactVersion}`,
    ...lineage.sourceEntryIds.map((entryId) => `entry:${entryId}`),
  ]
}

/** 视觉血缘事件输入（kind=stage + payload.visualLineage；逐资产证据链）。 */
export function visualLineageEvents(input: { readonly lineages: readonly VisualAssetLineage[]; readonly ts: string }): RunEventAppendInput[] {
  if (input.ts.length === 0) throw new VisualLineageError("ts 为空：事件落账前必须注入时间戳（零时钟纪律）")
  if (input.lineages.length === 0) return []
  return [
    {
      ts: input.ts,
      kind: "stage" as const,
      actor: "system" as const,
      evidenceRefs: input.lineages.flatMap((lineage) => visualLineageEvidenceRefs(lineage)),
      payload: {
        visualLineage: true,
        count: input.lineages.length,
        assets: input.lineages.map((lineage) => ({
          assetId: lineage.assetId,
          promptArtifactId: lineage.promptArtifactId,
          promptArtifactVersion: lineage.promptArtifactVersion,
          sourceEntryIds: lineage.sourceEntryIds,
        })),
      },
    },
  ]
}