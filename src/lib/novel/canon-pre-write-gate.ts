/**
 * 53 号报告 P1-2: canon 写前一致性门控 (lore-weave GuardrailViolation
 * L1_axiom 硬锁模式, AGPL-3.0 只借模式; QMAI 纯函数 TS 实现, 零 IO 零 LLM)。
 *
 * 语义 (对齐 lore-weave WriteCanonEntry → 409 canon_guardrail_l1_conflict):
 *  - 抽取即 canon 校验, Consistency 门控前置到写入前;
 *  - QMAI 四态: PASS / DUPLICATE / WARN / BLOCK (镜像写后对账 twoPhaseReconcile
 *    的确定性判定, 但语义相反: 对账是写后检测, gate 是写前拦截);
 *  - 与 Rust 侧 classify_conflict (53 P0-2) 共享判定逻辑: 同端点同 predicate
 *    异值 + 有效区间重叠 = 硬冲突 (BLOCK/contradicted), digest 重复 = 幂等跳过。
 *
 * additive 保证: gate 默认 warn-only 模式 (BLOCK 降级为 WARN 记录), 观察期后
 * 经配置旗标 preWriteGateMode 切换 "block"; 未启用/拉取失败时零行为变更。
 */

/** 写前门控四态。 */
export type PreWriteGateState = "PASS" | "DUPLICATE" | "WARN" | "BLOCK"

/** 写前 gate 输入 (new_edges 为待写新边, existingEdges 为现存边快照)。 */
export interface PreWriteGateInput {
  newEdges: ReadonlyArray<{
    id: string
    sourceId: string
    targetId: string
    predicate: string
    digest?: string
    validAt?: number | null
    invalidAt?: number | null
  }>
  existingEdges: ReadonlyArray<{
    id: string
    sourceId: string
    targetId: string
    predicate: string
    digest?: string
    validAt?: number | null
    invalidAt?: number | null
  }>
}

/** 写前 gate 结果。 */
export interface PreWriteGateResult {
  state: PreWriteGateState
  /** 触发 gate 的边 (BLOCK/WARN/DUPLICATE 时非空)。 */
  conflicts: Array<{
    newEdgeId: string
    existingEdgeId?: string
    reason: string
  }>
  /** 诊断备注。 */
  notes: string[]
}

/** gate 配置: 模式 + 有效区间重叠判定开关。 */
export interface PreWriteGateConfig {
  /** warn-only (默认): BLOCK 降级 WARN 记录不拦截; block: BLOCK 硬拦。 */
  mode?: "warn" | "block"
}

/** 默认写前 gate 模式: warn-only (additive 观察期, 零行为变更)。 */
export const DEFAULT_PRE_WRITE_GATE_MODE = "warn" as const

/** 有效区间重叠: 未封顶视为延伸到未来。 */
export function preWriteIntervalsOverlap(
  a: { validAt?: number | null; invalidAt?: number | null },
  b: { validAt?: number | null; invalidAt?: number | null },
): boolean {
  const aStart = a.validAt ?? Number.MIN_SAFE_INTEGER
  const bStart = b.validAt ?? Number.MIN_SAFE_INTEGER
  if (a.invalidAt == null && b.invalidAt == null) return true
  if (a.invalidAt != null && b.invalidAt == null) return bStart <= a.invalidAt
  if (a.invalidAt == null && b.invalidAt != null) return aStart <= b.invalidAt
  return aStart <= b!.invalidAt! && bStart <= a!.invalidAt!
}

/**
 * checkCanonPreWrite (53 号报告 P1-2 权威入口, 纯函数):
 *  - digest 非空且与现存边重合 + 区间重叠 → DUPLICATE (幂等跳过);
 *  - 同 sourceId+predicate 异 target + 区间重叠 → BLOCK (硬冲突, 镜像
 *    lore-weave L1 axiom 硬锁; warn mode 下降级 WARN);
 *  - 同端点同 predicate 异值但区间不重叠 → WARN (软冲突, 时态递进合法);
 *  - 其余 → PASS。
 * 语义歧义一律 PASS (宁漏勿误, 绝不误拦合法剧情反转 —— 剧情反转通常伴随
 * 新 predicate 或新端点, 不触发同键异值重叠)。
 */
export function checkCanonPreWrite(
  input: PreWriteGateInput,
  config: PreWriteGateConfig = {},
): PreWriteGateResult {
  const conflicts: PreWriteGateResult["conflicts"] = []
  const notes: string[] = []
  const mode = config.mode ?? "warn"
  for (const ne of input.newEdges) {
    // DUPLICATE: digest 幂等键
    if (ne.digest) {
      const dup = input.existingEdges.find(
        (e) => e.digest === ne.digest && preWriteIntervalsOverlap(e, ne),
      )
      if (dup) {
        conflicts.push({
          newEdgeId: ne.id,
          existingEdgeId: dup.id,
          reason: "DUPLICATE：digest 相同且有效区间重叠（幂等重复写入）",
        })
        continue
      }
    }
    // BLOCK: 同 source+predicate 异 target + 区间重叠
    const contradict = input.existingEdges.find(
      (e) =>
        e.sourceId === ne.sourceId &&
        e.predicate === ne.predicate &&
        e.targetId !== ne.targetId &&
        preWriteIntervalsOverlap(e, ne),
    )
    if (contradict) {
      conflicts.push({
        newEdgeId: ne.id,
        existingEdgeId: contradict.id,
        reason: "BLOCK：同端点同 predicate 异值且有效区间重叠（L1 硬冲突，需 supersede 而非平写）",
      })
      continue
    }
    // WARN: 同 source+predicate 异 target 但区间不重叠 (时态递进合法)
    const soft = input.existingEdges.find(
      (e) =>
        e.sourceId === ne.sourceId &&
        e.predicate === ne.predicate &&
        e.targetId !== ne.targetId &&
        !preWriteIntervalsOverlap(e, ne),
    )
    if (soft) {
      conflicts.push({
        newEdgeId: ne.id,
        existingEdgeId: soft.id,
        reason: "WARN：同端点同 predicate 异值但区间不重叠（时态递进，建议确认）",
      })
      continue
    }
  }
  if (conflicts.length > 0) {
    notes.push(`写前 gate 命中 ${conflicts.length} 处（mode=${mode}）`)
  }
  const hasBlock = conflicts.some((c) => c.reason.startsWith("BLOCK"))
  const hasWarn = conflicts.some((c) => c.reason.startsWith("WARN"))
  const hasDup = conflicts.some((c) => c.reason.startsWith("DUPLICATE"))
  let state: PreWriteGateState = "PASS"
  if (hasBlock) {
    // warn-only 模式: BLOCK 降级 WARN 记录不拦截 (additive 观察期)
    state = mode === "block" ? "BLOCK" : "WARN"
  } else if (hasDup) {
    state = "DUPLICATE"
  } else if (hasWarn) {
    state = "WARN"
  }
  return { state, conflicts, notes }
}
