# QMAI de-AI 交付 #34 收尾 · 三模型共识设计（第 3/3 票 · hy3）

> 只读分析产物。TASK A = skill version 提取正则 frontmatter 边界化；TASK B = DD-3 阈值真实语料标定。
> 约束遵守：ADR-19 零 LLM/IO ✓ · Track B soft ✓ · 112 词表不动 ✓ · reference/ 只读 ✓ · src/lib/novel/ 内增量 ✓。

---

## TASK A — `extractSkillVersion` frontmatter 边界化

### A.1 现状复核（读 `src/lib/novel/de-ai-adapter.ts` + `skills/de-ai-writing/SKILL.md` + `de-ai-adapter.spec.ts`）

- 当前正则：`/^\s*version:\s*["']?([^\s"']+)/m`（带 `m` 多行）。
- 匹配范围：**全文任意行**。`^\s*` 吃前导空白，故 `metadata` 内层缩进 `version:` 也能命中。
- 实测：源 `skills/de-ai-writing/SKILL.md` 第 11 行 `  version: "2.7.4"`（嵌套于 `metadata:`），当前正则解析为 `"2.7.4"` → `BUILTIN_DE_AI_SKILL_VERSION="2.7.4"`，现有 spec 断言通过 ✓。
- **真 bug（用户标注的「理论边角」）**：`m` 使 `^` 命中任意行首，正文孤立 `version: 9.9` 会被捕获。
- **已安全（无需改）**：`contentVersion:` 行首为 `content` 不满足 `^\s*version`；`schemaVersion:` 大写 `V` 不匹配小写 `version:` → 二者当前即不误配。
- 缺口：无 frontmatter 文档若含 `version:` 行会误配；正文 `version:` 误配。

### A.2 确定性修复设计（additive-only，函数签名与返回类型不变）

思路：先抽 frontmatter 块（`^---\r?\n … \r?\n---`），**仅在块内**匹配 `version:` 字段。

```ts
// 仅取首个 `--- … ---` 块；文档不以 `---` 开头或块缺失 → null（同时排除正文 `---` 围栏）
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/

function extractFrontmatter(md: string): string | null {
  const m = md.match(FRONTMATTER_RE)
  return m ? m[1]! : null
}

export function extractSkillVersion(markdown: string): string | null {
  const fm = extractFrontmatter(markdown)
  if (!fm) return null
  // 优先顶层（列 0）version:；否则取 metadata 内层缩进 version:
  const top = fm.match(/^version:\s*["']?([^\s"']+)/m)
  if (top) return top[1]!
  const nested = fm.match(/^\s+version:\s*["']?([^\s"']+)/m)
  return nested?.[1] ?? null
}
```

要点：
- 字段名边界保持 `^\s*version:`：行首/前导空白后须紧跟 `version:`，`contentVersion`/`schemaVersion`/`myversion` 均不误配（无需 lookbehind，零依赖）。
- 引号兼容：`["']?` 覆盖 `version: "2.7.4"` / `version: 2.7.4` / `version: '2.7.4'`。
- `FRONTMATTER_RE` 锚定文档起始 `^---`，正文 `---` 围栏不被当作 frontmatter；非贪婪停在首个 `\n---`，仅取块内。
- 顶层优先于内层（canonical SKILL.md 约定）；二者皆缺 → null。
- 注释更新：由「行锚 + 字段名边界」改为「frontmatter 块内边界匹配，body version: 不误配」。

### A.3 边界用例表（期望）

| # | 输入 | 期望 | 说明 |
|---|------|------|------|
| 1 | 无 frontmatter，正文 `version: 1.0` | `null` | **修复核心**：body 不误配 |
| 2 | 无 frontmatter 纯文本 | `null` | — |
| 3 | `---\nname: x\n---` | `null` | 无 version 字段 |
| 4 | `---\nname: x\n---\n\nbody version: 9.9` | `null` | 正文 version 不误配 |
| 5 | `---\ncontentVersion: 1.0\n---` | `null` | contentVersion 不误配 |
| 6 | `---\nschemaVersion: 1.0\n---` | `null` | schemaVersion 不误配 |
| 7 | `---\nversion: 2.7.4\n---` | `"2.7.4"` | 外层（顶层） |
| 8 | `---\nmetadata:\n  version: "2.7.4"\n---` | `"2.7.4"` | 内层（现有 SKILL.md）✓ |
| 9 | `---\nmetadata:\n  contentVersion: 1\n  version: 2.7.4\n---` | `"2.7.4"` | 内层 + 同块 contentVersion 不干扰 |
| 10 | `---\nversion: 2.7.4\nmetadata:\n  version: 9.9.9\n---` | `"2.7.4"` | 顶层优先于内层 |
| 11 | 真实 SKILL.md 导入 | `"2.7.4"` | BUILTIN 断言保持通过 |

### A.4 测试清单（追加 `de-ai-adapter.spec.ts`）

- 保留现有 3 条（嵌套解析 `"1.2.3"` / 无 version→null / `BUILTIN="2.7.4"`）。
- 新增：用例 1、4、5、6、7、10（`describe("extractSkillVersion frontmatter 边界")`）——覆盖 body 不误配 + contentVersion/schemaVersion 不误配 + 顶层优先。
- 不改函数签名 / 不改 SKILL.md 业务文案（其 `metadata.version` 已存在，仅确认）。

### A.5 风险

- 极低：纯正则增量，无 LLM/IO；现有断言全绿；唯一行为变化是「正文 `version:` 不再被捕获」=修复目标，不影响任何产品消费方（消费方只期望 frontmatter 内 version）。
- 注意：我先前误读 `release-portable/skills/.../SKILL.md`（构建产物副本，缺 version 字段）。**导入真源是 `skills/de-ai-writing/SKILL.md`**（带 version）。勿手写 release-portable 副本，交给构建重生成。

---

## TASK B — DD-3 阈值真实语料标定

### B.1 全链阈值现状盘点（均标「待校准/经验」，Track B soft）

| 模块 | 关键阈值 | 现状 |
|------|----------|------|
| mechanical-slop-detector | `SLOP_CLASSIFY_BLOCK=8` / `WARN=5`；密度 target `1.0/2.0/3.0` per1k；权重 `3.0/1.5/1.0`；cluster `penalty1.5/window200/minBurst3`；`SENTENCE_CV_LOW=0.1`+`MIN_CV_PENALTY=5`；`TRANSITION_OPENER=0.4`；`CAVITY_CV_LOW=0.08`/`HIGH=0.75`；`CAVITY_FILLER_PER_1000=3.0`/`BURST_MIN=3` | 经验/待校准 |
| mechanical-fingerprint | `cvScore` 自然 0.2–0.5；`burstiness` 自然 0.3–0.7；`openerDiversity>0.6`；`topWordRepetition<0.2`；score 权重 `0.35/0.2/0.15/0.15/0.15`；band `<0.35`/`<0.6`/`>=0.6` | 经验 |
| de-ai-selfcheck | `SELFCHECK_PASS=0.6`；维度权重；`scoreSyntax CV 0.15–0.55`；`scoreRhythm 段落CV 0.3–0.9`；`vocab slop/8`、`narr tier1/6`、`psych tier3/8`、`scene tier2/8` | 经验 |
| narrative-echo-detector | `NGRAM_OVERLAP_MIN=0.3`；段长桶 `0-20/21-60/61-200/200+`；转场桶 `0-10/10-25/25-50/50+`；句长量化 `>35=2 / 12-35=1 / <12=0`；`bucketTol=1`/`lenRatioTol=0.3`/`window=5` | 经验 |
| de-ai-intensity | `lightUpper=6`/`rewriteLower=16`/`slopFloor=5`/`cavitySkipUpper=0.7` | 经验/待校准 |
| de-ai-percentile | `calibrateThresholds` / `selfTestChineseFprProxy`（已就位，承载层） | 已标定脚手架 |

### B.2 语料候选清单（路径 + 规模 + adequacy）

**主标定集（真实语料，T20 已建，复用不重造）**
- `docs/p0/corpus/{human,ai}/batch-*` @ **hub 根**（非 QMAI 仓内，gitignored）：human 1035 + ai 139，5 族（言情/古风/玄幻/悬疑/都市）。
- adequacy：**高**（真实采集 + synthetic-degraded 混合，T20 四因子已在此标定）。注意：QMAI 仓内不可达 → 标定脚本跨目录跑；CI 回归用嵌入样本。

**嵌入种子（仓内，CI 可跑）**
- `src/lib/novel/anti-ai-seeds.generated.json`：60 样本（human 30 + ai 30，3 族 gufeng/xuanhuan/yanqing），~43K 字符；文本含 `# corpus-sample` YAML 头需剥离（取首个 `---` 后正文）。
- adequacy：**中**（synthetic-degraded 自写模拟，非真实分布；仅作回归锁定 + dev 代理，非 FPR 真值）。

**仓内人类中文文本补充（adequacy 低/中，domain 偏移）**
- `release-portable/skills/**/SKILL.md` ×124（human-authored 指令中文）：含 TIER2/3 词（确保/复杂）会虚高 slop → 仅作「低 slop 人类参考」，非叙事 baseline。
- `src/i18n/zh.json`（101KB，UI 串碎片）、`src/lib/novel/vendor/avoid-ai-writing/README.md`（579B）、`docs/**` 决策日志（LLM 辅助，混合）：adequacy 低。

**AI 腔对照样本（只读）**
- `reference/humanizer` / `reference/humanizer-x` / `reference/ultimate-humanizer` @ hub 根（只读）：提供 AI 写法检测 pattern 与方法论（非散文语料）。
- 首选 AI 对照：嵌入 `anti-ai-seeds.generated.json` 的 ai 层 + `mechanical-slop-detector.spec.ts` 内 slop 串。

**结论（纠正预期）**：QMAI 仓内**基本无真实人类中文叙事语料**；标定必须复用 hub 根 `docs/p0/corpus`（T20 已建），仓内仅 `anti-ai-seeds` 作 CI 回归代理。用户预期「fixtures/e2e/wiki/docs 有人类文本」在 QMAI 仓内不成立。

### B.3 标定方法（复用 T20 流水线，不重造）

- 复用 `scripts/anti-ai-calibrate.js` 已验证方法：分层加载 human/ai → 剥离 `# corpus-sample` 头 → 样本级检测得两分布 → **Wilson 95% CI** 算 FPR/召回（per genre）→ **阈值扫描**：选点 = **零误杀硬门优先**（human FPR=0）→ 最大召回；无零误杀点则最小 FPR→最大召回（标注未达零误杀）。
- 判据目标（Track B soft）：warn 档 FPR 95%CI 上界 ≤10% 且 召回 95%CI 下界 ≥60%（对齐 T20）；block 档标 `pending-real-corpus`（DD-3 本就软门）。
- 新增 `scripts/dd3-calibrate.ts`（镜像 anti-ai-calibrate.js），消费同一 corpus，产出：
  - `src/lib/novel/dd3-thresholds.generated.ts`（同 `anti-ai-thresholds.generated.ts` 形：`DD3_THRESHOLDS` + `DD3_CALIBRATION_META` + 头部「勿手改/可回溯 hash/commit」）。
  - `docs/p2/dd3-calibration.md`（Wilson 表 + 每族每因子 voice profile + 风险声明）。
- 轻量分位数/FPR 代理复用 `de-ai-percentile.ts` 的 `calibrateThresholds` / `selfTestChineseFprProxy`（已在位，`productHardGate=false`）。

### B.4 逐项建议（现状 → 建议 → 依据；**设计建议，待真实语料重跑确认**）

**mechanical-slop-detector.ts**
| 常量 | 现状 | 建议 | 依据 |
|------|------|------|------|
| BLOCK=8 / WARN=5 | 待校准 | 维持 8/5 | T20 零误杀+召回扫描语义；密度制下正常叙事稀释落 <5（spec 已验证） |
| 密度 target 1.0/2.0/3.0 per1k | 经验 | 维持；据 human p95 微调 | 容忍线以下不计罚；真实 human 每千字 slop 率应 < target |
| 密度权重 3.0/1.5/1.0 | 经验 | 维持（tier1 最高） | TIER1 强禁用、误伤低，权重最高合理 |
| cluster 1.5/200/3 | 经验 | 维持；MIN_BURST 据 corpus 验证 | 短窗连击语义保留 |
| CV_LOW=0.1 + MIN_CV_PENALTY=5 | 中文特调(原0.3→0.1) | 维持 | 中文短句 CV 天然 0.2–0.3，0.1 仅罚极齐整；句数 guard 防短文本误罚 |
| TRANSITION_OPENER=0.4 | 经验 | 维持 | 正常叙事段落转折开头比 <0.4 |
| CAVITY_CV_LOW=0.08 / HIGH=0.75 | 经验 | 维持；据 human CV 分布确认 | 人类 CV 中位 ~0.2–0.5；<0.08 过齐整、>0.75 人为造不规则 |
| CAVITY_FILLER_PER_1000=3.0 / BURST_MIN=3 | 经验 | 维持 3.0；据 human 填充词率微调 | 假口语密度异常线 |
| overCorrection 得分权重 0.4/0.3/0.2 | 经验 | 维持 | 0–1 软分，≥0.7 跳改写（联动 intensity.cavitySkipUpper） |

**mechanical-fingerprint.ts**
| 项 | 现状 | 建议 | 依据 |
|----|------|------|------|
| cvScore 自然 0.2–0.5 | 经验 | 维持 | 中文 CV 区间，偏离线性衰减 |
| entropyScore 归一化 | 实现 | 维持 | 均匀分布→1 |
| burstiness 自然 0.3–0.7 | 经验 | 维持；据 corpus 验证 | 极端值=信号 |
| openerDiversity>0.6 | 经验 | 维持 | 句首多样 |
| topWordRepetition<0.2 | 经验 | 维持 | 中文常用字占比高，放宽 |
| score 权重 0.35/0.2/0.15/0.15/0.15 | 经验 | 维持 | cv 主导 |
| band <0.35/<0.6/>=0.6 | 经验 | 维持；据 human 分布校准切点 | soft band，非硬门 |

**de-ai-selfcheck.ts**
| 项 | 现状 | 建议 | 依据 |
|----|------|------|------|
| PASS=0.6 | 经验 | 维持 | Track B soft PASS/REVIEW，不产品硬门 |
| 维度权重 | 经验 | 维持 | 词汇/句式各 0.2 |
| scoreSyntax CV 0.15–0.55 | 经验 | 维持 | 与 fingerprint 一致 |
| scoreRhythm 段落 CV 0.3–0.9 | 经验 | 维持 | 段落长度多样 |
| vocab slop/8 · narr tier1/6 · psych tier3/8 · scene tier2/8 | 经验 | 维持；分母据 corpus 微调 | 线性映射 |

**narrative-echo-detector.ts**
| 项 | 现状 | 建议 | 依据 |
|----|------|------|------|
| NGRAM_OVERLAP_MIN=0.3 | 经验 | 维持；据 human 章间重合率校准 | 同构附加维度 |
| 段长桶 0-20/21-60/61-200/200+ | 经验 | 维持 | 段长分桶 |
| 转场桶 0-10/10-25/25-50/50+ | 经验 | 维持 | 转场密度分桶 |
| 句长量化 >35=2/12-35=1/<12=0 | 经验 | 维持；边界据 human 句长分布校准 | 句长量化 |
| bucketTol=1 / lenRatioTol=0.3 / window=5 | 经验 | 维持 | 同构容差 |

**de-ai-intensity.ts**
| 项 | 现状 | 建议 | 依据 |
|----|------|------|------|
| lightUpper=6 / rewriteLower=16 / slopFloor=5 / cavitySkipUpper=0.7 | 经验 | 维持；据 corpus 微调 | 三档 triage，Track B soft |

**元建议（关键）**：T20 已证 `sentenceEntropy`/`paragraphLengthDist` 在真实语料**无稳定区分度**→降级诊断因子。推论：DD-3 中同类结构指标（CV/熵/突发/转场开头比/段长桶）应**同样定位 soft/diagnostic，不升产品硬门**。标定产出 soft bands + 回归断言即可，绝不下沉为 Consistency(P0) 硬门。

### B.5 落地形态与回归锁定

- 新增 `scripts/dd3-calibrate.ts` → 产出 `src/lib/novel/dd3-thresholds.generated.ts` + `docs/p2/dd3-calibration.md`。
- 新增 `src/lib/novel/dd3-threshold-calibration.spec.ts`（回归锁）：
  1. 加载嵌入 `anti-ai-seeds.generated.json`（剥离 `# corpus-sample` 头）。
  2. 对 human/ai 两层跑 `slopScore` / `statisticalFingerprint` / `chapterStructuralSignature` / `overCorrectionReport` / `runDeAiSelfCheck` / `classifyIntervention`。
  3. `calibrateThresholds(humanMetrics)` 得 soft bands；`selfTestChineseFprProxy(humanMetrics, aiMetrics)` 得 FPR/TPR。
  4. 断言（回归锁）：`fprAtP90 <= 0.15` 且 `tprAtP90 >= 0.55`（宽松软目标，待真实语料收紧）；各密度阈值在 human p95 内不误伤。
  5. 全量 corpus 标定块 `describe.skipIf(!CORPUS_AVAILABLE)`（CORPUS_ROOT 在 hub 根，QMAI CI 不可达→skip，仅本地/发版前跑）。
- **防过拟合留出**：
  - 嵌入 30+30 作仓内 holdout（与全量同源 synthetic-degraded，非独立真实分布 → 标注局限：仅验证「不回归」，不验证真实 FPR）。
  - 选点用「零误杀 + 最大召回」语义抗过拟合（宁可漏报不误杀 human）。
  - 阈值文件标 `corpusHash`/`gitCommit`；语料变更须重跑脚本（fail-closed：hash 不匹配 CI 告警）。
  - 不把 DD-3 任何阈值升产品硬门（Consistency P0 硬门独立），避免阈值过拟合传导主链。

### B.6 风险

- **语料代表性**：真实 human 叙事在 QMAI 仓内缺失，标定依赖 hub 根 `docs/p0/corpus`（synthetic-degraded + 部分真实）。结论为 soft 参考，不得作发版 anti-AI 效果宣称（同 T20 风险声明）。
- **结构指标弱区分**：T20 已证 sentenceEntropy/paragraphLengthDist 无稳定区分度；DD-3 同类指标同理，强推硬门将高误杀 → 设计上全部保持 soft。
- **嵌入样本同源**：30+30 与全量同源 synthetic-degraded，holdout 非独立；CI 回归仅验证不回归。
- **阈值过拟合**：小样本网格扫描易过拟合；以零误杀+最大召回+corpusHash 锁定缓解。
- **112 词表/reference**：全程未改（约束遵守）。

---

## 交付清单（验收）

- **TASK A**：`src/lib/novel/de-ai-adapter.ts` 改 `extractSkillVersion`（frontmatter 边界）+ `de-ai-adapter.spec.ts` 追加 6 用例（表 A.3 的 1/4/5/6/7/10）；确认 `skills/de-ai-writing/SKILL.md` 的 `metadata.version` 已存在（不改）。
- **TASK B**：新增 `scripts/dd3-calibrate.ts` + `src/lib/novel/dd3-thresholds.generated.ts` + `docs/p2/dd3-calibration.md` + `src/lib/novel/dd3-threshold-calibration.spec.ts`；复用 `de-ai-percentile.ts` 承载分位数/FPR。
- 全程零 LLM/IO、Track B soft、112 词表与 reference/ 未触碰。
