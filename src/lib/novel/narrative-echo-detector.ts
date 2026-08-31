/**
 * narrative-echo-detector.ts — P1-4 跨章回纹 (narrative echo) 检测
 *
 * 共识 (V2-ds structure-repetition / V2-glm 跨章/叙事结构重复 / V1-ds r-echo):
 * 2026 检测前沿 (aigc.md) 指出「长篇叙事模板循环 (回纹)」是双方都未解决的
 * 关键缺口 — 章节级模板 (每章同构的段落节奏/转场密度/句式签名) 是
 * 深度分类器跨章聚类的核心信号。
 *
 * 本模块做确定性结构签名 (零 LLM):
 *   - FNV-1a 哈希去重 (句级 n-gram 模板)
 *   - 结构签名 = 段长指纹 + 句长指纹 + 转场密度指纹
 *   - 跨 K 章滑窗重复警报
 *
 * 用法 (scheduler 接线):
 *   const sig = chapterStructuralSignature(chapterText)
 *   registerChapterSignature(sig) → 跨章窗口内检测重复
 */

/** FNV-1a 32-bit 哈希 (确定性, 零依赖) */
export function fnv1a32(input: string): number {
  const FNV_PRIME = 0x01000193
  const OFFSET = 0x811c9dc5
  let h = OFFSET >>> 0
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, FNV_PRIME) >>> 0
  }
  return h >>> 0
}

/** 归一化文本 (去空白) */
function normText(text: string): string {
  return text.replace(/\s+/g, "").replace(/[，。！？；：、,.!?;:]/g, "")
}

/** 句级 n-gram 模板哈希: 取每句前 N 字符构成模板 → n-gram → FNV 哈希集合 */
export function sentenceNGramSignature(text: string, n = 8): number[] {
  const sentences = text
    .split(/[。！？.?!]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)
  const tpls: number[] = []
  for (let i = 0; i <= sentences.length - n; i++) {
    const tpl = sentences.slice(i, i + n).map((s) => s.slice(0, 2)).join("|")
    tpls.push(fnv1a32(tpl))
  }
  return tpls
}

/** 结构签名: 段长指纹 + 句长指纹 + 转场密度 */
export interface StructuralSignature {
  /** 段长桶分布哈希 (每段长度 → 桶 → 聚合) */
  paragraphBuckets: number[]
  /** 句长签名: 句长序列量化哈希 */
  sentenceLengthHash: number
  /** 转场密度: 转折词开头段落占比 (分桶) */
  transitionDensityBucket: number
  /** 章节文本长度 (字符, 归一) */
  length: number
  /** 句级 n-gram 模板哈希 (参与同构判定重合度) */
  ngramHashes: number[]
}

/** n-gram 最小重合率 (>= 此值才算同构附加维度) */
export const NGRAM_OVERLAP_MIN = 0.3

/** 段长桶: 每段长度分桶 (0-20/21-60/61-200/200+) */
function paragraphBuckets(text: string): number[] {
  const paras = text.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0)
  const buckets = [0, 0, 0, 0]
  for (const p of paras) {
    const l = p.length
    if (l <= 20) buckets[0]++
    else if (l <= 60) buckets[1]++
    else if (l <= 200) buckets[2]++
    else buckets[3]++
  }
  return buckets
}

/** 转场词 (与 mechanical slop 一致) */
const TRANSITION_OPENERS = ["然而", "但是", "不过", "可是", "与此同时", "紧接着", "此外", "因此"] as const

/** 章节结构签名 (零 LLM)
 * 注意: 分句必须用原始文本 (保留句末标点), normText 剥离标点后无法分句。 */
export function chapterStructuralSignature(rawText: string): StructuralSignature {
  const text = normText(rawText)
  const paras = rawText.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0)
  const transCount = paras.filter((p) => TRANSITION_OPENERS.some((t) => p.startsWith(t))).length
  const transRatio = paras.length > 0 ? transCount / paras.length : 0
  // 转场密度分桶: 0-10% / 10-25% / 25-50% / 50%+
  const transBucket = transRatio <= 0.1 ? 0 : transRatio <= 0.25 ? 1 : transRatio <= 0.5 ? 2 : 3

  // 句长序列量化: 基于原始文本分句 (>35 字=长(2), 12-35=中(1), <12=短(0)) → 数字串哈希
  const sentenceLens = rawText.split(/[。！？.!?]+/).map((s) => s.length).filter((l) => l > 0)
  const quantized = sentenceLens.map((l) => (l > 35 ? "2" : l >= 12 ? "1" : "0")).join("")
  const sentenceLengthHash = fnv1a32(quantized.slice(0, 400))

  return {
    paragraphBuckets: paragraphBuckets(rawText),
    sentenceLengthHash,
    transitionDensityBucket: transBucket,
    length: text.length,
    ngramHashes: sentenceNGramSignature(rawText, 8),
  }
}

/** 两签名 n-gram 集合重合率 (最小集为分母) */
export function ngramOverlap(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setB = new Set(b)
  const common = a.filter((h) => setB.has(h)).length
  return common / Math.min(a.length, b.length)
}

/** 同构判定: 两个签名在容差内的结构重复 */
export function signaturesSimilar(
  a: StructuralSignature,
  b: StructuralSignature,
  opts?: { bucketTolerance?: number; lengthRatioTolerance?: number; ngramMinOverlap?: number },
): boolean {
  const tol = opts?.bucketTolerance ?? 1
  const lenRatio = opts?.lengthRatioTolerance ?? 0.3
  const ngramMin = opts?.ngramMinOverlap ?? NGRAM_OVERLAP_MIN
  // 长度差异太大 → 不算同构 (章节规模不同)
  if (a.length > 0 && b.length > 0) {
    const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length)
    if (ratio < 1 - lenRatio) return false
  }
  // 转场密度桶一致
  if (a.transitionDensityBucket !== b.transitionDensityBucket) return false
  // 段长桶: 每桶差 <= tolerance
  for (let i = 0; i < 4; i++) {
    if (Math.abs(a.paragraphBuckets[i]! - b.paragraphBuckets[i]!) > tol) return false
  }
  // 句长指纹相同 (模板级重复)
  if (a.sentenceLengthHash !== b.sentenceLengthHash) return false
  // 句级 n-gram 重合率 (句首模板惯性, 防仅长度/转场碰巧同构)
  if (a.ngramHashes.length >= 2 && b.ngramHashes.length >= 2) {
    return ngramOverlap(a.ngramHashes, b.ngramHashes) >= ngramMin
  }
  return true
}

/** 跨章回声注册器: 维护已见章节签名, 跨 K 章窗口检测重复 */
export class NarrativeEchoTracker {
  private readonly seen: { signature: StructuralSignature; chapter: number }[] = []
  private readonly windowSize: number

  constructor(opts?: { windowSize?: number }) {
    this.windowSize = opts?.windowSize ?? 5
  }

  /** 注册一章签名, 返回与该章同构的前序章节 (在窗口内) */
  register(chapter: number, signature: StructuralSignature): number[] {
    const similar: number[] = []
    const cutoff = this.seen.length - this.windowSize
    for (let i = Math.max(0, cutoff); i < this.seen.length; i++) {
      const s = this.seen[i]!
      if (signaturesSimilar(s.signature, signature)) {
        similar.push(s.chapter)
      }
    }
    this.seen.push({ signature, chapter })
    return similar
  }

  /** 窗口内所有重复对 (调试/审计) */
  duplicates(): { a: number; b: number }[] {
    const out: { a: number; b: number }[] = []
    for (let i = 0; i < this.seen.length; i++) {
      for (let j = i + 1; j < this.seen.length; j++) {
        const s = this.seen[i]!
        const t = this.seen[j]!
        if (t.chapter - s.chapter > this.windowSize) break
        if (signaturesSimilar(s.signature, t.signature)) {
          out.push({ a: s.chapter, b: t.chapter })
        }
      }
    }
    return out
  }
}

/** 文本化回声报告 (供审计) */
export function echoReportToText(matches: number[], currentChapter: number): string {
  if (matches.length === 0) return ""
  return `跨章回纹: 第 ${currentChapter} 章与 [${matches.join(", ")}] 章结构同构 (重复段落节奏/句长模板/转场密度)`
}
