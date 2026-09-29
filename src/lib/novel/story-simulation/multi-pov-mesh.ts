// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * 多主角并行织网架构 (Multi-POV Parallel Mesh Framework)
 *
 * 核心目标：
 * 1. 支持多视角（Multi-POV）并行叙事：每个 POV 角色拥有独立的故事支线、节拍推进与认知范围。
 * 2. 独立前情切片 (Independent Context Slicing)：
 *    - 杜绝传统单一线性前情注入带来的“上帝视角穿帮（Epistemic Leak）”；
 *    - 为当前撰写章节的 POV 角色精确切片其专属的“所见、所知、所忆”局部上下文。
 * 3. 支线交汇检测 (Convergence / Intersection Detection)：
 *    - 自动扫描多条 POV 支线在时空坐标（同章节/同时期）、共同地理（Location）、共同关键物（Key Item）
 *      或直接冲突/会面事件上的交集；
 *    - 当探测到交汇时，生成“视点交汇对齐包（Convergence Pack）”，实施物理事实硬对齐同时保留心理次文本分歧。
 */

import type { StoryNode } from "./types"

export interface EpistemicScope {
  /** 该视角确知的事实 */
  knows: string[]
  /** 该视角确知不知道或被隐瞒的事实 */
  doesNotKnow: string[]
}

export interface PovThread {
  id: string
  characterId: string
  characterName: string
  role: string
  arcTheme: string
  epistemicScope: EpistemicScope
  nodes: StoryNode[]
  /** 该 POV 专属的前序局部正文/概要记忆切片 */
  localSummarySlice: string
  /** 最近一次活跃的章节编号 */
  lastActiveChapter?: number
}

export type IntersectionType =
  | "direct_encounter"   // 直接会面 / 正面接触
  | "shared_location"    // 共同地点但不同时 / 错位
  | "information_leak"   // 情报间接传递 / 传闻听到对方行动
  | "conflict_collision" // 争夺同一关键目标 / 冲突碰撞

export interface PovIntersection {
  id: string
  chapterNumber: number
  involvedPovIds: string[]
  intersectionType: IntersectionType
  location?: string
  targetItemOrGoal?: string
  description: string
  /** 交汇引发的认知状态交换/变化 */
  epistemicExchange?: Array<{
    fromPovId: string
    toPovId: string
    factShared: string
  }>
}

export interface MultiPovMesh {
  id: string
  title: string
  threads: PovThread[]
  intersections: PovIntersection[]
  createdAt: string
  updatedAt: string
}

export interface CreateMultiPovMeshOptions {
  title: string
  characters: Array<{
    id: string
    name: string
    role: string
    arcTheme?: string
    knows?: string[]
    doesNotKnow?: string[]
  }>
}

/**
 * 初始化多主角并行织网
 */
export function createMultiPovMesh(options: CreateMultiPovMeshOptions): MultiPovMesh {
  const threads: PovThread[] = options.characters.map((c) => ({
    id: `pov-${c.id}`,
    characterId: c.id,
    characterName: c.name,
    role: c.role,
    arcTheme: c.arcTheme || `${c.name}的破局之路`,
    epistemicScope: {
      knows: c.knows ? [...c.knows] : [],
      doesNotKnow: c.doesNotKnow ? [...c.doesNotKnow] : [],
    },
    nodes: [],
    localSummarySlice: "",
  }))

  return {
    id: `mesh-${Date.now()}`,
    title: options.title,
    threads,
    intersections: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

export interface ChapterHistoryEntry {
  chapterNumber: number
  povId: string
  summary: string
  location?: string
  revealedFacts?: string[]
}

/**
 * 独立前情切片算法 (Independent Context Slicing)
 * 仅为当前活跃 POV 角色提取属于其认知视窗与行动轨迹的上下文，
 * 彻底隔离其他 POV 支线的未公开隐私事件。
 */
export function sliceContextForPov(
  mesh: MultiPovMesh,
  targetPovId: string,
  currentChapterNumber: number,
  chapterHistory: ChapterHistoryEntry[],
): {
  directive: string
  ownRecentSummary: string
  observableExternalEvents: string[]
  epistemicConstraints: string[]
} {
  const thread = mesh.threads.find((t) => t.id === targetPovId || t.characterId === targetPovId)
  if (!thread) {
    return {
      directive: "",
      ownRecentSummary: "",
      observableExternalEvents: [],
      epistemicConstraints: [],
    }
  }

  // 1. 筛选该 POV 自己的历史章节与切片
  const ownChapters = chapterHistory
    .filter((h) => (h.povId === thread.id || h.povId === thread.characterId) && h.chapterNumber < currentChapterNumber)
    .sort((a, b) => b.chapterNumber - a.chapterNumber)

  const ownRecentSummary = ownChapters.length > 0
    ? ownChapters[0].summary
    : thread.localSummarySlice || "（本视角初次登场，尚无前序独立切片）"

  // 2. 检查历史上是否通过已发生的交汇点得知了其他支线的情报
  const observableExternalEvents: string[] = []
  const pastIntersections = mesh.intersections.filter(
    (i) => i.chapterNumber < currentChapterNumber && i.involvedPovIds.includes(thread.id),
  )

  for (const inter of pastIntersections) {
    if (inter.epistemicExchange) {
      for (const ex of inter.epistemicExchange) {
        if (ex.toPovId === thread.id) {
          observableExternalEvents.push(`[第 ${inter.chapterNumber} 章交汇情报] ${ex.factShared}`)
        }
      }
    } else {
      observableExternalEvents.push(`[第 ${inter.chapterNumber} 章交汇事件] ${inter.description}`)
    }
  }

  // 3. 构建认知硬边界约束（防止全知视角泄露）
  const epistemicConstraints: string[] = [
    ...thread.epistemicScope.doesNotKnow.map((unk) => `【禁止描写】：${thread.characterName}此时绝对不知晓【${unk}】`),
  ]

  // 4. 组装 Prompt 承接指令包
  const directive = [
    `【多主角视角硬约束 · 当前视点人物：${thread.characterName} (${thread.role})】`,
    `- 视点主旨与故事线：${thread.arcTheme}`,
    `- 视点专属上一章承接摘要：\n${ownRecentSummary.slice(0, 1500)}`,
    observableExternalEvents.length > 0
      ? `- 视点经由交汇点已知外部动态：\n${observableExternalEvents.join("\n")}`
      : "- 外部其他支线动态：此时未与该视点交汇，角色对外界隐秘毫不知情。",
    epistemicConstraints.length > 0
      ? `- 认知视窗防穿帮铁律：\n${epistemicConstraints.join("\n")}`
      : "",
  ].filter(Boolean).join("\n\n")

  return {
    directive,
    ownRecentSummary,
    observableExternalEvents,
    epistemicConstraints,
  }
}

export interface UpcomingSceneDescriptor {
  chapterNumber: number
  povId: string
  location?: string
  targetItemOrGoal?: string
  eventSummary: string
}

/**
 * 支线交汇检测算法 (Convergence / Intersection Detection)
 * 对比多个 POV 计划演进的场景描述，探测地点重叠、同一章节碰撞或目标争夺。
 */
export function detectPovIntersections(
  mesh: MultiPovMesh,
  plannedScenes: UpcomingSceneDescriptor[],
): PovIntersection[] {
  const newIntersections: PovIntersection[] = []
  const len = plannedScenes.length

  for (let i = 0; i < len; i++) {
    for (let j = i + 1; j < len; j++) {
      const s1 = plannedScenes[i]
      const s2 = plannedScenes[j]

      // 同一 POV 不与自己交汇
      if (s1.povId === s2.povId) continue

      const sameChapter = s1.chapterNumber === s2.chapterNumber
      const sameLocation = Boolean(s1.location && s2.location && s1.location.trim() === s2.location.trim())
      const sameTarget = Boolean(
        s1.targetItemOrGoal && s2.targetItemOrGoal && s1.targetItemOrGoal.trim() === s2.targetItemOrGoal.trim(),
      )

      if (sameChapter && (sameLocation || sameTarget)) {
        // 同章直接碰撞
        const intersection: PovIntersection = {
          id: `inter-${Date.now()}-${s1.chapterNumber}-${i}-${j}`,
          chapterNumber: s1.chapterNumber,
          involvedPovIds: [s1.povId, s2.povId],
          intersectionType: sameTarget ? "conflict_collision" : "direct_encounter",
          location: s1.location,
          targetItemOrGoal: s1.targetItemOrGoal,
          description: `第 ${s1.chapterNumber} 章视点交汇：${s1.povId} 与 ${s2.povId} 在 [${s1.location || "同场景"}] 发生对撞（${s1.eventSummary} vs ${s2.eventSummary}）。`,
        }
        newIntersections.push(intersection)
      } else if (!sameChapter && sameLocation && Math.abs(s1.chapterNumber - s2.chapterNumber) <= 2) {
        // 相近章节经过同一地点（时间错位交汇）
        const intersection: PovIntersection = {
          id: `inter-${Date.now()}-loc-${s1.chapterNumber}-${s2.chapterNumber}`,
          chapterNumber: Math.max(s1.chapterNumber, s2.chapterNumber),
          involvedPovIds: [s1.povId, s2.povId],
          intersectionType: "shared_location",
          location: s1.location,
          description: `时空错位交汇：${s1.povId} (第${s1.chapterNumber}章) 与 ${s2.povId} (第${s2.chapterNumber}章) 先后到达 [${s1.location}]。`,
        }
        newIntersections.push(intersection)
      }
    }
  }

  // 记录到织网中去重
  for (const item of newIntersections) {
    if (!mesh.intersections.some((existing) => existing.id === item.id)) {
      mesh.intersections.push(item)
    }
  }

  return newIntersections
}

/**
 * 生成多主角交汇对齐指令包 (Convergence Pack)
 * 当两个 POV 在剧情中相遇或产生交叉时，强制物理事实对齐，但保留各自主观偏差。
 */
export function generateConvergencePack(
  mesh: MultiPovMesh,
  intersection: PovIntersection,
): string {
  const characters = intersection.involvedPovIds.map((id) => {
    const thread = mesh.threads.find((t) => t.id === id || t.characterId === id)
    return thread?.characterName || id
  })

  return [
    `【视点交汇硬约束 (Convergence Directive) · 第 ${intersection.chapterNumber} 章】`,
    `- 涉及视点人物：${characters.join(" 与 ")}`,
    `- 交汇类型：${intersection.intersectionType}`,
    `- 发生地点：${intersection.location || "未知空间"}`,
    `- 核心冲突目标：${intersection.targetItemOrGoal || "无特定物质争夺"}`,
    `- 叙事事实一致性底线（P0）：双方经历的物理动作、对话与客观结果必须严格互相对齐，严禁产生事实断层。`,
    `- 心理叙事实体分歧（P2）：保留各自的心理防备、动机猜忌与观察盲区，各视点叙事应符合其各自性格与信息差。`,
  ].join("\n")
}
