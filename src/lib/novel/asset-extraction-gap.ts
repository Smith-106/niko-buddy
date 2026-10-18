// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * asset-extraction-gap.ts — 「正文/拆书里有、资产库里没有」的只读缺口诊断。
 *
 * 解决的问题（续写 / 拆书两条链共用同一个缺口）：
 *   续写一本旧书时，前作可能压根没有资产库；拆书拆出来的场景/人物也要能落到本仓资产里。
 *   现状是「正文照写、资产不动」，前后数据对不上却没人发现。本模块把缺口**列出来**：
 *   哪些 wiki 人物实体在正文里出现、却没进角色状态；哪些角色在正文里同句出现、却没有关系条目。
 *
 * 三条硬口径：
 *   1. **只诊断，不写入**。输出的 `proposals` 只是可直接粘去草稿区的文本建议，
 *      绝不调用任何写盘/建实体 API（Draft-first：写正式资产必须先走草稿 + accept）。
 *   2. **未装载 ≠ 零缺口**：`charactersLoaded` / `wikiLoaded` 为 false 时对应检查整体落 N/A，
 *      不产出空缺口列表假装「没有缺口」。
 *   3. **世界构建 / 场景**目前没有结构化真源，因此显式 N/A，不拿关键词猜实体
 *      （猜出来的「新场景」会污染资产库，比缺一条更糟）。
 *
 * 判定用「必要条件 + 词边界」：
 *   人物名在句中出现是必要条件；单字名字（「王」vs「王府」）用邻字边界排除明显误命中。
 *   同句共现 → 候选关系；两侧任一侧已有该关系 → 不算缺口。
 *
 * @license MIT © Niko Buddy
 */

// ── 类型 ─────────────────────────────────────────────────────────────────────────

/** 诊断输入里的角色状态（与 `character-states.json` 同构的最小投影）。 */
export interface ExtractionCharacter {
  characterName: string
  relationships?: Readonly<Record<string, string>>
}

/** 缺口输入。 */
export interface ExtractionGapInput {
  /** 当前章号；`null` = 不知道章号（证据里不带章号）。 */
  chapterNumber: number | null
  /** 当前章正文（或待拆解文本）。空串 = 没正文，检查整体落 N/A。 */
  chapterText: string
  /** 角色状态。 */
  characters: readonly ExtractionCharacter[]
  /** 角色状态是否已装载（读失败 / 尚未加载完 → false）。 */
  charactersLoaded: boolean
  /** wiki 人物实体名（`wiki/entities/characters/*.md` 的实体名）。 */
  wikiCharacterNames: readonly string[]
  /** wiki 人物实体是否已装载。 */
  wikiLoaded: boolean
}

/** 一条缺口。 */
export interface ExtractionGap {
  code: "character_not_in_state" | "relationship_not_in_state"
  /** 主体（人物名 / 「甲→乙」）。 */
  subject: string
  /** 人话说明。 */
  detail: string
  /** 正文证据片段（截断 + 省略号）。 */
  evidence: string
}

/** 可直接粘进草稿区的补充建议（**不写入**，只是文本）。 */
export interface ExtractionProposal {
  kind: "character" | "relationship"
  title: string
  body: string
}

/** 诊断结果。 */
export interface ExtractionGapProjection {
  gaps: ExtractionGap[]
  proposals: ExtractionProposal[]
  /** 无法判定的部分，逐条写清原因。 */
  na: string[]
  counts: {
    /** 正文里被识别的已知人名数。 */
    mentionedCharacters: number
    /** wiki 人物实体数（未装载记 0，另有 N/A 说明）。 */
    wikiCharacters: number
    /** 已装载的角色状态数（未装载记 0，另有 N/A 说明）。 */
    stateCharacters: number
  }
}

// ── 工具 ─────────────────────────────────────────────────────────────────────────

const EVIDENCE_LIMIT = 60

function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a)
  const right = Array.from(b)
  const size = Math.min(left.length, right.length)
  for (let i = 0; i < size; i += 1) {
    const diff = (left[i] as string).codePointAt(0)! - (right[i] as string).codePointAt(0)!
    if (diff !== 0) return diff
  }
  return left.length - right.length
}

/**
 * 名字出现判定。
 *
 * 单字名（「王」）在中文里无法靠邻字边界判——「王站在门外」里后面紧跟汉字却是真命中；
 * 「王府」里紧跟汉字却属于另一个名字。可靠口径是**最长匹配优先**：
 * 命中的位置若被某个更长的已知名字覆盖（`王府`），这次出现就不算「王」。
 */
function nameAppears(text: string, name: string, longerNames: readonly string[]): boolean {
  if (!name) return false
  if (name.length > 1) return text.includes(name)
  const covering = longerNames.filter((other) => other.length > name.length && other.includes(name))
  let from = 0
  for (;;) {
    const index = text.indexOf(name, from)
    if (index < 0) return false
    const absorbed = covering.some((other) => {
      const at = text.indexOf(other, Math.max(0, index - other.length + 1))
      return at >= 0 && at <= index && index + name.length <= at + other.length
    })
    if (!absorbed) return true
    from = index + 1
  }
}

/** 按句切分（保留分句标点语义，只切不删）。 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;\n])/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  const chars = Array.from(flat)
  if (chars.length <= EVIDENCE_LIMIT) return flat
  return `${chars.slice(0, EVIDENCE_LIMIT).join("")}…`
}

function withChapter(chapterNumber: number | null, evidence: string): string {
  return chapterNumber === null ? evidence : `第 ${chapterNumber} 章：${evidence}`
}

// ── 投影 ─────────────────────────────────────────────────────────────────────────

/**
 * 诊断「正文有、资产没有」的缺口。
 *
 * 纯函数：不 IO、不写盘、不调模型；同输入必得同输出。
 */
export function detectAssetExtractionGaps(input: ExtractionGapInput): ExtractionGapProjection {
  const na: string[] = []
  const gaps: ExtractionGap[] = []
  const stateNames = (input.characters ?? [])
    .map((character) => (character.characterName ?? "").trim())
    .filter((name) => name.length > 0)
  const stateNameSet = new Set(stateNames)
  const wikiNames = (input.wikiCharacterNames ?? [])
    .map((name) => String(name ?? "").trim())
    .filter((name) => name.length > 0)
  const knownNames = [...new Set([...stateNames, ...wikiNames])]

  if (!input.wikiLoaded) {
    na.push("wiki 人物实体未装载：不判定「正文人物缺状态」，不是「没有缺口」")
  }
  if (!input.charactersLoaded) {
    na.push("角色状态未装载：不判定任何人物/关系缺口，不是「没有缺口」")
  }
  const text = input.chapterText ?? ""
  if (text.trim().length === 0) {
    na.push("没有可检查的正文（当前章无 draft.md 或内容为空）：本面 N/A")
  }
  // 世界构建 / 场景没有结构化真源：显式 N/A，禁止用关键词猜实体。
  na.push("世界构建与场景：仓库暂无结构化抽取真源，本面 N/A（不猜实体，避免污染资产库）")

  const canCheck = input.charactersLoaded && text.trim().length > 0

  if (!canCheck) {
    return {
      gaps,
      proposals: [],
      na,
      counts: {
        mentionedCharacters: 0,
        wikiCharacters: wikiNames.length,
        stateCharacters: stateNames.length,
      },
    }
  }

  const sentences = splitSentences(text)

  // ① wiki 有人物实体、正文出现、但角色状态里没有 → 缺角色资产。
  const missingCharacters: Array<{ name: string; evidence: string }> = []
  if (input.wikiLoaded) {
    for (const name of wikiNames) {
      if (stateNameSet.has(name)) continue
      const hit = sentences.find((sentence) => nameAppears(sentence, name, knownNames))
      if (!hit) continue
      missingCharacters.push({ name, evidence: hit })
    }
    missingCharacters.sort((a, b) => compareCodePoints(a.name, b.name))
    for (const item of missingCharacters) {
      gaps.push({
        code: "character_not_in_state",
        subject: item.name,
        detail: "wiki 有该人物实体且在正文出现，但角色状态里没有 —— 续写会读不到这个人",
        evidence: withChapter(input.chapterNumber, clip(item.evidence)),
      })
    }
  }

  // ② 两个已知角色同句出现，但双方都没有关系条目 → 缺关系资产。
  const relatedPairs = new Map<string, string>()
  for (const sentence of sentences) {
    // 按**句内首次出现顺序**排，而不是码点序：缺口是给人读的，「甲→乙」比「乙→甲」更贴原文。
    const present = stateNames
      .filter((name) => nameAppears(sentence, name, knownNames))
      .sort((a, b) => sentence.indexOf(a) - sentence.indexOf(b) || compareCodePoints(a, b))
    for (let i = 0; i < present.length; i += 1) {
      for (let j = i + 1; j < present.length; j += 1) {
        const left = present[i] as string
        const right = present[j] as string
        if (left === right) continue
        const leftRelations = input.characters.find((c) => c.characterName === left)?.relationships ?? {}
        const rightRelations = input.characters.find((c) => c.characterName === right)?.relationships ?? {}
        const hasEdge =
          Object.prototype.hasOwnProperty.call(leftRelations, right) ||
          Object.prototype.hasOwnProperty.call(rightRelations, left)
        if (hasEdge) continue
        const key = `${left}\u0000${right}`
        if (!relatedPairs.has(key)) relatedPairs.set(key, sentence)
      }
    }
  }

  const pairEntries = [...relatedPairs.entries()].sort((a, b) => compareCodePoints(a[0], b[0]))
  for (const [key, sentence] of pairEntries) {
    const [left, right] = key.split("\u0000") as [string, string]
    gaps.push({
      code: "relationship_not_in_state",
      subject: `${left}→${right}`,
      detail: "两人在正文同句出现，但角色状态里双方都没有这条关系 —— 关系图谱会缺一条边",
      evidence: withChapter(input.chapterNumber, clip(sentence)),
    })
  }

  // 建议文本：只给「可以补什么」，不落盘（Draft-first）。
  const proposals: ExtractionProposal[] = []
  for (const item of missingCharacters) {
    proposals.push({
      kind: "character",
      title: `补角色资产：${item.name}`,
      body: `在角色状态里新增「${item.name}」（来源：wiki 人物实体；正文证据 ${withChapter(
        input.chapterNumber,
        clip(item.evidence),
      )}）。请补齐定位、动机与初始关系后 accept，再由 ingest 写回。`,
    })
  }
  for (const [key, sentence] of pairEntries) {
    const [left, right] = key.split("\u0000") as [string, string]
    proposals.push({
      kind: "relationship",
      title: `补关系资产：${left}→${right}`,
      body: `为「${left}」补一条指向「${right}」的关系（来源：正文同句共现 ${clip(
        sentence,
      )}）。关系描述须写实质内容，避免「友」「敌」这类单字备注。`,
    })
  }

  const mentioned = new Set<string>()
  for (const name of [...stateNames, ...(input.wikiLoaded ? wikiNames : [])]) {
    if (sentences.some((sentence) => nameAppears(sentence, name, knownNames))) mentioned.add(name)
  }

  return {
    gaps,
    proposals,
    na,
    counts: {
      mentionedCharacters: mentioned.size,
      wikiCharacters: wikiNames.length,
      stateCharacters: stateNames.length,
    },
  }
}
