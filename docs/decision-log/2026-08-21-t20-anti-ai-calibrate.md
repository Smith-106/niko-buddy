# A-34 决策日志 — T20 反AI 标定流水线（warn 档先行）

```yaml
date: 2026-08-21
task_id: TASK-P2-20
decision_type: 基线值
wave: W2-base
model: deepseek-v4-flash
verified: node scripts/anti-ai-calibrate.js 产出 docs/p2/anti-ai-calibration.md + tsc 0 错
```

## 标定结论

### warn 档标定状态：❌ 未完全通过（样本不足导致，非检测器质量）

在 synthetic-degraded 种子语料（30 human + 30 AI，3 族各 10 篇）上标定四统计因子：

| 检测因子 | 点估计 FPR | 点估计 召回 | Wilson CI 95% FPR 上界 | Wilson CI 95% 召回下界 | 判定 |
|----------|-----------|-----------|----------------------|----------------------|------|
| nGramOverlap | 0.0% | 100.0% | 27.8% | 72.2% | ❌（FPR CI 上界 >10%，样本不足） |
| sentenceEntropy | 0.0% | 0.0% | 27.8% | 0.0% | ❌（无法区分 synthetic-degraded 下的人写与 AI） |
| punctuationFingerprint | 0.0% | 0.0% | 27.8% | 0.0% | ❌（同作者风格下标点模式相似） |
| paragraphLengthDist | 0.0% | 0.0% | 27.8% | 0.0% | ❌（短文本段落 CV 自然偏高） |

### 关键发现

1. **n-gram 重合度检测器表现优异**：0% FPR / 100% 召回，但 Wilson CI 上界 27.8% 因 n=10 过宽，无法通过严格判据。预期真实语料 ≥100 篇/族后可稳定通过。
2. **句式熵/标点指纹/段落长度分布**：在 synthetic-degraded 语料上无法区分人写与 AI，因为二者由同一作者模拟，风格差异不足以触发统计差异。这三个检测器在真实采集语料上可能表现不同，但需等待真实语料验证。
3. **synthetic-degraded 局限性**：自写模拟的 AI 文本（如"清晨，阳光透过窗帘照进房间，显得十分温暖"）与自写模拟的人写文本（如"雨停在傍晚七点，地铁口还在滴水"）虽然叙事风格差异明显，但句长分布、标点使用、段落长度等底层统计特征相似，导致非 n-gram 检测器失效。

## 阈值

### 当前阈值（warn 档，基于 synthetic-degraded）

| 阈值 | 值 | 来源 |
|------|-----|------|
| nGramOverlap warn | AI 3-gram 重合度 > 0.4 且 > 人写参照 × 1.5 | T19 anti-ai-candidate-pool.ts |
| sentenceEntropy warn | 归一化熵 < 0.7 | T19（短文本校正） |
| punctuationFingerprint warn | AI 余弦 > 0.85 且 > 人写参照 × 1.2 | T19 |
| paragraphLengthDist warn | CV < 0.3 (3-5 段: 0.35) | T19（短文本校正） |
| 综合 warn 触发 | 任意 1 因子 warn | T19 检测器设计 |

### Block 阈值

| 阈值 | 状态 | 来源 |
|------|------|------|
| 全部 | ⏳ pending-real-corpus | 真实 ≥100 语料成熟后重跑 |

## 风险声明

1. 本标定基于 synthetic-degraded 语料，**不得**用于产品发版宣称（Track L9/T36 审查时须核验语料成熟度）。
2. 句式熵/标点指纹/段落长度分布三个检测器在 synthetic-degraded 语料上未通过标定，建议在真实语料成熟后重新评估。
3. n-gram 重合度检测器点估计表现优异（0% FPR, 100% 召回），但需要更多样本确认统计显著性。

## 技术债

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20260821-t20-01 | 句式熵/标点指纹/段落长度分布在 synthetic-degraded 语料上标定未通过 | 真实采集 ≥100 篇/族后重跑标定 | P2 收口前 |
| DEBT-20260821-t20-02 | n-gram 重合度 Wilson CI 因 n=10 过宽未能通过严格判据 | 真实采集 ≥100 篇/族后重跑标定 | P2 收口前 |

## 文件

- `QMAI/scripts/anti-ai-calibrate.js`：标定脚本，`node scripts/anti-ai-calibrate.js` 可重跑
- `QMAI/docs/p2/anti-ai-calibration.md`：标定报告（自动生成）
- `docs/p0/corpus/MANIFEST.md`：语料清单
- `docs/p0/corpus/{human,ai}/batch-20260821-001/`：种子语料

## 验证

- `node scripts/anti-ai-calibrate.js`：产出标定报告
- `cd QMAI && npx tsc --build`：0 错误
- 受影响 spec 全绿