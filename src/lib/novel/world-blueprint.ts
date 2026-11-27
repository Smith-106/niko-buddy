/**
 * R-anwa-1 (26 审计落地): WorldBlueprint — 世界观分层骨架与一致性.
 *
 * 吸收来源：reference/AI-Novel-Writing-Assistant server/src/services/world/
 * worldStructure.ts（WorldStructuredData：axioms/background/geography/cultures/
 * magicSystem/politics/races/religions/technology/conflicts/history/economy/
 * factions 分层）+ worldConsistency.ts + worldSkeletonGeneration.ts。
 * 26 号审计三票共识盲区（value 8/5/6 全票 worth_absorbing）。
 *
 * 定位：世界观分层骨架数据模型 + 确定性完备性/一致性检查 + prompt 注入。
 * 骨架内容本身由写作流程产出（draft-first），本模块只做结构治理与
 * 确定性校验，不伪造语义生成。
 */

export const WORLD_LAYERS = [
  "axioms",
  "background",
  "geography",
  "cultures",
  "races",
  "magicSystem",
  "politics",
  "technology",
  "economy",
  "religions",
  "history",
  "conflicts",
  "factions",
] as const

export type WorldLayer = (typeof WORLD_LAYERS)[number]

/** 必填层（ANWA worldStructure 核心层；缺任一视为骨架不完备）。 */
export const REQUIRED_WORLD_LAYERS: WorldLayer[] = [
  "axioms",
  "background",
  "geography",
  "cultures",
  "conflicts",
]

export interface WorldBlueprint {
  version: string
  worldType: string
  /** 分层内容：层名 → 条目列表（每层 0..n 条）。 */
  layers: Partial<Record<WorldLayer, string[]>>
  /** 交叉引用：条目跨层引用（如 magicSystem 引用某 race 名）。 */
  crossRefs?: Array<{ from: WorldLayer; to: WorldLayer; term: string }>
}

export function createEmptyWorldBlueprint(worldType: string): WorldBlueprint {
  return { version: "1.0", worldType, layers: {}, crossRefs: [] }
}

export interface WorldFinding {
  code: "missing_layer" | "empty_layer" | "dangling_cross_ref"
  layer?: WorldLayer
  severity: "error" | "warn"
  message: string
}

export interface WorldValidation {
  findings: WorldFinding[]
  /** 完备（必填层全非空）且无 error → complete。 */
  verdict: "complete" | "incomplete"
}

/**
 * 确定性骨架校验：必填层缺失/为空 → error；可选层为空 → 无发现（合法稀疏）；
 * crossRefs 的 to 层若未包含被引条目 → dangling warn。
 */
export function validateWorldBlueprint(bp: WorldBlueprint): WorldValidation {
  const findings: WorldFinding[] = []

  for (const layer of REQUIRED_WORLD_LAYERS) {
    const entries = bp.layers[layer] ?? []
    if (entries.length === 0) {
      findings.push({
        code: "missing_layer",
        layer,
        severity: "error",
        message: `必填层「${layer}」缺失或为空`,
      })
    }
  }

  for (const ref of bp.crossRefs ?? []) {
    const targetEntries = bp.layers[ref.to] ?? []
    if (!targetEntries.includes(ref.term)) {
      findings.push({
        code: "dangling_cross_ref",
        layer: ref.to,
        severity: "warn",
        message: `交叉引用悬空：「${ref.from}」引用「${ref.to}」层不存在的条目「${ref.term}」`,
      })
    }
  }

  return {
    findings,
    verdict: findings.some((f) => f.severity === "error") ? "incomplete" : "complete",
  }
}

/**
 * 渲染世界观 prompt 片段（仅渲染非空层；空蓝图返回 ""）。
 * 层序固定为 WORLD_LAYERS 声明序，输出确定性。
 */
export function worldBlueprintToPromptFragment(bp: WorldBlueprint): string {
  const sections = WORLD_LAYERS.filter((l) => (bp.layers[l] ?? []).length > 0).map(
    (l) => `### ${l}\n${(bp.layers[l] ?? []).map((e) => `- ${e}`).join("\n")}`,
  )
  if (sections.length === 0) return ""
  return [`# 世界观骨架（${bp.worldType}）`, ...sections].join("\n\n")
}

// ── 持久化（MIG-001：补产物管线）──────────────────────────────────
// world-blueprint 之前只有校验器无持久化——orchestrator 拿不到真实 blueprint
// 只能吃手动 checkbox。补上 .novel/world-blueprint.json 原子 store，让
// 写作流程/编辑器能把骨架落盘，collectPhaseGateInput 才能读真实完备度。
import { createAtomicJsonStore } from "./projection-store"

const worldBlueprintStore = createAtomicJsonStore<WorldBlueprint | null>(
  "world-blueprint.json",
  () => null,
)

/** 持久化世界观骨架（.novel/world-blueprint.json 原子写）。 */
export async function saveWorldBlueprint(projectPath: string, bp: WorldBlueprint): Promise<void> {
  await worldBlueprintStore.save(projectPath, bp)
}

/** 读取持久化世界观骨架；未写过返回 null（调用方按需 createEmpty）。 */
export async function loadWorldBlueprint(projectPath: string): Promise<WorldBlueprint | null> {
  try {
    return await worldBlueprintStore.load(projectPath)
  } catch {
    return null
  }
}

// ── 生成器（MIG-002：从实体推导骨架层，接线产物生产管线）──────────────
// world-blueprint 之前有 store + 校验但无生成器——骨架永远 incomplete，
// worldComplete 判不死。补确定性推导：按 entities/ 物理子目录聚类映射到
// WORLD_LAYERS，产出骨架草稿（治理数据非正文，Draft-first 语义）。
import { listEntityFiles } from "./entity-subdir-resolver"
import { normalizePath } from "@/lib/path-utils"

/** entity 物理子目录 → 骨架层映射（保守推导：实体是骨架的原料）。 */
export const SUBDIR_TO_LAYER: Record<string, WorldLayer> = {
  locations: "geography",
  organizations: "factions",
  items: "technology",
  events: "conflicts",
  characters: "cultures",
  rules: "axioms",
  axioms: "axioms",
  lore: "background",
  background: "background",
  world: "background",
  history: "history",
  magic: "magicSystem",
  politics: "politics",
  races: "races",
  religions: "religions",
  economy: "economy",
}

/** spec 辅助：暴露映射表供断言（避免内部实现漂移）。 */
export const SUBDIR_TO_LAYER_TEST_EXPORT = SUBDIR_TO_LAYER

const WORLD_LAYER_SET: ReadonlySet<string> = new Set(WORLD_LAYERS)

export interface WorldBlueprintSeed {
  idea?: { title?: string; genre?: string; coreConflict?: string }
  existing?: WorldBlueprint | null
  fillMissingRequired?: boolean
}

export interface WorldBlueprintPatch {
  worldType?: string
  version?: string
  /** 合并策略：merge（默认，去重追加各层）或 replace（覆盖传入的层，保留未传入的层）。 */
  mode?: "merge" | "replace"
  layers?: Partial<Record<WorldLayer, string[]>>
  crossRefs?: Array<{ from: WorldLayer; to: WorldLayer; term: string }>
  fillMissingRequired?: boolean
  idea?: { title?: string; genre?: string; coreConflict?: string }
}

function dedupeTrimmedEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of entries) {
    if (typeof item !== "string") continue
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function dedupeCrossRefs(
  refs: readonly { from: WorldLayer; to: WorldLayer; term: string }[],
): Array<{ from: WorldLayer; to: WorldLayer; term: string }> {
  const seen = new Set<string>()
  const out: Array<{ from: WorldLayer; to: WorldLayer; term: string }> = []
  for (const ref of refs) {
    if (!WORLD_LAYER_SET.has(ref.from) || !WORLD_LAYER_SET.has(ref.to)) continue
    const term = ref.term.trim()
    if (!term) continue
    const key = `${ref.from}\0${ref.to}\0${term}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ from: ref.from, to: ref.to, term })
  }
  return out
}

function deterministicRequiredLayerSeed(
  layer: WorldLayer,
  worldType: string,
  idea?: { title?: string; genre?: string; coreConflict?: string },
): string {
  const title = idea?.title?.trim() || "未命名作品"
  const genre = idea?.genre?.trim() || worldType.trim() || "fantasy"
  const conflict = idea?.coreConflict?.trim() || "核心矛盾待进一步细化"
  switch (layer) {
    case "axioms":
      return `${genre}世界基本法则（待按《${title}》细化）`
    case "background":
      return `《${title}》（${genre}）时代背景与世界格局基线`
    case "geography":
      return `《${title}》核心舞台与地理格局（待细化）`
    case "cultures":
      return `《${title}》主要社会文化与人物群体（待细化）`
    case "conflicts":
      return `核心冲突：${conflict}`
    default:
      return `《${title}》${layer}基线设定`
  }
}

/**
 * 确定性合并/覆盖世界观骨架补丁（纯函数，不修改入参）。
 *
 * - `mode: "merge"`（默认）：在已有层后去重追加新条目；
 * - `mode: "replace"`：对本次显式传入的层直接替换，未传入的层保持原样；
 * - `fillMissingRequired: true`：对仍为空的 5 个必填层补齐确定性种子条目，
 *   消除开书 Phase 2 (world) 的 axioms/background 数学死锁。
 */
export function mergeWorldBlueprintPatch(
  existing: WorldBlueprint | null,
  patch: WorldBlueprintPatch,
): WorldBlueprint {
  const mode = patch.mode ?? "merge"
  const worldType = patch.worldType?.trim() || existing?.worldType?.trim() || "fantasy"
  const version = patch.version?.trim() || existing?.version?.trim() || "1.0"

  const nextLayers: Partial<Record<WorldLayer, string[]>> = {}
  if (existing?.layers) {
    for (const layer of WORLD_LAYERS) {
      const prev = existing.layers[layer]
      if (Array.isArray(prev)) {
        nextLayers[layer] = dedupeTrimmedEntries(prev)
      }
    }
  }

  if (patch.layers) {
    for (const [rawLayer, rawEntries] of Object.entries(patch.layers)) {
      if (!WORLD_LAYER_SET.has(rawLayer) || !Array.isArray(rawEntries)) continue
      const layer = rawLayer as WorldLayer
      const incoming = dedupeTrimmedEntries(rawEntries)
      if (mode === "replace") {
        nextLayers[layer] = incoming
      } else {
        nextLayers[layer] = dedupeTrimmedEntries([...(nextLayers[layer] ?? []), ...incoming])
      }
    }
  }

  if (patch.fillMissingRequired) {
    for (const layer of REQUIRED_WORLD_LAYERS) {
      const current = nextLayers[layer] ?? []
      if (current.length === 0) {
        nextLayers[layer] = [deterministicRequiredLayerSeed(layer, worldType, patch.idea)]
      }
    }
  }

  const existingRefs = Array.isArray(existing?.crossRefs) ? existing.crossRefs : []
  const nextCrossRefs =
    patch.crossRefs !== undefined
      ? mode === "replace"
        ? dedupeCrossRefs(patch.crossRefs)
        : dedupeCrossRefs([...existingRefs, ...patch.crossRefs])
      : dedupeCrossRefs(existingRefs)

  return {
    version,
    worldType,
    layers: nextLayers,
    crossRefs: nextCrossRefs,
  }
}

/**
 * 从项目实体推导世界骨架草稿：读 entities/ 各子目录实体名，映射到
 * WORLD_LAYERS 对应层。只做确定性聚合（不 LLM 生成语义），产物是骨架
 * 治理草稿供后续编辑/draft-first 完善。
 *
 * - 省略 `seed` 时 100% 保持既有行为（空项目返回必填层为空数组的 incomplete 骨架）；
 * - 提供 `seed.fillMissingRequired: true` 时按 `seed.idea` 确定性补齐缺失的 5 个必填层
 *   （含 `axioms` 与 `background`），确保 `validateWorldBlueprint` 返回 `complete`。
 */
export async function deriveWorldBlueprint(
  projectPath: string,
  worldType = "fantasy",
  seed?: WorldBlueprintSeed,
): Promise<WorldBlueprint> {
  const pp = normalizePath(projectPath).replace(/\/+$/, "")
  const entities = await listEntityFiles(pp).catch(() => [])

  // 按子目录聚类实体名 → 映射到骨架层
  const byLayer = new Map<WorldLayer, string[]>()
  for (const e of entities) {
    // path 形如 wiki/entities/<subdir>/<name>.md 或 wiki/entities/<name>.md
    const m = e.path.match(/entities\/([a-z-]+)\//)
    const subdir = m?.[1]
    const layer = subdir ? SUBDIR_TO_LAYER[subdir] : undefined
    if (!layer) continue
    if (!byLayer.has(layer)) byLayer.set(layer, [])
    byLayer.get(layer)!.push(e.name)
  }

  const derivedLayers: Partial<Record<WorldLayer, string[]>> = {}
  for (const [layer, names] of byLayer) {
    derivedLayers[layer] = [...names].sort()
  }

  if (!seed) {
    const bp = createEmptyWorldBlueprint(worldType)
    for (const [layer, names] of Object.entries(derivedLayers)) {
      bp.layers[layer as WorldLayer] = names
    }
    // 保底必填层：entities 为空的必填层给空数组，保持向后兼容
    if (entities.length === 0) {
      for (const layer of REQUIRED_WORLD_LAYERS) {
        bp.layers[layer] = bp.layers[layer] ?? []
      }
    }
    return bp
  }

  const merged = mergeWorldBlueprintPatch(seed.existing ?? null, {
    worldType,
    mode: "merge",
    layers: derivedLayers,
    fillMissingRequired: seed.fillMissingRequired,
    idea: seed.idea,
  })
  if (!seed.fillMissingRequired && entities.length === 0 && !seed.existing) {
    for (const layer of REQUIRED_WORLD_LAYERS) {
      merged.layers[layer] = merged.layers[layer] ?? []
    }
  }
  return merged
}

/** 推导并持久化世界骨架（derive + save 一步到位）。 */
export async function deriveAndSaveWorldBlueprint(
  projectPath: string,
  worldType = "fantasy",
  seed?: WorldBlueprintSeed,
): Promise<WorldBlueprint> {
  let effectiveSeed = seed
  if (seed !== undefined && seed.existing === undefined) {
    const existing = await loadWorldBlueprint(projectPath)
    effectiveSeed = { ...seed, existing }
  }
  const bp = await deriveWorldBlueprint(projectPath, worldType, effectiveSeed)
  await saveWorldBlueprint(projectPath, bp)
  return bp
}
