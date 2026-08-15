/**
 * related-chapters.ts — S2a absorb: ainovel-cli buildRelatedChapters 四维反查
 * (roadmap S2 P0 连续性深化 · R06 跨章调度/推荐)
 *
 * 参考 (reference/ 只读): ainovel-cli/internal/tools/novel_context.go
 *   buildRelatedChapters(chapter, entry, foreshadow, relationships, stateChanges):
 *   ① 伏笔反查 (活跃伏笔与当前大纲关键词匹配)
 *   ② 角色出场反查 (大纲角色最后出场章)
 *   ③ 状态变化反查
 *   ④ 关系反查
 *   去重后最多 5 条; recentWindow=10 不推荐太近章节。
 *
 * 融合说明: context-engine.searchRelevantContentUnified 做内容检索 (语义/向量/图),
 * 本模块做**跨章结构反查** (伏笔/角色/状态/关系) — 两者互补, 不重复。
 * 调用方把结果注入 ContextPack (context-engine 组合本模块)。
 *
 * 伏笔台账接线: 逾期 >5 章未推进的 planted 伏笔 → finding (与
 * foreshadowing-debt.analyzeForeshadowingDebt 的 plantedStale=5 阈值一致)。
 */

import type { ForeshadowingStore } from "./foreshadowing-tracker"
import type { ChapterSnapshot } from "./chapter-ingest"

// ============================================================================
// 类型
// ============================================================================

export type RelatedChapterReason =
  | "foreshadow"
  | "character"
  | "state_change"
  | "relationship"

export interface RelatedChapter {
  /** 章节号 */
  chapter: number
  /** 匹配原因 (可多个) */
  reasons: RelatedChapterReason[]
  /** 匹配的实体名 (角色/伏笔/关系) */
  matchedEntities: string[]
  /** 该章的简要说明 (调用方填充或省略) */
  note?: string
}

export interface RelatedChaptersOptions {
  /** 最近 N 章不推荐 (去噪, ainovel recentWindow=10) */
  recentWindow?: number
  /** 最多返回条数 (ainovel maxResults=5) */
  maxResults?: number
  /** 伏笔逾期阈值: planted 伏笔超过该章数未推进 → finding (默认 5, 与 foreshadowing-debt 一致) */
  foreshadowStaleThreshold?: number
}

export interface ForeshadowFinding {
  id: string
  name: string
  description: string
  plantedChapter: number
  chaptersSincePlanted: number
  /** "逾期未推进" — 已超阈值 */
  finding: string
}

// ============================================================================
// 四维反查输入 (由调用方从 store/快照构造 — 本模块保持纯函数可测)
// ============================================================================

export interface CharacterAppearance {
  character: string
  /** 该角色出场的章节列表 (升序) */
  chapters: number[]
}

export interface StateChange {
  /** 状态变化涉及的实体 */
  entity: string
  /** 状态变化发生的章节 */
  chapter: number
  /** 变化描述 */
  change: string
}

export interface RelationshipRef {
  /** 关系双方, 如 "白砚-苏未晞" */
  pair: string
  /** 关系被确认/变化的最新章节 */
  chapter: number
  /** 关系描述 */
  description: string
}

export interface RelatedChaptersInput {
  /** 当前章节号 */
  currentChapter: number
  /** 当前章大纲文本 (用于伏笔关键词匹配) */
  chapterOutline: string
  /** 伏笔台账 */
  foreshadowing: ForeshadowingStore
  /** 角色出场记录 */
  appearances: CharacterAppearance[]
  /** 状态变化记录 */
  stateChanges: StateChange[]
  /** 关系记录 */
  relationships: RelationshipRef[]
}

// ============================================================================
// 四维反查 (ainovel buildRelatedChapters 中文适配)
// ============================================================================

/**
 * 从大纲提取关键词: 中文无空格, 用 2-4 字滑动窗口提取候选 token。
 * (ainovel 是 Go + 已有结构化 outline; 本项目 outline 是自由文本,
 * 用 n-gram 窗口近似关键词提取 — 纯机械零 LLM。)
 */
function extractOutlineKeywords(outline: string): string[] {
  if (!outline) return []
  const cleaned = outline.replace(/[，。！？、；：""''（）【】\n\s]/g, " ")
  const tokens = cleaned.split(/\s+/).filter((t) => t.length >= 2)
  // 中文长串 (无空格): 2-4 字滑动窗口
  const grams: string[] = []
  for (const t of tokens) {
    if (t.length > 8) {
      for (let i = 0; i <= t.length - 2; i++) {
        for (let len = 2; len <= 4 && i + len <= t.length; len++) {
          grams.push(t.slice(i, i + len))
        }
      }
    } else {
      grams.push(t)
    }
  }
  return [...new Set(grams)]
}

/**
 * 四维反查: 伏笔/出场/状态/关系。
 * ainovel 逻辑: 每维独立扫描 → 结果按章节聚合 → 去重 (同章多原因合并) →
 * 排除 recentWindow 内章节 → 按 maxResults 截断。
 */
export function buildRelatedChapters(input: RelatedChaptersInput, options: RelatedChaptersOptions = {}): RelatedChapter[] {
  const recentWindow = options.recentWindow ?? 10
  const maxResults = options.maxResults ?? 5
  const current = input.currentChapter
  const minChapter = Math.max(1, current - recentWindow)

  /** chapter → RelatedChapter 聚合 */
  const byChapter = new Map<number, RelatedChapter>()

  function addMatch(chapter: number, reason: RelatedChapterReason, entity: string, note?: string) {
    if (chapter >= current) return // 只反查历史章
    if (chapter >= minChapter) return // 太近不去噪
    const existing = byChapter.get(chapter)
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason)
      if (!existing.matchedEntities.includes(entity)) existing.matchedEntities.push(entity)
      if (note && !existing.note) existing.note = note
    } else {
      byChapter.set(chapter, {
        chapter,
        reasons: [reason],
        matchedEntities: [entity],
        note,
      })
    }
  }

  // ① 伏笔反查: 活跃 (planted/advanced) 伏笔的 name/description 与大纲关键词匹配
  const outlineKeywords = extractOutlineKeywords(input.chapterOutline)
  for (const f of input.foreshadowing.items) {
    if (f.status === "resolved") continue
    const haystack = `${f.name}${f.description}`
    const matched = outlineKeywords.some((kw) => haystack.includes(kw))
    if (matched) {
      addMatch(f.plantedChapter, "foreshadow", f.name, "伏笔回扣")
      // 最近推进章节也纳入 (若存在且非太近)
      const lastAdvanced = f.advancedChapters.length > 0 ? Math.max(...f.advancedChapters) : undefined
      if (lastAdvanced && lastAdvanced < current && lastAdvanced < minChapter) {
        addMatch(lastAdvanced, "foreshadow", f.name, "伏笔推进")
      }
    }
  }

  // ② 角色出场反查: 大纲关键词命中角色名 → 该角色 recentWindow 外最近出场章
  const outlineTokens = new Set(extractOutlineKeywords(input.chapterOutline))
  for (const app of input.appearances) {
    if (!outlineTokens.has(app.character) && !input.chapterOutline.includes(app.character)) continue
    // 取 recentWindow 外最近的一次出场 (ainovel 取最后出场章, 但太近会被去噪;
    // 退而求其次取窗口外最近章, 反查历史才有意义)
    const lastChapter = [...app.chapters].reverse().find((c) => c < minChapter)
    if (lastChapter !== undefined) {
      addMatch(lastChapter, "character", app.character, "角色上次出场")
    }
  }

  // ③ 状态变化反查: 实体在大纲中 → 最近状态变化章
  for (const sc of input.stateChanges) {
    if (input.chapterOutline.includes(sc.entity)) {
      addMatch(sc.chapter, "state_change", sc.entity, sc.change)
    }
  }

  // ④ 关系反查: 关系对中任一方在大纲 → 最近确认章
  for (const rel of input.relationships) {
    const [a, b] = rel.pair.split("-")
    if (input.chapterOutline.includes(a) || input.chapterOutline.includes(b)) {
      addMatch(rel.chapter, "relationship", rel.pair, rel.description)
    }
  }

  // 聚合结果: 按章节降序 (越近越相关, 排除 recentWindow 后), 截断 maxResults
  const results = [...byChapter.values()].sort((a, b) => b.chapter - a.chapter)
  return results.slice(0, maxResults)
}

// ============================================================================
// 伏笔台账接线: 逾期 finding (roadmap S2a — 逾期>5章→finding)
// ============================================================================

/**
 * 扫描 planted 伏笔逾期未推进 (> foreshadowStaleThreshold 章) → finding。
 * 与 foreshadowing-debt.analyzeForeshadowingDebt 的 plantedStale 阈值语义一致,
 * 但以调度 finding 形式输出 (供 review 管线消费)。
 */
export function findOverdueForeshadowing(
  store: ForeshadowingStore,
  currentChapter: number,
  options: RelatedChaptersOptions = {},
): ForeshadowFinding[] {
  const threshold = options.foreshadowStaleThreshold ?? 5
  const findings: ForeshadowFinding[] = []
  for (const f of store.items) {
    if (f.status === "resolved") continue
    if (f.status === "planted") {
      const since = currentChapter - f.plantedChapter
      if (since > threshold) {
        findings.push({
          id: f.id,
          name: f.name,
          description: f.description,
          plantedChapter: f.plantedChapter,
          chaptersSincePlanted: since,
          finding: `伏笔「${f.name}」已植入 ${since} 章未推进 (逾期 >${threshold} 章)`,
        })
      }
    }
  }
  return findings
}

/** 将 RelatedChapter[] 渲染为上下文文本 (供 ContextPack 注入) */
export function relatedChaptersToContextText(chapters: RelatedChapter[]): string {
  if (chapters.length === 0) return ""
  const lines = chapters.map((c) => {
    const reasons = c.reasons
      .map((r) => ({ foreshadow: "伏笔", character: "角色", state_change: "状态", relationship: "关系" })[r])
      .join("+")
    const entities = c.matchedEntities.join("、")
    return `- 第${c.chapter}章 (${reasons}): ${entities}${c.note ? ` — ${c.note}` : ""}`
  })
  return `相关章节反查:\n${lines.join("\n")}`
}

/** 从 ChapterSnapshot 列表构造角色出场索引 (纯函数, 供调用方快速建 appearance 输入) */
export function buildAppearancesFromSnapshots(
  snapshots: readonly ChapterSnapshot[],
): CharacterAppearance[] {
  const map = new Map<string, number[]>()
  for (const snap of snapshots) {
    const chars = snap.characters ?? []
    for (const ch of chars) {
      const list = map.get(ch) ?? []
      list.push(snap.chapterNumber)
      map.set(ch, list)
    }
  }
  return [...map.entries()].map(([character, chapters]) => ({
    character,
    chapters: [...new Set(chapters)].sort((a, b) => a - b),
  }))
}
