/**
 * facts-store.ts — S1d absorb: graphiti Fact 时间窗字段契约 (roadmap S1 P1
 * 机械层 · R01 事实级时间窗持久化)
 *
 * 参考 (reference/ 只读): graphiti/graphiti_core/edges.py — Fact 类字段
 *   valid_at / invalid_at / expired_at / reference_time / episodes。
 * 本项目存储形态: 文件真源 + 派生投影 (buddy-vs-studio F-7) — facts 表以
 * JSON 文件为唯一持久化源, temporal-memory 保留为投影查询 (不持有存储)。
 *
 * ADR-26 / no-dual-truth: facts 表是事实级时间窗的**唯一持久化源**;
 * temporal-memory 的 TemporalFact 数组由本表派生 (loadFacts → getFactsAt),
 * 不再另建第二份持久化。chapter-ingest 的 newCanonFacts 写入本表后,
 * 投影层 (temporal-memory.factsFromCommittedSnapshots) 读本表而非再解析快照。
 *
 * 时间窗语义 (graphiti 对齐):
 *   - valid_at: 事实成立的时间点 (本项目 = 章节号, 与 temporal-memory.validFrom 一致)
 *   - invalid_at: 事实失效时间点 (章节号; graphiti 为时间戳, 本项目章节号)
 *   - expired_at: 事实节点整体过期时间 (可选, 软删除)
 *   - reference_time: 产生该事实的 episode (章节) 引用
 *   - episodes: 溯源 — 事实被哪些章节提及/确认
 */

// ============================================================================
// Schema (graphiti Fact 字段契约, 章节号时间窗)
// ============================================================================

export interface FactRecord {
  /** 稳定 id (如 `fact-<uuid8>` 或 `fact-ch5-<idx>`)。 */
  id: string
  /** Canonical subject (角色/实体名, 经 resolveCanonicalName 归一)。 */
  subject: string
  /** Predicate, 如 "持有" / "位于" / "状态"。 */
  predicate: string
  /** Object value, 如 "轩辕剑" / "凌霄殿" / "重伤"。 */
  object: string
  /** graphiti valid_at: 事实成立章节 (>=1)。 */
  valid_at: number
  /** graphiti invalid_at: 事实失效章节 (被取代/否定时闭合)。 */
  invalid_at?: number
  /** graphiti expired_at: 事实整体过期 (软删除) — 与 invalid_at 区分: invalid_at
   * 由取代/否定自然闭合, expired_at 由人工或清理流程标记。 */
  expired_at?: number
  /** graphiti reference_time: 产生该事实的章节引用 (溯源)。 */
  reference_time: number
  /** graphiti episodes: 提及/确认该事实的章节列表 (溯源链)。 */
  episodes: number[]
  /** 取代链: 本事实取代的事实 ids。 */
  supersedes?: string[]
  /** 来源说明 (如 "chapter-ingest newCanonFacts")。 */
  source: string
  /** 抽取置信度 0..1。 */
  confidence?: number
}

export interface EpisodeRecord {
  /** 章节号。 */
  chapter: number
  /** 该章节产生/确认的事实 ids。 */
  fact_ids: string[]
  /** 该章节的引用快照 id (如 ChapterSnapshot.id)。 */
  snapshot_ref?: string
}

// ============================================================================
// 存储形态: JSON 文件真源 (可重建派生索引)
// ============================================================================

export interface FactsFileShape {
  schema_version: "facts/1.0"
  /** facts 表 (事实级时间窗唯一持久化源)。 */
  facts: FactRecord[]
  /** episodes 溯源表。 */
  episodes: EpisodeRecord[]
  /** 单调递增的 id 计数器 (生成稳定 fact id)。 */
  next_id: number
}

/** 默认空表 (文件不存在时)。 */
export function emptyFactsFile(): FactsFileShape {
  return { schema_version: "facts/1.0", facts: [], episodes: [], next_id: 1 }
}

/**
 * 读取 facts 表 (文件真源)。路径不存在时返回空表 (可重建语义)。
 * 任何解析错误都抛错 — 表损坏不应静默吞掉 (宁可 fail loud)。
 */
export function loadFactsFile(raw: string, options: { strict?: boolean } = {}): FactsFileShape {
  const parsed = JSON.parse(raw) as Partial<FactsFileShape>
  if (parsed.schema_version !== "facts/1.0") {
    throw new Error(`facts.json schema_version mismatch: ${parsed.schema_version}`)
  }
  if (options.strict) {
    // strict 读：损坏表绝不以宽松空字段覆写回盘——拒绝以保留原字节。
    if (!Array.isArray(parsed.facts)
      || !Array.isArray(parsed.episodes)
      || !Number.isSafeInteger(parsed.next_id)
      || (parsed.next_id ?? 0) < 1
      || parsed.facts.some(f => !f || typeof f.id !== "string" || !f.id)
      || parsed.episodes.some(e => !e || !Array.isArray(e.fact_ids) || !Number.isSafeInteger(e.chapter))) {
      throw new Error("Invalid facts.json store; refusing to overwrite.")
    }
  }
  const facts: FactRecord[] = Array.isArray(parsed.facts) ? parsed.facts : []
  const episodes: EpisodeRecord[] = Array.isArray(parsed.episodes) ? parsed.episodes : []
  const next_id = typeof parsed.next_id === "number" && parsed.next_id >= 1 ? parsed.next_id : 1
  return { schema_version: "facts/1.0", facts, episodes, next_id }
}

/** 序列化 facts 表 (文件写入用)。 */
export function saveFactsFile(state: FactsFileShape): string {
  return JSON.stringify(state, null, 2)
}

// ============================================================================
// 事实级时间窗查询 (graphiti "what is true at chapter N")
// ============================================================================

/**
 * 查询第 chapter 章有效的事实 (语义与 temporal-memory.getFactsAt 一致):
 *   valid_at <= chapter AND (invalid_at 未设 或 invalid_at > chapter)
 *   AND expired_at 未设 (过期即不可见)。
 * subject 可选过滤 (经 aliasMap 归一)。
 */
export function getFactsAt(
  chapter: number,
  subject: string | undefined,
  state: FactsFileShape,
  aliasMap?: Record<string, string>,
): FactRecord[] {
  const canonical = subject !== undefined ? resolve(subject, aliasMap) : undefined
  return state.facts.filter((f) => {
    // 统一全局软删语义：一旦标记 expired_at，对所有章节均不可见。
    if (f.expired_at !== undefined) return false
    if (f.valid_at > chapter) return false
    if (f.invalid_at !== undefined && f.invalid_at <= chapter) return false
    if (canonical !== undefined && resolve(f.subject, aliasMap) !== canonical) return false
    return true
  })
}

function resolve(name: string, aliasMap?: Record<string, string>): string {
  if (!aliasMap) return name
  return aliasMap[name] ?? name
}

/** 查询某事实当前是否有效 (expired_at 一旦设置即全局软删不可见)。 */
export function isFactActive(fact: FactRecord, chapter: number): boolean {
  if (fact.expired_at !== undefined) return false
  if (fact.valid_at > chapter) return false
  if (fact.invalid_at !== undefined && fact.invalid_at <= chapter) return false
  return true
}

// ============================================================================
// 变更操作 (全部纯函数, 返回新 state — 调用方负责写回文件)
// ============================================================================

/** 追加事实 (自动分配 id + reference_time + episodes 初始化)。 */
export function addFact(
  state: FactsFileShape,
  input: Omit<FactRecord, "id" | "reference_time" | "episodes"> & { episodes?: number[] },
): FactsFileShape {
  const id = `fact-${state.next_id}`
  const fact: FactRecord = {
    id,
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    valid_at: input.valid_at,
    invalid_at: input.invalid_at,
    expired_at: input.expired_at,
    reference_time: input.valid_at,
    episodes: input.episodes ?? [input.valid_at],
    supersedes: input.supersedes,
    source: input.source,
    confidence: input.confidence,
  }
  return {
    ...state,
    facts: [...state.facts, fact],
    next_id: state.next_id + 1,
  }
}

/**
 * 取代: 新事实取代旧事实 — 旧事实 invalid_at 闭合为 chapter, 新事实
 * supersedes 记录旧 id, 并记录 episode 溯源。对应 graphiti invalid_at 语义
 * 与 temporal-memory.recordSupersession 的持久化版本。
 */
export function supersedeFact(
  state: FactsFileShape,
  oldFactId: string,
  newFactInput: Omit<FactRecord, "id" | "reference_time" | "episodes" | "supersedes">,
  chapter: number,
): FactsFileShape {
  const oldFact = state.facts.find((f) => f.id === oldFactId)
  if (!oldFact) return addFact(state, { ...newFactInput, supersedes: undefined })
  // 单调闭合: invalid_at 只收窄
  const closedOld: FactRecord = {
    ...oldFact,
    invalid_at: oldFact.invalid_at !== undefined
      ? Math.min(oldFact.invalid_at, chapter)
      : chapter,
  }
  const afterClose: FactsFileShape = {
    ...state,
    facts: state.facts.map((f) => (f.id === oldFactId ? closedOld : f)),
  }
  return addFact(afterClose, { ...newFactInput, supersedes: [oldFactId] })
}

/** 软删除 (expired_at 标记; 不清除记录, 审计可查)。 */
export function expireFact(state: FactsFileShape, factId: string, chapter: number): FactsFileShape {
  return {
    ...state,
    facts: state.facts.map((f) =>
      f.id === factId ? { ...f, expired_at: f.expired_at ?? chapter } : f,
    ),
  }
}

/**
 * 记录 episode 溯源: 章节 chapter 提及事实 ids (去重合并, 保持已有引用)。
 */
export function recordEpisode(
  state: FactsFileShape,
  chapter: number,
  factIds: string[],
  snapshotRef?: string,
): FactsFileShape {
  const existing = state.episodes.find((e) => e.chapter === chapter)
  const merged = [...new Set([...(existing?.fact_ids ?? []), ...factIds])]
  const episode: EpisodeRecord = {
    chapter,
    fact_ids: merged,
    snapshot_ref: snapshotRef ?? existing?.snapshot_ref,
  }
  const rest = state.episodes.filter((e) => e.chapter !== chapter)
  return { ...state, episodes: [...rest, episode] }
}

/**
 * 删除指定章节引入的事实与溯源记录（供 deleteChapterSnapshots 联动清理）。
 * - 产生于该章（reference_time === chapter 或 valid_at === chapter）或仅由该章提及的事实被移除；
 * - 其余跨章事实保留，但从其 episodes 溯源列表中移除该章号；
 * - 若被删事实曾取代旧事实并在该章闭合其 invalid_at，则撤销该章闭合；
 * - next_id 单调递增不回退，避免历史 id 复用；无变更时返回原 state 引用。
 */
export function removeChapterFacts(
  state: FactsFileShape,
  chapter: number,
): FactsFileShape {
  const removedIds = new Set<string>()
  const supersededByRemoved = new Set<string>()
  const remainingFacts: FactRecord[] = []
  let factsChanged = false

  for (const fact of state.facts) {
    const remainingEpisodes = fact.episodes.filter((c) => c !== chapter)
    const originatedInChapter = fact.reference_time === chapter || fact.valid_at === chapter
    const onlyInChapter = fact.episodes.length > 0 && remainingEpisodes.length === 0
    if (originatedInChapter || onlyInChapter) {
      removedIds.add(fact.id)
      factsChanged = true
      for (const oldId of fact.supersedes ?? []) {
        supersededByRemoved.add(oldId)
      }
      continue
    }
    if (remainingEpisodes.length !== fact.episodes.length) {
      factsChanged = true
      remainingFacts.push({ ...fact, episodes: remainingEpisodes })
    } else {
      remainingFacts.push(fact)
    }
  }

  const restoredFacts =
    supersededByRemoved.size > 0
      ? remainingFacts.map((fact) => {
          if (supersededByRemoved.has(fact.id) && fact.invalid_at === chapter) {
            factsChanged = true
            return { ...fact, invalid_at: undefined }
          }
          return fact
        })
      : remainingFacts

  let episodesChanged = false
  const remainingEpisodes: EpisodeRecord[] = []
  for (const ep of state.episodes) {
    if (ep.chapter === chapter) {
      episodesChanged = true
      continue
    }
    const nextFactIds = ep.fact_ids.filter((id) => !removedIds.has(id))
    if (nextFactIds.length !== ep.fact_ids.length) {
      episodesChanged = true
      remainingEpisodes.push({ ...ep, fact_ids: nextFactIds })
    } else {
      remainingEpisodes.push(ep)
    }
  }

  if (!factsChanged && !episodesChanged) return state
  return {
    ...state,
    facts: restoredFacts,
    episodes: remainingEpisodes,
  }
}

// ============================================================================
// 派生: temporal-memory 兼容投影
// ============================================================================

/**
 * 把 facts 表投影为 temporal-memory 的 TemporalFact 数组。
 * 字段映射: valid_at→validFrom / invalid_at→validUntil / reference_time→source。
 * 已软删除（expired_at !== undefined）的事实不进入投影视图。
 * 调用方把结果传给 temporal-memory.getFactsAt/queryFactsAt 即得一致语义 —
 * facts 表为唯一持久化源, temporal-memory 保持 VIEW 角色。
 */
export function projectToTemporalFacts(
  state: FactsFileShape,
): Array<{
  id: string
  subject: string
  predicate: string
  object: string
  validFrom: number
  validUntil?: number
  supersedes?: string[]
  source: string
  confidence?: number
}> {
  return state.facts
    .filter((f) => f.expired_at === undefined)
    .map((f) => ({
      id: f.id,
      subject: f.subject,
      predicate: f.predicate,
      object: f.object,
      validFrom: f.valid_at,
      validUntil: f.invalid_at,
      supersedes: f.supersedes,
      source: `facts:${f.reference_time}${f.episodes.length > 1 ? `+${f.episodes.length - 1}ep` : ""}`,
      confidence: f.confidence,
    }))
}
