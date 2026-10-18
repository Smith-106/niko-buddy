// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * agent-capability-matrix.ts — 「某个角色 / 某本书该配哪些技能」的只读诊断矩阵。
 *
 * 定位（纯函数 + 纯数据，零 IO / 零写盘 / 不调模型）：
 *   把「角色需要什么能力」「技能库提供了什么能力」摆成一张可断言的表，
 *   让「不同小说、不同场景调用不同 agent，需要的技能也不同」这件事**可被看见**，
 *   而不是靠人去翻技能库猜。
 *
 * 能力口径（刻意做窄，避免自造语义）：
 *   能力 = 角色声明的 `kinds` / `stages` 标记，与技能声明的 `kinds` / `stages` 取交集。
 *   仓库里技能本来就带这两个标记（`dynamicOutlinePlanner` 的 `stages`/`kinds`、
 *   技能库条目的 `kinds`），所以这是**复用既有真源**，不是新造分类学。
 *
 * 三条硬口径：
 *   1. `skillsLoaded === false`（技能库没装载）时**不下结论**：所有行 `matchedSkills: []`
 *      且一律进 `na`，绝不把「没读到」说成「零覆盖」。
 *   2. 角色需要的能力无人覆盖 → `missingCapabilities`（真缺口）；技能无人需要 →
 *      `unusedSkills`（冗余候选，不是错误）。两者方向相反，不合并。
 *   3. 本模块**不生成技能、不改技能库、不决定模型路由**；它只回答「谁被谁覆盖」。
 *
 * @license MIT © Niko Buddy
 */

// ── 类型 ─────────────────────────────────────────────────────────────────────────

/** 诊断输入里的技能（与技能库条目同构的最小投影）。 */
export interface CapabilitySkill {
  /** 技能名，稳定标识。 */
  name: string
  /** 可选说明，只用于展示。 */
  description?: string
  /** 技能声明的类型标记（如 `character` / `foreshadowing`）。 */
  kinds?: readonly string[]
  /** 技能声明的阶段标记（如 `outline` / `draft`）。 */
  stages?: readonly string[]
}

/** 诊断输入里的角色（agent 角色，不是小说人物）。 */
export interface CapabilityRole {
  /** 角色 id，稳定标识。 */
  id: string
  /** 展示名。 */
  label: string
  /** 该角色需要覆盖的类型能力。 */
  kinds?: readonly string[]
  /** 该角色需要覆盖的阶段能力。 */
  stages?: readonly string[]
}

/** 矩阵输入。 */
export interface AgentCapabilityMatrixInput {
  skills: readonly CapabilitySkill[]
  roles: readonly CapabilityRole[]
  /**
   * 技能库是否已装载。`false` = 未装载（读失败 / 还没加载完），此时不下覆盖结论；
   * 省略按 `true` 处理（调用方明确传了 `skills: []` 才是「确认零技能」）。
   */
  skillsLoaded?: boolean
}

/** 一行：某个角色被哪些技能覆盖、还缺什么。 */
export interface AgentCapabilityMatrixRow {
  roleId: string
  label: string
  /** 覆盖到该角色任一需求标记的技能名（码点序）。 */
  matchedSkills: string[]
  /** 该角色需要、但没有任何技能覆盖的能力标记（码点序）。 */
  missingCapabilities: string[]
}

/** 矩阵投影。 */
export interface AgentCapabilityMatrixProjection {
  rows: AgentCapabilityMatrixRow[]
  /** 所有角色合起来都没被覆盖的能力标记（码点序）。 */
  missingCapabilities: string[]
  /** 「无角色声明需要，但技能库里有」的技能名（码点序）——冗余候选，不是错误。 */
  unusedSkills: string[]
  /** 无法判定的部分，逐条写清原因（不静默吞掉）。 */
  na: string[]
  /** 参与判定的计数，便于面板显示规模而不是只显示结论。 */
  counts: {
    skills: number
    roles: number
    /** 有任意命中技能的角色数。 */
    coveredRoles: number
  }
}

// ── 工具 ─────────────────────────────────────────────────────────────────────────

/** 码点序比较（与仓库既有口径一致，避免星平面字符排序相反）。 */
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

function normalizeTokens(values: readonly string[] | undefined): string[] {
  if (!values) return []
  const seen = new Set<string>()
  for (const value of values) {
    const token = String(value ?? "").trim()
    if (token) seen.add(token)
  }
  return [...seen].sort(compareCodePoints)
}

function skillTokens(skill: CapabilitySkill): string[] {
  return [...normalizeTokens(skill.kinds), ...normalizeTokens(skill.stages)]
}

function roleTokens(role: CapabilityRole): string[] {
  return [...normalizeTokens(role.kinds), ...normalizeTokens(role.stages)]
}

// ── 投影 ─────────────────────────────────────────────────────────────────────────

/**
 * 生成 agent 能力矩阵。
 *
 * 纯函数：同输入必得同输出（所有数组都按码点序稳定排序）。
 */
export function projectAgentCapabilityMatrix(
  input: AgentCapabilityMatrixInput,
): AgentCapabilityMatrixProjection {
  const skillsLoaded = input.skillsLoaded !== false
  const skills = input.skills ?? []
  const roles = input.roles ?? []
  const na: string[] = []

  if (!skillsLoaded) {
    na.push("技能库未装载：不下覆盖结论（不是「零技能覆盖」）")
  }
  const noTokenSkills = skills.filter((skill) => skillTokens(skill).length === 0)
  if (skillsLoaded && noTokenSkills.length > 0) {
    // 没声明 kinds/stages 的技能无法参与能力匹配：如实说出来，而不是当成全覆盖或全不覆盖。
    na.push(
      `${noTokenSkills.length} 个技能未声明类型/阶段标记，无法参与匹配：${noTokenSkills
        .map((skill) => skill.name)
        .sort(compareCodePoints)
        .join("、")}`,
    )
  }

  const requiredTokens = new Set<string>()
  for (const role of roles) {
    for (const token of roleTokens(role)) requiredTokens.add(token)
  }

  const rows: AgentCapabilityMatrixRow[] = roles
    .map((role) => {
      const wanted = roleTokens(role)
      for (const token of wanted) requiredTokens.add(token)

      if (!skillsLoaded) {
        return {
          roleId: role.id,
          label: role.label,
          matchedSkills: [],
          missingCapabilities: [],
        }
      }

      const matched: string[] = []
      const covered = new Set<string>()
      for (const skill of skills) {
        const tokens = skillTokens(skill)
        const hit = tokens.filter((token) => wanted.includes(token))
        if (hit.length === 0) continue
        matched.push(skill.name)
        for (const token of hit) covered.add(token)
      }

      return {
        roleId: role.id,
        label: role.label,
        matchedSkills: matched.sort(compareCodePoints),
        missingCapabilities: wanted.filter((token) => !covered.has(token)).sort(compareCodePoints),
      }
    })
    .sort((a, b) => compareCodePoints(a.roleId, b.roleId))

  // 全局缺口：某能力「有角色需要」但「没有任何技能声明」。
  // 直接比技能标记集合，而不是汇总每行的 missing（每行只装自己需要的那几个标记，
  // 拿单行结果反推别的角色的需求会漏）。
  const declaredBySkills = new Set<string>()
  for (const skill of skills) {
    for (const token of skillTokens(skill)) declaredBySkills.add(token)
  }
  const missingCapabilities = skillsLoaded
    ? [...requiredTokens].filter((token) => !declaredBySkills.has(token)).sort(compareCodePoints)
    : []

  // 冗余候选：技能声明的标记没有任何角色需要。
  const unusedSkills = skillsLoaded
    ? skills
        .filter((skill) => {
          const tokens = skillTokens(skill)
          if (tokens.length === 0) return false
          return !tokens.some((token) => requiredTokens.has(token))
        })
        .map((skill) => skill.name)
        .sort(compareCodePoints)
    : []

  if (roles.length === 0) {
    na.push("没有任何角色定义：矩阵为空，不代表「不需要技能」")
  }

  return {
    rows,
    missingCapabilities,
    unusedSkills,
    na,
    counts: {
      skills: skills.length,
      roles: roles.length,
      coveredRoles: rows.filter((row) => row.matchedSkills.length > 0).length,
    },
  }
}

/**
 * 从「书需要的维度」推导角色需求标记的辅助口径（不猜语义，只做映射表）。
 *
 * 用途：调用方已经知道本书要哪些工作维度（如大纲阶段选了「人物关系」），
 * 这里把维度映射成角色需要覆盖的能力标记，交给 `projectAgentCapabilityMatrix`。
 * 未知维度原样保留 —— 宁可显示「没人覆盖 xxx」，也不静默丢弃。
 */
export function roleRequirementsFromDimensions(
  dimensions: readonly string[],
  mapping: Readonly<Record<string, readonly string[]>> = {},
): CapabilityRole[] {
  return dimensions
    .map((dimension) => String(dimension ?? "").trim())
    .filter((dimension) => dimension.length > 0)
    .map((dimension) => {
      const mapped = mapping[dimension]
      const kinds = mapped && mapped.length > 0 ? [...mapped] : [dimension]
      return { id: dimension, label: dimension, kinds }
    })
    .sort((a, b) => compareCodePoints(a.id, b.id))
}
