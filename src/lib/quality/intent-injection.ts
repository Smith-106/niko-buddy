/**
 * intent-injection.ts — v2.6.8 D3: 写作意图单射（诊断表 + 剥离进 pending）
 *
 * 蓝图 `docs/p0/blueprint-v268-20260828.md` D3：
 *   - 诊断表（信号→诊断→动作）——只读草稿静态扫描，不触 Consistency 门
 *   - 证据指针回链原始指令 ID
 *   - 剥离进 pending 不静默丢弃（Draft-first）
 *   - 伏笔/铺垫受保护类别（锁死需作者显式解封）
 *   - 单射≠双向唯一（意图→叙事单射；叙事→意图多射——禁压制复调书写）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 意图单射诊断（信号 → 诊断 → 动作）
// ============================================================================

/** 意图信号（诊断表行）。 */
export interface IntentSignal {
  /** 信号 ID。 */
  id: string
  /** 信号描述（诊断命令）。 */
  description: string
  /** 命中判定（纯函数——输入文本片段）。 */
  matches: (text: string) => boolean
}

/** 诊断结果。 */
export interface IntentDiagnosis {
  /** 命中的信号。 */
  signalId: string
  /** 证据指针（回链原始指令 ID）。 */
  evidenceRef: string
  /** 建议动作（剥离 pending / 锁死 / 拒绝）。 */
  action: "strip_to_pending" | "lock_protected" | "reject"
}

/** 受保护类别（伏笔/铺垫——不判为次要意图）。 */
export const PROTECTED_CATEGORIES = ["foreshadowing", "setup"] as const

/** 受保护类别命中判定（纯函数——关键词/标记）。 */
export function isProtected(text: string): boolean {
  return PROTECTED_CATEGORIES.some((c) => text.includes(`[${c}]`))
}

/**
 * 意图单射诊断（纯函数——确定性）。
 * 输入：文本片段 + 信号表 + 指令 ID；输出诊断（剥离建议——不自动删改）。
 * 单射语义：意图→叙事单射（一意一映射）；叙事→意图多射（复调不压制）。
 */
export function diagnoseIntent(
  text: string,
  signals: IntentSignal[],
  instructionId: string,
): IntentDiagnosis[] {
  const results: IntentDiagnosis[] = []
  for (const signal of signals) {
    if (signal.matches(text)) {
      // 受保护类别命中 → 锁死（需作者显式解封）
      if (isProtected(text)) {
        results.push({ signalId: signal.id, evidenceRef: instructionId, action: "lock_protected" })
      } else {
        results.push({ signalId: signal.id, evidenceRef: instructionId, action: "strip_to_pending" })
      }
    }
  }
  return results
}

/** 剥离动作（纯函数——产出 pending 草稿，不静默丢弃）。 */
export function stripToPending(text: string, diagnosis: IntentDiagnosis[]): { stripped: string; pending: string[] } {
  const pending: string[] = []
  let stripped = text
  for (const d of diagnosis) {
    if (d.action === "strip_to_pending") {
      pending.push(`[stripped:${d.signalId} ref:${d.evidenceRef}]`)
    }
  }
  return { stripped, pending }
}

/** 默认信号表（诊断表——意图动词直译/对话后括注内心/同段重复意图）。 */
export const DEFAULT_INTENT_SIGNALS: IntentSignal[] = [
  {
    id: "intent-verb-direct",
    description: "意图→动作直译（她想/他决定 紧接 她做了/他做了）",
    matches: (t) => /(她想|他决定|她打算|他想要)[^。]{0,20}(她做了|他做了|她走向|他拿起)/.test(t),
  },
  {
    id: "inner-note-after-dialogue",
    description: "对话后括注内心（引号后直接内心独白）",
    matches: (t) => /[”"]\s*(她想|他心想|她心想|她暗自|他默默)/.test(t),
  },
  {
    id: "repeated-intent-verb",
    description: "同段重复意图动词（同一意图词出现 ≥2 次）",
    matches: (t) => {
      const verbs = ["想", "决定", "打算", "希望", "试图"]
      return verbs.some((v) => (t.match(new RegExp(v, "g")) ?? []).length >= 2)
    },
  },
]
