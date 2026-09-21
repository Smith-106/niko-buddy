/**
 * 能力召回层（L1）— Capability Retrieval.
 *
 * 把 niko-buddy 的能力注册表（UserSkill / AiCapability）统一成 BM25 检索
 * 文档，对 userMessage 做 Top-K 召回，再经 Rule Filter 裁剪掉越界能力，
 * 输出一份「候选能力集」喂给下游 Capability Planner（L2）。
 *
 * 设计定位（对照 agent 演进史）：
 *   Registry →【本层：BM25 召回 + Rule Filter】→ LLM Planner → Execution
 *   - 复用 lib/novel/bm25-ranking.ts 的中文 bigram BM25，零新依赖、零推理
 *     成本、零索引服务（能力规模几十~几百，BM25 足够，不引向量库）。
 *   - 字段加权参考 pi-maestro tool-discovery.ts：name > kind/stage/intent
 *     > tags > description > content（技能正文权重最低，避免长文噪声）。
 *   - Rule Filter 是确定性硬约束（mode/intent/permission/source 白名单），
 *     在召回后、喂 LLM 前裁剪——防止规划器把联网/写库等越界能力塞进 DAG。
 *
 * 纯函数零 IO，可独立测试。
 */

import { rankByBm25, type Bm25Doc } from "../novel/bm25-ranking"
import type { UserSkill } from "../novel/skill-library"
import type { AiCapability, CapabilityIntent } from "./capabilities/types"
import type { AiWorkflowMode } from "./workflow-mode"

/** 检索字段权重（参考 pi-maestro tool-discovery.ts，按信息密度排序）。 */
const FIELD_WEIGHTS = {
  /** 能力名——最高信息密度 */
  name: 6,
  /** kind/stage/intent 结构化标签——次高 */
  label: 5,
  /** tags / modes —— 辅助召回 */
  tags: 3,
  /** description——一句说明 */
  description: 2,
  /** content 技能正文——权重最低（长文噪声大） */
  content: 1,
} as const

/**
 * 归一化的能力检索文档。UserSkill 与 AiCapability 两种来源都先转成此形状，
 * 保证召回层对「技能」和「能力」一视同仁。
 */
export interface CapabilityDoc {
  /** 稳定 id（skill.id 或 capability.id） */
  id: string
  /** 能力名 */
  name: string
  /** 结构化标签文本（kind+stages+intents 拼接，做 label 字段） */
  label: string
  /** tags/modes 辅助文本 */
  tags: string
  /** 一句说明 */
  description: string
  /** 技能正文（仅 UserSkill 有；AiCapability 为空串） */
  content: string
  /** 来源（built-in/project/uploaded/mcp/linked） */
  source: string
  /** 适用工作流模式 */
  modes: string[]
  /** 适用意图（仅 AiCapability 有；UserSkill 由调用方按 route 推断） */
  intents: string[]
  /** 执行权限（auto/confirm；UserSkill 恒 auto——技能是 prompt 约束非工具） */
  permission: "auto" | "confirm"
  /** 原始引用，召回后回取 */
  ref: UserSkill | AiCapability
}

/** Rule Filter 的裁剪约束（确定性硬约束，非语义判断）。 */
export interface CapabilityRuleContext {
  /** 当前工作流模式；能力的 modes 不含此模式则裁掉 */
  mode: AiWorkflowMode
  /** 当前任务意图；能力的 intents 非空且不含此意图则裁掉 */
  intent?: CapabilityIntent | string | null
  /** 允许的来源白名单；缺省全放行 */
  allowedSources?: ReadonlySet<string>
  /** 是否只允许 auto 权限能力（true 时裁掉 confirm 能力） */
  autoOnly?: boolean
}

export interface RetrievedCapability {
  doc: CapabilityDoc
  /** BM25 得分（已按字段加权聚合） */
  score: number
}

export interface CapabilityRetrievalResult {
  /** 召回且通过规则裁剪的能力，按得分降序 */
  candidates: RetrievedCapability[]
  /** 被 Rule Filter 裁掉的能力 id → 原因（可观测） */
  filteredOut: Array<{ id: string; reason: string }>
}

// ---------------------------------------------------------------------------
// 归一化：UserSkill / AiCapability → CapabilityDoc
// ---------------------------------------------------------------------------

export function docFromUserSkill(skill: UserSkill): CapabilityDoc {
  return {
    id: skill.id,
    name: skill.name,
    label: [...skill.kind, ...skill.stages].join(" "),
    tags: [...skill.tags, ...skill.modes, skill.categoryId].filter(Boolean).join(" "),
    description: skill.description ?? "",
    content: skill.content ?? "",
    source: skill.source,
    modes: [...skill.modes],
    intents: [],
    permission: "auto",
    ref: skill,
  }
}

export function docFromAiCapability(cap: AiCapability): CapabilityDoc {
  return {
    id: cap.id,
    name: cap.name,
    label: [cap.kind, ...cap.intents].filter(Boolean).join(" "),
    tags: [...cap.modes, cap.toolName ?? "", cap.source ?? ""].filter(Boolean).join(" "),
    description: "",
    content: "",
    source: cap.source ?? "built-in",
    modes: [...cap.modes],
    intents: [...cap.intents],
    permission: cap.permission,
    ref: cap,
  }
}

// ---------------------------------------------------------------------------
// BM25 索引：字段加权 — 把加权后的文档拼成单条 Bm25Doc 喂给 rankByBm25
// ---------------------------------------------------------------------------

/**
 * 字段加权展开：把每个字段按其权重重复 N 次后拼接，等价于 pi-maestro
 * tool-discovery.ts 的 addWeightedTokens（termFrequency 加权）。BM25 对词频
 * 敏感，重复即线性提权——比改 rankByBm25 接口侵入小，且保持纯函数。
 */
function buildWeightedText(doc: CapabilityDoc): string {
  const parts: string[] = []
  const push = (text: string, weight: number) => {
    const t = text.trim()
    if (!t) return
    for (let i = 0; i < weight; i += 1) parts.push(t)
  }
  push(doc.name, FIELD_WEIGHTS.name)
  push(doc.label, FIELD_WEIGHTS.label)
  push(doc.tags, FIELD_WEIGHTS.tags)
  push(doc.description, FIELD_WEIGHTS.description)
  push(doc.content, FIELD_WEIGHTS.content)
  return parts.join(" ")
}

export function buildCapabilityIndex(
  items: ReadonlyArray<UserSkill | AiCapability>,
): Bm25Doc[] {
  return items.map((item) => {
    const doc = isUserSkill(item) ? docFromUserSkill(item) : docFromAiCapability(item)
    return { id: doc.id, text: buildWeightedText(doc) }
  })
}

function isUserSkill(item: UserSkill | AiCapability): item is UserSkill {
  // UserSkill 有 content/stages/priority；AiCapability 有 kind/permission/intents。
  return typeof (item as UserSkill).content === "string" && Array.isArray((item as UserSkill).stages)
}

// ---------------------------------------------------------------------------
// Rule Filter：确定性硬约束裁剪
// ---------------------------------------------------------------------------

/**
 * 逐条应用硬约束。返回 null 表示通过，否则返回裁剪原因（可观测）。
 */
export function ruleFilterReason(
  doc: CapabilityDoc,
  ctx: CapabilityRuleContext,
): string | null {
  if (doc.modes.length > 0 && !doc.modes.includes(ctx.mode)) {
    return `mode 不匹配 (${ctx.mode})`
  }
  if (ctx.intent && doc.intents.length > 0 && !doc.intents.includes(ctx.intent)) {
    return `intent 不匹配 (${ctx.intent})`
  }
  if (ctx.allowedSources && ctx.allowedSources.size > 0 && !ctx.allowedSources.has(doc.source)) {
    return `source 不允许 (${doc.source})`
  }
  if (ctx.autoOnly && doc.permission !== "auto") {
    return `需确认权限 (${doc.permission})`
  }
  return null
}

// ---------------------------------------------------------------------------
// 召回入口：BM25 TopK → Rule Filter
// ---------------------------------------------------------------------------

/**
 * 对 query 在 items 上做 BM25 召回，取 TopK，再经 Rule Filter 裁剪。
 * - query 为空 / items 为空 → 返回空候选（调用方走查表兜底）。
 * - minScore 默认 0：BM25 零分词不达意，但仍给规划器留候选（由 limit 控量）。
 */
export function retrieveCapabilities(
  query: string,
  items: ReadonlyArray<UserSkill | AiCapability>,
  ctx: CapabilityRuleContext,
  opts: { limit?: number; minScore?: number } = {},
): CapabilityRetrievalResult {
  const limit = opts.limit ?? 8
  const minScore = opts.minScore ?? 0
  if (!query.trim() || items.length === 0) {
    return { candidates: [], filteredOut: [] }
  }

  // id → CapabilityDoc 映射（同一 id 可能对应 skill 与 capability，保留两份需唯一 id；
  // 实践中 UserSkill.id 与 AiCapability.id 命名空间不同，碰撞概率极低）
  const docById = new Map<string, CapabilityDoc>()
  for (const item of items) {
    const doc = isUserSkill(item) ? docFromUserSkill(item) : docFromAiCapability(item)
    docById.set(doc.id, doc)
  }

  const index = buildCapabilityIndex(items)
  const ranked = rankByBm25(query, index)
    .filter((r) => r.score > minScore)
    .slice(0, limit)

  const candidates: RetrievedCapability[] = []
  const filteredOut: Array<{ id: string; reason: string }> = []
  for (const r of ranked) {
    const doc = docById.get(r.id)
    if (!doc) continue
    const reason = ruleFilterReason(doc, ctx)
    if (reason) filteredOut.push({ id: r.id, reason })
    else candidates.push({ doc, score: r.score })
  }
  return { candidates, filteredOut }
}
