/**
 * kb-lifecycle.ts — 生命周期双轨治理（E-06 / F-006，双库架构蓝图 kb-governance）。
 *
 * ## 职责（REQ-GOV-LIFE-01..06 / DA-05 / SME-07）
 *   - 能力库侧：蒸馏 + 衰减（越用越小越精）。衰减作为 rerank 权重输入，
 *     MUST NOT 物理删除（GOV-LIFE-01，保证可回溯）；状态由事件日志派生
 *     （`.novel/kb-decay-events.jsonl`，报告工件可删重建——零新真源纪律），
 *     清空重放 → decay 恒 1（可回滚，GOV-REV-03 重建语义）。
 *   - 过程库侧：supersession / compaction（版本一致）。superseded 旧版标记
 *     invalid_at、MUST NOT 再装配（GOV-LIFE-02）；compaction MUST 经确定性
 *     fold（GOV-LIFE-04）——物理执行需扩 chapter-ingest fold 域，本期只落
 *     纯判定 + dry-run 计划（compactPlan），显式 DEFERRED（E-06 共识 C-12）。
 *   - 策略不交叉（GOV-LIFE-03）：类型层隔离——CapabilityDecayState 刻意无
 *     invalidAt/version 字段、ProcessSupersession 刻意无 decayFactor/distilledAt
 *     字段（spec 以类型 + 运行时键集合双断言钉死）。
 *
 * ## 边界与纪律
 *   - 纯函数层：零 IO、零 LLM、零写句柄；不新建任何真相文件。
 *   - 默认参数（G-3）全部标 [需校准]：校准前 flag 默认关闭，衰减不生效。
 *   - 过程库 supersession 元数据落晋升凭证层（superseded 状态 + revision 单调链），
 *     不动 `.novel` 真相文件（E-06 共识 C-5 / hy3 F-9）。
 *
 * ## DimensionCoord（SA-05 / GOV-REV-02，E-06 共识 C-10）
 *   capability-decay: (Decoupled, Async, Tunable) —— 事件日志派生，异步生效，
 *     可逆 = 清空重放；process-supersession: (Coupled, Sync, Sovereign) ——
 *     与门面读取路径耦合，invalid_at 权威元数据，可逆 = 清除 invalid_at。
 *
 * 遵循 QMAI/CLAUDE.md：E-06 新增锚点（2026-09-04 三模型共识），落 `src/lib/novel/`。
 */

// ──────────────────────────────────────────────────────────────────────────
// 能力库侧：蒸馏 + 衰减（GOV-LIFE-01/05）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 能力库衰减状态（派生，非真相文件）。
 * 刻意无 invalidAt / version 字段（GOV-LIFE-03 策略不交叉，类型层隔离）。
 */
export interface CapabilityDecayState {
  entryId: string
  /** 蒸馏时刻（epoch ms；null = 未蒸馏）。 */
  distilledAt: number | null
  /** 使用计数（蒸馏触发输入）。 */
  usageCount: number
  /** 衰减因子 ∈ (0,1]，单调不增；1 = 无衰减。 */
  decayFactor: number
}

/** 衰减默认参数（G-3，全部 [需校准]——校准前 flag 关闭不生效）。 */
export const DEFAULT_DECAY_PARAMS = {
  /** 使用次数触发蒸馏阈值 [需校准] */
  distillTriggerUsage: 20,
  /** 条目年龄（天）触发蒸馏阈值 [需校准] */
  distillTriggerAgeDays: 30,
  /** 半衰期（天）[需校准] */
  halfLifeDays: 180,
} as const

/**
 * 衰减因子纯函数：单调不增、∈(0,1]。
 * 未蒸馏（distilledAt=null）→ 1（无衰减）；蒸馏后按半衰期指数衰减。
 */
export function decayFactorOf(input: {
  distilledAt: number | null
  usageCount: number
  now: number
  halfLifeDays?: number
}): number {
  const halfLifeDays = input.halfLifeDays ?? DEFAULT_DECAY_PARAMS.halfLifeDays
  if (input.distilledAt === null) return 1
  const ageDays = Math.max(0, (input.now - input.distilledAt) / 86_400_000)
  return Math.max(0.05, Math.pow(0.5, ageDays / halfLifeDays))
}

/** 蒸馏触发判定（G-3 默认值 [需校准]）。 */
export function shouldDistill(input: {
  usageCount: number
  ageDays: number
  params?: Partial<typeof DEFAULT_DECAY_PARAMS>
}): boolean {
  const p = { ...DEFAULT_DECAY_PARAMS, ...(input.params ?? {}) }
  return input.usageCount >= p.distillTriggerUsage || input.ageDays >= p.distillTriggerAgeDays
}

/**
 * 由事件日志重放派生衰减状态（零新真源：事件日志是报告工件，可删重建）。
 * 空事件日志重放 = 恒等（decayFactor 全 1）→ 回滚 = 清空事件日志 + 重放。
 * @param now 重放时刻（epoch ms）；缺省取事件最大 distilledAt（蒸馏时刻即 1）。
 */
export function recomputeDecay(
  events: readonly { entryId: string; distilledAt: number | null; usageCount: number }[],
  now?: number,
): CapabilityDecayState[] {
  const replayNow = now ?? Math.max(0, ...events.map((e) => e.distilledAt ?? 0))
  return events.map((e) => ({
    entryId: e.entryId,
    distilledAt: e.distilledAt,
    usageCount: e.usageCount,
    decayFactor: decayFactorOf({ distilledAt: e.distilledAt, usageCount: e.usageCount, now: replayNow }),
  }))
}

// ──────────────────────────────────────────────────────────────────────────
// 过程库侧：supersession / compaction（GOV-LIFE-02/04）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 过程库 supersession 元数据（版本一致）。
 * 刻意无 decayFactor / distilledAt 字段（GOV-LIFE-03 策略不交叉，类型层隔离）。
 */
export interface ProcessSupersession {
  entity: string
  version: number
  /** 失效章号（null = 未失效）。 */
  invalidAt: number | null
  /** 取代者版本（null = 未被取代）。 */
  supersededBy: string | null
}

/** 版本推进（单调）。 */
export function nextVersion(prev: ProcessSupersession): ProcessSupersession {
  return { ...prev, version: prev.version + 1 }
}

/** 标记 superseded（返回新值，不改原对象——纯函数）。 */
export function markSuperseded(
  entry: ProcessSupersession,
  input: { at: number; byRevision: string },
): ProcessSupersession {
  return { ...entry, invalidAt: input.at, supersededBy: input.byRevision }
}

/** superseded 判定：invalidAt 非空且 ≤ 当前章 → 不得再装配（GOV-LIFE-02）。 */
export function isSuperseded(entry: ProcessSupersession, atChapter: number): boolean {
  return entry.invalidAt !== null && entry.invalidAt <= atChapter
}

/** compaction dry-run 计划（GOV-LIFE-04：物理执行 DEFERRED，需扩 fold 域）。 */
export function compactPlan(entries: readonly ProcessSupersession[]): {
  toSupersede: ProcessSupersession[]
  toKeep: ProcessSupersession[]
} {
  const toSupersede: ProcessSupersession[] = []
  const toKeep: ProcessSupersession[] = []
  for (const e of entries) {
    if (e.invalidAt !== null) toSupersede.push(e)
    else toKeep.push(e)
  }
  return { toSupersede, toKeep }
}

/** 装配过滤：剔除 superseded 条目（E-06 共识 C-5，消费点复用）。 */
export function filterAssemblable<T extends { status?: string; invalidAt?: number | null }>(
  entries: readonly T[],
  atChapter: number,
): T[] {
  return entries.filter((e) => {
    if (e.status === "superseded") return false
    if (e.invalidAt !== null && e.invalidAt !== undefined && e.invalidAt <= atChapter) return false
    return true
  })
}

/**
 * 晋升治理迁移（E-05 C-8 归 E-06）：同 chapterId+entity 下 revision 更大者晋升 →
 * 旧 record 状态置 superseded（复用 E-05 C-2 权威 revision 链）。
 * 纯函数：返回新数组，不改原对象；状态可逆（无物理删除）。
 */
export function supersedeByRevision<T extends { replayKey: string; status: string; sourceRef: { chapterId: string; revision: number } }>(
  records: readonly T[],
): T[] {
  const byKey = new Map<string, T>()
  for (const r of records) {
    const existing = byKey.get(r.sourceRef.chapterId)
    if (!existing || r.sourceRef.revision > existing.sourceRef.revision) {
      byKey.set(r.sourceRef.chapterId, r)
    }
  }
  return records.map((r) => {
    const newest = byKey.get(r.sourceRef.chapterId)
    if (newest && newest.replayKey !== r.replayKey && r.status === "promoted") {
      return { ...r, status: "superseded" as const }
    }
    return r
  })
}

// ──────────────────────────────────────────────────────────────────────────
// 策略不交叉（GOV-LIFE-03）
// ──────────────────────────────────────────────────────────────────────────

/** 生命周期策略表：能力库无 supersession、过程库无蒸馏（GOV-LIFE-03）。 */
export const LIFECYCLE_POLICY = {
  capability: { decay: true, supersession: false },
  process: { decay: false, supersession: true },
} as const
