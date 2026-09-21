/**
 * 能力规划器（L2）— Capability Planner.
 *
 * 这是 Commander 层的「decide」：把召回后的候选能力集交给 LLM 规划成一张
 * **能力 DAG（Capability DAG，非任务 DAG）**，节点是能力、边是「先用 A 的
 * 结果再跑 B」的依赖。这是 niko-buddy 从「带工具的写作助手」到「自主选择
 * 能力链的 Agent」的关键一跃——把 dynamic-agent-planner 从「大纲规划器」
 * 泛化为「能力规划器」。
 *
 * 链路位置：
 *   BM25 召回(L1) → Rule Filter →【本层：LLM 出能力 DAG + 校验】→ Execution
 *
 * 产物契约：
 *   CapabilityPlan[] { id, name, capabilityId, dependsOn, permission,
 *                      reason, finalReview }
 *   - capabilityId 必须落在候选集内（防幻觉：规划器不能发明能力）
 *   - dependsOn 表达能力间数据/顺序依赖（character_check → style_rewrite）
 *   - permission 透传执行闸（auto 直接跑 / confirm 走人审）
 *
 * 纯函数零 IO：LLM 调用点留 seam（调用方注入 runPlanner 回调），本模块只
 * 负责 prompt 构建 + JSON 解析 + DAG 校验，可独立测试。
 */

import type { CapabilityDoc, RetrievedCapability } from "./capability-retrieval"

export const MAX_CAPABILITY_NODES = 6

export interface CapabilityPlan {
  /** 计划节点 id（LLM 生成，DAG 内唯一） */
  id: string
  /** 人类可读名 */
  name: string
  /** 引用的能力 id —— 必须在候选集内 */
  capabilityId: string
  /** 依赖的前置节点 id（表达能力间顺序/数据依赖） */
  dependsOn: string[]
  /** 执行权限（auto 直接跑 / confirm 走人审） */
  permission: "auto" | "confirm"
  /** 为什么选这个能力（落 SelectedCapabilityTrace.reason） */
  reason: string
  /** 是否终末审查节点 */
  finalReview: boolean
}

export interface CapabilityPlannerContext {
  userMessage: string
  /** 召回后的候选能力（已过 Rule Filter） */
  candidates: RetrievedCapability[]
  /** 上下文摘要（contextPack 摘要，可选） */
  contextSummary?: string
  /** 当前任务意图（可选，给规划器提示方向） */
  intent?: string | null
  /** 是否处于「简单任务」——true 时最多 1 节点 */
  simpleTask?: boolean
}

export type CapabilityPlanParseResult =
  | { ok: true; plan: CapabilityPlan[] }
  | { ok: false; error: string }

export interface CapabilityPlanValidation {
  ok: boolean
  errors: string[]
}

// ---------------------------------------------------------------------------
// Prompt 构建
// ---------------------------------------------------------------------------

export function buildCapabilityPlannerPrompt(context: CapabilityPlannerContext): string {
  const { candidates, userMessage, contextSummary, intent, simpleTask } = context
  const capBlocks = candidates.map(({ doc }, index) => describeDoc(doc, index))
  const maxNodes = simpleTask ? 1 : MAX_CAPABILITY_NODES
  return [
    "你是写作能力规划器。只输出 JSON，不要输出解释。",
    "根据用户任务和候选能力，规划一条能力执行链（DAG），而不是机械全选。",
    `最多 ${maxNodes} 个能力节点。简单局部任务只规划 1 个；需要审查的产出须以 finalReview 能力收尾。`,
    "每个节点包含 id、name、capabilityId、dependsOn、permission、reason、finalReview。",
    "dependsOn 表达「先用哪个能力的结果再跑当前能力」的顺序依赖；无依赖则为空数组。",
    "capabilityId 必须从候选能力列表中选取，不得发明不存在的能力。",
    "reason 用一句话说明为何选它（会写进能力选择 trace）。",
    "",
    `## 用户任务\n${userMessage || "（未提供）"}`,
    intent ? `## 任务意图\n${intent}` : "",
    contextSummary ? `## 上下文摘要\n${contextSummary}` : "",
    "## 候选能力",
    ...(capBlocks.length > 0 ? capBlocks : ["- 无候选能力"]),
    "",
    "输出格式：",
    JSON.stringify({
      nodes: [{
        id: "n1",
        name: "人物一致性检查",
        capabilityId: "char-check",
        dependsOn: [],
        permission: "auto",
        reason: "改写前需确认人物设定不冲突",
        finalReview: false,
      }],
    }, null, 2),
  ].filter(Boolean).join("\n")
}

function describeDoc(doc: CapabilityDoc, index: number): string {
  return [
    `- [${index + 1}] ${doc.name}（capabilityId: ${doc.id}）`,
    `  来源：${doc.source} · 权限：${doc.permission} · 模式：${doc.modes.join(",") || "不限"}`,
    doc.description ? `  说明：${doc.description}` : "",
    doc.label ? `  标签：${doc.label}` : "",
  ].filter(Boolean).join("\n")
}

// ---------------------------------------------------------------------------
// JSON 解析（容错提取，复用大纲 planner 的 extractJsonObject 思路）
// ---------------------------------------------------------------------------

export function parseCapabilityPlan(
  text: string,
  allowedCapabilityIds?: ReadonlySet<string>,
): CapabilityPlanParseResult {
  const jsonText = extractJsonObject(text)
  if (!jsonText) return { ok: false, error: "规划器未返回 JSON 对象" }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (error) {
    return { ok: false, error: `规划 JSON 解析失败：${formatError(error)}` }
  }

  const root = asRecord(parsed)
  const rawNodes = Array.isArray(root?.nodes)
    ? root.nodes
    : Array.isArray(root?.tasks)
      ? root.tasks
      : Array.isArray(parsed)
        ? parsed
        : null
  if (!rawNodes) return { ok: false, error: "规划 JSON 缺少 nodes 数组" }

  const plan: CapabilityPlan[] = []
  for (let index = 0; index < rawNodes.length; index += 1) {
    const raw = asRecord(rawNodes[index])
    if (!raw) return { ok: false, error: `第 ${index + 1} 个节点不是对象` }
    const id = stringValue(raw.id)
    const name = stringValue(raw.name)
    const capabilityId = stringValue(raw.capabilityId ?? raw.capability_id ?? raw.skillId ?? raw.skill_id)
    if (!id || !capabilityId) {
      return { ok: false, error: `第 ${index + 1} 个节点缺少 id 或 capabilityId` }
    }
    plan.push({
      id,
      name: name || capabilityId,
      capabilityId,
      dependsOn: stringArray(raw.dependsOn ?? raw.depends_on ?? raw.dependencies),
      permission: raw.permission === "confirm" ? "confirm" : "auto",
      reason: stringValue(raw.reason),
      finalReview: booleanValue(raw.finalReview ?? raw.final_review),
    })
  }

  if (allowedCapabilityIds && allowedCapabilityIds.size > 0) {
    const unknown = plan.find((node) => !allowedCapabilityIds.has(node.capabilityId))
    if (unknown) return { ok: false, error: `规划使用了不存在的能力：${unknown.capabilityId}` }
  }

  const validation = validateCapabilityPlan(plan)
  if (!validation.ok) return { ok: false, error: validation.errors.join("；") }
  return { ok: true, plan }
}

// ---------------------------------------------------------------------------
// DAG 校验（id 唯一 / 依赖存在 / DFS 环检测 / 上限）— 泛化自 validateOutlineSubAgentPlan
// ---------------------------------------------------------------------------

export function validateCapabilityPlan(plan: CapabilityPlan[]): CapabilityPlanValidation {
  const errors: string[] = []
  if (plan.length === 0) errors.push("能力计划不能为空")
  if (plan.length > MAX_CAPABILITY_NODES) errors.push(`能力节点数量不能超过 ${MAX_CAPABILITY_NODES}`)

  const ids = new Set<string>()
  for (const node of plan) {
    if (!node.id.trim()) errors.push("能力节点 ID 不能为空")
    if (ids.has(node.id)) errors.push(`能力节点 ID 重复：${node.id}`)
    ids.add(node.id)
  }

  for (const node of plan) {
    for (const dep of node.dependsOn ?? []) {
      if (dep === node.id) errors.push(`能力节点不能依赖自身：${node.id}`)
      else if (!ids.has(dep)) errors.push(`依赖不存在：${node.id} -> ${dep}`)
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(plan.map((n) => [n.id, n]))
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    const cyclic = (byId.get(id)?.dependsOn ?? []).some((dep) => byId.has(dep) && visit(dep))
    visiting.delete(id)
    visited.add(id)
    return cyclic
  }
  if (plan.some((node) => visit(node.id))) errors.push("能力依赖存在循环")

  return { ok: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function extractJsonObject(text: string): string | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  const start = cleaned.indexOf("{")
  const arrayStart = cleaned.indexOf("[")
  const effectiveStart = start < 0 ? arrayStart : arrayStart < 0 ? start : Math.min(start, arrayStart)
  if (effectiveStart < 0) return null
  const open = cleaned[effectiveStart]
  const close = open === "{" ? "}" : "]"
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = effectiveStart; index < cleaned.length; index += 1) {
    const char = cleaned[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return cleaned.slice(effectiveStart, index + 1)
    }
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : []
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true"
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
