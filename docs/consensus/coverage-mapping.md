# 共识验收：AI-Novel-Writing-Assistant → niko-buddy (QMAI) 功能覆盖+超越映射表

> 第 3 轮共识配套工件。锚点均为 `QMAI/src/lib/novel/`（另注）机械模块 + spec。
> 硬门终态（commit `1b3d828c`，smith/master）：tsc `--build` 0 错误；
> `npm run test:mocks` **13,019 passed / 852 文件**（基线 fedc2370 `12,833` 零回退）；
> `npx eslint src` 0 findings（exit 0）；`node scripts/check-boundaries.mjs` 4/4。
> 新 spec 17 文件共 132 个 it()（world-constraint 10 / auto-arm 15 / ledger-store 9 /
> gate-chain-e2e 9 / title-forge 7 / book-analysis-evolution 9 / director-followup 10 /
> repair-loop 8 / gate-retry-diff 5 / aura-homogenization 9 / trend-radar 5 /
> cross-form 8 / counterfactual 6 / visual-lineage 5 / dashboard-evidence 10 /
> evidence-dashboard-section 4 / subgate-alerts 3）。

| # | 对标模块 | niko-buddy 对应物（文件:行，机械口） | 超越点 |
|---|---|---|---|
| 1 | 世界样本/设定库 | `asset-library.ts` WORLD_SAMPLE_ENTRY_SCHEMA + `world-constraint-gate.ts:68` forbid:/require: DSL（硬→error 可 P0 FAIL，软→warning 永不 P0 FAIL） | 世界样本约束在门评估中**强制执行**且执行记录落账本 |
| 2 | 拆书/Aura | `book-analysis-*` + `book-analysis-evolution.ts:86` evolutionToAuraSeeds（单向闭环+守恒） | 拆书→aura 种子单向闭环可审计 |
| 3 | 三门机械门控 | `rule-stack.ts` + `audit-taxonomy.ts`（门序 P0>P1>P2 不可逆） | ADR-19 机械层：纯函数、零时钟、零模型 |
| 4 | 检索留痕 | `retrieval-trace.ts` + `search-adapter.ts` trace 透传；e2e:161 queryHash/modelId/corpusFilter/落选原因可点开 | 对标无强制留痕 |
| 5 | 证据链 | `run-event-ledger.ts`（append-only）+ `evidence-snapshot.ts:82` + `evidence-gate-card.tsx` + `dashboard-evidence.ts` + 首页/列表接线（`director-view.tsx` / `book-analysis-book-list.tsx`） | R-04 三态强制（未落=未发生永不显示通过） |
| 6 | 导演跟进 | `director-followup.ts:50` buildBlockingQueue（P0→P1→P2 队列+blockedBy 传染）+ `director-view.tsx`/`director-panel.tsx` | 阻塞传染+重跑成本不臆造 |
| 7 | 标题工坊 | `title-forge.ts:105` forgeTitles（候选×种子逐条对账裁定+落账） | 逐条 hit/miss 机械锚点 |
| 8 | 反 AI 修正闭环 | `repair-loop.ts:82`（闭环率+FP 账本聚合）+ `gate-retry-diff.ts:70`（同门两 run 差分+换模型轨迹） | 对标无闭环率/FP 量化 |
| 9 | 角色同质化 | `aura-homogenization.ts:81`（shingle Jaccard 告警+sharedSeeds）+ 声音漂移按章 + `character-aura-view.tsx` | 同质化告警事件+漂移按章入账 |
| 10 | 题材雷达 | `trend-radar.ts:45`（RadarSignal→kb 产物，sourceRef 出处强制+守恒复核） | 对标无；外部写入产物同样受检 |
| 11 | 多形态派生（短剧/漫画） | `cross-form-consistency.ts:114`（单向派生 blocked 语义）+ VIS-CONT 跨帧 aura 判据 + L9 显式 N/A | 单向派生永不反向改写母本 |
| 12 | 反事实重放 | `counterfactual-lab.ts:47`（任意 GateKey 通用化；对标仅 P0 固定）+ retrieval-trace counterfactualReplay | 通用化+收容回归测试 |
| 13 | 视觉血缘 | `visual-lineage.ts:59` assertVisualAppliesTo（appliesTo=module:visual，挂错面 fail-loud） | 证据链 visual/prompt@version/entry |
| 14 | 调度/熔断 | `scheduling-gate.ts`（INV-7 熔断零门控字段，熔断不写门控） | 对标无熔断隔离 |
| 15 | 草稿生命周期 | `novel-session-status.ts` 五态 + `auto-arm-status.ts`（apply 仅 pending→ready；assert 深扫 accepted 即抛，自动化零 accept） | 自动化路径结构性不可逃逸 |
| 16 | 记忆中心 | `memory-center-view.tsx`（既有底座） | — |

## 事件种类收容矩阵（契约，`run-event-ledger.ts:24` 注释 + 回归测试）

`readGateRunPayload`（`run-event-ledger.ts:329`）首查 `event.kind !== "gate-run"` 即 null：
stage 系（子门/告警/反事实）结构性无法污染三门权威。
gate-run→三门快照+覆盖分母唯一来源；retrieval→检索审计；
retry/generate→闭环修正判定；stage→子门告警面板（`deriveSubGateAlerts:139`）唯一来源；
quota/error/accept/kb-rebuild→不进任何门控口径。

## 撤销条件锚点（DeepSeek 轮 3 要求，实物可验）

- (a) `run-event-ledger.ts:329-333` kind 首查谓词
- (b) `director-modes.ts:205-216` arm 显式 pass 合取（fail-closed）
- (c) `prompt-artifacts.ts:38` appliesTo 必填无 default；`visual-lineage.ts:60-62` 唯一消费方 fail-loud
- (d) `auto-arm-status.ts:148-154` 唯一自动化 `draft_status` 写入者（精确匹配仅产出 ready）
- (e) `dashboard-evidence.spec.ts:151` 收容回归测试（stage 落账后门状态/快照/覆盖率/闭环统计不变）

## 共识裁决记录

- 轮 1：GLM continue（16 缺口）、DeepSeek continue（14 缺口）、Qwen FAIL（配额 400）
- 轮 2（卷宗模式，子进程 relay EPIPE）：GLM continue（P1 G-14）/ DeepSeek continue（P0 形态未决 E1）/ Muse complete
- 波2-E（`1b3d828c`）：G-14 修复 + E1 机械证伪 + 收容矩阵固化
- 轮 3（卷宗模式）：GLM **complete** / DeepSeek **complete** / Muse **complete**（agent 记录见 todo #369）
- 行号勘误：卷宗中所记 `readGateRunPayload:318` 实际为 `:329`（注释新增 11 行所致，无害漂移）
