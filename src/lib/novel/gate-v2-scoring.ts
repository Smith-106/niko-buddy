/**
 * gate-v2-scoring.ts — S3a absorb: StoryForge Gate v2 加权 P2 参考分
 * (roadmap S3 P2 质量 · R10 review-scoring Gate v2)
 *
 * 参考 (reference/ 只读):
 * - StoryForge/src-tauri/src/agency/gate.rs: Gate v2 统一加权评分
 *   code/rule/model 三级 grader 合成 0.2/0.3/0.5, threshold 0.75
 * - StoryForge/src-tauri/src/agency/graders.rs: reading_power 纯规则特征
 *   hook*0.4 + coolpoint*0.3 + micropayoff*0.3 (clamp 0..1)
 *
 * 门控语义 (P0>P1>P2 不可动摇): 本模块产出的是 **P2 参考分**, 仅用于
 * 阅读动力诊断/写作建议排序, **永不覆盖 P0 (consistency) 分层阻断**。
 * 调用方必须: P0 失败时无视本参考分; 本模块本身不暴露任何 gate 判定入口。
 *
 * 纯算法零 LLM: hook/coolpoint/micropayoff 特征用规则提取 (正则/词表),
 * 不引入外部 API (无遥测无外部调用)。
 */

// ============================================================================
// Gate v2 加权 (StoryForge gate.rs: 0.2*code + 0.3*rule + 0.5*model)
// ============================================================================

export const GATE_V2_WEIGHTS = { code: 0.2, rule: 0.3, model: 0.5 } as const
export const GATE_V2_PASS_THRESHOLD = 0.75 as const

export interface GateV2Score {
  code: number
  rule: number
  model: number
  weighted: number
  /** 是否达到 P2 参考线 (0.75, StoryForge) — 仅参考, 非硬门 */
  referencePass: boolean
}

/**
 * Gate v2 加权合成 (StoryForge GateScore::new)。
 * 三级 grader 分数均 0..1。weighted = 0.2*code + 0.3*rule + 0.5*model。
 */
export function gateV2WeightedScore(code: number, rule: number, model: number): GateV2Score {
  const weighted = GATE_V2_WEIGHTS.code * code + GATE_V2_WEIGHTS.rule * rule + GATE_V2_WEIGHTS.model * model
  return {
    code,
    rule,
    model,
    weighted,
    referencePass: weighted >= GATE_V2_PASS_THRESHOLD,
  }
}

// ============================================================================
// reading_power 特征分 (StoryForge graders.rs reading_power_score_of 移植)
// ============================================================================

export type ReadingPowerHookType = "cliffhanger" | "mystery" | "emotional" | "action" | "weak" | "none"

export interface ReadingPowerFeatures {
  isTransition: boolean
  hookType: ReadingPowerHookType
  /** 章末钩子强度 0..1 (映射: transition 0 / cliffhanger+mystery 0.9 / emotional+action 0.6 / 其余 0.3) */
  hookScore: number
  /** 爽点模式命中数 */
  coolpointCount: number
  /** 微兑现命中数 */
  micropayoffCount: number
  /** hook*0.4 + coolpoint*0.3 + micropayoff*0.3, clamp 0..1 */
  readingPowerScore: number
}

/** 章末钩子类型映射 (StoryForge graders.rs:106-110 中文适配) */
export function mapHookTypeToScore(hookType: ReadingPowerHookType, isTransition: boolean): number {
  if (isTransition) return 0
  switch (hookType) {
    case "cliffhanger":
    case "mystery":
      return 0.9
    case "emotional":
    case "action":
      return 0.6
    default:
      return 0.3
  }
}

/** 章末钩子正则: 以悬念/疑问/未决收尾 */
const CLIFFHANGER_PATTERNS: RegExp[] = [
  /(?<!。)[。！]?\s*(?:就在|突然|这时|却|然而|但|就在这时)[^。！]{0,20}?(?:……|\.\.\.|？！|$)/,
  /[^。！？]{0,15}(?:是谁|为什么|到底是什么|究竟是|难道)[^。！？]{0,15}[？?!！]/,
  /(?:……|\.\.\.)[^。！\n]{0,30}$/,
]

/** 过渡章判定: 无对话 + 无冲突词 (长度不作为硬判据 — 片段测试友好) */
function detectTransition(content: string): boolean {
  const trimmed = content.trim()
  const hasDialogue = /[""「」『』'']/.test(trimmed)
  const hasConflict = /(冲突|对峙|爆发|决战|反杀|危机|阴谋|背叛|真相)/.test(trimmed)
  return !hasDialogue && !hasConflict
}

/** 章末 200 字内钩子检测 */
function detectHookType(content: string): ReadingPowerHookType {
  const tail = content.slice(-200)
  if (CLIFFHANGER_PATTERNS.some((p) => p.test(tail))) return "cliffhanger"
  if (/(悬念|谜|秘密|未知|伏笔|真相|为何|究竟)/.test(tail)) return "mystery"
  if (/(震撼|泪目|感动|心碎|狂喜|怒|悲|恨)/.test(tail)) return "emotional"
  if (/(战斗|出手|斩杀|逃脱|危机|爆发|追逐)/.test(tail)) return "action"
  return "weak"
}

/** 爽点模式词表 (coolpoint) — 全局标志供重复计数 */
const COOLPOINT_PATTERNS: RegExp[] = [
  /打脸|反杀|碾压|逆转|震惊全场|霸气|王炸|装逼|爆表|无敌|扮猪吃虎/g,
  /实力碾压|一鸣惊人|技惊四座|全场哗然|瞠目结舌/g,
]

/** 微兑现词表 (micropayoff) — 全局标志供重复计数 */
const MICROPAYOFF_PATTERNS: RegExp[] = [
  /兑现|回应|报应|付出代价|因果|宿命/g,
  /报仇|雪恨|翻盘|守得云开|苦尽甘来/g,
  /伏笔.*回收|线索.*闭环|埋的.*揭晓/g,
]

function countPatternHits(content: string, patterns: readonly RegExp[]): number {
  return patterns.reduce((sum, p) => {
    // matchAll 需要全局标志; 无 g 时退化用 match 计数 (只计首命中) 或手动扫描
    if (p.global) {
      return sum + (Array.from(content.matchAll(p)).length)
    }
    const matches = content.match(p)
    return sum + (matches ? matches.length : 0)
  }, 0)
}

/**
 * 纯规则 reading_power 特征分 (StoryForge ContentFeatureExtractor 中文适配)。
 * coolpoint +0.1/命中 上限 0.8; micropayoff +0.1/命中 上限 0.4 (graders.rs:112-115)。
 */
export function extractReadingPowerFeatures(content: string): ReadingPowerFeatures {
  const isTransition = detectTransition(content)
  const hookType = isTransition ? "none" : detectHookType(content)
  const hookScore = mapHookTypeToScore(hookType, isTransition)
  const coolpointCount = countPatternHits(content, COOLPOINT_PATTERNS)
  const micropayoffCount = countPatternHits(content, MICROPAYOFF_PATTERNS)
  const coolpoint = Math.min(coolpointCount * 0.1, 0.8)
  const micropayoff = Math.min(micropayoffCount * 0.1, 0.4)
  const readingPowerScore = Math.min(1, Math.max(0, hookScore * 0.4 + coolpoint * 0.3 + micropayoff * 0.3))
  return {
    isTransition,
    hookType,
    hookScore,
    coolpointCount,
    micropayoffCount,
    readingPowerScore,
  }
}

// ============================================================================
// P2 参考分合成 (仅参考, 不覆盖 P0)
// ============================================================================

export interface P2ReferenceScoreInput {
  /** Gate v2 三级分 (code=机械, rule=规则, model=LLM 评分) */
  gate?: { code: number; rule: number; model: number }
  /** 正文文本 (reading_power 特征提取) */
  content: string
}

export interface P2ReferenceScore {
  /** Gate v2 加权 (0.2/0.3/0.5) */
  gateV2?: GateV2Score
  /** reading_power 特征分 */
  readingPower: ReadingPowerFeatures
  /** 综合 P2 参考分 0..1 (gate*0.5 + reading_power*0.5, StoryForge graders.rs:129) */
  referenceScore: number
  /** 约束声明: 本分仅 P2 参考, P0 (consistency) 失败时须无视 */
  p0OverrideGuard: "P2 reference only — never overrides P0 consistency gate"
}

/**
 * 构建 P2 参考分。注意: 返回值带 p0OverrideGuard 契约, 调用方必须遵守
 * P0>P1>P2 门控语义 — 本函数不判定任何 gate, 纯参考分合成。
 */
export function buildP2ReferenceScore(input: P2ReferenceScoreInput): P2ReferenceScore {
  const readingPower = extractReadingPowerFeatures(input.content)
  const gateV2 = input.gate ? gateV2WeightedScore(input.gate.code, input.gate.rule, input.gate.model) : undefined
  const referenceScore = gateV2
    ? Math.min(1, Math.max(0, gateV2.weighted * 0.5 + readingPower.readingPowerScore * 0.5))
    : readingPower.readingPowerScore
  return {
    gateV2,
    readingPower,
    referenceScore,
    p0OverrideGuard: "P2 reference only — never overrides P0 consistency gate",
  }
}

/** 渲染 P2 参考分摘要 (诊断用, 非 gate 判定) */
export function formatP2ReferenceScore(score: P2ReferenceScore): string {
  const gate = score.gateV2
    ? `gateV2=${score.gateV2.weighted.toFixed(2)}(${score.gateV2.code.toFixed(1)}/${score.gateV2.rule.toFixed(1)}/${score.gateV2.model.toFixed(1)})`
    : "gateV2=n/a"
  const rp = score.readingPower
  return [
    `P2参考=${score.referenceScore.toFixed(2)}`,
    gate,
    `readingPower=${rp.readingPowerScore.toFixed(2)}`,
    `hook=${rp.hookType}(${rp.hookScore.toFixed(1)})`,
    `coolpoint=${rp.coolpointCount} micropayoff=${rp.micropayoffCount}`,
    rp.isTransition ? "transition" : "",
  ].filter(Boolean).join(" ")
}
