// 由 scripts/anti-ai-calibrate.js 自动生成（T20 标定产物，勿手改）
// 来源: docs/p2/anti-ai-thresholds.json（A-12.3 四元组可回溯）
// corpus: human 1035 + ai 139 | hash 0b04f81f30d1 | commit 55d8f1dd | 2026-08-26
// 组合判据: nGramOverlap + punctuationFingerprint（sentenceEntropy/paragraphLengthDist 降级诊断因子，真实语料无稳定区分度）

export const ANTI_AI_THRESHOLDS = {
  "nGramOverlap": {
    "min": 0.5
  },
  "sentenceEntropy": {
    "direction": "low",
    "bound": 0.7
  },
  "punctuationFingerprint": {
    "min": 0.7
  },
  "paragraphLengthDist": {
    "shortThreshold": 0.2,
    "longThreshold": 0.2
  }
}

export const ANTI_AI_COMBINED_FACTORS = ["nGramOverlap", "punctuationFingerprint", "selfRepetition"]

// 2026-09-04 55 号设计覆盖度 100% 激活: selfRepetition 观察期结束 (用户决策),
// 阈值 0.35 warn-only 不硬门控。G8 门控 hash 变更 = 有意激活, 非漂移 (decision-log 20260904-55-ref-cover-v2-w1w3.md 追记)。
export const ANTI_AI_CALIBRATION_META = {
  corpusHash: "0b04f81f30d1",
  gitCommit: "55d8f1dd",
  date: "2026-08-26",
  human: 1035,
  ai: 139,
}
