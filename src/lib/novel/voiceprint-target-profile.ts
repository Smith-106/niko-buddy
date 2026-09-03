/**
 * 53 号报告 P1-1: 中文 per-1k 目标作者声纹画像 + 欠靶恢复 (fiction-forge
 * voice-matching 模式, MIT 借模式; QMAI 中文适配, 纯函数零 IO 零 LLM)。
 *
 * 语义 (对齐 fiction-forge docs/voice-matching.md):
 *  - per-1k 度量 = 每千字出现次数 (count / (总字数/1000));
 *  - 双向 diff: 欠靶 (under-target) 只能靠恢复 (restoration) 不能靠删减;
 *    超靶 (over-target) 用替换/收敛指令;
 *  - word-count-neutral ±5% 硬守卫: 改写不得显著改变篇幅;
 *  - 小样本噪声守卫: 章字数 < minSampleChars 时跳过欠靶判定
 *    (镜像 voice-matching「Small numbers are noise」)。
 *
 * 与 de-ai-intensity weightedPerK 的关系: de-ai 度量管「AI 味密度删减」,
 * 本模块管「作者声纹欠靶恢复」— 两套口径独立 (度量词表与检测词表刻意分离),
 * 冲突时以 Anti-AI(P1) 残留率为准 (门控优先级 Consistency > Anti-AI > Quality)。
 */

/** 单度量 per-1k 画像 (每千字率)。 */
export interface Per1kMetric {
  metric: Per1kMetricKey
  /** 每千字出现次数 */
  perK: number
}

/** 度量键 (10 项, 中文适配 fiction-forge 四组 + 中文等价扩展)。 */
export type Per1kMetricKey =
  | "sentence_initial_negation" // 句首否定片段 (不是…而是/并非/没有…只有)
  | "dash_density" // 破折号 ——
  | "abstract_crutch" // 抽象拐杖 (仿佛/似乎/缓缓/某种…的感觉)
  | "adverb_complement" // 副词补语结构 (地/得)
  | "simile_density" // 比喻 (像/如同/宛如/好似)
  | "short_sentence_ratio" // 短句占比 (≤8 字)
  | "long_sentence_ratio" // 长句占比 (>40 字)
  | "mean_sentence_length" // 平均句长 (字)
  | "dialogue_ratio" // 对话占比 (引号内字数)
  | "body_language_verbs" // 身体语言动词 (点头/摇头/耸肩/低头 等平实动作)

/** 目标画像: 每度量目标每千字率 + 偏差判定阈值。 */
export interface Per1kTargetProfile {
  /** 度量 → 目标 per-1k 值 (缺省维度不检测)。 */
  targets: Partial<Record<Per1kMetricKey, number>>
  /** 判定「欠靶/超靶」的相对偏差阈值 (默认 0.25 = ±25% 内视为达标)。 */
  tolerance?: number
  /** 小样本噪声守卫: 少于该字数的文本跳过欠靶判定 (默认 500)。 */
  minSampleChars?: number
  /** 恢复指令风格附加 (可选, 追加到 buildRecoveryDirectives 输出)。 */
  extraDirectives?: string[]
}

/** 单度量 diff: 当前值 vs 目标值, over/under 分类。 */
export interface Per1kDiff {
  metric: Per1kMetricKey
  /** 当前 per-1k 值 */
  currentPerK: number
  /** 目标 per-1k 值 (undefined = 未配置目标) */
  targetPerK?: number
  /** 相对偏差 (current-target)/target */
  ratio: number
  /** under = 欠靶 (需恢复), over = 超靶 (需收敛), ok = 达标, untargeted = 未配置 */
  status: "under" | "over" | "ok" | "untargeted"
}

/** 恢复指令输出。 */
export interface RecoveryDirectives {
  /** 欠靶恢复指令 (每度量一条, 含数值目标)。 */
  restoration: string[]
  /** 超靶收敛指令 (每度量一条)。 */
  convergence: string[]
  /** word-count-neutral 守卫句 (恒存在)。 */
  wordCountGuard: string
  /** 组装后的单段文本 (供 prompt 注入)。 */
  text: string
}

const SENTENCE_BOUNDARY = /(?<=[。！？!?；;…\n])/g

/** 切句 (中文标点边界)。 */
export function splitSentences(text: string): string[] {
  if (!text) return []
  return text
    .split(SENTENCE_BOUNDARY)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** 中文字数 (排除空白与标点)。 */
export function countHanChars(text: string): number {
  const matches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g)
  return matches ? matches.length : 0
}

const METRIC_PATTERNS: Record<Exclude<Per1kMetricKey, "short_sentence_ratio" | "long_sentence_ratio" | "mean_sentence_length" | "dialogue_ratio">, RegExp> = {
  sentence_initial_negation: /(?:不是…而是|并非|没有…只有|不只是|不是没|绝无可能|毫不|从未)/g,
  dash_density: /——/g,
  abstract_crutch: /(?:仿佛|似乎|缓缓|某种…的感觉|隐约|依稀|宛若|宛如|好似)/g,
  adverb_complement: /(?:地|得)(?=[\u4e00-\u9fff]{1,6}(?:[，。！？；]|$))/g,
  simile_density: /(?:像|如同|宛如|好似|犹如)(?=[\u4e00-\u9fff])/g,
  body_language_verbs: /(?:点头|摇头|耸肩|低头|抬头|皱眉|闭眼|睁眼|攥紧|握拳|咬牙|抿唇|转身|踱步|坐直)/g,
}

/**
 * measurePer1kProfile: 计算文本的 per-1k 度量画像 (10 项)。
 * 分母 = 中文字数/1000 (fiction-forge count/(words/1000) 公式)。
 */
export function measurePer1kProfile(text: string): Per1kMetric[] {
  const hanChars = countHanChars(text)
  if (hanChars === 0) return []
  const perK = (count: number) => (count / (hanChars / 1000))
  const sentences = splitSentences(text)
  const sentenceCount = Math.max(sentences.length, 1)
  const shortSentences = sentences.filter((s) => countHanChars(s) <= 8).length
  const longSentences = sentences.filter((s) => countHanChars(s) > 40).length
  const meanLen = Math.round(countHanChars(text) / sentenceCount * 10) / 10
  // 对话占比: 引号内中文字数 / 总中文字数
  const quoted = text.match(/[“"“”'][^“"”']*[”"“”']/g) ?? []
  const dialogueChars = quoted.reduce((acc, q) => acc + countHanChars(q), 0)
  const dialogueRatio = Math.round((dialogueChars / Math.max(hanChars, 1)) * 1000) / 1000
  const result: Per1kMetric[] = [
    { metric: "sentence_initial_negation", perK: 0 },
    { metric: "dash_density", perK: 0 },
    { metric: "abstract_crutch", perK: 0 },
    { metric: "adverb_complement", perK: 0 },
    { metric: "simile_density", perK: 0 },
    { metric: "short_sentence_ratio", perK: 0 },
    { metric: "long_sentence_ratio", perK: 0 },
    { metric: "mean_sentence_length", perK: 0 },
    { metric: "dialogue_ratio", perK: 0 },
    { metric: "body_language_verbs", perK: 0 },
  ]
  const setMetric = (metric: Per1kMetricKey, value: number) => {
    const slot = result.find((m) => m.metric === metric)
    if (slot) slot.perK = Math.round(value * 10) / 10
  }
  for (const [key, re] of Object.entries(METRIC_PATTERNS) as Array<[Per1kMetricKey, RegExp]>) {
    re.lastIndex = 0
    setMetric(key, perK((text.match(new RegExp(re.source, "g")) ?? []).length))
  }
  setMetric("short_sentence_ratio", perK(shortSentences))
  setMetric("long_sentence_ratio", perK(longSentences))
  setMetric("mean_sentence_length", meanLen * 1000)
  setMetric("dialogue_ratio", dialogueRatio)
  return result
}

/**
 * diffPer1kProfile: 当前画像 vs 目标画像 → 每度量 diff。
 * 未配置目标的度量 → untargeted (不参与恢复判定)。
 */
export function diffPer1kProfile(
  current: readonly Per1kMetric[],
  target: Per1kTargetProfile,
): Per1kDiff[] {
  const currentMap = new Map(current.map((m) => [m.metric, m.perK]))
  const tolerance = target.tolerance ?? 0.25
  const diffs: Per1kDiff[] = []
  for (const [metric, targetPerK] of Object.entries(target.targets) as Array<[Per1kMetricKey, number]>) {
    const currentPerK = currentMap.get(metric) ?? 0
    const ratio = targetPerK > 0 ? (currentPerK - targetPerK) / targetPerK : 0
    let status: Per1kDiff["status"] = "ok"
    if (targetPerK > 0 && currentPerK > 0) {
      if (currentPerK < targetPerK * (1 - tolerance)) status = "under"
      else if (currentPerK > targetPerK * (1 + tolerance)) status = "over"
    } else if (targetPerK > 0 && currentPerK === 0) {
      status = "under"
    }
    diffs.push({ metric, currentPerK, targetPerK, ratio, status })
  }
  return diffs
}

const METRIC_LABELS: Record<Per1kMetricKey, string> = {
  sentence_initial_negation: "句首否定片段",
  dash_density: "破折号",
  abstract_crutch: "抽象拐杖词",
  adverb_complement: "副词补语",
  simile_density: "比喻",
  short_sentence_ratio: "短句占比",
  long_sentence_ratio: "长句占比",
  mean_sentence_length: "平均句长",
  dialogue_ratio: "对话占比",
  body_language_verbs: "身体语言动词",
}

const RECOVERY_EXAMPLES: Partial<Record<Per1kMetricKey, string>> = {
  sentence_initial_negation: "如「不是…而是…」「并非…」",
  dash_density: "用「——」插入补足语",
  abstract_crutch: "恢复「仿佛/似乎/缓缓」等口语化缓滞词",
  adverb_complement: "恢复「地/得」补语结构做节奏",
  simile_density: "恢复「像/如同/宛如」比喻",
  body_language_verbs: "恢复「点头/低头/攥紧」等平实身体动作描写",
}

/**
 * buildRecoveryDirectives: 由 diff 组装恢复/收敛指令。
 *  - 欠靶 (under) → 恢复指令: 恢复对应风格特征 + 数值目标
 *  - 超靶 (over) → 收敛指令: 降低对应特征密度
 *  - word-count-neutral ±5% 守卫句恒在
 *  - 小样本守卫由 caller 提前按 minSampleChars 跳过 (本函数不读正文)
 */
export function buildRecoveryDirectives(diffs: readonly Per1kDiff[]): RecoveryDirectives {
  const restoration: string[] = []
  const convergence: string[] = []
  for (const d of diffs) {
    const label = METRIC_LABELS[d.metric] ?? d.metric
    if (d.status === "under" && d.targetPerK !== undefined) {
      const example = RECOVERY_EXAMPLES[d.metric]
      restoration.push(
        `欠靶恢复·${label}：当前约 ${d.currentPerK}/${d.targetPerK} 每千字，恢复到目标密度${example ? `（${example}）` : ""}。`,
      )
    } else if (d.status === "over" && d.targetPerK !== undefined) {
      convergence.push(`超靶收敛·${label}：当前约 ${d.currentPerK}/${d.targetPerK} 每千字，降低至目标密度附近。`)
    }
  }
  const wordCountGuard = "篇幅守卫：改写前后总字数变化必须控制在 ±5% 以内（" +
    "If a chapter comes back 15% shorter, you did it wrong）。"
  const text = [wordCountGuard, ...restoration, ...convergence].join("\n")
  return { restoration, convergence, wordCountGuard, text }
}

/**
 * checkPer1kRecovery: 改写前后欠靶度量恢复方向判定 (纯函数)。
 * 欠靶度量 after 比 before 更接近 target → 恢复成功; 否则 stalled。
 * 与 checkVoiceprintConvergence (防漂移) 正交: 本函数管欠靶补回。
 */
export function checkPer1kRecovery(
  before: readonly Per1kMetric[],
  after: readonly Per1kMetric[],
  target: Per1kTargetProfile,
): { metric: Per1kMetricKey; recovered: boolean; beforePerK: number; afterPerK: number }[] {
  const beforeMap = new Map(before.map((m) => [m.metric, m.perK]))
  const afterMap = new Map(after.map((m) => [m.metric, m.perK]))
  const results: { metric: Per1kMetricKey; recovered: boolean; beforePerK: number; afterPerK: number }[] = []
  const initial = diffPer1kProfile(before, target)
  for (const d of initial) {
    if (d.status !== "under") continue
    const afterPerK = afterMap.get(d.metric) ?? 0
    const beforePerK = beforeMap.get(d.metric) ?? 0
    const targetPerK = d.targetPerK ?? 0
    const beforeGap = Math.abs(beforePerK - targetPerK)
    const afterGap = Math.abs(afterPerK - targetPerK)
    results.push({
      metric: d.metric,
      recovered: afterGap < beforeGap,
      beforePerK,
      afterPerK,
    })
  }
  return results
}

/** 小样本守卫: 文本中文字数 < minSampleChars 时跳过欠靶判定。 */
export function isSmallSample(text: string, minSampleChars = 500): boolean {
  return countHanChars(text) < minSampleChars
}

/**
 * appendRecoveryDirectives (53 号报告 P1-1 接线): 在 de-ai 改写 prompt fragment
 * 尾部追加欠靶恢复指令 (纯函数)。
 *  - targetProfile 未配置 → 返回原 fragment 逐字节不变 (零行为变更);
 *  - 小样本 (字数 < minSampleChars) → 跳过恢复指令 (噪声守卫);
 *  - 恢复指令只进 prompt 不进门控 (Draft-first); 冲突时 de-ai 删减优先
 *    (调用方以 runDeAiDualPass 残留率复查为准, 门控优先级 Anti-AI > Quality)。
 */
export function appendRecoveryDirectives(
  fragment: string,
  content: string,
  targetProfile?: Per1kTargetProfile,
): string {
  if (!targetProfile) return fragment
  if (isSmallSample(content, targetProfile.minSampleChars ?? 500)) return fragment
  const profile = measurePer1kProfile(content)
  const diff = diffPer1kProfile(profile, targetProfile)
  const underTargets = diff.filter((d) => d.status === "under")
  if (underTargets.length === 0) return fragment
  const directives = buildRecoveryDirectives(diff)
  return `${fragment}\n\n## 作者声纹恢复（目标画像）\n${directives.text}`
}
