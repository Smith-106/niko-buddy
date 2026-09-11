# C4 stretch-2 重测：偏好面板评分者一致性（rater-agreement-20260910-n5）

- **日期**：2026-09-10（重测执行 09-10 11:19 → 09-11 20:45）
- **状态**：CLOSED — **FAIL**（预承诺门未通过，阈值未下调）
- **权威产物**：`.workflow/harvest-staging/stretch-gate-20260910-preferred/cross-model-n5-20260910-preferred.json`
  （sha256 清单：`QMAI/docs/p6/ab-evidence/c4-stretch2-preferred-hash-manifest-20260910.json`）
- **上游决策**：`docs/decision-log/20260910-c3-f34-local-exemption-aggregation-path.md`（F-34 解封）；`stretch-gate-20260907/decision-record-20260907b.md`（阈值与门定义，本次沿用不改）

## 1. 决策

在**用户裁决的偏好面板**（与 2026-09-07 面板互斥）上重跑 cross-model 一致性门：**结论仍为 FAIL**。

| 指标 | 门限 | 实测（preferred 面板） | 判定 |
|---|---|---|---|
| `medianDelta`（全体模型两两×六维 \|Δ\| 的中位数） | ≤ 0.5 | **0.8375** | FAIL |
| `maxDimDelta`（最差单维两两 Δ） | ≤ 0.7 | **6.0** | FAIL |
| 预承诺组合规则（任一章超限即 FAIL） | 全部 ≤ 门限 | 6/6 章 FAIL | **FAIL** |

分章：ch1 0.750/1.70 · ch2 0.875/3.80 · ch3 0.450/2.85 · ch4 0.950/**6.00** · ch5 0.800/3.50 · ch6 **1.400/5.00**（medianDelta/maxDimDelta）。

**可比性声明**：本产物面板与 20260907 不同（替换 4 个模型、第 5 槽经裁决替换），**与 20260907 的 FAIL-FINAL 不可直接比较**；20260907 结论保留不动。本次为**替代证据线**，但两条互斥面板均 FAIL ⇒「9/7 的 FAIL 是面板特例」这一假设被否定。

## 2. 面板变更链（必须是披露项）

1. **9/7 面板**（5 模型）：deepseek-v4-pro / openai-gpt-oss-20b / google-gemma-4-31b-it / nemotron-3-super / glm-5.3-flash → FAIL-FINAL。
2. **用户 2026-09-10 裁决**改「偏好面板」：deepseek-v4-flash / qwen3.8-flash / glm-5.3-flash / GLM-5.2 / grok-4.6，明确放弃与 9/7 可比性。
3. **第 5 槽替换**：`glm-5.3-flash` 在 harness 唯一通道（流式）下**内容恒为空**——无参 / `enable_thinking:true` / `enable_thinking:false` 三形态各 3/3 全空、`finish_reason=length`（证据 `probe-20260910-glm-streaming.json`）⇒ 该模型在协议下**结构上不可测**。用户裁决以 **composer-2.5**（xAI，sub2 同渠道）替换。
4. **最终面板（5 模型 / 4 厂商 / 双 relay）**：deepseek-v4-flash（DeepSeek·cpa·6 路）· qwen3.8-flash（Alibaba·cpa·6 路）· GLM-5.2（Zhipu·cpa·6 路）· grok-4.6（xAI·sub2·3 路按维分批）· composer-2.5（xAI·sub2·2 路按维分批）。厂商数 4 ✓，cross-model-bias 门要求的「≥5 模型」✓。

## 3. 方法与成本

- 夹具：`archives/20260816-release-cleanup-v248/fixtures-overall9-baseline-20260811/step0-ab-prompts.ch{1..6}.json`（全文窗，chapterText ≤ 11.3k chars）；**仅 new 臂**定向采集（`STEP0_AB_ONLY`、`STEP0_DIAGNOSIS_NEW_ONLY=1`）。
- 规模：6 章 × 5 模型 × N=5 = 30 格 / 900 采样，实收 **877（97.4%）**；每格 6 维 `newMedian` 全部有限 ⇒ **有效性门 30/30 通过**（16 个维度样本数 1–4，清单见产物 `validity.cellsPartial`，已如实披露）。
- 补采样纪律：PASS1 全采 → PASS2 修「0 样本维」（2 轮）→ PASS3 补「<5 样本维」（单轮）；运行器 `run-preferred-panel-v5.sh` / `v6-glm6000.sh`（脚本与日志均入 hash 清单）。样本数不足**不**通过重采样挑选分数，只做补充采集。

## 4. 分歧结构（为什么 FAIL）

三类失效**同时**存在，不是单一离群点：

1. **模型间系统性档位差**：qwen3.8-flash 系统性偏高（ch1 六维 8.5–9.2），deepseek-v4-flash 系统性偏低（ch1 7.2–7.5），差值稳定跨越门限 → 拉高全体 `medianDelta`。
2. **单维极端离群**：ch4 `continuity` grok-4.6=3.5 vs GLM-5.2=9.5（Δ=6.0，本次最大）；ch6 `consistency/character` GLM-5.2=4 且 grok/composer=3.5，而 deepseek=7.5。
3. **模型自身重采样离散度大**：同格同维 5 样本 min–max 可差 5 分（GLM-5.2 ch1 `thrill` 3.5–9.0、`character` 4.0–9.5）⇒ 单次 LLM 评分不可作为门控信号。

**推论**：本面板下「六维 0–10 结构化评分」不满足跨模型一致性要求；若继续以 LLM 评分作为 Track A 门控，必须先做**评分协议改造**（档位锚定/校准样例/偏差校正）或**人工锚定子集**，否则门控结果不可复现。

## 5. 过程中发现并修复的两个 harness 缺陷（均已提交）

| 缺陷 | 证据 | 修复 |
|---|---|---|
| GLM 系 thinking 无法通过 `chat_template_kwargs`/`thinking` 关闭，导致思考污染结构化输出 | relay 实测三形态对照 | `f06b5242`：`isGlmThinkingModel` → reasoning off 时顶层 `enable_thinking:false`（回归 `llm-providers.spec.ts` 61/61） |
| GLM 系思考 token **不随流式 content 下发**，`max_tokens=2000` 被思考吃光 → 内容 0 字节、`finish_reason=length`，取不到 `score`（GLM-5.2 ch2 `character` 维连续 3 轮 45 次调用全 null） | 对照探针：`max_tokens=2000` → 3/3 `length` + 0 字节；`max_tokens=6000` → 3/3 `stop` + 可解析 score（8.5/8.5/6.0） | `734a80c9`：GLM id 显式小上限抬到 6000（更大上限保留、其他模型不动；回归覆盖下限/保留上限/非 GLM 守卫）。修复后 GLM-5.2 六格由 16–27/30 变为 28–30/30 |

研究侧还放宽了单次调用上限（`STEP0_CALL_TIMEOUT_MS`，默认仍 300000，本次 GLM 补跑用 480000），仅延长允许等待时间，不改变成功调用的评分语义。

上述两项均属**采集仪器参数变更**（非阈值/规则变更），已在三处显式落地：①主产物 `protocol.panelChangeFrom20260907.glmTokenHeadroom`（失败模式 + 3/3 对照探针结论 + 修复 commit）；② `protocol.panelChangeFrom20260907.cellCollectionVariant`（GLM 六格=v6-glm6000 + 480s；其余 4 模型=默认 2000/300s；弃用格 `invalid/pre-6000cap/` GLM ch1-ch5 有效样本 106 + 有效样本记账 983 vs 预承诺 900 次调用）；③ 本记录 + hash 清单 `_meta.harnessCommits`。**阈值与预承诺解释规则未动，无事后换锚**。

## 6. 执行与残量

- **不做**：macos e2e（用户明示跳过）；不重跑其他模型以匹配 GLM 的 token 上限（面板内每模型独立通道，披露即可）。
- **已知残量（不阻塞结论）**：877/900 采样；16 个维度 n=1–4（最弱 ch1/grok `character` n=1）——这些维度的中位数稳健性弱于 n=5，但**有效性门（中位数有限）全通过**，且 FAIL 幅度（0.8375 vs 0.5；6.0 vs 0.7）远超样本数不足可能造成的抖动。
- **未做裁决**：阈值（0.5/0.7）与面板均未因本次结果调整——预承诺规则要求不得因补证上调门限。

## 7. 后续建议（供 Track A 门控改造决策）

1. 将 cross-model 一致性门从「LLM 自评均值」改为**人工锚定子集 + 机器评分偏差校正**（人工 N≥5 抽样，机器仅做回归/异常检测）。
2. 若保留 LLM 评分，协议需固定**同厂商同通道**评分者并做档位校准（提供 3–5 个已锚定样例），或改用**成对比较**（A/B）而非绝对 0–10 分。
3. 把「评分者离散度」本身作为可观测指标（本产物 `perModelSpread` 已含 min/max/n）纳入 Track B 诊断。
