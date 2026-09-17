# 检索强化评测矩阵（R3-a，2026-09-17）

> 来源：批准计划 r2（`planHandoffKey 738a75141a5a6b2386f8b38eef21ef600dedf9461eca4972037b2f0b68f55113`）§R3。
> 本文件是**治理文档**（矩阵口径 / 回归网 / 裁决网 / backlog 认领条件），与门控产物（`docs/p0/<topic>-<date>.md` 证据快照）分工不同：证据快照可重生成，本文件是口径真源、须可 diff 审计。
> 生效前置：R-1 反目标门禁（`consensus-antigoals.ts` + `scripts/guard-consensus-antigoals.mjs`）在 CI 侧常绿，本矩阵不得作为「收敛结论」使用（反目标 #3）。

## 1. 证据面矩阵（R-1 → R2）

| 波次 | 面 | 输入 | 判据 | 产物 / 通道 | 门禁（可执行） | 现役值（2026-09-17） |
|------|----|------|------|-------------|---------------|---------------------|
| R-1 | 反目标门禁 | 语料计数 / flag 默认值 / novel 核心检索函数清单 / `docs/p0` 清单 | 六条反目标（AG1 语料上限 64 且基线 6；AG2 flag 期望值 dual=false/hardInject=true/usefulness=false；AG3 收敛声称须豁免标记；AG4 只许 `src/lib/novel/` 内定义；AG5 rule-stack 须含 `gate!=="quality"` + `GATE_PRIORITY_ORDER`；AG6 只看 corpus 集合） | 判定核 `consensus-antigoals.ts`；IO 层 `scripts/guard-consensus-antigoals.mjs`（exit 0/2/3，含 TS 字面同步自检） | `consensus-antigoals.gates.spec.ts`（14）+ guard 双跑 | ALL PASS(6/6)；corpus=6 ≤ 64；flags 与期望一致 |
| R0-a | 同尺迁移评测 | golden-34 fixture + `kb-routing-view.generated.json` + WeKnora 快照（`weknora-snapshot.1ef38fdb.json`，只读抽取 commit `1ef38fdb`） | Wilson 95% CI（z=1.96, N=34）**下界** ≥ 阈值（默认 0.7）：`lower >= threshold ? triggered : 未达裁决` | `same-scale-harness.ts`（`compareSameScale`/`wilsonScoreInterval`）；报告 `docs/p0/same-scale-<date>.md`（门控 `SAME_SCALE_REPORT=1`） | `same-scale-harness.spec.ts`（13，含 24/34→[0.5384,0.8317] 手算对照）+ `same-scale-report.spec.ts`（3） | top3 34/34 = 1.0000，CI [0.8985, 1.0000] → **triggered**；掉档 0 |
| R0-b | rerank 触发证据 | golden ranks 分档（query/rank/top3/top20）+ 基线阈值 | top20 守住（`top20Rate ≥ minTop20Rate`）**且** top3 掉档（`top3Rate < minTop3Rate`）→ triggered；top20 未达 → armed | 判据核 `rerank-trigger-evidence.ts`（`collectRerankTriggerEvidence`）；留痕 channel `rerank-trigger`（槽位 `rerank-candidate`）；产物 `docs/p0/rerank-trigger-evidence-<date>.md`（门控 `RERANK_TRIGGER_EVIDENCE=1`） | `rerank-trigger-evidence.spec.ts`（13）+ golden F5 接入单一真源 | status=**armed**（top3 34/34、top20 34/34）→ rerank **未获采纳依据**（谓词 locked） |
| R0-c | 运行时 span 面 | `search-adapter.novelMixedSearch` 六 stage 真实注入点 | 契约序完整：`tokenize → sources → rrf → tiering → rerank_trigger → cap_degrade`（缺环/乱序/重复 fail-loud） | `retrieval-span.ts`（`makeRetrievalSpan`/`createRetrievalSpanCollector(now)`/`assertRetrievalSpanSequence`）；留痕 channel `retrieval-span` | `retrieval-span.spec.ts`（13）+ `search-adapter.spec.ts` 真实链路集成测（传/不传 spans 结果同形） | 六 stage 全量落 span；可选参数零语义改动（+40/−2 行） |
| R0-d | 延迟成本预算账本 | 路径（source/rerank）+ 实测耗时 | `within = measuredMs < budgetMs`；达上限即 `reject_fallback`（真实超时恰好落上限）；可回退注册表按调用级 ctx 幂等注册 | `retrieval-budget.ts`（数值真源 2500/2500/45000 + `checkRetrievalBudget` + `registerRollback/ensureRollback/rollback`）；λ 初值 `RETRIEVAL_LAMBDA_INITIAL = 25 ms/pp, calibrated=false` | `retrieval-budget.spec.ts` + `search-adapter.spec.ts` / `context-engine` 超时语义等价测（fake timers） | 常量收编单一真源；2500ms 超时 → 回退 [] + 账本记账；rerank `.catch` 保留原候选（语义不变） |
| R1 | 策展闸门（资产空置） | 全字段内容面快照（`reference-kb-view.content-<sha>.json`，sha 后缀冻结） | 债分 ≤ `CURATION_DEBT_CAP`(0)：`missing_field +2` / `no_provenance +1` / `short_summary +1` / `theme_vacant +3`（**题材@collection 粒度**）/ `collection_vacant +3` | 判定核 `curation-gate.ts`（`scoreCurationBatch`）；IO 层 `scripts/check-curation-debt.mjs`（exit 0/2/3 + TS 字面同步自检），串联进 `sync-kb-view-to-qmai.mjs --check` | `curation-gate.spec.ts`（16，含真实面债分 0 与负向控制）+ `channel-b-attribution.spec.ts`（7） | 债分 **0** / 80 条；负向控制（抽掉 10 张修仙世界卡）exit 2 点名 `theme_vacant+3 修仙@world_ref`；通道 B：world_ref 8→18、lexicon 38→44，修仙探针 10/10 命中 |
| R2 | 解冻提名谓词 | R0-a/b/c/d 四产物 + 现役规模 + λ | 逐谓词（提名 ≠ 开启）：rerank = 语料 > 1000 **AND** R0-b status=triggered；MMR = 净增益(pp) = 簇内 top3 增益(pp) − p95 延迟增量(ms)/λ(ms_per_pp) > 0 且簇 ≥ 30；扇出 = 探针 + R0-b 采集器重放自洽；ANN 恒 locked | `scale-unlock-gates.ts`（`evaluateUnlockGates` + 理由码枚举 + `formatUnlockGateReport`）；报告 `docs/p0/scale-unlock-<date>.md`（门控 `SCALE_UNLOCK_REPORT=1`） | `scale-unlock-gates.spec.ts`（22）+ `scale-unlock-report.spec.ts`（6，读真实产物 + 与 golden `_meta.rerankTrigger.status` 交叉校验） | 语料 80 → **4/4 locked、0 提名**：`rr_corpus_below_threshold` / `mmr_corpus_below_threshold` / `fanout_corpus_below_threshold` / `ann_no_implementation`；`configMutated=false` |

### 1.1 统一口径声明

- **统计口径冻结**：N=34（golden 集），z=1.96，Wilson 95% 双侧；裁决只看 **CI 下界**——点估计 ≥ 阈值但下界 < 阈值记「未达裁决」（不得记 triggered）。
- **阈值状态**：R2 的全部数量阈值（语料 1000 / chunk 1e4 / 簇 30 / 净增益下限 0pp）与 R0-d 的 λ（25 ms/pp）均为**待标定初值**，非同源矩阵缺席期间不得当作已标定口径。
- **提名 ≠ 开启**：谓词只产出解冻候选提名；开启仍走 `docs/kb-flag-promotion-flow.md` 双臂离线评测（`consistencyNoRegression && qualityGain && seedCaseCoverage ≥ MIN_SEED`）→ gate PASS 判据包（ADR-48）。
- **报告落盘策略**：`docs/` 默认 gitignore（`.gitignore:/docs/*`）；证据快照靠门控环境变量重生成（`SAME_SCALE_REPORT=1` / `RERANK_TRIGGER_EVIDENCE=1` / `SCALE_UNLOCK_REPORT=1`）；**本矩阵为治理文档，`git add -f` 入仓**（沿用 `docs/consensus/coverage-mapping.md`、`docs/p0/gov-seed/*` 的治理文档先例：口径类文档必须可 diff 审计）。
- **状态真源**：任何报告都不写 `.novel/status.json`（状态真源唯一）；flag 默认值变更须单独 commit 且注明 `git revert` 对象，禁止与数据填充同 commit。

## 2. golden-34 的降级角色：回归网（非裁决集）

| 项 | 值 |
|----|----|
| 文件 | `src/lib/novel/__fixtures__/golden-queries.json` |
| 角色 | **回归网**：任何检索链改动（路由/分词/融合/重排/回退）都不得使其降级 |
| 阈值 | `minHitRate 0.9` / `minHitsPerQuery 1` / `minTop20Rate 0.9` / `minTop3Rate 0.7` |
| 现役 | top3 34/34、top20 34/34、命中率 34/34（全绿） |
| 明确禁止 | 用作「收敛结论 / 已收敛」的证据——同源集只证非劣化（反目标 #3 豁免标记见 `consensus-antigoals.ts` 的 `CONVERGENCE_CLAIM_PATTERNS`）；跨系统结论必须走非同源集（§3） |
| 回归触发 | 任何 PR 触及 `src/lib/novel/` 检索面 → 必跑 `golden-retrieval.spec.ts`；`kb-shadow-harness.spec.ts` 同列必跑集 |

## 3. 非同源多集裁决矩阵（目标态；当前缺席）

| 集 | 来源 | 规模 | 阈值口径 | 裁决 | 现状 |
|----|------|------|----------|------|------|
| W 面（WeKnora demo） | `reference/` 只读抽取（`scripts/extract-weknora-snapshot.mjs`，commit `1ef38fdb`） | queries 1 / corpus 4 / qrels 4（**全标**，无判别力） | 仅作方法学同尺参照（口径对齐表） | **未达裁决** | W 面服务不可运行 → 已诚实降级为方法学同尺 + 口径声明（`docs/p0/same-scale-2026-09-16.md`，首页声明非同实例对跑）；qrels 全标 → topK 恒 1.0，不伪造跨系统数字 |
| 第三方公开检索集 | 待认领（候选：公开中文长文 QA/检索集，许可须可再分发） | 认领时定（建议 N ≥ 100 queries） | Wilson 95% CI 下界 ≥ 阈值 | 待裁决 | **backlog（R0-a2）** |
| 内部非同源写作集 | 待建（跨题材/跨书稿的真实写作查询 + 人工 qrels） | 认领时定 | 同上 + 掉档 query 清单必附 | 待裁决 | **backlog（R0-a2）** |

### 3.1 R0-a2 认领条件（进入裁决矩阵的门槛）

1. **集身份**：来源、许可、规模（query 数 N、corpus 数、qrels 行数）三者齐备，且与 golden-34 非同源（不共享 query/corpus 文本）；
2. **口径声明**：写明 tokenization/分词、命中判据（如正确项 rank 分档）、阈值来源；与 §1.1 冻结口径一致，偏离须显式声明；
3. **可复跑**：抽取脚本 + 快照 fixture（文件名带源 commit sha）+ `--check` 幂等校验；
4. **裁决输出**：N、top3/top20 率、Wilson 95% CI 下界、掉档 query 清单、判定（triggered / 未达裁决）；CI 下界 < 阈值不得记 triggered；
5. **反目标合规**：不得以同源集充数（AG3）；不得在豁免标记外声称收敛。

## 4. Backlog（护城河线与工程预案）

| # | 项 | 归属 | 现状与依赖 | 认领条件 / 下一步 |
|---|----|------|-----------|------------------|
| B1 | 非同源多集裁决矩阵落地（R0-a2） | 评测 | §3 缺席；W 面服务不可运行 | 按 §3.1 五条；先做「内部非同源写作集」（可控许可），再谈第三方集 |
| B2 | 阈值标定（1000 语料 / 1e4 chunk / 30 簇 / 0pp / λ=25 ms/pp） | 评测 + 成本 | 全部为待标定初值（R2 §1.1） | 需 B1 产出非同源延迟-质量配对点（≥30 点）→ 回归标定 λ；标定后须改 `RETRIEVAL_LAMBDA_INITIAL.calibrated=true` 并单 commit |
| B3 | ANN / 分片预案 | 检索底座 | 无实现（`ann_no_implementation` 恒 locked）；占位类型见 `retrieval-scale-placeholders.ts` | 实现向量索引（HNSW/IVF 选型）+ 分片路由；接入前须过 §3 裁决矩阵 + 预算账本（R0-d） |
| B4 | 矿脉管道契约（ore pipeline） | 语料供给 | 契约占位（`OREPIPE_CONTRACT`，**⓪ 计价待定**：单价/成本模型未拍板） | 先定计价与配额（付费源/自有语料比例）→ 再冻结契约版本；当前仅占位类型 |
| B5 | 护城河线：lexicon 扩容 + 意图路由 + 题材词典长期投入 | 知识资产 | lexicon 44 / world_ref 18（R1 后）；意图路由 = `routeByQueryIntent` allowlist（现役 craft/lexicon/world_ref/corpus） | 按题材滚动扩容（保持 `CURATION_DEBT_CAP=0`）；意图→collection allowlist 变更须配 R1 归因 spec + 债分门禁；题材词典以内容包（CC0 + ADR）为单位增补 |

## 5. 收口绑定记录（R3 开工/收口）

| 项 | 开工 | 收口 |
|----|------|------|
| HEAD | `da1a6c6b`（R-1 门禁进仓前重核） | 见本文末「收口提交」行（R3 收口 commit） |
| 规模计数 | `corpus 6 / craft 12 / lexicon 38 / world_ref 8`（R1 前） | `corpus 6 / craft 12 / lexicon 44 / world_ref 18`（R1 后，builtFrom `sha256:ec3f9b0e01c912cb`） |
| flag 默认值 | `dual false / hardInject true / usefulness false` | **不变**（`src/stores/wiki-store.ts:435/440/441`） |
| 会话状态文件 | `.novel/status.json`（唯一） | 同前，无第二状态文件 |

> 收口提交行由 R3 收口时补齐（commit sha + `master...smith/master` 一致性）。
