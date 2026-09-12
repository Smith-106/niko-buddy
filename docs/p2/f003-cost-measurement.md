# F-003 前置门禁：单章节多路成本实测 + rubric 定义（C-014）

- **任务**：TASK-009（OpenWrite W4，F-003 门禁）
- **rubric 版本**：`rerank-rubric/1`
- **rubric_hash**：`7e3cc1a1830ac888`
- **门禁判定**：**BLOCKED**（理由见 §6；**实测未执行**，见 §5）
- **结论**：F-003（多路择优）**不得**进入实施波次 → TASK-010 未实现，A-F-003 维持冻结（0 行 F-003 代码）

> **阅读须知**：本文有两类数字，请勿混用。
> - §5.1 的**解析模型**是纯算术推演（不是测量），只回答「若前缀共享生效，倍数能被压到多少」。
> - §5.2 是**实测**，本次**未执行**，所有字段为 `not_executed`。
> 门禁判定**只**采纳实测（C-014）；解析模型不能替代测量，本文也**没有**用它放行。

---

## 1. 为什么需要这道门

C-014 明文要求 F-003 在成本实测完成前不得进入实施波次；data-architect 追加要求 rubric 定义完成前不得上线（无评分准则的择优是不可审计黑箱）。两件事本次一并交付：**rubric 定义（已完成）** 与 **成本实测（未完成，故门禁 blocked）**。

## 2. rubric 定义（已交付）

实现：`src/lib/novel/rerank-rubric.ts`（纯定义，**不含采样与评分器**）。测试：`src/lib/novel/rerank-rubric.spec.ts`（20 用例）。

### 2.1 判据集合：全部复用，零新判据（INV-4）

| 判据 | 来源（既有实现） | 权重 |
|---|---|---|
| `thrill`（爽感密度） | `dimension-review-adapter.ts` `runSixDimensionReview` | 0.05 |
| `consistency`（设定自治） | 同上 | **0.25** |
| `pacing`（节奏） | 同上 | 0.05 |
| `character`（角色） | 同上 | 0.05 |
| `continuity`（前后一致） | 同上 | **0.25** |
| `pull`（追读引力） | 同上 | 0.05 |
| `anti_ai_fingerprint` | `anti-ai-candidate-pool.ts` `quickAntiAiAnalysis` | **0.30** |

分数归一**唯一入口**仍是 `normalizeDimensionScore`（`rerank-rubric.ts` 的 `normalizeRerankScore` 只是转发）。判据来源以**函数引用**形式挂在 `RERANK_REUSED_SOURCES` 上（不是字符串名）：上游改名会让本模块**编译失败**，而不是静默分叉成第二套实现。测试 `binds the rubric to the existing judge functions by identity` 用 `toBe` 断言引用同一函数实体。

`rerank-rubric.ts` **不导出任何 `scoreCandidates` / `rankCandidates` / `sample*` 函数**，并有测试机械核验导出面。

### 2.2 权重来源：项目既有优先级，不是新标定

类间比例来自项目硬边界「门控优先级固定 `Consistency(P0) > Anti-AI(P1) > Quality(P2)`」：

```
P0 = 0.5  （consistency + continuity，类内均分 → 各 0.25）
P1 = 0.3  （anti_ai_fingerprint 独占）
P2 = 0.2  （thrill/pacing/character/pull，类内均分 → 各 0.05）
合计 1.000
```

**为什么不能直接继承 `CALIBRATED_DIMENSION_WEIGHTS`（实测发现）**

`review-scoring.ts:75` 的标定权重键是 `{plot, character, world, pacing, facts, compliance}`；而六维评审经 `dimension-review-adapter.ts:71` 的 `DIM_TO_GATE_TYPE` 落到的门类型是 `{plot, consistency, character_consistency, timeline}`。两套分类**只共享 `plot`**：

```
DIM_TO_GATE_TYPE 的像 − CALIBRATED_DIMENSION_WEIGHTS 的键
= {character_consistency, consistency, timeline}   （实测，见 spec 断言）
```

硬凑一张对照表就是**发明权重**。因此 rubric 明确声明权重来源为「门控优先级类 + 类内均分」，并把这件事写成**漂移探测器**：一旦上游补齐缺口，spec 的 `records that the calibrated gate-type weights cannot be inherited mechanically` 会失败，强制后续改用标定权重。

### 2.3 `rubric_hash` 生成方式

```
payload = rerank-rubric/1
        | normalizeDimensionScore@0..10/1dp
        | {id}:{weightClass}:{weight.toFixed(6)}:{source}:{gateType|"-"}   ← 按 id 排序
rubric_hash = FNV-1a64(payload)  → 16 位十六进制
```

- 复用 `book-analysis/content-fingerprint.ts` 的 FNV-1a（浏览器可用、纯函数、无 Node 依赖）。
- 它是**版本钉定指纹**，不是密码学摘要——用途是让「改了权重却沿用旧结论」在机械层面不可能发生。
- 测试覆盖：权重变 / 类变 / 门类型变 / 来源变 / 版本变 → hash 必变；判据顺序变 → hash 不变（规范序）。

当前值：**`7e3cc1a1830ac888`**。任何权重或判据调整都须同步更新本文件与决策日志，否则旧结论视为过期。

## 3. 测量协议（arms 与字段）

| 项 | 定义 |
|---|---|
| `N=1`（基线） | 单路生成一章；记录 `prompt_tokens` / `completion_tokens` / `cache_read_tokens` / `latency_ms` |
| `N=2`（中间点，可选） | 两路同前缀并联，判定共享是否真的发生 |
| `N=3`（目标） | 三路同前缀并联；同样四字段，另加 `cache_read_tokens` 归因 |
| 采样量 | **≥ 5 章**（`F003_MIN_CHAPTER_SAMPLES`），固定章节样本集 |
| 派生量 | 成本倍数 = `N=3` 总 token ÷ `N=1` 总 token；前缀缓存复用率 = `N=3.cache_read_tokens ÷ N=3.prompt_tokens` |

`prompt_tokens`/`completion_tokens`/`cache_read_tokens` 三字段必须来自 **provider 返回值**，不得由字符数估算；`latency_ms` 为墙钟。

## 4. 门禁阈值来源（全部取自既有代码，非本文发明）

| 阈值 | 值 | 来源（既有） |
|---|---|---|
| 硬封顶 | 240 000 token | `budget-counters.ts` `DEFAULT_TOKEN_HARD_CAP_TOKENS` |
| 软警告线 | 120 000 token | `budget-counters.ts` `DEFAULT_TOKEN_SOFT_WARN_TOKENS` |
| 单章墙钟预算 | 2 700 000 ms（45 min） | `budget-counters.ts` `WALLCLOCK_BUDGET_PER_CHAPTER_MS` |
| 成本倍数上限 | 2.5x | **本任务提案**（`F003_MAX_COST_MULTIPLE`，待人工批准） |
| 前缀缓存复用率下限 | 0.5 | **本任务提案**（`F003_MIN_PREFIX_CACHE_REUSE`，待人工批准） |
| 采样章数下限 | 5 | 任务卡原文「采样 ≥5 章」 |

判定实现：`rerank-rubric.ts` 的 `evaluateF003CostGate(input) -> F003GateVerdict`。**缺数据即 blocked**是刻意默认——门禁的意义就是不允许在缺数据时凭判断放行。

**提案阈值的可达性（解析发现）**：三路共享同一前缀时，复用率上界不是 1 而是 `ρ_max = 2p/3`（p = 单臂 prompt 中共享前缀的占比）。故 ρ ≥ 0.5 要求 **p ≥ 0.75**——即共享前缀必须占单臂 prompt 的四分之三以上。这个前提条件**必须**在实测中一并验证，否则 0.5 的下限可能是不可达的。

## 5. 结果

### 5.1 解析模型（**非测量**；纯算术推演）

设 `U = prompt 总长`、`p` = 共享前缀占比、`c = completion / prompt`、`r` = 缓存读计费折扣（`r=0.1` 表示缓存命中 token 按 10% 计费）。则

```
成本倍数(ρ, c, r) = [ 3 − 3ρ(1−r) + 3c ] / (1 + c)
```

两个必答结论：

**（1）N=3 相对 N=1 的成本倍数（无缓存时）**：`= 3.00x`，与 `c` 无关——三路完整 prompt + 三路 completion 都是三倍。

**（2）共享前缀缓存可将倍数压到多少**（`c = 0.15`，`r = 0.1`）：

| ρ（缓存复用率） | 倍数 | 对应 p |
|---|---|---|
| 0.00 | **3.00x** | 0 |
| 0.25 | 2.41x | 0.375 |
| 0.50 | 1.83x | 0.75 |
| 0.667（上界） | **1.43x** | 1.00 |

即可达区间为 **≈1.43x ~ 3.00x**。下界由 completion 侧决定（completion 不可缓存，恒为三倍）：`3c/(1+c) = 0.39x` 是理论地板，实际地板是 ρ 取上界时的 1.43x。

> 该模型**不能**代替测量：它假设「前缀确实共享且缓存确实命中」，而这两件事恰恰是实测要验证的对象（见 §4 的 p ≥ 0.75 前提）。**本门禁不采纳本节数字。**

### 5.2 实测（**not_executed**）

| arm | prompt_tokens | completion_tokens | cache_read_tokens | latency_ms | 章数 |
|---|---|---|---|---|---|
| N=1 | `not_executed` | `not_executed` | `not_executed` | `not_executed` | 0 |
| N=2 | `not_executed` | `not_executed` | `not_executed` | `not_executed` | 0 |
| N=3 | `not_executed` | `not_executed` | `not_executed` | `not_executed` | 0 |

**未执行原因（实测证据）**：

1. 本环境无 provider 凭据。已查：无 `~/.qmai`、无应用数据目录（`ls ~/.qmai` 与 `ls "$APPDATA/com.nikobuddy.app"` 均无输出）。
2. 仓库的真实 LLM 入口全部是**显式 opt-in**：`package.json` 的 `eval:l3 = cross-env REAL_LLM=1 vitest run src/lib/novel/eval/eval-harness.real-llm.spec.ts --no-file-parallelism`、`bench:llm = cross-env REAL_LLM=1 vitest run src/lib/novel/llm-latency.bench.ts`。执行它们会消耗真实配额，本会话无权代用户授权。
3. 因此**没有任何** `prompt_tokens` / `completion_tokens` / `cache_read_tokens` / `latency_ms` 数值是可报告的。**本文不提供任何估算值冒充实测。**

**待凭据就绪后的执行步骤（可直接照跑）**：

```bash
# 1) 真实 LLM 通路自检（会真实消耗配额）
npm run eval:l3
# 2) 墙钟时延基线
npm run bench:llm
# 3) 按 §3 协议对固定章节样本跑 N=1/2/3，收集四字段
# 4) 把每章聚合值喂给门禁函数，得到机械判定
node -e "…"   # 或直接调用 evaluateF003CostGate / formatF003GateVerdict
```

第 4 步的门禁入口已就绪，**无需再写代码**：`evaluateF003CostGate({ chaptersSampled, singleArm, threeArm })` 会返回 `decision` / `costMultiple` / `prefixCacheReuse` / `reasons`。

## 6. 门禁判定

```
F-003 cost gate: BLOCKED (rubric 7e3cc1a1830ac888)
cost multiple n/a; prefix cache reuse 0.000
- insufficient samples: 0 chapter(s) measured, need >= 5
- cannot compute a cost multiple: the N=1 baseline carries no tokens
- prefix cache reuse 0.000 is below the floor 0.5
```

上串由 `formatF003GateVerdict(evaluateF003CostGate({ chaptersSampled: 0, … }))` 实际输出（非手写）。

**后果**：

1. F-003 **不进入下一波**；TASK-010（conditional 窄版多路择优）**未实现**，登记为「因门禁未过而正确未执行」，不是遗漏。
2. A-F-003 维持**冻结**（0 行 F-003 代码），与阶段 2 覆盖矩阵的既有判定一致。
3. 硬否决复核：`MAX_PARALLEL=3` 命中 **0**、`multi_draft.rs` 中 `snapshots` 命中 **0**（见决策日志 §验证）。

## 7. 诚实缺口

1. **成本实测未执行**（§5.2）——本文最重要的结论因此是「不能放行」，而不是「放行且便宜」。
2. **`F003_MAX_COST_MULTIPLE = 2.5` 与 `F003_MIN_PREFIX_CACHE_REUSE = 0.5` 是本任务提案**，未经人工批准。两者都会进入 `rubric_hash` 覆盖范围之外的成本门参数（hash 只覆盖 rubric 权重与判据），故调参不会换 hash——这是**有意的**：调参是策略决定，rubric 是判据定义。
3. **解析模型的 `c = 0.15`、`r = 0.1` 是示例取值**，不是本项目实测值；换成真实值结论会变。
4. **N=2 中间点未定义采样**：协议里留了位置，但没有任何实现或验证说明两路并联是否产生可归因的缓存命中。
5. **`rerank-rubric.ts` 未加入 `src/lib/novel/index.ts` 导出面**：本任务未要求，且该文件尚无消费方（TASK-010 未实施）。一旦 F-003 解冻，须一并补上导出与消费方接线。
