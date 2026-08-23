/**
 * anti-ai-factors.mjs — 反AI四因子检测器共享库（PAT-G2 孪生逻辑唯一实现）
 *
 * 由 anti-ai-calibrate.js 程序化逐字节抽取（2026-08-22 特征提取轨重构）。
 * 消费方: scripts/anti-ai-calibrate.js + scripts/shadow-factor-profile.mjs
 */

// ============================================================================
// 文本工具函数 (PAT-G2 孪生: anti-ai-candidate-pool.ts)
// ============================================================================

export function splitSentences(text) {
  if (!text || text.trim().length === 0) return []
  return text.split(/[。！？!?.…]+/).map(s => s.trim()).filter(s => s.length > 0)
}

export function splitParagraphs(text) {
  if (!text || text.trim().length === 0) return []
  return text.split(/\n+/).map(p => p.trim()).filter(p => p.length > 0)
}

export function tokenize(text) {
  return text.split(/[，。！？、；：""''（）\s\n]+/).filter(t => t.length > 0)
}

export function extractWordNGrams(tokens, n) {
  const ngrams = []
  for (let i = 0; i <= tokens.length - n; i++) {
    ngrams.push(tokens.slice(i, i + n).join(""))
  }
  return ngrams
}

export function mean(values) {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

export function stddev(values) {
  if (values.length === 0) return 0
  const m = mean(values)
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

export function coefficientOfVariation(values) {
  const m = mean(values)
  if (m === 0) return 0
  return stddev(values) / m
}

export function entropy(counts, total) {
  if (total === 0) return 0
  let h = 0
  for (const c of Object.values(counts)) {
    const p = c / total
    if (p > 0) h -= p * Math.log2(p)
  }
  return h
}

export function buildCorpusIndexes(humanSamples, aiSamples) {
  // AI 3-gram 索引 (leave-one-out: 构建时排除自身)
  const ai3GramIndex = new Map()
  let ai3GramTotal = 0
  for (const sample of aiSamples) {
    const tokens = tokenize(sample.text)
    const ngrams = extractWordNGrams(tokens, 3)
    for (const ng of ngrams) {
      ai3GramIndex.set(ng, (ai3GramIndex.get(ng) || 0) + 1)
      ai3GramTotal++
    }
  }

  // 人写 3-gram 索引
  const human3GramIndex = new Map()
  let human3GramTotal = 0
  for (const sample of humanSamples) {
    const tokens = tokenize(sample.text)
    const ngrams = extractWordNGrams(tokens, 3)
    for (const ng of ngrams) {
      human3GramIndex.set(ng, (human3GramIndex.get(ng) || 0) + 1)
      human3GramTotal++
    }
  }

  // 标点指纹
  const aiPunctFingerprint = computePunctuationFingerprint(aiSamples)
  const humanPunctFingerprint = computePunctuationFingerprint(humanSamples)

  return {
    ai3GramIndex, ai3GramTotal,
    human3GramIndex, human3GramTotal,
    aiPunctFingerprint, humanPunctFingerprint,
  }
}

export function computePunctuationFingerprint(corpus) {
  const punctuationChars = "，。！？、；：\u201c\u201d''…—·～"
  const totalCounts = {}
  let totalPunct = 0
  for (const sample of corpus) {
    for (const ch of sample.text) {
      if (punctuationChars.includes(ch)) {
        totalCounts[ch] = (totalCounts[ch] || 0) + 1
        totalPunct++
      }
    }
  }
  const fingerprint = {}
  for (const [ch, count] of Object.entries(totalCounts)) {
    fingerprint[ch] = totalPunct > 0 ? count / totalPunct : 0
  }
  return fingerprint
}

// ============================================================================
// 四统计因子检测器 (PAT-G2 孪生: anti-ai-candidate-pool.ts)
// 返回原始因子值（非归一化），与 T19 阈值面一致。
// ============================================================================

export const PUNCTUATION_CHARS = "，。！？、；：\u201c\u201d''…—·～"

/**
 * 检测器 1: n-gram 重合度 (nGramOverlap)
 * 返回: [0,1] — 输入文本 AI 3-gram 重合度
 *   同时返回人写参照重合度用于相对判断
 * 阈值 (T19): > 0.4 且 > humanOverlap * 1.5 → warn
 */
export function rawNGramOverlap(text, ai3GramIndex, human3GramIndex) {
  const tokens = tokenize(text)
  const ngrams = extractWordNGrams(tokens, 3)
  if (ngrams.length === 0) return { aiOverlap: 0, humanOverlap: 0, ngrams: 0 }
  let aiHits = 0, humanHits = 0
  for (const ng of ngrams) {
    if (ai3GramIndex.has(ng)) aiHits++
    if (human3GramIndex.has(ng)) humanHits++
  }
  return {
    aiOverlap: aiHits / ngrams.length,
    humanOverlap: humanHits / ngrams.length,
    ngrams: ngrams.length,
  }
}

/**
 * 检测器 2: 句式熵 (sentenceEntropy)
 * 返回: Shannon 熵值 (bits) — 句长分布熵
 *   AI 倾向: 低熵 (< 3.5 bits, short-text 校正后)
 * 阈值 (T19): < 3.5 bits → warn
 *
 * 短文本校正:
 *   对于短文本 (< 15 句), 计算最大可能熵 maxEnt = log2(numSentences, 2)
 *   归一化熵 = rawEntropy / maxEnt (0-1)
 *   归一化熵 < 0.7 (短文本校正) 视为 warn
 */
export function rawSentenceEntropy(text) {
  const sentences = splitSentences(text)
  if (sentences.length < 8) return { entropy: 0, normalized: 0, count: sentences.length }
  const buckets = {}
  for (const s of sentences) {
    const bucket = Math.floor(s.length / 5) * 5
    const key = `${bucket}-${bucket + 4}`
    buckets[key] = (buckets[key] || 0) + 1
  }
  const ent = entropy(buckets, sentences.length)
  // 归一化: 当前熵 / 最大可能熵 (log2(桶数))
  const maxEnt = Math.log2(Object.keys(buckets).length)
  const normalized = maxEnt > 0 ? ent / maxEnt : 0
  return { entropy: ent, normalized, count: sentences.length, buckets: Object.keys(buckets).length }
}

/**
 * 检测器 3: 标点指纹 (punctuationFingerprint)
 * 返回: 余弦相似度 (与 AI 语料指纹)
 *   同时返回人写参照余弦相似度
 * 阈值 (T19): > 0.85 且 > humanCosine * 1.2 → warn
 */
export function rawPunctuationFingerprint(text, aiPunctFingerprint, humanPunctFingerprint) {
  const punctCounts = {}
  let totalPunct = 0
  for (const ch of text) {
    if (PUNCTUATION_CHARS.includes(ch)) {
      punctCounts[ch] = (punctCounts[ch] || 0) + 1
      totalPunct++
    }
  }
  if (totalPunct === 0) return { aiCosine: 0, humanCosine: 0, totalPunct: 0 }

  const allPunct = PUNCTUATION_CHARS.split("")
  // AI 余弦
  let aiDot = 0, aiMag = 0, textMag = 0
  for (const ch of allPunct) {
    const aiFreq = aiPunctFingerprint[ch] ?? 0
    const textFreq = (punctCounts[ch] ?? 0) / totalPunct
    aiDot += aiFreq * textFreq
    aiMag += aiFreq * aiFreq
    textMag += textFreq * textFreq
  }
  const aiCosine = (Math.sqrt(aiMag) > 0 && Math.sqrt(textMag) > 0) ? aiDot / (Math.sqrt(aiMag) * Math.sqrt(textMag)) : 0
  // 人写余弦
  let humanDot = 0, humanMag = 0
  for (const ch of allPunct) {
    const humanFreq = humanPunctFingerprint[ch] ?? 0
    const textFreq = (punctCounts[ch] ?? 0) / totalPunct
    humanDot += humanFreq * textFreq
    humanMag += humanFreq * humanFreq
  }
  const humanCosine = (Math.sqrt(humanMag) > 0 && Math.sqrt(textMag) > 0) ? humanDot / (Math.sqrt(humanMag) * Math.sqrt(textMag)) : 0

  return { aiCosine, humanCosine, totalPunct }
}

/**
 * 检测器 4: 段落长度分布 (paragraphLengthDist)
 * 返回: 变异系数 CV
 *   同时返回段落数
 * 阈值 (T19): CV < 0.3 → warn
 *
 * 短文本校正:
 *   对于短文本 (< 3 段), 无法计算
 *   对于 3-5 段, CV 自然偏低, 使用校正阈值 0.35
 */
export function rawParagraphLengthDist(text) {
  const paragraphs = splitParagraphs(text)
  if (paragraphs.length < 3) return { cv: 0, count: paragraphs.length }
  const lengths = paragraphs.map(p => p.length)
  const cv = coefficientOfVariation(lengths)
  return { cv, count: paragraphs.length }
}

export function runDetection(text, indexes) {
  const ngo = rawNGramOverlap(text, indexes.ai3GramIndex, indexes.human3GramIndex)
  const se = rawSentenceEntropy(text)
  const pf = rawPunctuationFingerprint(text, indexes.aiPunctFingerprint, indexes.humanPunctFingerprint)
  const pl = rawParagraphLengthDist(text)

  // T19 阈值判定:
  // nGramOverlap: > 0.4 且 > humanOverlap * 1.5
  const ngoWarn = ngo.aiOverlap > 0.4 && ngo.aiOverlap > ngo.humanOverlap * 1.5
  // sentenceEntropy: < 3.5 bits (短文本校正: 归一化熵 < 0.7)
  const seWarn = se.count >= 8 && se.normalized < 0.7
  // punctuationFingerprint: > 0.85 且 > humanCosine * 1.2
  const pfWarn = pf.totalPunct > 0 && pf.aiCosine > 0.85 && pf.aiCosine > pf.humanCosine * 1.2
  // paragraphLengthDist: CV < 0.3 (短文本校正: 3-5 段时阈值 0.35)
  const plThreshold = pl.count < 5 ? 0.35 : 0.3
  const plWarn = pl.count >= 3 && pl.cv < plThreshold

  const warnCount = [ngoWarn, seWarn, pfWarn, plWarn].filter(Boolean).length

  return {
    nGramOverlap: ngo, sentenceEntropy: se, punctuationFingerprint: pf, paragraphLengthDist: pl,
    warns: { nGramOverlap: ngoWarn, sentenceEntropy: seWarn, punctuationFingerprint: pfWarn, paragraphLengthDist: plWarn },
    warnCount,
  }
}
