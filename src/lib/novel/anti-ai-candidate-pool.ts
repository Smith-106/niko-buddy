/**
 * anti-ai-candidate-pool.ts — TASK-P2-19 (T19) 反AI 候选池 + 四统计因子检测器
 *
 * 目的:
 *   构建中文人写语料候选池 (synthetic-degraded 种子语料) 并做 mutation testing,
 *   实现四统计因子候选检测器 (n-gram 重合度 / 句式熵 / 标点指纹 / 段落长度分布),
 *   标定前只 warn 不 block。
 *
 * 门控优先级: Consistency(P0) > Anti-AI(P1) > Quality(P2)。
 *   warn 态不阻塞主链, 仅注入审查参考。
 *
 * 语料源 (synthetic-degraded):
 *   docs/p0/corpus/{human,ai,gold}/batch-20260821-001/
 *   66 条 manifest (human 30 + ai 30 + gold 6)。
 *   标定结论标记基于 synthetic-degraded (非真实采集)。
 *
 * 使用方式:
 *   const pool = new AntiAiCandidatePool()
 *   await pool.loadCorpus()              // 加载语料
 *   const report = pool.analyze(text)    // 四因子检测, 返回 warn 信息
 *   const mutation = pool.mutateTest(text) // mutation testing
 *
 * 四个统计因子:
 *   nGramOverlap      — 语料 n-gram 重合度 (AI 候选池句级 3-gram)
 *   sentenceEntropy   — 句长熵 (句式多样性)
 *   punctuationFingerprint — 标点使用模式指纹
 *   paragraphLengthDist    — 段落长度分布 (CV)
 */

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// ============================================================================
// 类型定义
// ============================================================================

/** 单个语料样本 */
export interface CorpusSample {
  file: string
  genre: string
  layer: "human" | "ai" | "gold"
  text: string
  words: number
  source: string
  batchId: string
}

/** 语料库加载结果 */
export interface CorpusLoadResult {
  human: CorpusSample[]
  ai: CorpusSample[]
  gold: CorpusSample[]
  total: number
  source: string
}

/** 四统计因子检测报告 (单项) */
export interface StatisticalFactorReport {
  /** 因子名 */
  factor: string
  /** 检测值 */
  value: number
  /** 阈值 (超过此值触发 warn) */
  threshold: number
  /** 是否触发警告 */
  warn: boolean
  /** 描述 */
  description: string
  /** 值量纲 (sentenceEntropy = "normalized"; 其余因子缺省历史语义) */
  unit?: "bits" | "normalized"
  /** 原始量纲值 (sentenceEntropy: raw bits), 调试对拍用 */
  rawValue?: number
  /** 句长分桶观测桶数 K (sentenceEntropy 调试字段; 归一化分母 = log2(K)) */
  bucketCount?: number
}

/** 完整分析报告 */
export interface AntiAiAnalysisReport {
  /** 四因子检测结果 */
  factors: StatisticalFactorReport[]
  /** 是否触发任何警告 */
  hasWarnings: boolean
  /** 警告总数 */
  warningCount: number
  /** 综合建议 */
  summary: string
  /** 标定语料来源 */
  calibrationSource: string
}

/** Mutation testing 结果 */
export interface MutationTestResult {
  /** 原始文本 */
  originalText: string
  /** 变异文本 */
  mutatedText: string
  /** 变异类型 */
  mutationType: string
  /** 原始分析报告 */
  originalReport: AntiAiAnalysisReport
  /** 变异后分析报告 */
  mutatedReport: AntiAiAnalysisReport
  /** 检测器是否区分 (true = good, false = 检测器不敏感) */
  discriminates: boolean
}

// ============================================================================
// 默认路径 (import.meta.url 兼容 renderer 直连)
// ============================================================================

/**
 * 语料根目录 (相对于项目根 niko-hub)。
 * 使用 import.meta.url 解析，兼容 renderer bundle 直连。
 * 可通过构造参数覆盖。
 */
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * 语料根目录 (相对于项目根 niko-hub)。
 * 使用 import.meta.url 代替 __dirname，兼容 renderer bundle 直连。
 * 可通过构造参数覆盖。
 */
const DEFAULT_CORPUS_ROOT = resolve(__dirname, "../../../../docs/p0/corpus")

// ============================================================================
// 文本工具函数
// ============================================================================

/** 按句号/问号/感叹号/省略号分句 */
function splitSentences(text: string): string[] {
  if (!text || text.trim().length === 0) return []
  return text.split(/[。！？!?.…]+/).map((s) => s.trim()).filter((s) => s.length > 0)
}

/** 按换行分段落 */
function splitParagraphs(text: string): string[] {
  if (!text || text.trim().length === 0) return []
  return text.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0)
}

/** 提取 n-gram (句级词语) — 按标点/空格/换行分割 tokens */
function tokenize(text: string): string[] {
  return text.split(/[，。！？、；：""''（）\s\n]+/).filter((t) => t.length > 0)
}

/** 提取句级 word n-gram */
function extractWordNGrams(tokens: string[], n: number): string[] {
  const ngrams: string[] = []
  for (let i = 0; i <= tokens.length - n; i++) {
    ngrams.push(tokens.slice(i, i + n).join(""))
  }
  return ngrams
}

/** 计算均值 */
function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

/** 计算标准差 */
function stddev(values: number[]): number {
  if (values.length === 0) return 0
  const m = mean(values)
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

/** 计算变异系数 CV = stddev / mean */
function coefficientOfVariation(values: number[]): number {
  const m = mean(values)
  if (m === 0) return 0
  return stddev(values) / m
}

/** 计算熵 (shannon entropy, 以 bits 为单位) */
function entropy(counts: Record<string, number>, total: number): number {
  if (total === 0) return 0
  let h = 0
  for (const c of Object.values(counts)) {
    const p = c / total
    if (p > 0) h -= p * Math.log2(p)
  }
  return h
}

// ============================================================================
// 语料加载
// ============================================================================

/**
 * 从语料目录加载某层 (human/ai/gold) 的样本。
 * 每批格式: {layer}/batch-{id}/{genre}-NNN.txt
 */
function loadCorpusLayer(
  corpusRoot: string,
  layer: "human" | "ai" | "gold",
  batchId: string,
): CorpusSample[] {
  const layerDir = resolve(corpusRoot, layer, `batch-${batchId}`)
  if (!existsSync(layerDir)) {
    console.warn(`[anti-ai-candidate-pool] 语料层目录不存在: ${layerDir}`)
    return []
  }

  const files = readdirSync(layerDir).filter((f) => f.endsWith(".txt") || f.endsWith(".json"))
  const samples: CorpusSample[] = []

  for (const file of files) {
    const filePath = resolve(layerDir, file)
    try {
      const text = readFileSync(filePath, "utf-8")
      // 跳过 JSON 金标准 (structure-only, 不能用作文本分析)
      if (file.endsWith(".json")) continue
      // 提取 genre 从文件名: {genre}-NNN.txt
      const genreMatch = file.match(/^([a-z]+)-\d+/)
      const genre = genreMatch ? genreMatch[1] : "unknown"
      // 粗略字数
      const words = text.replace(/\s+/g, "").length

      samples.push({
        file,
        genre,
        layer,
        text,
        words,
        source: "synthetic-degraded",
        batchId,
      })
    } catch {
      console.warn(`[anti-ai-candidate-pool] 读取失败: ${filePath}`)
    }
  }

  return samples
}

// ============================================================================
// 候选池类
// ============================================================================

export class AntiAiCandidatePool {
  /** 人写语料 */
  humanCorpus: CorpusSample[] = []
  /** AI 生成语料 */
  aiCorpus: CorpusSample[] = []
  /** 黄金标准 (标注数据) */
  goldCorpus: CorpusSample[] = []
  /** 是否已加载 */
  loaded = false
  /** 语料根目录 */
  corpusRoot: string
  /** 批次 ID */
  batchId: string
  /** 语料来源描述 */
  source: string

  /** AI 语料 3-gram 索引 (句级) */
  private ai3GramIndex: Map<string, number> = new Map()
  /** AI 语料 3-gram 总数 */
  private ai3GramTotal = 0
  /** 人写语料 3-gram 索引 */
  private human3GramIndex: Map<string, number> = new Map()
  /** 人写语料 3-gram 总数 */
  private human3GramTotal = 0

  /** AI 语料标点指纹 (均值) */
  private aiPunctuationFingerprint: Record<string, number> = {}
  /** 人写语料标点指纹 (均值) */
  private humanPunctuationFingerprint: Record<string, number> = {}

  constructor(corpusRoot?: string, batchId = "20260821-001") {
    this.corpusRoot = corpusRoot ?? DEFAULT_CORPUS_ROOT
    this.batchId = batchId
    this.source = "synthetic-degraded"
  }

  /**
   * 加载语料并构建索引。
   * 默认加载 batch-20260821-001。
   * 返回加载统计。
   */
  loadCorpus(): CorpusLoadResult {
    this.humanCorpus = loadCorpusLayer(this.corpusRoot, "human", this.batchId)
    this.aiCorpus = loadCorpusLayer(this.corpusRoot, "ai", this.batchId)
    this.goldCorpus = loadCorpusLayer(this.corpusRoot, "gold", this.batchId)

    this.buildIndexes()
    this.loaded = true

    return {
      human: this.humanCorpus,
      ai: this.aiCorpus,
      gold: this.goldCorpus,
      total: this.humanCorpus.length + this.aiCorpus.length + this.goldCorpus.length,
      source: this.source,
    }
  }

  /**
   * 构建 n-gram 索引与统计指纹。
   * 在 loadCorpus 后自动调用。
   */
  private buildIndexes(): void {
    // AI 3-gram 索引
    this.ai3GramIndex = new Map()
    this.ai3GramTotal = 0
    for (const sample of this.aiCorpus) {
      const tokens = tokenize(sample.text)
      const ngrams = extractWordNGrams(tokens, 3)
      for (const ng of ngrams) {
        this.ai3GramIndex.set(ng, (this.ai3GramIndex.get(ng) || 0) + 1)
        this.ai3GramTotal++
      }
    }

    // 人写 3-gram 索引
    this.human3GramIndex = new Map()
    this.human3GramTotal = 0
    for (const sample of this.humanCorpus) {
      const tokens = tokenize(sample.text)
      const ngrams = extractWordNGrams(tokens, 3)
      for (const ng of ngrams) {
        this.human3GramIndex.set(ng, (this.human3GramIndex.get(ng) || 0) + 1)
        this.human3GramTotal++
      }
    }

    // 标点指纹
    this.aiPunctuationFingerprint = this.computeCorpusPunctuationFingerprint(this.aiCorpus)
    this.humanPunctuationFingerprint = this.computeCorpusPunctuationFingerprint(this.humanCorpus)
  }

  /**
   * 计算语料库标点指纹 (各标点出现频率)。
   * 标点集: , 。！？、；：""''…—·～
   */
  private computeCorpusPunctuationFingerprint(
    corpus: CorpusSample[],
  ): Record<string, number> {
    const punctuationChars = "，。！？、；：\u201c\u201d''…—·～"
    const totalCounts: Record<string, number> = {}
    let totalPunct = 0

    for (const sample of corpus) {
      for (const ch of sample.text) {
        if (punctuationChars.includes(ch)) {
          totalCounts[ch] = (totalCounts[ch] || 0) + 1
          totalPunct++
        }
      }
    }

    const fingerprint: Record<string, number> = {}
    for (const [ch, count] of Object.entries(totalCounts)) {
      fingerprint[ch] = totalPunct > 0 ? count / totalPunct : 0
    }
    return fingerprint
  }

  // ==========================================================================
  // 四统计因子检测器
  // ==========================================================================

  /**
   * 检测器 1: n-gram 重合度 (nGramOverlap)
   *
   * 计算输入文本的句级 3-gram 与 AI 语料 3-gram 索引的重合度。
   * 重合度 = 命中 AI 3-gram 数 / 总 3-gram 数。
   * 阈值: >40% 触发 warn (基于 synthetic-degraded 语料标定)。
   *
   * 标定 (synthetic-degraded): AI 语料 self-3gram 重合度 ~60-80%,
   * 人写语料对 AI 3-gram 重合度 ~15-30%。阈值 40% 为保守中间值。
   */
  detectNGramOverlap(text: string): StatisticalFactorReport {
    const tokens = tokenize(text)
    const ngrams = extractWordNGrams(tokens, 3)
    if (ngrams.length === 0) {
      return {
        factor: "nGramOverlap",
        value: 0,
        threshold: 0.4,
        warn: false,
        description: "文本过短, 无法计算 n-gram 重合度",
      }
    }

    let hits = 0
    for (const ng of ngrams) {
      if (this.ai3GramIndex.has(ng)) hits++
    }
    const overlap = hits / ngrams.length

    // 同时计算人写重合度作为参照
    let humanHits = 0
    for (const ng of ngrams) {
      if (this.human3GramIndex.has(ng)) humanHits++
    }
    const humanOverlap = humanHits / ngrams.length

    const warn = overlap > 0.4 && overlap > humanOverlap * 1.5

    return {
      factor: "nGramOverlap",
      value: overlap,
      threshold: 0.4,
      warn,
      description: `AI 3-gram 重合度 ${(overlap * 100).toFixed(1)}% (人写参照 ${(humanOverlap * 100).toFixed(1)}%), 阈值 >40% 且显著高于人写参照时 warn`,
    }
  }

  /**
   * 检测器 2: 句式熵 (sentenceEntropy)
   *
   * 计算句长分布 Shannon 熵并按观测桶数归一化 (归一化熵 = rawEntropy / log2(桶数))。
   * 归一化消除桶数对原始比特线的支配: 中文句长普遍落在 ≤10 个 5 字符桶,
   * log2(K)≤3.32 恒低于旧 raw<3.5 线 → 旧实现对任意 ≥8 句中文文本必然误报 warn。
   * 阈值: 归一化熵 <0.7 触发 warn; <8 句跳过。
   *
   * 标定: synthetic-degraded 认证链口径 (anti-ai-calibration.md 判据表)。
   * 2026-08-23 三模型共识裁决 A: TS 对齐 .mjs 唯一实现 (修实现缺陷, 非重标定)。
   */
  detectSentenceEntropy(text: string): StatisticalFactorReport {
    const sentences = splitSentences(text)
    if (sentences.length < 8) {
      return {
        factor: "sentenceEntropy",
        value: 0,
        threshold: 0.7,
        warn: false,
        unit: "normalized",
        rawValue: 0,
        bucketCount: 0,
        description: "句数过少 (<8), 无法计算有意义的句式熵",
      }
    }

    // 句长分桶 (每 5 字符一桶)
    const buckets: Record<string, number> = {}
    for (const s of sentences) {
      const bucket = Math.floor(s.length / 5) * 5
      const key = `${bucket}-${bucket + 4}`
      buckets[key] = (buckets[key] || 0) + 1
    }

    const ent = entropy(buckets, sentences.length)
    const bucketCount = Object.keys(buckets).length
    const maxEnt = Math.log2(bucketCount)
    const normalized = maxEnt > 0 ? ent / maxEnt : 0

    // 归一化判定线 —— 与 scripts/lib/anti-ai-factors.mjs 唯一实现同语义
    const warn = normalized < 0.7

    return {
      factor: "sentenceEntropy",
      value: normalized,
      threshold: 0.7,
      warn,
      unit: "normalized",
      rawValue: ent,
      bucketCount,
      description: `句长分布归一化熵 ${normalized.toFixed(3)} (<0.7 触发 warn; 原始熵 ${ent.toFixed(2)} bits / 上限 log2(K=${bucketCount})=${maxEnt.toFixed(2)}, ${sentences.length} 句)`,
    }
  }

  /**
   * 检测器 3: 标点指纹 (punctuationFingerprint)
   *
   * 计算文本标点分布与 AI 语料标点指纹的偏离度 (余弦距离)。
   * 偏离度低 (接近 AI 指纹) → 提示 AI 生成。
   * 阈值: >0.85 余弦相似度触发 warn。
   *
   * 标定 (synthetic-degraded): AI 语料 self-指纹余弦 ~0.95-1.0,
   * 人写语料对 AI 指纹余弦 ~0.4-0.7。阈值 0.85 为保守值。
   */
  detectPunctuationFingerprint(text: string): StatisticalFactorReport {
    const punctuationChars = "，。！？、；：\u201c\u201d''…—·～"
    const punctCounts: Record<string, number> = {}
    let totalPunct = 0

    for (const ch of text) {
      if (punctuationChars.includes(ch)) {
        punctCounts[ch] = (punctCounts[ch] || 0) + 1
        totalPunct++
      }
    }

    if (totalPunct === 0) {
      return {
        factor: "punctuationFingerprint",
        value: 0,
        threshold: 0.85,
        warn: false,
        description: "无标点, 无法计算指纹",
      }
    }

    // 计算余弦相似度 (与 AI 语料指纹)
    const allPunct = punctuationChars.split("")
    let dotProduct = 0
    let aiMag = 0
    let textMag = 0

    for (const ch of allPunct) {
      const aiFreq = this.aiPunctuationFingerprint[ch] ?? 0
      const textFreq = (punctCounts[ch] ?? 0) / totalPunct
      dotProduct += aiFreq * textFreq
      aiMag += aiFreq * aiFreq
      textMag += textFreq * textFreq
    }

    const aiMagSqrt = Math.sqrt(aiMag)
    const textMagSqrt = Math.sqrt(textMag)
    const cosineSimilarity = aiMagSqrt > 0 && textMagSqrt > 0
      ? dotProduct / (aiMagSqrt * textMagSqrt)
      : 0

    // 同时计算与人写指纹的相似度作为参照
    let humanDotProduct = 0
    let humanMag = 0
    for (const ch of allPunct) {
      const humanFreq = this.humanPunctuationFingerprint[ch] ?? 0
      const textFreq = (punctCounts[ch] ?? 0) / totalPunct
      humanDotProduct += humanFreq * textFreq
      humanMag += humanFreq * humanFreq
    }
    const humanMagSqrt = Math.sqrt(humanMag)
    const humanSimilarity = humanMagSqrt > 0 && textMagSqrt > 0
      ? humanDotProduct / (humanMagSqrt * textMagSqrt)
      : 0

    // warn: 接近 AI 指纹且远于人写指纹
    const warn = cosineSimilarity > 0.85 && cosineSimilarity > humanSimilarity * 1.2

    return {
      factor: "punctuationFingerprint",
      value: cosineSimilarity,
      threshold: 0.85,
      warn,
      description: `AI 标点指纹余弦相似度 ${cosineSimilarity.toFixed(3)} (人写参照 ${humanSimilarity.toFixed(3)}), 阈值 >0.85 且高于人写参照时 warn`,
    }
  }

  /**
   * 检测器 4: 段落长度分布 (paragraphLengthDist)
   *
   * 计算段落长度的变异系数 (CV) 并对比 AI 语料段落 CV 范围。
   * CV 过低 (均匀段落) → 提示 AI 模板。
   * 阈值: CV < 0.3 触发 warn (基于 synthetic-degraded 语料标定);
   * 短文本校正: 3-5 段时阈值放宽至 0.35。
   *
   * 标定 (synthetic-degraded): AI 语料段落 CV ~0.15-0.35,
   * 人写语料段落 CV ~0.4-0.8。阈值 0.3 为保守值。
   * 2026-08-23 生产等价单元复测: 人写章节级 CV 中位 ~0.64,
   * 0.30 位于人写分布 <P1 深尾, warn 语义为「均匀性异常」而非判别线;
   * 维持 0.30/0.35 不变 (三模型共识裁决, 见 decision-log 2026-08-22-t01b 追记五)。
   */
  detectParagraphLengthDist(text: string): StatisticalFactorReport {
    const paragraphs = splitParagraphs(text)
    if (paragraphs.length < 3) {
      return {
        factor: "paragraphLengthDist",
        value: 0,
        threshold: 0.3,
        warn: false,
        description: "段落数过少, 无法计算分布",
      }
    }

    const lengths = paragraphs.map((p) => p.length)
    const cv = coefficientOfVariation(lengths)
    const paraMean = mean(lengths)

    // 短文本校正: 3-5 段时阈值放宽至 0.35 —— 与唯一实现 scripts/lib/anti-ai-factors.mjs 对齐
    // (2026-08-23 三模型共识: TS 补齐放宽带消除孪生漂移, 阈值本身不变)
    const plThreshold = paragraphs.length < 5 ? 0.35 : 0.3
    const warn = cv < plThreshold

    return {
      factor: "paragraphLengthDist",
      value: cv,
      threshold: plThreshold,
      warn,
      description: `段落 CV ${cv.toFixed(3)} (${paragraphs.length} 段, 均值 ${paraMean.toFixed(0)} 字符), 阈值 <${plThreshold} 时 warn (段落过于均匀)`,
    }
  }

  /**
   * 全量四因子检测。
   * 不阻塞主链, 仅返回 warn 信息。
   */
  analyze(text: string): AntiAiAnalysisReport {
    if (!this.loaded) {
      return {
        factors: [],
        hasWarnings: false,
        warningCount: 0,
        summary: "语料未加载, 跳过检测",
        calibrationSource: this.source,
      }
    }

    const factors: StatisticalFactorReport[] = [
      this.detectNGramOverlap(text),
      this.detectSentenceEntropy(text),
      this.detectPunctuationFingerprint(text),
      this.detectParagraphLengthDist(text),
    ]

    const warnings = factors.filter((f) => f.warn)
    const hasWarnings = warnings.length > 0

    let summary: string
    if (hasWarnings) {
      const warnList = warnings.map((w) => w.factor).join(", ")
      summary = `[warn] ${warnings.length} 个因子触发警告: ${warnList}。建议审查文本, 但不阻塞。标定基于 ${this.source}。`
    } else {
      summary = `[clean] 四因子检测通过。标定基于 ${this.source}。`
    }

    return {
      factors,
      hasWarnings,
      warningCount: warnings.length,
      summary,
      calibrationSource: this.source,
    }
  }

  // ==========================================================================
  // Mutation Testing
  // ==========================================================================

  /**
   * 对人写语料进行 mutation testing: 注入 AI 腔特征,
   * 验证检测器能区分变异前后。
   *
   * mutation 类型:
   *   - addSummaryClause: 添加总结腔 (显然/事实上/毫无疑问)
   *   - addMechanicalTransition: 添加机械转场 (就在这时/与此同时/紧接着)
   *   - addPsychTemplate: 添加心理描写模板 (心中五味杂陈/不禁感到)
   *   - addPunctuationUniform: 统一标点 (句号为主, 去除其他标点)
   *   - addParagraphUniform: 均匀段落长度
   *   - addAI3Gram: 注入 AI 高频 3-gram
   */
  mutateTest(
    text: string,
    mutationType?: string,
  ): MutationTestResult {
    const originalReport = this.analyze(text)
    const type = mutationType ?? "addSummaryClause"

    let mutatedText = text
    switch (type) {
      case "addSummaryClause": {
        // 在句末添加总结腔
        const sentences = splitSentences(mutatedText)
        if (sentences.length > 0) {
          const lastSentence = sentences[sentences.length - 1]
          mutatedText = mutatedText.replace(
            lastSentence,
            `${lastSentence}显然，这一切都表明了一个事实，毫无疑问。`,
          )
        }
        break
      }
      case "addMechanicalTransition": {
        // 在段落前添加机械转场
        const paragraphs = splitParagraphs(mutatedText)
        if (paragraphs.length > 1) {
          mutatedText = paragraphs.map((p, i) => {
            if (i > 0 && i < paragraphs.length - 1) {
              return `与此同时，${p}`
            }
            return p
          }).join("\n\n")
        }
        break
      }
      case "addPsychTemplate": {
        // 在每个段落后添加心理描写模板
        const paragraphs = splitParagraphs(mutatedText)
        mutatedText = paragraphs.map((p) => {
          return `${p}他不禁感到心中五味杂陈，无法言说的情绪涌上心头。`
        }).join("\n\n")
        break
      }
      case "addPunctuationUniform": {
        // 将非句号标点替换为句号 (统一标点)
        mutatedText = mutatedText.replace(/[，！？、；：]/g, "，").replace(/[？]/g, "。")
        break
      }
      case "addParagraphUniform": {
        // 均匀化段落长度 (每段切成等长)
        const chars = mutatedText.split("")
        const avgLen = Math.floor(chars.length / 3)
        if (avgLen > 10) {
          mutatedText = ""
          for (let i = 0; i < chars.length; i += avgLen) {
            mutatedText += chars.slice(i, i + avgLen).join("") + "\n\n"
          }
        }
        break
      }
      case "addAI3Gram": {
        // 注入 AI 高频 3-gram (从 AI 索引中取前 10 个高频 3-gram)
        const topNGrams = [...this.ai3GramIndex.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([ng]) => ng)
          .filter((ng) => !text.includes(ng))
        if (topNGrams.length > 0) {
          mutatedText = `${mutatedText} ${topNGrams.join("，")}。`
        }
        break
      }
      default:
        break
    }

    const mutatedReport = this.analyze(mutatedText)

    // 检测器是否区分: 变异后 warn 数 > 原始 warn 数
    const discriminates = mutatedReport.warningCount > originalReport.warningCount

    return {
      originalText: text,
      mutatedText,
      mutationType: type,
      originalReport,
      mutatedReport,
      discriminates,
    }
  }

  /**
   * 批量运行 mutation testing 所有人写语料。
   * 返回区分率统计。
   */
  runAllMutationTests(): {
    total: number
    discriminated: number
    rate: number
    results: MutationTestResult[]
  } {
    const mutationTypes = [
      "addSummaryClause",
      "addMechanicalTransition",
      "addPsychTemplate",
      "addPunctuationUniform",
      "addParagraphUniform",
      "addAI3Gram",
    ] as const

    const results: MutationTestResult[] = []

    for (const sample of this.humanCorpus) {
      for (const mType of mutationTypes) {
        const result = this.mutateTest(sample.text, mType)
        results.push(result)
      }
    }

    const discriminated = results.filter((r) => r.discriminates).length

    return {
      total: results.length,
      discriminated,
      rate: results.length > 0 ? discriminated / results.length : 0,
      results,
    }
  }
}

// ============================================================================
// 便捷函数 (无需构造实例即可使用)
// ============================================================================

/**
 * 快速四因子检测 (自动加载语料)。
 * 适合简单调用场景, 首次调用耗时 ~50ms (加载+索引 66 条语料)。
 */
let _defaultPool: AntiAiCandidatePool | null = null

function getDefaultPool(): AntiAiCandidatePool {
  if (!_defaultPool) {
    _defaultPool = new AntiAiCandidatePool()
    _defaultPool.loadCorpus()
  }
  return _defaultPool
}

/**
 * 快速检测文本的 AI 候选特征。
 * 返回四因子分析报告, 只 warn 不 block。
 */
export function quickAntiAiAnalysis(text: string): AntiAiAnalysisReport {
  return getDefaultPool().analyze(text)
}

/**
 * 获取检测报告文本化版本 (供 LLM 审查参考或日志输出)。
 */
export function analysisReportToText(report: AntiAiAnalysisReport): string {
  if (report.factors.length === 0) {
    return report.summary
  }

  const lines: string[] = []
  lines.push(`反AI 四统计因子检测 (${report.calibrationSource})`)
  lines.push(`状态: ${report.hasWarnings ? "[warn] 有警告" : "[ok] 通过"}`)
  lines.push("")

  for (const factor of report.factors) {
    const icon = factor.warn ? "[warn]" : "[ok]"
    lines.push(`- ${icon} ${factor.factor}: ${factor.value.toFixed(3)} (阈值 ${factor.threshold})`)
    lines.push(`  ${factor.description}`)
  }

  lines.push("")
  lines.push(`综合: ${report.summary}`)

  return lines.join("\n")
}