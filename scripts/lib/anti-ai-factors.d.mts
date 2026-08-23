/**
 * anti-ai-factors.mjs 的最小类型声明（供 vitest 规格引用；实现真源为同名 .mjs）
 */
export interface CorpusIndexes {
  [key: string]: unknown
}

export interface AntiAiWarns {
  nGramOverlap: boolean
  sentenceEntropy: boolean
  punctuationFingerprint: boolean
  paragraphLengthDist: boolean
}

export interface DetectionResult {
  nGramOverlap: { aiOverlap: number; humanOverlap: number }
  sentenceEntropy: { normalized: number; entropy: number; count: number }
  punctuationFingerprint: { aiCosine: number; humanCosine: number; totalPunct: number }
  paragraphLengthDist: { cv: number; count: number }
  warns: AntiAiWarns
  warnCount: number
}

export declare function buildCorpusIndexes(
  humanSamples: { text: string }[],
  aiSamples: { text: string }[],
): CorpusIndexes

export declare function runDetection(text: string, indexes: CorpusIndexes): DetectionResult
