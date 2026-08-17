/**
 * behavior-state-machine.ts — P2: 角色行为状态机系统
 *
 * 可选增强模块，为每个角色建立行为状态机，追踪：
 * - 基线行为（放松时）
 * - 触发行为（紧张/思考/说话时）
 * - 行为一致性评分
 * - 行为异常预警
 *
 * 零 LLM，纯正则 + 算术。通过 review-adapter 的 injectedContinuityResults
 * 机制可选接入，不影响核心审查流程。
 */

import { readFileSync } from "fs"
import { detectCharacterActions } from "./mechanical-slop-detector"

// ============================================================================
// 类型定义
// ============================================================================

/** 角色行为画像 */
export interface CharacterBehaviorProfile {
  archetype: string
  baselineMannerisms: string[]
  establishedPatterns: { action: string; context: string; description: string }[]
  acceptableVariations: string[]
}

/** 单个行为记录 */
export interface BehaviorRecord {
  character: string
  action: string
  chapter: number
  count: number
}

/** 行为异常 */
export interface BehaviorAnomaly {
  character: string
  severity: "error" | "warning" | "info"
  type: "overuse" | "context_mismatch" | "no_evolution" | "established_pattern"
  message: string
  suggestion: string
}

/** 行为状态机输出 */
export interface BehaviorStateReport {
  profiles: Record<string, CharacterBehaviorProfile>
  anomalies: BehaviorAnomaly[]
  consistencyScores: Record<string, number>
  evolutionTraces: Record<string, Record<number, string[]>>
}

// ============================================================================
// 角色行为画像定义
// ============================================================================

const CHARACTER_BEHAVIOR_PROFILES: Record<string, CharacterBehaviorProfile> = {
  白砚: {
    archetype: "冷静观察者",
    baselineMannerisms: ["少言", "观察", "不动"],
    establishedPatterns: [
      { action: "转动戒指", context: "thinking", description: "思考时下意识转动戒指" },
    ],
    acceptableVariations: ["在白砚极激动时可出现一次性动作偏离"],
  },
  王迦: {
    archetype: "智性掌控者",
    baselineMannerisms: ["推眼镜", "微笑", "平稳语调"],
    establishedPatterns: [
      { action: "推眼镜", context: "speech", description: "说话/解释时推眼镜" },
      { action: "嘴角上扬", context: "tension", description: "紧张时用微笑掩饰" },
    ],
    acceptableVariations: [],
  },
  苏未晞: {
    archetype: "怯懦受害者",
    baselineMannerisms: ["抠指甲", "低头", "角落"],
    establishedPatterns: [
      { action: "抠指甲", context: "tension", description: "紧张时抠指甲自伤" },
    ],
    acceptableVariations: ["在觉醒后，抠指甲可被更坚定的动作替代"],
  },
  陆织锦: {
    archetype: "记录者",
    baselineMannerisms: ["写笔记", "笔尖声"],
    establishedPatterns: [],
    acceptableVariations: [],
  },
  陈烬: {
    archetype: "暴躁网红",
    baselineMannerisms: ["骂", "挣扎", "崩溃"],
    establishedPatterns: [],
    acceptableVariations: [],
  },
  李昭然: {
    archetype: "愧疚富二代",
    baselineMannerisms: ["低头", "小声", "苦笑"],
    establishedPatterns: [],
    acceptableVariations: [],
  },
  周棠: {
    archetype: "冷静医生",
    baselineMannerisms: ["轻声", "观察"],
    establishedPatterns: [],
    acceptableVariations: [],
  },
}

// ============================================================================
// 行为状态机引擎
// ============================================================================

/**
 * 跨章节分析角色行为模式。
 * @param chapterPaths - 章节文件路径数组，每项 { num, path }
 * @returns 行为状态报告
 */
export function analyzeBehaviorStateMachine(
  chapterPaths: { num: number; path: string }[]
): BehaviorStateReport {
  const allActions: BehaviorRecord[] = []

  // 逐章分析
  for (const ch of chapterPaths) {
    try {
      const content = readFileSync(ch.path, "utf-8")
      const hits = detectCharacterActions(content)

      for (const hit of hits) {
        for (const [char, count] of Object.entries(hit.perCharacter)) {
          allActions.push({
            character: char,
            action: hit.action,
            chapter: ch.num,
            count,
          })
        }
      }
    } catch {
      // 跳过无法读取的章节
    }
  }

  // 按角色分组
  const byChar: Record<string, BehaviorRecord[]> = {}
  for (const act of allActions) {
    if (!byChar[act.character]) byChar[act.character] = []
    byChar[act.character].push(act)
  }

  // 检测异常
  const anomalies = detectAnomalies(byChar)

  // 计算一致性评分
  const consistencyScores = computeConsistencyScores(byChar)

  // 生成演化轨迹
  const evolutionTraces = buildEvolutionTraces(byChar)

  return {
    profiles: CHARACTER_BEHAVIOR_PROFILES,
    anomalies,
    consistencyScores,
    evolutionTraces,
  }
}

/** 检测行为异常 */
function detectAnomalies(byChar: Record<string, BehaviorRecord[]>): BehaviorAnomaly[] {
  const anomalies: BehaviorAnomaly[] = []

  for (const [char, actions] of Object.entries(byChar)) {
    if (actions.length < 3) continue

    const profile = CHARACTER_BEHAVIOR_PROFILES[char]
    if (!profile) continue

    // 统计每种行为总次数
    const actionCounts: Record<string, number> = {}
    for (const act of actions) {
      actionCounts[act.action] = (actionCounts[act.action] || 0) + act.count
    }

    const topAction = Object.entries(actionCounts).sort((a, b) => b[1] - a[1])[0]
    /* v8 ignore next */
    if (!topAction) continue

    // 异常 1: 行为过度重复
    if (topAction[1] >= 5) {
      const isPattern = profile.establishedPatterns.some((p) => p.action === topAction[0])
      if (!isPattern) {
        anomalies.push({
          character: char,
          severity: "warning",
          type: "overuse",
          message: `"${topAction[0]}" 出现 ${topAction[1]} 次，非该角色标志性行为`,
          suggestion: "减少该行为频次，或确认是否为刻意设定",
        })
      } else {
        anomalies.push({
          character: char,
          severity: "info",
          type: "established_pattern",
          message: `"${topAction[0]}" 出现 ${topAction[1]} 次，为该角色标志性行为`,
          suggestion: "保持标志性但避免标签化，建议全章 ≤3 次",
        })
      }
    }

    // 异常 2: 行为无演化
    const chapterSpan = [...new Set(actions.map((a) => a.chapter))].sort((a, b) => a - b)
    if (chapterSpan.length >= 4) {
      const earlyActions = new Set(actions.filter((a) => a.chapter <= 3).map((a) => a.action))
      const lateActions = new Set(actions.filter((a) => a.chapter > 3).map((a) => a.action))
      const newActions = [...lateActions].filter((a) => !earlyActions.has(a))
      if (newActions.length === 0) {
        anomalies.push({
          character: char,
          severity: "info",
          type: "no_evolution",
          message: `全书行为模式无演化，始终使用相同行为集合`,
          suggestion: "随着角色弧光发展，应引入新的行为表达",
        })
      }
    }
  }

  return anomalies
}

/** 计算行为一致性评分 */
function computeConsistencyScores(byChar: Record<string, BehaviorRecord[]>): Record<string, number> {
  const scores: Record<string, number> = {}

  for (const [char, actions] of Object.entries(byChar)) {
    if (actions.length < 3) {
      scores[char] = 10
      continue
    }

    let score = 10
    const actionCounts: Record<string, number> = {}
    for (const act of actions) {
      actionCounts[act.action] = (actionCounts[act.action] || 0) + act.count
    }

    for (const [action, total] of Object.entries(actionCounts)) {
      if (total < 3) continue
      // 集中在单章
      const chapterCounts: Record<number, number> = {}
      for (const act of actions.filter((a) => a.action === action)) {
        chapterCounts[act.chapter] = (chapterCounts[act.chapter] || 0) + act.count
      }
      const maxPerChapter = Math.max(...Object.values(chapterCounts))
      if (maxPerChapter >= total * 0.7) score -= 2
      // 出现过多
      if (total >= 5) score -= 1.5
    }

    scores[char] = Math.max(0, score)
  }

  return scores
}

/** 构建行为演化轨迹 */
function buildEvolutionTraces(byChar: Record<string, BehaviorRecord[]>): Record<string, Record<number, string[]>> {
  const traces: Record<string, Record<number, string[]>> = {}

  for (const [char, actions] of Object.entries(byChar)) {
    if (actions.length < 3) continue

    const chapterSeq: Record<number, Record<string, number>> = {}
    for (const act of actions) {
      if (!chapterSeq[act.chapter]) chapterSeq[act.chapter] = {}
      chapterSeq[act.chapter][act.action] = (chapterSeq[act.chapter][act.action] || 0) + act.count
    }

    const trace: Record<number, string[]> = {}
    for (const [ch, acts] of Object.entries(chapterSeq)) {
      trace[Number(ch)] = Object.entries(acts)
        .sort((a, b) => b[1] - a[1])
        .map(([a, c]) => `${a}×${c}`)
    }

    traces[char] = trace
  }

  return traces
}

/**
 * 文本化行为状态报告。
 */
export function behaviorStateReportToText(report: BehaviorStateReport): string {
  const lines: string[] = []
  lines.push("角色行为状态机分析:")

  // 异常
  if (report.anomalies.length > 0) {
    lines.push("- 行为异常:")
    for (const anomaly of report.anomalies) {
      const icon = anomaly.severity === "error" ? "❌" : anomaly.severity === "warning" ? "⚠️" : "ℹ️"
      lines.push(`  ${icon} [${anomaly.character}] ${anomaly.message}`)
      lines.push(`    建议: ${anomaly.suggestion}`)
    }
  }

  // 一致性评分
  const scoredChars = Object.entries(report.consistencyScores).filter(([, s]) => s < 10)
  if (scoredChars.length > 0) {
    lines.push("- 行为一致性评分:")
    for (const [char, score] of scoredChars) {
      const status = score >= 8 ? "✅" : score >= 5 ? "⚠️" : "❌"
      lines.push(`  ${status} ${char}: ${score.toFixed(1)}/10`)
    }
  }

  return lines.join("\n")
}