# 20261102 同步三目标 · 批次裁决 · 前缀缓存 · 正史规则保护（ralph-sync-cache）

> 范围：Session `20261102-ralph-sync-cache` 全波次（W1–W4）收口记录（TASK-001 … TASK-008）。
> 代码面：
> `src-tauri/src/commands/secret_store.rs`（`nb:` 逻辑域凭据层）、
> `src-tauri/src/commands/sync_target.rs`（传输编排层）、
> `src-tauri/src/commands/sync_target_decision.rs`（决策纯支撑层）、
> `src-tauri/src/commands/sync_scheduler.rs`（后台调度与门禁）、
> `src/lib/novel/snapshot-scanner.ts`（批量提取范围/预算纯函数）、
> `src/lib/stable-prefix.ts`（稳定前缀唯一真源）、
> `src/lib/llm-request-trace.ts` + `src/lib/cache-hit-harness.ts`（命中口径）、
> `src/lib/context-budget.ts` + `src/lib/novel/context-compact.ts`（预算/压缩/规则保护）、
> `src/i18n/{zh,en}.json`（`sync.*` / `extract.*` / `rules.*`）。
> 关联记录：双改三路语义见 `20261102-sync-conflict-semantics.md`（本文件不复述其条目，只引用结论）。
> 引用纪律：只用**符号引用**（函数 / 常量 / 字段名），不写行号（行号随实现漂移会让复核空转）。

## 一、决策条目（D1–D8 最终选择）

| 编号 | task_id | decision_type | 最终选择 | evidence_ref |
|------|---------|---------------|----------|--------------|
| D1 | TASK-001 | 裁决人 | **GitHub 私有仓是第三种传输目标，凭据走 `nb:github:<account>` 逻辑域句柄**。配置只持有句柄，明文只进系统钥匙串；非 `nb:github:` 域在**配置期**即被拒（`require_github_credential_ref`）。Linux 无 Secret Service 时**拒绝明文回落**并给出可操作提示（`github_store_degraded_message`），宁可不可用也不静默降级。传输选型 R1：≤ `CONTENTS_API_MAX_BYTES`（1 MiB）走 contents API 单 PUT（带 sha 并发保护，防覆盖他端写入），> 1 MiB 走 Git Data API（blob → tree → commit → ref）——同一个分界点同时用于写与读兜底（contents API 对 >1 MiB 不回内容，改用 blob sha 取原始字节） | `sync_target.rs` `GITHUB_ENDPOINT` / `GITHUB_API_BASE` / `CONTENTS_API_MAX_BYTES` / `choose_transfer_path`；`secret_store.rs` `GITHUB_SECRET_DOMAIN` / `GITHUB_CREDENTIAL_REF_PREFIX` / `github_credential_ref` / `require_github_credential_ref` / `github_store_degraded_message`；`src/lib/secret-client.ts` `isGitHubCredentialRef` |
| D2 | TASK-002 | 裁决人 | **本地文件夹目标 + `enabled` 是全局开关（不是单目标启用位）**。本地目标 `endpoint = "local"`、块 `{localPath}`、`credential_ref` 必须为空串（本地目标无凭据，配了就是配置错误）；目标目录首次推送自动创建。`sync_enabled` **默认 false**，只有显式 `true` 才算开启（读不出来 = 关闭）：关闭时 `evaluate_gate` 直接返回 `SkipReason::Disabled`，`sync_scheduler_start` 拒绝启动，一切自动触发全停，只留手动入口。间隔档位是契约：`SCHEDULE_INTERVAL_MINUTES = [15, 30, 60]`，越界在配置期拒收。**手动「立即同步」与后台调度同一条 `run_cycle`**，不存在手动/自动两套判定；「没跑」不是异常，`SkipReason` 六值（`disabled` / `not_configured` / `window_closed` / `sleeping` / `offline` / `no_artifact`）原样上报并**照常落 skip journal**（不静默） | `sync_target.rs` `LOCAL_ENDPOINT` / `SCHEDULE_INTERVAL_MINUTES` / `validate_schedule` / `SYNC_CONFIG_FILE`；`sync_scheduler.rs` `SkipReason` / `evaluate_gate` / `append_skip_journal`；`src/components/settings/sync-settings.tsx`；`src/commands/sync.ts` `DEFAULT_SYNC_ENABLED` / `SYNC_SCHEDULE_INTERVALS` |
| D3 | TASK-003 | 裁决人 | **批次明细 + 双改逐项 pick-and-apply 的完整语义按 `20261102-sync-conflict-semantics.md` 的 G2b-1 … G2b-12 执行，本波次不再改动**。三条硬边界在此复述以免被后续改动绕过：① 默认裁决恒 `keep_both`，无 base 时后端**硬拒** `pick_mine` / `pick_theirs`（不是只置灰）；② 空 `actor` 整次拒绝（禁止静默自动裁决）；③ 裁决落 `.novel/resolutions/<batch_id>/<path>`，不写工作文件树，逐项 journal 与传输 journal 物理分文件。批次回看窗口 `BATCH_DETAIL_LIMIT = 20`，`transport-health` 行不计入批次 | `sync_target_decision.rs` `PickChoice` / `apply_item_decisions_impl` / `base_state_before`；`sync_target.rs` `SYNC_JOURNAL_FILE` / `SYNC_ITEM_JOURNAL_FILE` / `batches_impl` / `BATCH_DETAIL_LIMIT`；`CloudBackupPanel.tsx` 批次记录区 |
| D4 | TASK-004 | 裁决人 | **批量提取把「范围」与「预算」做成纯函数，UI 只读常量、不写副本**。范围两值（`missing` 默认 / `all`），全量模式默认跳过已有完整快照（`DEFAULT_BATCH_SKIP_EXISTING = true`），`force` 才无视跳过。预算 **默认 20 章、硬顶 60 章、强制开启**（`BATCH_EXTRACT_BUDGET_DEFAULT` / `_MAX` / `_ENFORCED`）：超限即停并记账 `skippedByBudget`，界面明示超限章数——这是 R3（全量重提烧预算 / 失控排队）的直接缓解。**Draft-first**：产出只停在 `ready` 草稿，必须经 accept 才回填正式记忆（`BATCH_DRAFT_REQUIRES_ACCEPT`），批量提取不会静默改写记忆库。批量链路复用既有 confirm / extract / abort / 进度通道，不新开第二套 | `snapshot-scanner.ts` `DEFAULT_BATCH_EXTRACT_SCOPE` / `DEFAULT_BATCH_SKIP_EXISTING` / `DEFAULT_BATCH_FORCE` / `BATCH_EXTRACT_BUDGET_DEFAULT` / `BATCH_EXTRACT_BUDGET_MAX` / `BATCH_EXTRACT_BUDGET_ENFORCED` / `BATCH_DRAFT_REQUIRES_ACCEPT` / `applyBatchExtractBudget`；`sidebar-panel-import.ts` 批量提取队列；`knowledge-tree.tsx` 范围/预算面板 |
| D5 | TASK-005 | 手设参数 | **稳定前缀 = 白名单 + 锁定顺序 + 版本号，三者缺一都会让缓存静默失效**。`STABLE_PREFIX_FIELD_ORDER` 五个字段（`skillPrompt` / `roleDirective` / `chapterOutputRules` / `answerRules` / `formatHint`）是唯一真源：白名单外的键被丢弃（「dynamic 段永不进缓存」由白名单兜住，不靠调用方自觉），渲染顺序只由数组决定（顺序进哈希，所以对象字面量顺序不再影响命中）。「继续未完成」组装点保留拆分前的既有文本顺序，单独锁 `CONTINUE_UNFINISHED_FIELD_ORDER`。`STABLE_PREFIX_VERSION = 1`：任一字段文本 / 字段增删 / 顺序 / 分隔符变动都必须 +1，否则旧版本已被上游缓存的过期前缀会被静默复用（R4）。版本折进指纹，因此**不新增 trace 字段**。跨 provider 三档策略收敛为 `resolvePromptCacheStrategy`（explicit / implicit / none），并修掉「system 段被压平成字符串 → cacheControl 断点根本没送到上游」这个真 bug（`toAnthropicSystem` 在存在断点时升级为 content block 数组，无断点时逐字节与旧行为一致） | `stable-prefix.ts` `STABLE_PREFIX_VERSION` / `STABLE_PREFIX_FIELD_ORDER` / `CONTINUE_UNFINISHED_FIELD_ORDER` / `composeStableSystemBlocks` / `buildStablePrefixTraceFields`；`llm-providers.ts` `resolvePromptCacheStrategy` / `promptCacheTraceLabel` / `toAnthropicSystem` |
| D6 | TASK-006 | 统计口径 | **命中率必须可重复跑出，口径只认字节**。harness 的请求体由 `buildChatStablePrefix` + `composeStableSystemBlocks` 真实拼出（不是手写假 system），「复用」用 `serializeLlmRequestPayload` 做**字节级最长公共前缀**比较（上游认字节，不认语义），命中/节省落成真实 `LlmRequestCacheTrace`，再由 `summarizeLlmCacheHits` 汇总——harness 数字与线上统计同源。目标线是**下限**：主对话二轮 99.6%、审稿复用写作前缀 99.3%；`meetsTarget` / `gapPct` 如实输出，差距为负照报，**不允许改口径凑数**。trace 扩三个字段：`stablePrefixVersion` / `cacheHit` / `savedTokens`；无 usage 时 `cacheHit` 留空而不是记 `false`（不把「未知」记成「未命中」）。同时做两件回归：① **换算分支化**——CJK 段保留 `CJK_CHARS_PER_TOKEN = 1.5`，非 CJK 段改走 `NON_CJK_CHARS_PER_TOKEN = 1.0`（保守下界：一字符当一 token 花，只少填不超窗；旧版一律 1.5 在非 CJK 上只用掉一半容量，在 CJK 上反而高估）；② **trim 预算边界回归**——空预算 / 恰好满 / 超一 token 三档只加断言，`trimChatMessagesToBudget` 的三 pass 语义一字未改 | `cache-hit-harness.ts` `CACHE_HIT_TARGET_MAIN_CHAT_PCT` / `CACHE_HIT_TARGET_REVIEW_REUSE_PCT` / 两个场景常量；`llm-request-trace.ts` `LlmStablePrefixTraceInput` / `cacheHit` / `savedTokens` / `summarizeLlmCacheHits` / `serializeLlmRequestPayload`；`context-budget.ts` `CJK_CHARS_PER_TOKEN` / `NON_CJK_CHARS_PER_TOKEN` / `charsPerTokenForText`；`context-budget.spec.ts` trim 预算边界回归 |
| D7 | TASK-007 | 裁决人 | **正史规则从「最后手段可截断」升格为「零截断 + 容量告警」**。`canonRules` 在既有三项配额（resp / index / page，配比与算式一字未改）之外**优先**从剩余未分配额度中划出独立预留槽 `RESERVED_CANON_RULES_CHARS = 3_840`；剩余不足时按剩余封顶（`clamped = true`），绝不反向挤占既有配额（小窗口下既有预算数值不变）。`context-compact` 的 L4 `fullSummary` 裁剪侧跳过 `canonRules`：规则**永不因预算被裁**，宁可挤占其他段（`mustAvoid` / `outline` 仍按原规则承担截断）。超限时产出 `BudgetExceededRecord`（`truncated: false` 是类型级不变量，不是运行时约定）并经 `emitBudgetExceeded` **双记**（trace 审计留痕 + journal 可重放流水），返回值显式报告两侧是否真的落账（任一侧缺 sink 即视为未双记，不静默）。UI 文案键 `CANON_RULES_BUDGET_EXCEEDED_KEY = rules.canonRules.reserveExceeded` | `context-budget.ts` `RESERVED_CANON_RULES_CHARS` / `computeContextBudget` 的 `canonRulesReserve`；`context-compact.ts` `CANON_RULES_BUDGET_EXCEEDED_KEY` / `CANON_RULES_BUDGET_EXCEEDED_TEXT` / `BudgetExceededRecord` / `buildCanonRulesBudgetExceeded` / `emitBudgetExceeded` |
| D8 | TASK-008 | 统计口径 | **收口只做「已实现能力的对外一致化」，不顺带改行为**：① i18n 四命名空间收敛——`sync.*`（76 键）/ `extract.*`（25 键）已与代码引用点完全对齐（零缺键），本次补齐唯一真缺的 `rules.canonRules.reserveExceeded`（中英成对）；`cache.*` 在代码里**没有任何 `t()` 引用点**（命中统计只进 trace / harness，尚未有 UI 消费者），因此**不新增**该命名空间的键——造无消费者的死键等于给自己发绿，与「不写假数据」冲突；② docs-site 新增 `features/sync-backup.md` 覆盖三目标 / 批次明细 / 双改裁决 / 提取预算 / 世界规则保护五要点；③ 本决策记录；④ 全门禁实跑（见第四节） | `src/i18n/{zh,en}.json`；`docs-site/src/content/docs/features/sync-backup.md`；本文件；`context-compact.ts` `CANON_RULES_BUDGET_EXCEEDED_KEY` |

## 二、macro 压缩选项取舍（G5 相关的唯一新增取舍）

本波次**没有**新增宏观压缩档位，只改了 L4 的**截断侧判定**。压缩阶梯保持五级不变：`none` → `microcompact`（清空白，零信息损失）→ `lightTrim`（按 dropOrder 半裁/整丢低优先段）→ `storeSummary`（旧章节正文换 store 现成摘要，零 LLM）→ `fullSummary`（整包折叠 + `mustAvoid` / `outline` 最后手段截断）。

取舍与理由：

1. **不引入 LLM 生成摘要**。`context-compact` 的硬约束是「机械层零 LLM」——宏观摘要替换若调模型，会把压缩链路变成一次付费、非确定性的外部调用，且失败即触发熔断。现有 `storeSummary` 已经用 store 里的现成摘要（零 LLM）拿到宏观折叠的大部分收益，边际收益不足以为此破约束。
2. **只把 `canonRules` 从「最后手段截断」这一档里摘出来**，其余 `mustAvoid` / `outline` 的截断语义原样保留。这样超预算时的退化顺序不变，唯一变化是「规则永不删字」。
3. **代价显式记账，而不是靠裁字止损**：规则超预留槽时缺口字符数进 `budget_exceeded`（trace + journal 双记），UI 横幅说明「已全文保留（未截断），可能挤占其他上下文段」。即：**选择「占别人额度 + 大声告警」而不是「悄悄裁规则」**（R5：正史规则被截断 → 写作越权）。
4. **不做的事**：不动 `applyTemporalFactsToCanonRules` 的时序合并链路，不动取值侧，不改既有三项配额算式——G5 是「加一个优先扣除项 + 改一个截断侧判定」，不是重写预算模型。
5. 预留槽按剩余额度封顶（`clamped`）而非硬挤既有配额：小窗口下宁可槽位变小并告警，也不让既有预算数值漂移（否则历史预算断言全线失效）。

## 三、deferred 清单（本波次明确不做）

| 债 ID | 描述 | 为什么不现在做 | 偿还触发 |
|-------|------|----------------|----------|
| DEBT-20261102-03 | **release 附件大文件路径**：GitHub 目标当前所有对象都走仓库内容面（contents API / Git Data API），没有走 Release 附件通道。超大备份包会进仓库历史，长期让仓库体积膨胀 | 附件上传需要另开 release 生命周期（创建 tag/release、附件命名与去重、失败回滚），属于独立传输通道而非阈值调参；本波次目标是「三目标可用 + 双改不覆盖」，不夹带新通道 | 出现「仓库体积增长影响克隆」或用户要求归档不占仓库时 |
| DEBT-20261102-04 | **LLM provider 口令迁钥匙串维持现状**：本波次只把**同步凭据**收进系统钥匙串（`nb:<domain>:<account>` 逻辑域）；LLM provider 的 API key 仍沿用应用内既有配置存储，未迁移 | 迁移需要一次性密钥搬运 + 无钥匙串平台的降级策略 + 迁移失败回滚，且会改动所有 provider 的配置读取路径（面远大于本波次）；同步凭据先落地可验证同一套句柄语义 | 钥匙串层被证明稳定（跨 macOS / Windows / Linux 三平台无回归）后 |
| DEBT-20261102-05 | **Git Data 1 MiB 阈值调优**：`CONTENTS_API_MAX_BYTES = 1 MiB` 是 R1 锁定的分界点，尚未按真实网络 / 真实仓表现标定 | 调阈值需要实测数据（contents API 大文件失败率 vs Git Data 多请求开销），拍脑袋调只会把「偶发失败」换成「偶发变慢」；且该常量同时用于读写两侧，改一处即改两条路径 | 有真实大对象传输的失败/耗时样本后（配合 DEBT-20261102-03 一起评估） |

> 说明：`20261102-sync-conflict-semantics.md` 的 DEBT-20261102-01（`mine` 侧来源不可得 → 逐项降级为「只能保留两者」）与 DEBT-20261102-02（块级耗时记 0）仍然有效，本波次未偿还，不在此重复登记。

## 四、全门禁实跑记录（2026-11-02，本机 Windows / bash）

| 门禁 | 命令 | 结果 |
|------|------|------|
| typecheck | `npm run typecheck` | exit 0，无诊断输出（`tsc --build --force`） |
| lint | `npx eslint .` | exit 0，0 条 findings |
| boundaries | `node scripts/check-boundaries.mjs` | `5/5 fixture 通过` |
| gen | `node scripts/check-generated.mjs` | 首跑 `5/6 passed`（module-atlas 偏移 1395 字节漂移）→ `node scripts/gen-module-atlas.mjs` 重生成 → **`6/6 passed`**（atlas 244,537 字节；modules=1175 reachable=984 unwired=191 specOnly=264 barrelOnly=2 edges=4534） |
| consistency | `node scripts/check-consistency.mjs` | `14/14 passed`（含 i18n key-parity：zh/en 各 4049 键完全一致；ipc 123 命令 / 119 invoke 闭合） |
| cargo | `cargo check --manifest-path src-tauri/Cargo.toml` | exit 0，无 warning |
| vitest（全量） | `npx vitest run` | 见下（全量包含 `*.real-llm.spec.ts`，需真实网关凭据） |

vitest 全量口径注记：本机存在 `.env.test.local`，因此 `*.real-llm.spec.ts` 会**实际发起网络请求**。基线（改动前）与改动后同为 2 个失败，均落在 real-llm 通道（`p44-real-provider.real-llm.spec.ts` 的健康检查 / 流式两步、`step0-ab-calibration.real-llm.spec.ts` 的维度聚合），根因是网关侧 `unknown provider for model ...`（模型不在该网关目录），**与本波次改动无关**；非 real-llm 的 mock 口径全绿。原始数字见第五节。

## 五、纪律自查

- 改动面：本任务只碰 `src/i18n/zh.json`、`src/i18n/en.json`、`docs-site/src/content/docs/features/sync-backup.md`（新）、`docs/decision-log/20261102-ralph-sync-cache.md`（新），以及 H4 指令要求下的 `src/lib/novel/module-atlas.generated.json`（由 `gen-module-atlas.mjs` 生成，非手改）。
- 未执行 commit / push / 版本号变更 / 发版动作；未触碰 `reference/`；未写 `.workflow/sessions` 下文件。
- 门禁未降级：无 `@ts-ignore`、无 skip 测试、无 warn-only 放行。real-llm 两个失败如实登记，不隐藏、不改口径。

## 六、不变量（后续改动前先读）

1. **默认不覆盖**：同步默认裁决恒 `keep_both`；无 base 时后端硬拒覆盖；空 `actor` 整次拒绝。
2. **远端非真值**：裁决写 `.novel/resolutions/`，不写工作文件树；`WriteSource::SyncPull` 仍受写权威判定约束。
3. **凭据只走句柄**：配置里只有 `nb:<domain>:<account>`；明文只在钥匙串；不可用时宁可失败不回落明文。
4. **全局开关默认关**：`sync_enabled` 默认 false，读不出来即关闭；关闭时调度器与一切自动触发全停。
5. **前缀只认字节**：稳定前缀的字段白名单、顺序、版本号三者共同决定命中；动态内容永不进 cacheControl 段。
6. **正史规则零截断**：`canonRules` 不因预算被裁字；超预留槽只告警 + 记账，缺口显式可见。
7. **预算强制**：全量提取预算默认 20 / 硬顶 60 / 强制开启；提取产出必须经 accept 才回填正式记忆。
8. **历史不重写**：同步 journal append-only；老批次缺 base 字段永远按「无 base」处理，不迁移不回填。
