/**
 * 事实记录的 canonical status 枚举。
 * MIT licensed implementation.
 */
export type CanonStatus = "candidate" | "verified" | "rejected" | "pending_review"

/**
 * 事实记录数据模型。
 * MIT licensed implementation.
 *
 * 用于存储和验证小说中出现的 canon 事实（角色、事件、物品等）。
 */
export interface FactRecord {
  fact_id: string                    // 唯一标识符
  fact_type: string                  // 事实类型（如 "event", "character", "location"）
  subject_id: string                 // 主体标识符
  predicate: string                  // 谓词（关系描述）
  object_id_or_value: string         // 宾语 ID 或值
  time_scope: string                 // 时间范围/上下文
  chapter_ref: string                // 章节引用（来源定位）
  evidence_anchor: string            // 证据锚点（原文位置）
  confidence: number                 // 置信度 [0,1]
  canon_status: CanonStatus          // canonical status
}

/**
 * 创建带有默认值的 FactRecord。
 * MIT licensed implementation.
 *
 * @param partial - 部分填充的事实对象
 * @returns 完整的 FactRecord 实例
 */
export const createFactRecord = (partial: Partial<FactRecord>): FactRecord => ({
  fact_id: partial.fact_id ?? "fact:test",
  fact_type: partial.fact_type ?? "event",
  subject_id: partial.subject_id ?? "entity:test",
  predicate: partial.predicate ?? "does",
  object_id_or_value: partial.object_id_or_value ?? "value:test",
  time_scope: partial.time_scope ?? "chapter",
  chapter_ref: partial.chapter_ref ?? "ch-1@v1",
  evidence_anchor: partial.evidence_anchor ?? "p1:s1",
  confidence: partial.confidence ?? 0.8,
  canon_status: partial.canon_status ?? "candidate",
})

/**
 * 判断事实是否可以加入图谱（verified 状态）。
 * MIT licensed implementation.
 *
 * @param fact - 待检查的事实记录
 * @returns true 如果 canon_status 为 verified
 */
export const canPromoteFactToGraph = (fact: FactRecord): boolean => fact.canon_status === "verified"
