/**
 * 55 号设计 W2-5 (B-01): 数值事实检查器 (fiction-number-checker 模式借鉴, MIT 只借模式)。
 *
 * 确定性数值一致性 (Consistency 轴), 纯函数零 IO 零 LLM。
 * - 基数类 (money/measure/count): 正则抽取 + 单位归一化 + 按 (subject, kind, unit) 分组,
 *   同组 ≥2 个不同归一化值 → candidate_conflict (warn-only, 不越权断言矛盾)。
 * - 序数类 (境界/层级): 只做单调性校验 (递增不回退), 不做量纲换算 (网文"练气三层"不可换算)。
 * - 中文主语绑定: 复用调用方传入的角色名表 (local-entity-names 同源), 不直搬英文大写启发式。
 *
 * 默认观察期 warn-only (对齐 canon-pre-write-gate DEFAULT_PRE_WRITE_GATE_MODE="warn" 纪律)。
 */

export type NumericFactKind = "money" | "measure" | "count" | "ordinal"

export interface NumericFact {
  chapter: number
  subject: string
  kind: NumericFactKind
  unit: string
  rawValue: string
  normalizedValue: number
}

export interface NumericFactFinding {
  type: "numeric_drift"
  subtype: "consistency_mechanical"
  severity: "warning"
  ref: string
  message: string
  chapter: number
  evidence: string
  verdict: "consistent" | "candidate_conflict" | "insufficient"
}

/** 单位 → 基准单位换算系数 (365.25 天/年, 1609.344 米/英里 等)。 */
const UNIT_MAP: Record<string, number> = {
  年: 365.25,
  月: 30.44,
  天: 1,
  日: 1,
  小时: 1 / 24,
  时: 1 / 24,
  分钟: 1 / 1440,
  分: 1 / 1440,
  秒: 1 / 86400,
  米: 1,
  公里: 1000,
  千米: 1000,
  里: 500,
  英里: 1609.344,
  斤: 500,
  公斤: 1000,
  千克: 1000,
  两: 50,
  元: 1,
  块: 1,
  万: 10000,
  亿: 100000000,
}

/** 序数类关键词 (境界/层级, 只做单调性校验)。 */
const ORDINAL_KEYWORDS = ["层", "阶", "级", "品", "重", "转", "境"]

const MONEY_RE = /([\d.]+)\s*(元|块|两|万|亿)/g
const MEASURE_RE = /([\d.]+)\s*(年|月|天|日|小时|时|分钟|分|秒|米|公里|千米|里|英里|斤|公斤|千克)/g
const COUNT_RE = /([\d.]+)\s*(个|人|名|只|件|把|辆|艘|架|次|枚|颗|匹|头|条|间|座|层|阶|级|重|转|境)/g
// 中文数字 (序数类境界/层级常用: 练气三层/五层)
const CN_NUM_RE = /([一二三四五六七八九十百千万两]+)\s*(层|阶|级|品|重|转|境)/g

const CN_NUM_MAP: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  百: 100, 千: 1000, 万: 10000,
}

function cnToNumber(s: string): number | null {
  if (s.length === 1) return CN_NUM_MAP[s] ?? null
  let total = 0
  let current = 0
  for (const ch of s) {
    const v = CN_NUM_MAP[ch]
    if (v === undefined) return null
    if (v >= 10) {
      total += (current === 0 ? 1 : current) * v
      current = 0
    } else {
      current = v
    }
  }
  return total + current
}

function normalizeUnit(unit: string): string {
  return UNIT_MAP[unit] !== undefined ? unit : unit
}

function toBaseValue(value: number, unit: string): number {
  const factor = UNIT_MAP[unit]
  return factor !== undefined ? value * factor : value
}

/**
 * 从正文抽取数值事实 (基数类: money/measure/count)。
 * @param text 章节正文
 * @param chapter 章号
 * @param knownSubjects 角色/实体名表 (中文主语绑定, 防英文大写启发式失效)
 */
export function extractNumericFacts(text: string, chapter: number, knownSubjects: string[] = []): NumericFact[] {
  const facts: NumericFact[] = []
  const subjectList = knownSubjects.length > 0 ? knownSubjects : ["主角", "他", "她"]
  const subjectRe = new RegExp(`(${subjectList.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[^。！？\\n]{0,40}?`)

  const scan = (re: RegExp, kind: NumericFactKind) => {
    for (const m of text.matchAll(re)) {
      const rawValue = m[1]!
      const unit = m[2]!
      const value = Number(rawValue)
      if (!Number.isFinite(value)) continue
      // 序数类 (境界/层级): 只做单调性校验, 不做量纲换算
      const effectiveKind: NumericFactKind = ORDINAL_KEYWORDS.includes(unit) ? "ordinal" : kind
      // 找该数值前最近的主语 (40 字窗口内)
      const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0)
      const subjMatch = before.match(subjectRe)
      const subject = subjMatch ? subjMatch[1]! : "未知"
      facts.push({
        chapter,
        subject,
        kind: effectiveKind,
        unit: normalizeUnit(unit),
        rawValue,
        normalizedValue: toBaseValue(value, unit),
      })
    }
  }

  scan(MONEY_RE, "money")
  scan(MEASURE_RE, "measure")
  scan(COUNT_RE, "count")
  // 中文数字序数 (境界/层级)
  for (const m of text.matchAll(CN_NUM_RE)) {
    const value = cnToNumber(m[1]!)
    if (value === null) continue
    const unit = m[2]!
    const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0)
    const subjMatch = before.match(subjectRe)
    const subject = subjMatch ? subjMatch[1]! : "未知"
    facts.push({
      chapter,
      subject,
      kind: "ordinal",
      unit,
      rawValue: m[1]!,
      normalizedValue: value,
    })
  }
  return facts
}

/**
 * 序数类单调性校验: 同一 subject 的序数 (境界/层级) 只允许递增, 回退 → candidate_conflict。
 */
export function checkOrdinalMonotonicity(
  facts: NumericFact[],
): NumericFactFinding[] {
  const findings: NumericFactFinding[] = []
  const bySubject = new Map<string, NumericFact[]>()
  for (const f of facts) {
    if (f.kind !== "ordinal") continue
    const arr = bySubject.get(f.subject) ?? []
    arr.push(f)
    bySubject.set(f.subject, arr)
  }
  for (const [subject, arr] of bySubject) {
    const sorted = [...arr].sort((a, b) => a.chapter - b.chapter)
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]!
      const curr = sorted[i]!
      if (curr.normalizedValue < prev.normalizedValue) {
        findings.push({
          type: "numeric_drift",
          subtype: "consistency_mechanical",
          severity: "warning",
          ref: `numeric:${subject}`,
          message: `${subject} 的${curr.unit}从第 ${prev.chapter} 章 (${prev.rawValue}) 回退到第 ${curr.chapter} 章 (${curr.rawValue})，序数类只允许递增。`,
          chapter: curr.chapter,
          evidence: `subject=${subject}; ch${prev.chapter}=${prev.rawValue}; ch${curr.chapter}=${curr.rawValue}`,
          verdict: "candidate_conflict",
        })
      }
    }
  }
  return findings
}

/**
 * 主入口: 跨章数值事实矛盾候选分组。
 * 同 (subject, kind, unit) 组出现 ≥2 个不同归一化值 → candidate_conflict (warn-only)。
 */
export function runNumericFactCheck(
  chapters: { chapter: number; text: string }[],
  knownSubjects: string[] = [],
): NumericFactFinding[] {
  const findings: NumericFactFinding[] = []
  const allFacts: NumericFact[] = []
  for (const ch of chapters) {
    allFacts.push(...extractNumericFacts(ch.text, ch.chapter, knownSubjects))
  }
  // 序数类单调性
  findings.push(...checkOrdinalMonotonicity(allFacts))

  // 基数类分组矛盾
  const byKey = new Map<string, NumericFact[]>()
  for (const f of allFacts) {
    if (f.kind === "ordinal") continue
    const key = `${f.subject}|${f.kind}|${f.unit}`
    const arr = byKey.get(key) ?? []
    arr.push(f)
    byKey.set(key, arr)
  }
  for (const [key, arr] of byKey) {
    const values = new Set(arr.map((f) => f.normalizedValue))
    if (values.size < 2) continue
    const [subject, kind, unit] = key.split("|")
    const latest = arr[arr.length - 1]!
    findings.push({
      type: "numeric_drift",
      subtype: "consistency_mechanical",
      severity: "warning",
      ref: `numeric:${subject}`,
      message: `${subject} 的${kind === "money" ? "金额" : kind === "measure" ? "度量" : "数量"} (${unit}) 跨章不一致: ${arr.map((f) => `第${f.chapter}章 ${f.rawValue}${f.unit}`).join(" / ")}。`,
      chapter: latest.chapter,
      evidence: `subject=${subject}; kind=${kind}; unit=${unit}; values=${[...values].join(",")}`,
      verdict: "candidate_conflict",
    })
  }
  return findings
}
