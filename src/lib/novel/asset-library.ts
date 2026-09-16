/**
 * asset-library.ts — 波1 五库 EB-2 投影契约（题材基底 / 推进模式 / 标题种子 /
 * 世界样本 / 角色原型）。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 模块 9/10/11/13/16 投影面）：
 *   EB-2 投影契约——库 = **生成器产物 → 只读 → 守恒校验 → kb-health**：
 *   - 数据归口三分类之「资产」归口：五库条目一律由生成器产出（kb 产物化管线），
 *     手工编辑被守恒校验检出（contentHash 由 entries 确定性重建，篡改即失配）；
 *   - 禁第二真源：库文件是产物不是真源，真源在 kb 生成器输入（与本契约正交）；
 *   - 跨书隔离（G2 反证）：条目携带 projectId（可选）时，单库 artifact 内
 *     projectId 集合必须 ≤ 1（跨书混载 = 健康违规）；
 *   - 超越点挂载面：题材 forbidPatterns（→ de-ai 规则引用，波2）、世界样本
 *     transferableConstraints 强制 + 硬/软约束分级（软违规不得 P0 FAIL）。
 *
 * 机械层（ADR-19）：纯函数 + zod，零 IO / 零时钟（generatedAt 注入）/
 * 零模型调用；哈希与 prompt-artifacts 同法（FNV-1a 身份哈希）。
 *
 * @license MIT © QMAI
 */

import { z } from "zod"
import { ADVANCE_MODE_SCHEMA, type AdvanceMode } from "./director-modes"

// ============================================================================
// 五库条目 schema
// ============================================================================

/** 题材基底条目（模块 9）：forbidPatterns 将被 de-ai 规则引用（题材库改一条→门控行为可测变）。 */
export const GENRE_BASE_ENTRY_SCHEMA = z
  .object({
    entryId: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128).optional(),
    name: z.string().min(1).max(128),
    toneTags: z.array(z.string().min(1).max(64)).max(16).default([]),
    /** 反 AI 禁用句式（可执行约束，非文案）。 */
    forbidPatterns: z.array(z.string().min(1).max(256)).max(64).default([]),
    /** 题材标准情节节拍。 */
    plotBeats: z.array(z.string().min(1).max(128)).max(32).default([]),
  })
  .strict()

export type GenreBaseEntry = z.infer<typeof GENRE_BASE_ENTRY_SCHEMA>

/** 推进模式条目（模块 10）：复用 director-modes 模式契约（不复制第二真源）。 */
export const PACING_PATTERN_ENTRY_SCHEMA = ADVANCE_MODE_SCHEMA.extend({}).passthrough()

export type PacingPatternEntry = AdvanceMode & { projectId?: string }

/** 标题种子条目（模块 11）：约束可证筛选的素材面。 */
export const TITLE_SEED_ENTRY_SCHEMA = z
  .object({
    entryId: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128).optional(),
    pattern: z.string().min(1).max(256),
    /** 命中/违反可测的题材约束（标题工坊筛选依据）。 */
    constraints: z.array(z.string().min(1).max(128)).max(16).default([]),
    examples: z.array(z.string().min(1).max(128)).max(16).default([]),
    modelHint: z.string().min(1).max(128).optional(),
  })
  .strict()

export type TitleSeedEntry = z.infer<typeof TITLE_SEED_ENTRY_SCHEMA>

/** 世界样本条目（模块 13）：transferableConstraints 强制（无约束不算合格样本）+ 硬/软分级。 */
export const WORLD_SAMPLE_ENTRY_SCHEMA = z
  .object({
    entryId: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128).optional(),
    sourceRef: z.string().min(1).max(256),
    /** 可迁移硬约束（P0 参照；缺省非空——健康探针强制）。 */
    transferableConstraints: z.array(z.string().min(1).max(256)).default([]),
    /** 软设定约束（违规不得 P0 FAIL，防误伤）。 */
    softConstraints: z.array(z.string().min(1).max(256)).default([]),
    sceneSeeds: z.array(z.string().min(1).max(256)).max(32).default([]),
  })
  .strict()

export type WorldSampleEntry = z.infer<typeof WORLD_SAMPLE_ENTRY_SCHEMA>

/** 角色原型条目（模块 16）：aura 种子可检索（同质化量化与声音漂移的数据面）。 */
export const CHARACTER_ARCHETYPE_ENTRY_SCHEMA = z
  .object({
    entryId: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128).optional(),
    archetype: z.string().min(1).max(128),
    voiceProfileHint: z.string().min(1).max(256).optional(),
    auraSeeds: z.array(z.string().min(1).max(256)).max(32).default([]),
  })
  .strict()

export type CharacterArchetypeEntry = z.infer<typeof CHARACTER_ARCHETYPE_ENTRY_SCHEMA>

/** 五库 id。 */
export const LIBRARY_IDS = ["genre_base", "pacing_pattern", "title_seed", "world_sample", "character_archetype"] as const

export type LibraryId = (typeof LIBRARY_IDS)[number]

/** 任意条目（五库联合）。 */
export type LibraryEntry =
  | GenreBaseEntry
  | PacingPatternEntry
  | TitleSeedEntry
  | WorldSampleEntry
  | CharacterArchetypeEntry

// ============================================================================
// 库 artifact（生成器产物；只读）
// ============================================================================

/** 库 schema 版本。 */
export const ASSET_LIBRARY_SCHEMA_VERSION = "asset-library/1.0"

/** 库产物（deepFreeze 只读；contentHash 由 entries 确定性重建）。 */
export interface LibraryArtifact {
  readonly libraryId: LibraryId
  readonly schemaVersion: typeof ASSET_LIBRARY_SCHEMA_VERSION
  readonly generatorVersion: string
  readonly generatedAt: string
  readonly entries: readonly LibraryEntry[]
  readonly contentHash: string
}

/** 库错误基类。 */
export class AssetLibraryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AssetLibraryError"
  }
}

/** 每库条目校验器（按 libraryId 分派 zod schema）。 */
const ENTRY_SCHEMAS_BY_ID: Record<LibraryId, z.ZodTypeAny> = {
  genre_base: GENRE_BASE_ENTRY_SCHEMA,
  pacing_pattern: ADVANCE_MODE_SCHEMA,
  title_seed: TITLE_SEED_ENTRY_SCHEMA,
  world_sample: WORLD_SAMPLE_ENTRY_SCHEMA,
  character_archetype: CHARACTER_ARCHETYPE_ENTRY_SCHEMA,
}

/** 确定性序列化（键排序稳定 JSON——守恒重建的规范化输入）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")
  return `{${body}}`
}

/** 确定性身份哈希（FNV-1a 32-bit + 长度后缀；与 prompt-artifacts 同法）。 */
export function computeLibraryHash(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `lib-fnv1a-${hash.toString(16).padStart(8, "0")}-len${input.length}`
}

/**
 * 构建库产物（生成器出口）：条目 schema 校验 + 确定性 contentHash + 深度冻结。
 * hash 输入 = `${libraryId}:${stableStringify(entries)}`——库内条目顺序变化
 * 会改变 hash（产物内容指纹含序，守恒口径=字节级一致）。
 */
export function buildLibraryArtifact(input: {
  readonly libraryId: LibraryId
  readonly generatorVersion: string
  readonly generatedAt: string
  readonly entries: readonly LibraryEntry[]
}): LibraryArtifact {
  const schema = ENTRY_SCHEMAS_BY_ID[input.libraryId]
  for (let i = 0; i < input.entries.length; i += 1) {
    const result = schema.safeParse(input.entries[i])
    if (!result.success) {
      throw new AssetLibraryError(
        `${input.libraryId} 条目[${i}] 契约违反: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      )
    }
  }
  const contentHash = computeLibraryHash(`${input.libraryId}:${stableStringify(input.entries)}`)
  const artifact: LibraryArtifact = {
    libraryId: input.libraryId,
    schemaVersion: ASSET_LIBRARY_SCHEMA_VERSION,
    generatorVersion: input.generatorVersion,
    generatedAt: input.generatedAt,
    entries: input.entries.map((entry) => deepFreeze(entry)),
    contentHash,
  }
  return deepFreeze(artifact)
}

// ============================================================================
// 守恒 / 只读守卫 / kb-health 探针
// ============================================================================

/** 守恒校验结果。 */
export interface ConservationReport {
  readonly conserved: boolean
  readonly expectedHash: string
  readonly actualHash: string
}

/**
 * 守恒校验（EB-2 核心）：由 entries 确定性重建 hash 并与 artifact.contentHash
 * 比对——手工篡改条目（生成器之外）必然失配被检出。
 */
export function verifyLibraryConservation(artifact: LibraryArtifact): ConservationReport {
  const expected = computeLibraryHash(`${artifact.libraryId}:${stableStringify(artifact.entries)}`)
  return { conserved: expected === artifact.contentHash, expectedHash: expected, actualHash: artifact.contentHash }
}

/** 只读守卫（EB-2）：产物必须深度冻结（生成器产物只读；禁手改）。 */
export function assertArtifactImmutable(artifact: LibraryArtifact): void {
  const frozen =
    artifact !== null &&
    typeof artifact === "object" &&
    Object.isFrozen(artifact) &&
    Object.isFrozen(artifact.entries) &&
    artifact.entries.every((entry) => Object.isFrozen(entry))
  if (!frozen) {
    throw new AssetLibraryError("asset-library 产物必须深度冻结（只读守卫：生成器产物禁手改）")
  }
}

/** kb-health 探针结果。 */
export interface LibraryHealthReport {
  readonly libraryId: LibraryId
  readonly healthy: boolean
  readonly violations: readonly string[]
  readonly entryCount: number
}

/**
 * kb-health 探针（确定性）：
 *   1. 守恒校验通过；
 *   2. 只读守卫通过；
 *   3. world_sample 条目 transferableConstraints 非空（无约束不算合格样本）；
 *   4. 跨书隔离：artifact 内 projectId 集合 ≤ 1（跨书混载即违规）。
 */
export function probeLibraryHealth(artifact: LibraryArtifact): LibraryHealthReport {
  const violations: string[] = []
  const conservation = verifyLibraryConservation(artifact)
  if (!conservation.conserved) {
    violations.push(
      `守恒失配（疑似手工篡改）: expected=${conservation.expectedHash} actual=${conservation.actualHash}`,
    )
  }
  try {
    assertArtifactImmutable(artifact)
  } catch (err) {
    violations.push(err instanceof Error ? err.message : String(err))
  }
  if (artifact.libraryId === "world_sample") {
    for (const entry of artifact.entries) {
      const sample = entry as WorldSampleEntry
      if (Array.isArray(sample.transferableConstraints) && sample.transferableConstraints.length === 0) {
        violations.push(`world_sample "${sample.entryId}" 缺 transferableConstraints（无约束不算合格样本）`)
      }
    }
  }
  const projectIds = new Set<string>()
  for (const entry of artifact.entries) {
    const projectId = (entry as { projectId?: string }).projectId
    if (projectId !== undefined) projectIds.add(projectId)
  }
  if (projectIds.size > 1) {
    violations.push(`跨书混载: 单库 artifact 内出现 ${projectIds.size} 个 projectId`)
  }
  return {
    libraryId: artifact.libraryId,
    healthy: violations.length === 0,
    violations,
    entryCount: artifact.entries.length,
  }
}

// ============================================================================
// 内部工具
// ============================================================================

/** 深度冻结（与 rule-stack.ts deepFreeze 同型；函数值跳过）。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (!Object.isFrozen(value)) {
      Object.freeze(value)
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}