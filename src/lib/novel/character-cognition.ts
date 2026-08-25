import { createDirectory, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { ChapterSnapshot } from "./chapter-ingest"
import { matchesAnyAlias } from "./book-analysis/alias-resolver"
import type { NameAliasMap } from "./book-analysis/types"
// T25 (F-13): canon 图投影读出口产物类型 + 禁句柄外泄兜底断言（defense-in-depth）。
// 输入只能来自 T14 `getFactsKnownBy` 的返回物；若上游契约被击穿（含 known_by/digest），
// 此处 fail-loud 拦下，不静默传播 POV 泄密数据。
import { assertNoHandleLeak, getFactsKnownBy, type CanonFact } from "./canon-graph-client"

export interface CharacterCognition {
  character: string
  knows: string[]
  doesNotKnow: string[]
}

/**
 * EPIC-003 / ADR-32 / TASK-008: 条件路由 ROI 埋点样本。
 *
 * 每次 contextPack 装配后记录一条 A/B 统计样本，用于跨章节验证条件路由
 * （conditionalRoutingEnabled=true）是否降低 contextPack 无关内容占比。
 * G-002/G-003 跨章节数据统计驱动 G-003 长篇规模 ROI 可量化。
 *
 * 写入 cognition-state.json 现有 key（`routingROIBuckets` 字段，additive
 * optional — HARD-1 守恒：不新建第二份真源文件，复用 cognition-state.json）。
 */
export interface RoutingROISample {
  /** A/B 分组：'enabled' = conditionalRoutingEnabled=true，'disabled' = false。 */
  variant: "enabled" | "disabled"
  /** contextPack 内容中与 activeEntities 无关的比例（0~1，启发式标记）。 */
  irrelevantRatio: number
  /** 当前章节号（用于跨章节统计）。 */
  chapterId: string
  /** 采集时间戳 ISO 串。 */
  timestamp: string
}

/**
 * EPIC-001 / TASK-005 / ADR-29: exemplar A/B ROI 埋点样本。
 *
 * 每次 de-AI 运行后 UI 埋点文风主观评分（1-5 星），用于跨章节验证
 * exemplar+slop（exemplarEnabled=true）是否优于 slop-only（false）。
 * G-002 UI 埋点驱动 PM-03 文风一致性 ROI 可量化。
 *
 * 写入 cognition-state.json 现有 key（`exemplarABuckets` 字段，additive
 * optional — HARD-1 守恒：不新建第二份真源文件，复用 cognition-state.json）。
 */
export interface ExemplarABSample {
  /** A/B 分组：'enabled' = exemplarEnabled=true，'disabled' = false。 */
  variant: "enabled" | "disabled"
  /** 文风主观评分（1-5 星，UI 用户评分）。 */
  score: number
  /** 当前章节号（用于跨章节统计）。 */
  chapterId: string
  /** 采集时间戳 ISO 串。 */
  timestamp: string
}

/**
 * EPIC-002 / ADR-30 / TASK-013: scene-breakdown rewrite 率 A/B 埋点样本。
 *
 * 每次 6-dim review 后记录一条 A/B 统计样本，用于跨章节验证 scene-breakdown
 * （sceneBreakdownEnabled=true）是否降低 rewrite 率（severity=error findings 占
 * 总 findings 的比例）。G-002 跨章节数据统计驱动 PM-03 ROI 验证。
 *
 * 写入 cognition-state.json 现有 key（`rewriteRateABuckets` 字段，additive
 * optional — HARD-1 守恒：不新建第二份真源文件，复用 cognition-state.json）。
 */
export interface RewriteRateABSample {
  /** A/B 分组：'enabled' = sceneBreakdownEnabled=true，'disabled' = false。 */
  variant: "enabled" | "disabled"
  /** rewrite 率 = severity=error findings 数 / 总 findings 数（0~1）。 */
  rewriteRate: number
  /** 当前章节号（用于跨章节统计）。 */
  chapterId: string
  /** 采集时间戳 ISO 串。 */
  timestamp: string
}

export interface CognitionState {
  characters: CharacterCognition[]
  readerKnows: string[]
  lastUpdatedChapter: number
  /**
   * EPIC-003 / TASK-008: 条件路由 ROI 埋点样本数组（additive optional）。
   * 跨章节累积，A/B 验证 enabled vs disabled 平均 irrelevantRatio。
   * 缺失时 [] — 向后兼容（pre-TASK-008 cognition-state.json 无此字段）。
   */
  routingROIBuckets?: RoutingROISample[]
  /**
   * EPIC-001 / TASK-005: exemplar A/B ROI 埋点样本数组（additive optional）。
   * 跨章节累积，A/B 验证 enabled vs disabled 平均文风主观评分。
   * 缺失时 [] — 向后兼容（pre-TASK-005 cognition-state.json 无此字段）。
   */
  exemplarABuckets?: ExemplarABSample[]
  /**
   * EPIC-002 / TASK-013: scene-breakdown rewrite 率 A/B 埋点样本数组（additive optional）。
   * 跨章节累积，A/B 验证 enabled vs disabled 平均 rewriteRate（enabled < disabled）。
   * 缺失时 [] — 向后兼容（pre-TASK-013 cognition-state.json 无此字段）。
   */
  rewriteRateABuckets?: RewriteRateABSample[]
}

const COGNITION_DIR = ".novel"
const COGNITION_FILENAME = "cognition-state.json"

const NOT_KNOW_RE = /^(.+?)不知道(.+)$/
const READER_KNOW_RE = /^读者知道[了了]?(.+)$/
const KNOW_RE = /^(.+?)知道[了了]?(.+)$/
const EXTRA_KNOW_RES = [/^(.+?)得知[了了]?(.+)$/, /^(.+?)察觉到?(.+)$/, /^(.+?)意识到(.+)$/]

/**
 * F-003 (identity-resolution): NFKC normalize + strip Japanese nakaguro (・)
 * so "菜月昴" / "菜月・昴" collapse to the same canonical key even when no
 * alias map is available. Backwards-compatible fallback — callers that pass
 * an aliasMap get matchesAnyAlias first; this only runs when aliasMap is
 * absent or does not match.
 */
function nfkcCanonical(name: string): string {
  return name.normalize("NFKC").replace(/・/g, "")
}

/**
 * Resolve a raw character name to its canonical form.
 *
 * (1) If aliasMap is provided and matchesAnyAlias hits, use aliasMap.canonical.
 * (2) Otherwise fall back to NFKC + nakaguro-strip so mid-dot variants of the
 *     same name fold together. Returns the trimmed original when no map hits.
 */
export function resolveCanonicalName(name: string, aliasMap?: NameAliasMap): string {
  const trimmed = name.trim()
  if (!trimmed) return trimmed
  if (aliasMap && matchesAnyAlias(trimmed, aliasMap)) {
    return aliasMap.canonical
  }
  return nfkcCanonical(trimmed)
}

/**
 * Given a list of per-character alias maps, find the one whose canonical or
 * alias entries contain `name`. Returns undefined when no map matches — the
 * caller then falls back to resolveCanonicalName's NFKC path.
 */
export function resolveMatchingMap(name: string, aliasMaps?: readonly NameAliasMap[]): NameAliasMap | undefined {
  if (!aliasMaps || aliasMaps.length === 0) return undefined
  const trimmed = name.trim()
  if (!trimmed) return undefined
  for (const map of aliasMaps) {
    if (matchesAnyAlias(trimmed, map)) return map
  }
  return undefined
}

export function emptyCognitionState(): CognitionState {
  return {
    characters: [],
    readerKnows: [],
    lastUpdatedChapter: 0,
  }
}

export function mergeCognitionFromSnapshot(
  current: CognitionState,
  snapshot: ChapterSnapshot,
  aliasMaps?: readonly NameAliasMap[],
): CognitionState {
  const next: CognitionState = {
    characters: current.characters.map(c => ({ ...c, knows: [...c.knows], doesNotKnow: [...c.doesNotKnow] })),
    readerKnows: [...current.readerKnows],
    lastUpdatedChapter: Math.max(current.lastUpdatedChapter, snapshot.chapterNumber),
  }

  for (const change of snapshot.knowledgeChanges) {
    const trimmed = change.trim()
    if (!trimmed) continue

    const notKnowMatch = trimmed.match(NOT_KNOW_RE)
    if (notKnowMatch) {
      const charName = notKnowMatch[1].trim()
      const info = notKnowMatch[2].trim()
      const entry = ensureCharacter(next, charName, resolveMatchingMap(charName, aliasMaps))
      if (!entry.doesNotKnow.includes(info)) {
        entry.doesNotKnow.push(info)
      }
      continue
    }

    const readerMatch = trimmed.match(READER_KNOW_RE)
    if (readerMatch) {
      const info = readerMatch[1].trim()
      if (!next.readerKnows.includes(info)) {
        next.readerKnows.push(info)
      }
      continue
    }

    const knowMatch = trimmed.match(KNOW_RE)
    if (knowMatch) {
      const charName = knowMatch[1].trim()
      const info = knowMatch[2].trim()
      const entry = ensureCharacter(next, charName, resolveMatchingMap(charName, aliasMaps))
      if (!entry.knows.includes(info)) {
        entry.knows.push(info)
      }
      entry.doesNotKnow = entry.doesNotKnow.filter(i => i !== info)
      continue
    }

    for (const pattern of EXTRA_KNOW_RES) {
      const extraMatch = trimmed.match(pattern)
      if (extraMatch) {
        const charName = extraMatch[1].trim()
        const info = extraMatch[2].trim()
        const entry = ensureCharacter(next, charName, resolveMatchingMap(charName, aliasMaps))
        if (!entry.knows.includes(info)) {
          entry.knows.push(info)
        }
        entry.doesNotKnow = entry.doesNotKnow.filter(i => i !== info)
        break
      }
    }
  }

  return next
}

export async function saveCognitionState(projectPath: string, state: CognitionState): Promise<void> {
  const pp = normalizePath(projectPath)
  const dir = `${pp}/${COGNITION_DIR}`
  const filePath = `${dir}/${COGNITION_FILENAME}`
  await createDirectory(dir)
  await writeFileAtomic(filePath, JSON.stringify(state, null, 2))
}

export async function loadCognitionState(projectPath: string): Promise<CognitionState | null> {
  const pp = normalizePath(projectPath)
  const filePath = `${pp}/${COGNITION_DIR}/${COGNITION_FILENAME}`
  const exists = await fileExists(filePath)
  // ISS-20260712-010: missing/empty → null (no-data); non-empty corrupt JSON → throw so UI can show error vs no-data.
  if (!exists) return null
  const raw = await readFile(filePath)
  if (!raw || !raw.trim()) return null
  try {
    return JSON.parse(raw) as CognitionState
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to parse cognition-state.json: ${detail}`)
  }
}

/**
 * EPIC-003 / ADR-32 / TASK-008: 追加一条条件路由 ROI 埋点样本到 cognition-state.json。
 *
 * 读现有 cognition-state.json → append 样本 → 写回（复用 loadCognitionState +
 * saveCognitionState，HARD-1 守恒：写 cognition-state.json 现有文件非新真源）。
 * 文件不存在时创建最小 CognitionState（空 characters + readerKnows）承载 ROI 样本。
 * 失败非致命（non-fatal）— ROI 采集不影响主链装配。
 *
 * @param projectPath 项目根路径
 * @param sample ROI 样本（variant/irrelevantRatio/chapterId/timestamp）
 */
export async function appendRoutingROISample(
  projectPath: string,
  sample: RoutingROISample,
): Promise<void> {
  const pp = normalizePath(projectPath)
  try {
    const existing = await loadCognitionState(pp)
    const state: CognitionState = existing ?? {
      characters: [],
      readerKnows: [],
      lastUpdatedChapter: 0,
    }
    const buckets = Array.isArray(state.routingROIBuckets)
      ? state.routingROIBuckets
      : []
    // 上限保护：单项目跨章节累积样本封顶，避免无界增长（LRU-ish 弹最旧）。
    // 1024 条足够 A/B 统计置信度，单条 ~120B → ~120KB 上限可接受。
    const ROI_BUCKETS_MAX = 1024
    const next = [...buckets, sample]
    while (next.length > ROI_BUCKETS_MAX) {
      next.shift()
    }
    state.routingROIBuckets = next
    await saveCognitionState(pp, state)
  } catch {
    // non-fatal — ROI 采集失败不影响主链
  }
}

/**
 * EPIC-001 / TASK-005: 追加一条 exemplar A/B ROI 埋点样本到 cognition-state.json。
 *
 * 读现有 cognition-state.json → append 样本 → 写回（复用 loadCognitionState +
 * saveCognitionState，HARD-1 守恒：写 cognition-state.json 现有文件非新真源）。
 * 文件不存在时创建最小 CognitionState（空 characters + readerKnows）承载样本。
 * 失败非致命（non-fatal）— ROI 采集不影响主链。
 *
 * @param projectPath 项目根路径
 * @param sample      A/B 样本（variant/score/chapterId/timestamp）
 */
export async function appendExemplarABSample(
  projectPath: string,
  sample: ExemplarABSample,
): Promise<void> {
  const pp = normalizePath(projectPath)
  try {
    const existing = await loadCognitionState(pp)
    const state: CognitionState = existing ?? {
      characters: [],
      readerKnows: [],
      lastUpdatedChapter: 0,
    }
    const buckets = Array.isArray(state.exemplarABuckets)
      ? state.exemplarABuckets
      : []
    // 上限保护：单项目跨章节累积样本封顶（与 routingROIBuckets 一致，1024 条）。
    const AB_BUCKETS_MAX = 1024
    const next = [...buckets, sample]
    while (next.length > AB_BUCKETS_MAX) {
      next.shift()
    }
    state.exemplarABuckets = next
    await saveCognitionState(pp, state)
  } catch {
    // non-fatal — ROI 采集失败不影响主链
  }
}

/**
 * EPIC-001 / TASK-005: 统计 exemplar A/B 两组平均分（跨章节 ROI 验证）。
 *
 * @param state cognition-state（含 exemplarABuckets）
 * @returns `{ enabledAvg, disabledAvg }` — 缺数据组返回 null
 */
export function exemplarABStats(state: CognitionState | null): {
  enabledAvg: number | null
  disabledAvg: number | null
} {
  if (!state || !Array.isArray(state.exemplarABuckets) || state.exemplarABuckets.length === 0) {
    return { enabledAvg: null, disabledAvg: null }
  }
  const enabledScores: number[] = []
  const disabledScores: number[] = []
  for (const sample of state.exemplarABuckets) {
    if (sample.variant === "enabled") enabledScores.push(sample.score)
    else disabledScores.push(sample.score)
  }
  const avg = (scores: number[]): number | null =>
    scores.length === 0 ? null : scores.reduce((a, b) => a + b, 0) / scores.length
  return { enabledAvg: avg(enabledScores), disabledAvg: avg(disabledScores) }
}

/**
 * EPIC-002 / TASK-013: 追加一条 scene-breakdown rewrite 率 A/B 埋点样本到
 * cognition-state.json。
 *
 * 读现有 cognition-state.json → append 样本 → 写回（复用 loadCognitionState +
 * saveCognitionState，HARD-1 守恒：写 cognition-state.json 现有文件非新真源）。
 * 文件不存在时创建最小 CognitionState（空 characters + readerKnows）承载样本。
 * 失败非致命（non-fatal）— ROI 采集不影响主链装配。
 *
 * @param projectPath 项目根路径
 * @param sample      A/B 样本（variant/rewriteRate/chapterId/timestamp）
 */
export async function appendRewriteRateASample(
  projectPath: string,
  sample: RewriteRateABSample,
): Promise<void> {
  const pp = normalizePath(projectPath)
  try {
    const existing = await loadCognitionState(pp)
    const state: CognitionState = existing ?? {
      characters: [],
      readerKnows: [],
      lastUpdatedChapter: 0,
    }
    const buckets = Array.isArray(state.rewriteRateABuckets)
      ? state.rewriteRateABuckets
      : []
    // 上限保护：单项目跨章节累积样本封顶（与 routingROIBuckets/exemplarABuckets
    // 一致，1024 条）。
    const AB_BUCKETS_MAX = 1024
    const next = [...buckets, sample]
    while (next.length > AB_BUCKETS_MAX) {
      next.shift()
    }
    state.rewriteRateABuckets = next
    await saveCognitionState(pp, state)
  } catch {
    // non-fatal — ROI 采集失败不影响主链
  }
}

/**
 * EPIC-002 / TASK-013: 统计 scene-breakdown rewrite 率 A/B 两组平均（跨章节
 * ROI 验证）。
 *
 * @param state cognition-state（含 rewriteRateABuckets）
 * @returns `{ enabledAvg, disabledAvg }` — 缺数据组返回 null
 */
export function rewriteRateABStats(state: CognitionState | null): {
  enabledAvg: number | null
  disabledAvg: number | null
} {
  if (!state || !Array.isArray(state.rewriteRateABuckets) || state.rewriteRateABuckets.length === 0) {
    return { enabledAvg: null, disabledAvg: null }
  }
  const enabledRates: number[] = []
  const disabledRates: number[] = []
  for (const sample of state.rewriteRateABuckets) {
    if (sample.variant === "enabled") enabledRates.push(sample.rewriteRate)
    else disabledRates.push(sample.rewriteRate)
  }
  const avg = (rates: number[]): number | null =>
    rates.length === 0 ? null : rates.reduce((a, b) => a + b, 0) / rates.length
  return { enabledAvg: avg(enabledRates), disabledAvg: avg(disabledRates) }
}

export function cognitionToContextText(state: CognitionState): string {
  if (state.characters.length === 0 && state.readerKnows.length === 0) return ""

  const lines: string[] = []

  for (const char of state.characters) {
    if (char.knows.length > 0) {
      lines.push(`${char.character}知道：${char.knows.join("、")}`)
    }
    if (char.doesNotKnow.length > 0) {
      lines.push(`${char.character}不知道：${char.doesNotKnow.join("、")}`)
    }
  }

  if (state.readerKnows.length > 0) {
    lines.push(`读者知道：${state.readerKnows.join("、")}`)
  }

  return lines.join("\n")
}

function ensureCharacter(state: CognitionState, name: string, aliasMap?: NameAliasMap): CharacterCognition {
  const canonical = resolveCanonicalName(name, aliasMap)
  let entry = state.characters.find(c => c.character === canonical)
  if (!entry) {
    entry = { character: canonical, knows: [], doesNotKnow: [] }
    state.characters.push(entry)
  }
  return entry
}

/**
 * T25 (F-13) 认知轴读取输入：单个 POV 角色的已知事实集。
 *
 * `facts` 必须是 T14 `getFactsKnownBy(projectId, characterId)` 的投影产物 ——
 * 认知轴句柄（known_by）在 Rust 过滤后已被剥离，此处只消费"该角色知道什么"的
 * 结果集，POV 防泄密边界由 T14 读出口保证，本函数再经 assertNoHandleLeak 兕底。
 */
export interface CanonCognitionInput {
  /** POV 角色 id / 名（与 getFactsKnownBy 的 characterId 同源）。 */
  character: string
  /** 该角色已知事实（T14 投影产物）。 */
  facts: readonly CanonFact[]
}

/** 知晓时点：认知轴优先（revealed_at），缺省回退世界时态/来源章。 */
function canonFactChapterRef(fact: CanonFact): number | null {
  return fact.revealedAt ?? fact.validAt ?? fact.sourceChapter ?? null
}

/** 单条 canon 边 → 确定性 knows 文本（`source predicate target（第N章）`）。 */
function canonFactToKnowsText(fact: CanonFact): string {
  const base = `${fact.sourceId} ${fact.predicate} ${fact.targetId}`.trim()
  const ch = canonFactChapterRef(fact)
  return ch !== null ? `${base}（第${ch}章）` : base
}

/**
 * T25 (F-13/A-04.4): 从 canon 图读出认知轴 → `CharacterCognition[]` 视图。
 *
 * 与 {@link mergeCognitionFromSnapshot}（正则抽取路径）互补的 canon 原生路径：
 * 调用方对每个 POV 角色调一次 T14 `getFactsKnownBy`，把结果集按角色聚成
 * `CanonCognitionInput[]` 传入。VIEW only —— 不写 cognition-state.json，
 * 不持有任何存储；默认快照折叠路径完全不变（向后兼容）。
 *
 * 确定性（F-13「角色所知事实跨模型逐字节一致」地基）：
 *   - knows 按 (知晓时点升序, id 码点升序) 双键排序，与 IPC 返回顺序解耦；
 *   - 渲染文本去重（保序）；archived 边跳过（非权威）。
 *
 * doesNotKnow 恒为空数组：canon 读出口按 POV 查询只给正向已知集，「某角色不知
 * 某事」需全量观众矩阵求补，属 T33 五角色编排层职责 —— 本视图不做隐式推断，
 * 不伪造负向认知。
 *
 * @param entries   每个 POV 角色一条输入（facts 来自 getFactsKnownBy 投影产物）
 * @param aliasMaps 可选别名映射群（与 mergeCognitionFromSnapshot 同款折叠语义）
 */
export function fromCanonGraph(
  entries: readonly CanonCognitionInput[],
  aliasMaps?: readonly NameAliasMap[],
): CharacterCognition[] {
  return entries.map((entry) => {
    const canonical = resolveCanonicalName(
      entry.character,
      resolveMatchingMap(entry.character, aliasMaps),
    )
    // 确定性排序：(知晓时点 升序, id 码点升序)。时点缺失（null）排末尾 ——
    // 无时态锚点的边视为最不稳定信息。
    const sorted = [...entry.facts].sort(
      (a, b) =>
        (canonFactChapterRef(a) ?? Number.MAX_SAFE_INTEGER) -
          (canonFactChapterRef(b) ?? Number.MAX_SAFE_INTEGER) ||
        (a.id < b.id ? -1 : 1),
    )
    const knows: string[] = []
    const seen = new Set<string>()
    for (const fact of sorted) {
      // POV 防泄密兑底：任何含 known_by/digest 的输入在此 fail-loud（T14 兑底断言复用）。
      assertNoHandleLeak(fact)
      if (fact.archived) continue
      const text = canonFactToKnowsText(fact)
      if (!text || seen.has(text)) continue
      seen.add(text)
      knows.push(text)
    }
    return { character: canonical, knows, doesNotKnow: [] }
  })
}

/**
 * T25 (F-13) POV 路由设施 —— 本章 POV 角色身份解析（接入点 / 扩展锚）。
 *
 * 主链今天无结构化 per-chapter POV 字段（ChapterSnapshot / NovelConfig / 章节 frontmatter /
 * session-status 均无 POV；POV 路由属路线图级新设施，见 C 任务书硬约束「停下报告而非硬塞」）。
 * 故本函数当前返回 null —— 优雅降级为世界层投影（行为不变），绝不臆造 POV（避免误归因）。
 *
 * 未来 per-chapter POV 真源落地（章节元数据 / cognition-state POV 字段 / 大纲 POV 标注）时，
 * 在此解析并返回角色 id，下游 `buildPovCognition` 与 loadCanonSourceFacts 第二查询的
 * `known_by` 过滤即自动激活「角色 X 曾以为」精确归因（剥离世界层限制）。
 */
export async function resolveChapterPovCharacter(
  _projectPath: string,
  _chapter: number,
): Promise<string | null> {
  // EXTENSION POINT: per-chapter POV 真源就绪时在此解析并返回角色 id。
  return null
}

/**
 * T25 (F-13) POV 精确归因首个运行时调用点：按 POV 角色取「曾以为」事实集。
 *
 * 调 T14 `getFactsKnownBy(projectId, povCharacterId, chapter, true)` —— 4 参形态
 * （includeInvalidated=true）召回该角色已知且已失效的窗口边，剥离世界层投影限制，
 * 真正实现「角色 X 曾以为…」而非世界层「此事实曾成立」。结果经本模块 fromCanonGraph
 * 折叠为 `CharacterCognition` 视图（POV 防泄密兑底 assertNoHandleLeak 复用）。
 *
 * 调用方传入已解析的 `povCharacterId`（经 resolveChapterPovCharacter 解析）；当前 POV 真源
 * 未就绪时由解析器返回 null 保护，本函数即设施锚点、不主动臆造 POV。
 */
export async function buildPovCognition(
  projectId: string,
  povCharacterId: string,
  chapter: number,
  aliasMaps?: readonly NameAliasMap[],
): Promise<CharacterCognition[]> {
  const facts = await getFactsKnownBy(projectId, povCharacterId, chapter, true)
  return fromCanonGraph([{ character: povCharacterId, facts }], aliasMaps)
}
