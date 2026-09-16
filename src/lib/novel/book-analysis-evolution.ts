/**
 * book-analysis-evolution.ts — 波2-B 模块 8：拆书形象演变 → 角色库 aura 单向闭环。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 波2 + 模块 8）：
 *   - GLM P1 缺口「imageEvolutionTimeline→aura」：拆书形象演变 timeline 未闭
 *     环到角色库 auraSeeds——本模块把演变锚点序列确定性合成 aura 种子；
 *   - DS 验收：拆书产出的形象演变序列可生成角色 auraSeeds 并在角色库中可见
 *     同源血缘——种子文本内嵌血缘锚 `⟨锚文本⟩@ch⟨章⟩`，事件 evidenceRefs
 *     逐条可点开（kind=kb-rebuild，kb 产物更新事件）；
 *   - **单向闭环不变量**：演变(timeline) → 种子(auraSeeds) 只允许此方向；
 *     applyAuraSeedsToArchetype 返回**新**条目（输入冻结不变），种子是产物
 *     不是真源（真源=拆书演变序列；kb-EB-2 生成器→只读产物纪律）。
 *
 * 机械层（ADR-19）：纯函数 + zod，零 IO / 零时钟 / 零模型调用；事件对象只
 * 产出输入形态（RunEventAppendInput，seq/eventId 由 ledger-store 派生落账）。
 *
 * @license MIT © QMAI
 */

import { z } from "zod"
import { CHARACTER_ARCHETYPE_ENTRY_SCHEMA, type CharacterArchetypeEntry } from "./asset-library"
import type { RunEventAppendInput } from "./run-event-ledger-store"

// ============================================================================
// 拆书形象演变 timeline 契约（本模块定义——拆书产物的 aura 闭环面）
// ============================================================================

/** 演变锚点（章级文本锚；≤256 对齐库 schema 种子上限）。 */
export const IMAGE_EVOLUTION_ANCHOR_SCHEMA = z
  .object({
    /** 演变所在章号（非负；0 = 章前/设定期）。 */
    chapterId: z.number().int().nonnegative(),
    /** 形象锚点文本（拆书产物逐字引用，禁改写）。 */
    anchorText: z.string().min(1).max(256),
  })
  .strict()

/** 形象演变 timeline（单角色锚点序列，章升序由调用方保证——合成期重排防乱序）。 */
export const IMAGE_EVOLUTION_TIMELINE_SCHEMA = z
  .object({
    /** 角色 key（与角色库条目 entryId 或 archetype 对齐，调用方负责语义）。 */
    characterKey: z.string().min(1).max(128),
    /** 锚点序列（≥1；合成期确定性重排为 chapterId 升序 + anchorText 字典序）。 */
    anchors: z.array(IMAGE_EVOLUTION_ANCHOR_SCHEMA).min(1).max(256),
  })
  .strict()

export type ImageEvolutionAnchor = z.infer<typeof IMAGE_EVOLUTION_ANCHOR_SCHEMA>
export type ImageEvolutionTimeline = z.infer<typeof IMAGE_EVOLUTION_TIMELINE_SCHEMA>

/** 拆书演变错误（schema 违反 / 血缘溢出）。 */
export class BookAnalysisEvolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BookAnalysisEvolutionError"
  }
}

// ============================================================================
// 演变 → aura 种子（单向合成）
// ============================================================================

/** aura 种子合成结果（血缘逐条可点开）。 */
export interface AuraSeedSynthesis {
  /** 合成种子：`⟨锚文本⟩@ch⟨章号⟩`（血缘内嵌，≤256 对齐库 schema）。 */
  readonly seeds: readonly string[]
  /** 种子 → 锚点血缘（同序）。 */
  readonly lineage: readonly {
    readonly seed: string
    readonly chapterId: number
    readonly anchorText: string
  }[]
  /** 超容量截断的锚点数（确定性丢弃：排序后取前 max）。 */
  readonly truncatedAnchors: number
  /** 与既有种子去重后新增的种子数。 */
  readonly seedsAdded: number
}

/**
 * 演变 timeline → aura 种子（**单向合成**，纯函数）：
 *   1. 锚点确定性排序：chapterId 升序 → anchorText 字典序（乱序输入同输出）；
 *   2. 种子文本内嵌血缘：`锚文本@chN`（角色库投影可见同源血缘）；
 *   3. 与既有种子去重（existingSeeds）；总量按 maxSeeds（缺省 32 = 库 schema
 *      上限）确定性截断——先保既有，后按排序补新，溢出计入 truncatedAnchors。
 */
export function evolutionToAuraSeeds(input: {
  readonly timeline: ImageEvolutionTimeline
  readonly existingSeeds?: readonly string[]
  readonly maxSeeds?: number
}): AuraSeedSynthesis {
  const parsed = IMAGE_EVOLUTION_TIMELINE_SCHEMA.parse(input.timeline)
  const max = input.maxSeeds ?? 32
  if (max < 0 || max > 32) {
    throw new BookAnalysisEvolutionError(`maxSeeds 越界 [0,32]: ${max}（对齐 CHARACTER_ARCHETYPE_ENTRY_SCHEMA）`)
  }
  const ordered = [...parsed.anchors].sort((a, b) =>
    a.chapterId !== b.chapterId ? a.chapterId - b.chapterId : a.anchorText < b.anchorText ? -1 : 1,
  )
  const existing = new Set(input.existingSeeds ?? [])
  const seeds: string[] = []
  const lineage: { seed: string; chapterId: number; anchorText: string }[] = []
  let truncated = 0
  for (const anchor of ordered) {
    const seed = `${anchor.anchorText}@ch${anchor.chapterId}`
    if (existing.has(seed)) continue
    if (existing.size + seeds.length >= max) {
      truncated += 1
      continue
    }
    seeds.push(seed)
    lineage.push({ seed, chapterId: anchor.chapterId, anchorText: anchor.anchorText })
  }
  return { seeds, lineage, truncatedAnchors: truncated, seedsAdded: seeds.length }
}

// ============================================================================
// 种子 → 角色库条目（返回新条目；输入不可变 = 单向闭环机械面）
// ============================================================================

/**
 * 将合成种子并入角色原型条目（**纯函数**，返回新条目；输入条目保持原样）：
 *   - 既有种子在前（保序），新种子按合成序追加；
 *   - 溢出 fail-loud：合并总量超 32（库 schema 上限）即抛——容量纪律由合成期
 *     evolutionToAuraSeeds 的 maxSeeds 承担，并入端绝不静默丢种子；
 *   - 产物必须能通过 CHARACTER_ARCHETYPE_ENTRY_SCHEMA（zod 校验兜底）；
 *   - 调用方须将新条目经 buildLibraryArtifact 重建产物 + 守恒校验（可审计）。
 */
export function applyAuraSeedsToArchetype(
  entry: CharacterArchetypeEntry,
  synthesis: AuraSeedSynthesis,
): CharacterArchetypeEntry {
  const merged = [...(entry.auraSeeds ?? []), ...synthesis.seeds]
  if (merged.length > 32) {
    throw new BookAnalysisEvolutionError(
      `aura 种子合并后越界（${merged.length} > 32）：合成期 maxSeeds 必须预留容量（不静默丢种子）`,
    )
  }
  const next = { ...entry, auraSeeds: merged }
  const parsed = CHARACTER_ARCHETYPE_ENTRY_SCHEMA.safeParse(next)
  if (!parsed.success) {
    throw new BookAnalysisEvolutionError(
      `aura 种子并入后契约违反: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    )
  }
  return parsed.data
}

// ============================================================================
// kb 产物更新事件（kind=kb-rebuild；血缘 evidenceRefs 逐条可点开）
// ============================================================================

/**
 * 产出 kb 产物更新事件输入（appendRunEventsToStore 落账）：
 *   - kind=kb-rebuild（EB-2 生成器产物更新口径）；
 *   - evidenceRefs = 逐条种子血缘锚 `aura-seed:<characterKey>@ch<章号>`；
 *   - payload 记录新增/截断计数与时间线 key（审计面）。
 */
export function evolutionAuraEvents(input: {
  readonly timeline: ImageEvolutionTimeline
  readonly synthesis: AuraSeedSynthesis
  readonly ts: string
}): RunEventAppendInput[] {
  if (input.ts.length === 0) {
    throw new BookAnalysisEvolutionError("ts 为空：事件落账前必须由调用方注入时间戳（零时钟纪律）")
  }
  return [
    {
      ts: input.ts,
      kind: "kb-rebuild" as const,
      actor: "system" as const,
      evidenceRefs: input.synthesis.lineage.map(
        (l) => `aura-seed:${input.timeline.characterKey}@ch${l.chapterId}`,
      ),
      payload: {
        characterKey: input.timeline.characterKey,
        anchorsCount: input.timeline.anchors.length,
        seedsAdded: input.synthesis.seedsAdded,
        truncatedAnchors: input.synthesis.truncatedAnchors,
        lineage: input.synthesis.lineage.map((l) => ({ seed: l.seed, chapterId: l.chapterId })),
      },
    },
  ]
}