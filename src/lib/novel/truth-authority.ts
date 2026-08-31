/**
 * R-allrepo-1 (29 全仓吸收落地): TruthAuthority — 真源五级分级与编辑事务.
 *
 * 吸收来源：累积残余 roadmap（25 号 hy3 value 8 / 29 号三模型 3/3 residual
 * value 7-8）——参考仓 truth-authority 模式（事实分级+编辑事务）。
 *
 * 定位：事实条目的权威等级声明 + 等级间合法迁移 + 编辑事务冲突检测。
 * 等级语义（对齐 Draft-first 与 canon 体系）：canon（定稿正典）>
 * established（已确立设定）> draft（草稿待定）> hypothesis（推测）>
 * superseded（已被取代）。不构成第二真源：本模块治理「事实条目的等级
 * 元数据」，事实内容本身仍在 Truth Files/status.json 体系。
 */

export const AUTHORITY_LEVELS = ["canon", "established", "draft", "hypothesis", "superseded"] as const

export type AuthorityLevel = (typeof AUTHORITY_LEVELS)[number]

/** 等级权重：canon 最高。superseded 最低（仅存档）。 */
export const AUTHORITY_WEIGHT: Record<AuthorityLevel, number> = {
  canon: 5,
  established: 4,
  draft: 3,
  hypothesis: 2,
  superseded: 1,
}

export interface TruthEntry {
  entryId: string
  subject: string
  statement: string
  level: AuthorityLevel
  /** 上一等级（迁移链溯源；初始声明为空）。 */
  previousLevel?: AuthorityLevel
  /** 事务序号（每次等级变更 +1）。 */
  revision: number
  /** superseded 时指向取代本条的 entryId。 */
  supersededBy?: string
}

export interface TruthEditTransaction {
  entryId: string
  /** 目标等级。 */
  toLevel: AuthorityLevel
  /** 变更理由（审计必填）。 */
  reason: string
}

/** 合法迁移表：等级间允许的方向（吸收「编辑事务」模式——不可静默跨级）。 */
const LEGAL_TRANSITIONS: Record<AuthorityLevel, AuthorityLevel[]> = {
  canon: ["superseded"],
  established: ["canon", "superseded"],
  draft: ["established", "canon", "superseded"],
  hypothesis: ["draft", "established", "superseded"],
  superseded: [],
}

export interface TruthEditResult {
  entries: TruthEntry[]
  applied: boolean
  reason?: string
}

/**
 * 应用编辑事务（纯函数）：合法迁移 → 更新等级+previousLevel+revision+1；
 * 非法迁移 → 拒绝并给出原因；目标条目不存在 → 拒绝。
 * canon 降级仅允许 superseded（正典不可直降草稿）；
 * superseded 为终态（已被取代的事实不可复活，需新建条目）。
 */
export function applyTruthEdit(
  entries: TruthEntry[],
  tx: TruthEditTransaction,
): TruthEditResult {
  const idx = entries.findIndex((e) => e.entryId === tx.entryId)
  if (idx === -1) {
    return { entries, applied: false, reason: `条目不存在：${tx.entryId}` }
  }
  if (!tx.reason.trim()) {
    return { entries, applied: false, reason: "变更理由缺失（审计必填）" }
  }
  const entry = entries[idx]
  if (!LEGAL_TRANSITIONS[entry.level].includes(tx.toLevel)) {
    return {
      entries,
      applied: false,
      reason: `非法迁移：${entry.level} → ${tx.toLevel}（允许：${LEGAL_TRANSITIONS[entry.level].join("、") || "无（终态）"}）`,
    }
  }
  const updated: TruthEntry = {
    ...entry,
    previousLevel: entry.level,
    level: tx.toLevel,
    revision: entry.revision + 1,
  }
  if (tx.toLevel === "superseded" && tx.reason.startsWith("supersededBy:")) {
    updated.supersededBy = tx.reason.slice("supersededBy:".length).trim()
  }
  const next = [...entries]
  next[idx] = updated
  return { entries: next, applied: true }
}

export interface TruthConflict {
  subject: string
  entries: TruthEntry[]
  severity: "error" | "warn"
  message: string
}

/**
 * 同主题冲突检测：同 subject 下存在多条非 superseded 条目时，
 * 若最高等级并列（双 canon/double-established）→ error；否则 warn（需收敛）。
 * 确定性：按 entries 输入序报告。
 */
export function detectTruthConflicts(entries: TruthEntry[]): TruthConflict[] {
  const bySubject = new Map<string, TruthEntry[]>()
  for (const e of entries) {
    if (e.level === "superseded") continue
    const list = bySubject.get(e.subject) ?? []
    list.push(e)
    bySubject.set(e.subject, list)
  }
  const conflicts: TruthConflict[] = []
  for (const [subject, list] of bySubject) {
    if (list.length < 2) continue
    const maxWeight = Math.max(...list.map((e) => AUTHORITY_WEIGHT[e.level]))
    const top = list.filter((e) => AUTHORITY_WEIGHT[e.level] === maxWeight)
    if (top.length >= 2) {
      conflicts.push({
        subject,
        entries: list,
        severity: "error",
        message: `主题「${subject}」存在 ${top.length} 条同级最高（${top[0].level}）冲突条目，须收敛`,
      })
    } else {
      conflicts.push({
        subject,
        entries: list,
        severity: "warn",
        message: `主题「${subject}」存在 ${list.length} 条并存条目，低等级项待收敛或取代`,
      })
    }
  }
  return conflicts
}

/** 权威裁决：同主题多等级并存时返回最高等级条目（canon>established>draft>hypothesis）。 */
export function resolveAuthoritative(entries: TruthEntry[], subject: string): TruthEntry | undefined {
  const list = entries.filter((e) => e.subject === subject && e.level !== "superseded")
  if (list.length === 0) return undefined
  return list.reduce((best, e) => (AUTHORITY_WEIGHT[e.level] > AUTHORITY_WEIGHT[best.level] ? e : best))
}
