/**
 * 简报渲染（F-003）：把 `BriefingDigest` 变成结构化块，并在与 canon 冲突时以 canon 为准，
 * 额外产出 `divergence` 块。
 *
 * 本模块是**纯函数**：不读文件、不写文件、不调用任何 IPC。
 */

import {
  type BriefingAssertion,
  type BriefingBlockKind,
  type BriefingDigest,
  type OpenDebt,
} from "./digest-aggregator"

export const BRIEFING_RENDERER_VERSION = "briefing-renderer/1"

/** canon 侧的权威取值；`claimKey` 与断言对齐。 */
export interface CanonClaim {
  claimKey: string
  value: string
  /** 可选的 canon 内位置，用于展示来源。 */
  source?: string
}

export interface DivergenceEntry {
  claimKey: string
  projectionSide: string
  canonSide: string
  canonSource: string | null
  source: BriefingAssertion["source"]
}

export interface RenderedBlock {
  kind: BriefingBlockKind
  title: string
  lines: RenderedLine[]
}

export interface RenderedLine {
  id: string
  text: string
  source: BriefingAssertion["source"]
  /** true = 该行被 canon 覆盖，只在 divergence 块里出现。 */
  supersededByCanon: boolean
}

export interface RenderedBriefing {
  version: string
  blocks: RenderedBlock[]
  divergence: DivergenceEntry[]
  warnings: string[]
}

const BLOCK_TITLES: Record<BriefingBlockKind, string> = {
  emotion: "emotion",
  debts: "debts",
  behavior: "behavior",
  facts: "facts",
  progress: "progress",
}

/** 记忆补丁路径（opt-in 写入时使用）。聚合器/渲染器都不会自己去写。 */
export function memoryPatchPath(projectNamespace: string, timestamp: string): string {
  return `QM/memory/${projectNamespace}/patches/${timestamp}.json`
}

/**
 * 用 canon 裁决投影侧断言。canon 是权威：命中且取值不同的断言被标记 `supersededByCanon`，
 * 并进入 `divergence` 块（同时给出两侧取值，供人工判断是投影漂移还是 canon 过期）。
 */
export function resolveAgainstCanon(
  assertions: BriefingAssertion[],
  canonClaims: CanonClaim[],
): { kept: BriefingAssertion[]; divergence: DivergenceEntry[] } {
  const canon = new Map(canonClaims.map((c) => [c.claimKey, c]))
  const kept: BriefingAssertion[] = []
  const divergence: DivergenceEntry[] = []

  for (const assertion of assertions) {
    const claim = assertion.claimKey ? canon.get(assertion.claimKey) : undefined
    if (!claim) {
      kept.push(assertion)
      continue
    }
    if (claim.value === assertion.text) {
      kept.push(assertion)
      continue
    }
    divergence.push({
      claimKey: claim.claimKey,
      projectionSide: assertion.text,
      canonSide: claim.value,
      canonSource: claim.source ?? null,
      source: assertion.source,
    })
  }

  return { kept, divergence }
}

export function renderBriefing(
  digest: BriefingDigest,
  canonClaims: CanonClaim[] = [],
): RenderedBriefing {
  const { kept, divergence } = resolveAgainstCanon(digest.assertions, canonClaims)
  const blocks: RenderedBlock[] = []

  for (const kind of digest.blocks) {
    const lines = kept
      .filter((a) => a.block === kind)
      .map((a) => ({
        id: a.id,
        text: a.text,
        source: a.source,
        supersededByCanon: false,
      }))
    if (lines.length === 0) continue
    blocks.push({ kind, title: BLOCK_TITLES[kind], lines })
  }

  return {
    version: BRIEFING_RENDERER_VERSION,
    blocks,
    divergence,
    warnings: digest.warnings,
  }
}

/** 债务块的展示顺序：越早播种越靠前（`dueChapter` 在真实 store 中不存在）。 */
export function sortDebtsForDisplay(debts: OpenDebt[]): OpenDebt[] {
  return [...debts].sort(
    (a, b) => a.plantedChapter - b.plantedChapter || a.id.localeCompare(b.id),
  )
}

/** 记忆补丁的纯构造（不落盘）。 */
export interface MemoryPatchDraft {
  schema: "briefing-memory-patch/1"
  generatedAt: string
  assertions: Array<{
    id: string
    text: string
    source: BriefingAssertion["source"]
  }>
}

export function buildMemoryPatch(
  digest: BriefingDigest,
  generatedAt: string,
): MemoryPatchDraft {
  return {
    schema: "briefing-memory-patch/1",
    generatedAt,
    assertions: digest.assertions.map((a) => ({
      id: a.id,
      text: a.text,
      source: a.source,
    })),
  }
}
