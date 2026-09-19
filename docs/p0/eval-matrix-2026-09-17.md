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
| R1 | 策展闸门（资产空置） | 全字段内容面快照（`reference-kb-view.content-<sha>.json`，sha 后缀冻结） | 债分 ≤ `CURATION_DEBT_CAP`(0)：`missing_field +2` / `no_provenance +1` / `short_summary +1` / `theme_vacant +3`（**题材@collection 粒度**）/ `collection_vacant +3` | 判定核 `curation-gate.ts`（`scoreCurationBatch`）；IO 层 `scripts/check-curation-debt.mjs`（exit 0/2/3 + TS 字面同步自检），串联进 `sync-kb-view-to-niko-buddy.mjs --check` | `curation-gate.spec.ts`（16，含真实面债分 0 与负向控制）+ `channel-b-attribution.spec.ts`（7） | 债分 **0** / 80 条；负向控制（抽掉 10 张修仙世界卡）exit 2 点名 `theme_vacant+3 修仙@world_ref`；通道 B：world_ref 8→18、lexicon 38→44，修仙探针 10/10 命中 |
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

## 3. 非同源多集裁决矩阵（目标态；第三方集仍缺席）

| 集 | 来源 | 规模 | 阈值口径 | 裁决 | 现状 |
|----|------|------|----------|------|------|
| W 面（WeKnora demo） | `reference/` 只读抽取（`scripts/extract-weknora-snapshot.mjs`，commit `1ef38fdb`） | queries 1 / corpus 4 / qrels 4（**全标**，无判别力） | 仅作方法学同尺参照（口径对齐表） | **未达裁决** | W 面服务不可运行 → 已诚实降级为方法学同尺 + 口径声明（`docs/p0/same-scale-2026-09-16.md`，首页声明非同实例对跑）；qrels 全标 → topK 恒 1.0，不伪造跨系统数字 |
| 第三方公开检索集 | 待认领（候选：公开中文长文 QA/检索集，许可须可再分发） | 认领时定（建议 N ≥ 100 queries） | Wilson 95% CI 下界 ≥ 阈值 | 待裁决 | **backlog（R0-a2）** |
| 内部非同源写作集（B1，已落地） | **本仓自建**：参考库条目身份规则导出（`scripts/build-internal-eval-set.mjs`，5 探针面：title/domain/genre-domain/name-latin/purpose） | **N=336**（跨 6 流派；gold 92 条：world_ref 27 + lexicon 53 + craft 12；排除 corpus 范文面） | 义务召回率 + Wilson 95% CI 下界（top3 ≥ 0.70 / top20 ≥ 0.90）；**不使用 MRR/NDCG** | **内部一致性：PASS**（@top3 334/336=0.9940 CI[0.9786,0.9984]；@top20 336/336 CI[0.9887,1.0000]；掉档 2 条） | `source="reference-library-self-built"`；**不构成第三方裁决 / 不构成跨系统裁决**；**非 real 门锚点**（real 门 case 来自 canon 抽取）；毒块拦截仅提取期双证（44/44 零入消费面），面内无 veto（负向控制 40/40 浮现，如实声明）；报告 `docs/p0/non-same-source-2026-09-17.md` |

### 3.1 R0-a2 认领条件（进入裁决矩阵的门槛）

1. **集身份**：来源、许可、规模（query 数 N、corpus 数、qrels 行数）三者齐备，且与 golden-34 非同源（不共享 query/corpus 文本）；
2. **口径声明**：写明 tokenization/分词、命中判据（如正确项 rank 分档）、阈值来源；与 §1.1 冻结口径一致，偏离须显式声明；
3. **可复跑**：抽取脚本 + 快照 fixture（文件名带源 commit sha）+ `--check` 幂等校验；
4. **裁决输出**：N、top3/top20 率、Wilson 95% CI 下界、掉档 query 清单、判定（triggered / 未达裁决）；CI 下界 < 阈值不得记 triggered；
5. **反目标合规**：不得以同源集充数（AG3）；不得在豁免标记外声称收敛。

## 4. Backlog（护城河线与工程预案）

| # | 项 | 归属 | 现状与依赖 | 认领条件 / 下一步 |
|---|----|------|-----------|------------------|
| B1 | 非同源多集裁决矩阵落地（R0-a2） | 评测 | **内部非同源集已落地**（2026-09-17）：N=336 / 6 流派 / 5 探针面，qrels 规则导出（`kb/internal-eval-set.generated.json`，`source="reference-library-self-built"`）；判定核 `internal-eval-set.spec.ts`（义务召回率@top3 334/336=0.9940 CI[0.9786,0.9984] 下界≥0.70 PASS；@top20 336/336 PASS）；**第三方集仍缺席，W 面（WeKnora）服务不可运行 → W 面维持「未达裁决」** | 第三方集按 §3.1 五条认领；内部集不得冒充第三方/跨系统裁决（报告首段已声明）；W 面可运行时重跑同尺比较 |
| B2 | 阈值标定（1000 语料 / 1e4 chunk / 30 簇 / 0pp / λ=25 ms/pp） | 评测 + 成本 | **λ 标定证据已产出，未翻位**：`lambda-calibration.ts` + 双臂 harness（配对点取内部集全 336 条）→ 非零 Δpp **仅 1/336**（增益 0/损失 1）、排序变化 105/336 但 top3 成员变化 1、增量 ~0.21 ms/query → R²=0.0000 **未达标**（`r2_below_threshold`，近零信号→slope 不可采信）；`calibrated=false` / λ=25 ms/pp / 四阈值全不变 | 需**有判别信号**的配对点（当前规模下重排不产生 top3 义务增益 → 与 R2 `mmr_corpus_below_threshold` 互为交叉印证）；标定达标后方可谈 `calibrated=true`（须单 commit + 注明 revert 对象） |
| B3 | ANN / 分片预案 | 检索底座 | **分片已实做**（B3-a）：`shard-routing.ts`（resolve/select/merge + 可选 `shards` 参数接入 `novelMixedSearch`；不传=字节等价，六 stage 契约序与「先过滤后截断」不变）→ `SHARD_PLAN.implemented=true`；**ANN 仅接口 + 精确参考**（B3-b）：`ann/ann-index.ts`（`AnnIndex` 契约）+ `ann/brute-force-index.ts`（exact=true）+ recall/延迟 harness（注入时钟）→ `ANN_PLAN.implemented=false`，谓词 `ann_no_implementation` **仍 locked** | 近似索引（HNSW/IVF/DiskANN）未实现：认领方须同 schema/同名次口径、过 `ANN_HARNESS` 延迟地板、并同 commit 更新 ANN_PLAN + 谓词（ADR-48）；精确参考 recall=1.0 **不构成可用性证据** |
| B4 | 矿脉管道契约（ore pipeline） | 语料供给 | **计价骨架已定，计价仍待定**：`ore-pricing.ts`（三候选 per-token/per-entry/subscription，`decided:false`；`estimateOreCost`/`checkOreQuota` 纯函数，费率必传不内置）+ 契约 `pricing.models` 入清单；`pricing.status="pending"` / `unitPrice` 未填 / `enabled=false` / `isOrePipelineUsable()=false` **全部保持** | 单价/成本模型/配额由**用户拍板**（本任务范围外）；未拍板前不得升契约 minor、不得启用管道 |
| B5 | 护城河线：lexicon 扩容 + 意图路由 + 题材词典长期投入 | 知识资产 | **扩容 + 路由已实做**：内容包 16→**34 个自建 CC0 包**（新增奇幻/武侠/科幻 3 流派 ×6），REFERENCE-INDEX 193→**211 项**，QMAI 消费面 `builtFrom=sha256:df39ecbc9a177c41`（craft 12 / lexicon 53 / world_ref 27 / corpus 6；债分 `CURATION_DEBT_CAP=0` 保持）；意图路由 `revise` allowlist 补 `world_ref`（修订需回引世界/设定事实）+ 新归因 spec `intent-routing-attribution.spec.ts` | 按题材滚动扩容（保持债分 0）；allowlist 变更须配意图×题材归因 spec + 债分门禁；题材词典以内容包（CC0 + LICENSE + ADR）为单位增补 |

## 5. 收口绑定记录（R3 开工/收口）

| 项 | 开工 | 收口 |
|----|------|------|
| HEAD（r2 波） | `da1a6c6b`（R-1 门禁进仓前重核） | `edb4cfe6`（R-1→R3 全波收口）→ `98fcb7b2`（收口行补齐） |
| HEAD（r3 波：B1–B5） | `98fcb7b2` | 本行 commit sha（见下「r3 收口验证」） |
| 规模计数 | `corpus 6 / craft 12 / lexicon 38 / world_ref 8`（R1 前） | `corpus 6 / craft 12 / lexicon 53 / world_ref 27`（B5 后，builtFrom `sha256:df39ecbc9a177c41`） |
| flag 默认值 | `dual false / hardInject true / usefulness false` | **不变**（`src/stores/wiki-store.ts:435/440/441`） |
| 会话状态文件 | `.novel/status.json`（唯一） | 同前，无第二状态文件 |
| λ / R2 阈值 | λ=25 ms/pp `calibrated=false`；1000/1e4/30/0pp | **不变**（B2 只产出证据，未翻位） |
| ANN / pricing 门控 | `ANN_PLAN.implemented=false`；`pricing.status=pending` | **不变**（B3-b 仅接口+精确参考；B4 仅骨架）——唯一描述性例外：`SHARD_PLAN_PLACEHOLDER.implemented false→true`（分片已实做；无门控/配置消费者） |

> 收口验证（2026-09-17，QMAI `edb4cfe6`）：vitest scoped 16 文件 424 passed / 1 skipped（含回归必跑集 golden-retrieval、kb-shadow-harness）；typecheck 0 错；`eslint src` clean；boundaries 4/4；antigoals ALL PASS(6/6)；anchors ALL PASS(9/9)；生成器 `--check` 三链一致（`sync-kb-view-to-niko-buddy.mjs`（含策展债分门禁）/ `snapshot-kb-view-content.mjs` / `extract-weknora-snapshot.mjs`）。收口后 `master...smith/master` 一致性与本行 commit sha 的对应关系由推送记录核验。
>
> flag 默认值变更：**无**（本次未翻任何默认值，故无 `git revert` 对象需注明）；数据填充（R1 内容包）与任何默认值变更均未同 commit（后者不存在）。
