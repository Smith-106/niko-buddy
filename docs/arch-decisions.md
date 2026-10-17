# 架构决策索引（ADR Index）

> 唯一索引真源：本文件收敛散落在 `src/**` 注释、`docs/decision-log/`、`.workflow/specs/` 中的
> ADR 锚点。**编码时引用 ADR 一律写 `ADR-nn`，取值以本表为准；新增 ADR 只在本表登记一行。**
> 生成背景：`.swarm/ts-bloat-20261017` 裁决（架构指控「部分成立：外壳每借包一层，内核有纯函数反例」）。

## 1. 已登记 ADR

| ID | 决策 | 落地锚点（代码） | 判定式 / 不能做什么 |
|----|------|------------------|---------------------|
| ADR-19 | **机械层零模型调用**：契约/算法层为纯函数 + zod，零 IO、零时钟、零模型调用，时间由调用方注入 | `arc-settlement.ts`、`asset-library.ts`、`audit-taxonomy.ts`、`auto-arm-status.ts`、`budget-counters.ts`、`book-analysis-evolution.ts`、`aura-homogenization.ts` | 机械层内不得出现 `Date.now()` / `invoke` / `streamChat`；需要时间一律注入 |
| ADR-26 | **no dual truth source**：单一真源 + 影子对账，不设第二份权威状态 | `canon-dual-write.ts`、`canon-store`、`.novel/status.json` | 不得新建第二份会话/正典状态文件；影子只做对账 |
| ADR-29 | **逐步迁移**：旧入口保留薄包装，新内核逐步接管，签名零变化 | `context-engine.ts`（`buildContextPack`）、`search-adapter.ts`（`runVectorSearch`） | 迁移期不得直接删除旧导出；先 re-export 再切调用点 |
| ADR-32 | **四维反查融合**：伏笔/出场/状态/关系组合成可注入上下文，不与内容检索重复实现 | `context-engine.ts: buildRelatedChaptersContext`、`related-chapters.ts` | 不得在检索层平行实现四维反查 |
| ADR-34 | **Draft-first**：AI 输出先进 pending/ready 草稿，accept 后才回填正文与正式记忆 | `deep-chapter-generation.ts`、review adapters | 禁止直写正式正文/正式记忆 |
| ADR-47 | **检索维实测解锁判定式**：影子采集 → `eval:gov` 判据 → 才允许解锁开关 | `kb-shadow-collector.ts`、`kb-shadow-harness.ts` | 不得以「shadow 有数据」代替判定式直接解锁 |
| ADR-48 | **裁决 ≠ 开启**：门禁与谓词同 commit 更新，双臂证据齐备才算解锁 | `consensus-antigoals.ts`、`ann/ann-recall-harness.ts`、`docs/kb-flag-promotion-flow.md` | 不得只改开关不补谓词/证据 |

## 2. 结构与拆分决策（本索引新增，编号预留）

| ID | 决策 | 落地锚点 |
|----|------|----------|
| ADR-49 | **巨文件拆分范式**：`>1500` 行实现文件按「同实现搬迁 + 主文件 re-export」拆分，公开 API 与调用点零改动；拆分后每条路径必须 typecheck + 受影响 spec 全绿 | `deep-chapter-{runtime-support,context-assembly,review-repair}.ts`、`context-engine-{gaps,technique-sources,temporal,outline,prompt}.ts`、`retrieval-source-pipeline.ts`、`deterministic-continuity-denoise.ts` |
| ADR-50 | **命名唯一映射真源**：结案步骤名与实体目录名的多轨写法只在 `naming-canonical-map.ts` 定义，其余模块只读该映射，不各自硬编码 | `src/lib/novel/naming-canonical-map.ts` |
| ADR-51 | **adapter 公共层**：多源检索的纯函数（源权重 / RRF / 去重代表选择 / 单源超时）只允许存在于 `retrieval-source-pipeline.ts`，adapter 只做编排 | `retrieval-source-pipeline.ts`、`search-adapter.ts` |

## 3. 引用纪律

1. 代码注释引用 ADR 使用 `ADR-nn`；不得自造未登记的 ADR 编号。
2. 新增 ADR：本表登记 + `docs/decision-log/` 追加一份决策记录（一次改动可只登记表，重大决策需记录）。
3. 与 `.workflow/specs/` 冲突时，以本表 + 对应 spec 的显式条款为准，冲突需在 §3 记录处理结论。

## 4. 已知冲突与待收敛（诚实披露）

| 项 | 现状 | 处理 |
|----|------|------|
| `canon-dual-write.ts` 与 `canon-store` 双写窗口 | ADR-26 允许影子对账，退役前仍存在双写 | 按 ADR-26 T+5 退役计划执行，本索引不新增例外 |
| 三 adapter 体积（拆分前 `1170/1171/1165`） | 已抽出公共层，`search-adapter` 降至 ~1046 行 | `review-adapter` 因并行脏文件纪律本批未触碰，下一批接入 |
