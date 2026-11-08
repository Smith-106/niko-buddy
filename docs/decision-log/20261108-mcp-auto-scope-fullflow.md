# 2026-11-08 一窗口全流程：MCP `auto` 档 + 5 个编排工具（P4）

- **状态**：Accepted
- **日期**：2026-11-08
- **范围**：应用内 MCP 控制面（`src-tauri/src/mcp_server/`、`src/lib/mcp/`、设置页「外部控制」）
- **锚定**：v2.26.0 交付的 P0–P3 控制面（17 工具 / 四档 scope / 直写审计）；`docs/decision-log/2026-09-write-authority-matrix.md`（G-5 写入权限矩阵）
- **实现**：`src-tauri/src/mcp_server/{session.rs,tools.rs,mod.rs}`、`src/lib/mcp/{state-bridge.ts,pipeline-tasks.ts}`、`src/lib/novel/director-auto-advance.ts`、`src/components/settings/sections/external-control-section.tsx`

## 背景

审计结论（2026-11-07）：主控（`mainControl`）只能配置 6/50 个 `NovelConfig` 字段、只能触发深章/采纳/门控重跑，41 个视图里只管自己。外部 Agent 经 MCP 的 `project` 档能起章节与读门控，但**没有大纲、角色、导演阶段、批量、导出**入口，也没有「同时改设置 + 起项目动作」的单档权限——因此「一个窗口跑完整写作流程」在能力上不成立。

本决策把缺口补成一条可用链路，而不是重做主控。

## 决策

| 字段 | 值 |
|------|-----|
| date | 2026-11-08 |
| task_id | 路径 C（一窗口全流程） |
| decision_type | U-xx 定稿 |
| value | ① 新增会话档 `auto` = `settings` + `project`，**不含** `full`；只能逐会话授予，不能在 `mcp_server_start` 授予。② 新增 5 个工具：`director.advance` / `outline.generate` / `character.upsert` / `chapter.batch` / `export.run`，全部 `required_scope = Project`（故 `auto` 与 `full` 均可调用）。③ 长任务统一进 `pipeline-tasks` 登记表，只用 `pipeline.status` 轮询（新增 `kind` / `phase` / `advanced` / `advancedCount` / `artifactPath` 字段，均为 additive）。④ 所有写盘复用既有单一真源，不新开第二实现。 |
| evidence_ref | `src-tauri/src/mcp_server/session.rs`（`SessionScope::Auto` + `satisfies` + `grant_auto/revoke_auto/effective_scope`）；`src-tauri/src/mcp_server/tools.rs`（5 个工具 + `build_registry` 权限断言）；`src-tauri/src/mcp_server/mod.rs`（`mcp_session_grant_auto|revoke_auto`，且 `mcp_server_start` 拒绝 `auto`）；`src/lib/mcp/pipeline-tasks.ts`（`registerTask` / `startPipelineBatch` / `startDirectorAdvanceTask` / `startOutlineGenerationTask`）；`src/lib/novel/director-auto-advance.ts`（`upsertCharacterEntity` 单点落盘） |

### D1：`auto` 为什么是独立一档，而不是「会话可叠加两个 scope」

`settings` 与 `project` 刻意互不蕴含（防一次授权顺带开另一处能力）。允许叠加会把授权变成可组合集合，界面开关与真实能力会逐渐对不上。把「两类都要、但不要直写正文」压成一档显式组合，用户看到的就是一个可授予/可吊销的按钮（`external-control-section.tsx` 的「授予自动编排」）。

### D2：与 `full` 的边界只有一条——能不能不经草稿改正文

`auto` 能起生成、能改设置、能导出；`chapter.write_direct` / `memory.write` / `undo_last` 仍要 `full`。Draft-first（`draft-manager.acceptChapterDraft` 的 `!confirmed` 抛错）与门控优先级（`Consistency(P0) > Anti-AI(P1) > Quality(P2)`，单源 `buildDecisionGates`）都未被放宽：`chapter.batch` 的产出仍落草稿区，需用户在应用内接受；门控结论仍只由管线产出，工具只读不判。

### D3：五个工具各自的单一真源（不新开第二实现）

| 工具 | 复用的既有实现 | 不做什么 |
|------|----------------|----------|
| `director.advance` | `advanceDirectorToStall`（→ `advanceDirectorAutomatically`）+ `saveDirectorPersisted` | 不重写阶段门；门未过时任务 `failed`，不把「没推进」报成成功 |
| `outline.generate` | `generateOutlineFile` / `generateOutlineFileMultiAgent`（设置页大纲生成器同函数） | 不产正文；大纲是规划产物（`wiki/outlines`），不触发 Draft-first |
| `character.upsert` | `upsertCharacterEntity`（导演 `character` 阶段同一函数、同一文档格式） | 不写章节、不写正式记忆、不改角色状态账本 |
| `chapter.batch` | 逐元素 `startPipelineTask`（与 `pipeline.run_chapter` 同一入口） | 不自建批量管线；上限 10 章，**先全量校验再起任务** |
| `export.run` | `canon_export_project` 命令（含 `agent_gate` 与审计） | 不另写打包/校验和/加密 |

### D4：长任务一律「起任务 + 轮询」，不赌超时

状态桥 15s 超时，而阶段生成是分钟级。`director.advance` / `outline.generate` / `chapter.batch` 都立即返回 `taskId`，进度与终态只能经 `pipeline.status` 读；三类任务共用一张登记表，因此调用方只有一种等待形状。

### D5：`workflowMode` 的诚实说明

`pipeline.run_chapter` 与 `chapter.batch` 接受 `workflowMode`（`fast|standard|strict`）并校验，但深章管线（`DeepChapterGenerationInput`）没有深度参数，行为不随它变化。此前工具描述写成「pipeline depth」是不准确的，本次改为「validated for forward compatibility」。保留字段是为了不改客户端契约。

## 债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20261108-01（已修，2026-11-08 20:50） | `workflowMode` 被接受但不生效（`pipeline.run_chapter` / `chapter.batch` / `run_chapter_workflow` 三处都校验后丢弃，调用方以为传了有效值、实际零影响）。**修法**：新增 `src/lib/novel/workflow-mode-depth.ts` 的 `applyWorkflowModeDepth()`，把档位映射到管线**已经在读**的两个加厚阶段开关——`fast` 关 `consensusEnabled` + `literaryPolishAfterGate`、`strict` 打开这两个、`standard`/未传原对象引用直通（零行为变更）；三处入口全部接线，Rust 侧三处 schema 描述同步为真实语义。**边界**：任何档位都不跳一致性门控（`fast` 只少做加厚、不少做验收）；`strict` 是否真起多模型仍取决于共识模型组是否配置。 | `workflow-mode-depth.spec.ts` 5 例 + `pipeline-tasks.spec.ts` 新增 4 例（22 passed）+ `run-chapter-workflow.spec.ts` 新增 3 例（26 passed / 5 skipped），typecheck 0 错、eslint 干净 | 已修 |
| DEBT-20261108-02（已接受，非缺陷，2026-11-08） | `auto` 档目前只覆盖「设置 + 项目动作」；角色/大纲只写 `wiki/` 规划产物，尚无「人物关系账本」与「世界观蓝图」的独立外部工具。 | 需要外部 Agent 驱动世界观阶段时再开工具 | 已接受（能力边界，不造第二写入面） |
| DEBT-20261108-03 | 【已结项 2026-11-07】本地 `cargo test` 无法运行。真机制：测试二进制静态导入 `comctl32!TaskDialogIndirect`（仅 ComCtl32 **v6** 导出）；`tauri-build` 只给 bin target 嵌 manifest，test target 依赖 `QMAI/src-tauri/.cargo/config.toml` 的 `target.*.rustflags=/MANIFESTDEPENDENCY:...Common-Controls 6.0.0.0`，而 cargo 的 config 发现是**从 cwd 逐级向上**：⇒ 必须 `cd QMAI/src-tauri && cargo test --lib`（CI 就是这么跑的）；从仓库根用 `--manifest-path` 调用不会得到该 flag，产物缺旁挂 `.exe.manifest`，进程在 main 之前就 `0xC0000139`、0 用例执行。实测：`cd QMAI/src-tauri` 形态 **600 用例 / 597 passed / 0 failed / 3 ignored**。 | — | 已结项 |
| DEBT-20261108-04（已闭环，2026-11-08 21:00） | 测试二进制对 SxS manifest 的依赖曾是**旁挂**（`<exe>.manifest`），且 rustflags 只写在 `src-tauri/.cargo/config.toml`——cargo 的 config 发现依赖 cwd，从仓库根用 `--manifest-path` 调用读不到，测试 exe 绑定 system32 comctl32 v5 → 启动即 `0xC0000139`、0 个用例。**修法**：①新增仓库根 `QMAI/.cargo/config.toml`（同一条 `MANIFESTDEPENDENCY`），使两种 cwd 都能拿到；②`src-tauri/build.rs` 追加 tests-only `cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:...`（覆盖 `src-tauri/tests/*.rs` 集成测试目标，与 cwd 无关）。**实测不可行的两条路**（已写进代码注释，勿重试）：`cargo:rustc-link-arg-tests` 不作用于 lib 单测目标（`-v` 日志里 lib test 的 rustc 命令行没有该 link-arg）；全局 `/MANIFEST:EMBED` 与 tauri-build 的资源清单冲突 → `CVT1100 duplicate resource MANIFEST` + `LNK1123`，bin 构建直接失败。 | `cd src-tauri && cargo test --lib` → 597 passed / 3 ignored / 0 failed；`cd QMAI && cargo test --manifest-path src-tauri/Cargo.toml --lib` → 597 passed / 0 failed（修复前 0 用例 + 0xC0000139）；`cargo build --bin niko-buddy` 成功；`cargo test --test bf002_bf007_smoke` 链接正常 | 已闭环 |
| DEBT-20261108-06（已修，2026-11-08 20:35） | 长章节生成在「慢网关 / 代理黑洞」下被 HTTP header 超时误杀：原默认 `DEFAULT_HTTP_HEADER_TIMEOUT_MS = 20_000` 只管响应头到达，非流式大请求或网关侧排队会先撞 20s（实测单发大请求 36s 才回头部，`chapter.batch` 门控阶段连续报「连接模型接口超过 20 秒仍无响应」）。**修法**：默认提到 `60_000`（connect 10s / stream idle 90s / 退避 2-5-10s 全不变），设置页文案改「默认 10/60/90 秒」；`llmConfig.httpHeaderTimeoutMs`（钳制 5s–300s）仍可覆盖。 | `llm-client.spec.ts` 两处依赖默认值的定时器断言同步到 4×60s+17s≈257s，该文件 129 例全绿；typecheck 0 错 | 已修 |
| DEBT-20261108-07（已修，2026-11-08 04:00） | 章节管线对 provider 的**并发上限**零适配：同一把 key 打 `cpa.nikoniko.tech/v1`，串行/单发大请求 200，**6 路并发大请求 → 4 路 503 `no_healthy_account`**（网关并发额度约 2，且把限流错标成「账号池无健康账号」）。**修法**：容量类 503/429 退避重试（5/10/20/30/45/60s）+ 传输层配置回退 + 可选 `maxConcurrency` 门闸（缺省不介入）。 | 真机第 4 轮一窗口全流程跑通（`ptask_mw6rc948_1` → done，3780 字；`gate.run`/`chapter.read` 均 isError=false），证据见 `.workflow/sessions/close-verification-gaps/e2e/round4-20261108.md` | 已修 |
| DEBT-20261108-05（已修，2026-11-08 20:38） | `auto` 逐会话授权按钮的 i18n key（`grantAuto` / `revokeAuto` / `autoGranted`）在 `zh.json`/`en.json` 双缺，中文界面回落显示英文 defaultValue（如 `Grant auto (settings + actions)`）。**修法**：两份 locale 各补三条（zh：授予 auto（设置 + 项目动作）/ 撤销 auto / auto 编排；en：Grant auto (settings + actions) / Revoke auto / Auto orchestration），组件 defaultValue 兜底保留。 | `i18n/key-coverage.spec.ts`（此前正是它在报这三条）转绿；`en-no-cjk.seq62.spec.ts` + `external-control-section.spec.tsx` 同批 33 例全绿 | 已修 |
| DEBT-20261108-08（待人工策展决定，2026-11-08 21:20 实测） | hub 工作区 `reference/REFERENCE-KB-VIEW.json`（源 `builtFrom=sha256:1c755328f06c75ca`）与仓内 pinned 产物 `src/lib/novel/kb/kb-routing-view.generated.json`（`sha256:878b6f16f9b20798`）漂移，`kb-routing-view.spec.ts` 2 条守恒用例因此失败。**实测不能直接采纳新源**：run `node scripts/sync-kb-view-to-niko-buddy.mjs` 之后产物变为 corpus=7 / lexicon=53 / world_ref=27，而 `channel-b-attribution.spec.ts` 明确守住「corpus 不增（AG1 唯一 headroom 保护）：corpus 必须 = 6」——新源多出 1 条 corpus 条目，与仓内策展保护冲突；同时 `curation-gate.spec.ts` 的 curation 快照仍带旧指纹，需连坐更新。故这不是机械 sync 问题，而是「hub 池新增 corpus 条目是否获准」的策展决定。 | 复现：`node scripts/sync-kb-view-to-niko-buddy.mjs --check` 报 builtFrom 漂移；`npx vitest run src/lib/novel/kb-routing-view.spec.ts` → 2 failed （其余 1410 个测试文件全绿） | 需人工二选一：(a) 撤回 hub 池里新增的 corpus 条目 → 重跑 sync + 三 spec 同绿；(b) 批准 corpus 扩容 → 同步放宽 AG1 断言并更新 curation 快照与 channel-B 基线 |

## 2026-11-08 修复：真机一窗口全流程跑通（第 4 轮）

### 根因（三条，全部可复现）

1. **容量类 503 被当终态**：同一 key 打 `cpa.nikoniko.tech/v1`，串行/单发（60k–300k 字符输入、
   `max_tokens` 2000–16000、`reasoning_effort=high`）全 200；**6 路并发大请求 → 4 路
   `503 no_healthy_account`**。网关每 key 并发额度约 2，且把限流错标成「账号池无健康账号」。
   `chapter.batch` 在 `after_draft` 之后的门控环节并行发大请求 → 必然撞上 → 整章 failed。
2. **模型路由丢传输层配置**：`resolveConfig()` 只从 provider 覆盖读三档 HTTP 超时，按任务模型
   （review/summary）重建配置时全局设的 120s header 超时被静默丢弃、退回 20s 默认。实测单次大请求
   36s 才回头部 → 20s 必死。
3. **审查阶段 5 分钟硬编码**：等上游腾位的退避还没结束就先撞阶段超时。

### 修复

| 文件 | 变更 |
|---|---|
| `src/lib/llm-client.ts` | `CAPACITY_RETRY_DELAYS_MS=[5s,10s,20s,30s,45s,60s]` + `isCapacityLimitResponse()`（429 一律重试；503 仅当 body 含 `no_healthy_account`/`auth_unavailable` 等容量语义）+ `clampMaxConcurrency()` + `acquireEndpointSlot()` 按端点并发门闸（缺省不介入）。非容量 503 与 400 保持不重试 |
| `src/lib/llm-config/preset-resolver.ts` | 三档超时回退优先级改为 `provider 覆盖 > 全局 LlmConfig` |
| `src/lib/novel/review-adapter.ts` + `wiki-store-config.ts` | `NovelConfig.reviewStageTimeoutMs`（默认 300000，钳制 60s–30min），阶段超时错误文案按实际分钟数渲染；`LlmConfig.maxConcurrency`（可选，1–32） |
| 测试 | `llm-client.spec.ts` +6 条（退避恢复、非容量 503 不重试、400 不重试、429 退避、耗尽上报、并发峰值=1）；`review-adapter.spec.ts` +2 条（钳制）；`preset-resolver.override.spec.ts` +2 条（超时回退/覆盖优先） |

### 验收证据（第 4 轮真机，2026-11-08 03:48–04:17）

- `chapter.batch` → `taskId=ptask_mw6rc948_1`；`pipeline.status` 68 次轮询走完
  `queued → after_task_brief → after_scene_breakdown → after_draft → after_review → after_revision → done`，
  终态 `status=done`、`contentChars=3780`、`finishedAt=1794078701201`。
- `gate.run` isError=false，返回真实结论：`anti_ai` passed/pass（0 条）、`consistency` failed/manual_review
  （21 条 + 12 条修复建议）、`quality` failed/manual_review（11 条）、`overall`+`manualReviewRequired`+`note` 齐备。
- `chapter.read {chapter:"1"}` isError=false，3775 字符正文。
- 单测：`llm-client.spec.ts` 127 passed、`review-adapter.spec.ts` 62 passed、`preset-resolver.override.spec.ts` 8 passed；
  `npm run typecheck` 0 错；`eslint` 干净。
- 证据文件：`.workflow/sessions/close-verification-gaps/e2e/{mcp-e2e-final.json, mcp-e2e-round4-evidence.json, round4-20261108.md}`。

### 环境前提

`llmConfig.model=deepseek-v4.1-flash`、`httpHeaderTimeoutMs=120000`、`httpStreamIdleMs=300000`、
`maxConcurrency` 未设；`novelConfig` 四个任务模型统一 `deepseek/deepseek-v4.1-flash`、
`reviewStageTimeoutMs=900000`。已排除的误判：`writingModel` 曾指向网关不存在的
`muse-spark-1.3-contributor-free`（实发请求被抓到 → 400 unknown provider），已改。

## 验收证据

- Rust：`cd QMAI/src-tauri && cargo test --lib` → **600 用例 / 597 passed / 0 failed / 3 ignored**（3 条 ignored 均为既有用例）；`cargo check` 0 error；`cargo fmt --check` 干净。
- TS：`npm run typecheck` 0 错误；`npx vitest run src/lib/mcp src/components/settings/sections/external-control-section.spec.tsx src/lib/novel/director-auto-advance.spec.ts` 16 文件 / 288 用例全绿（含新增：批量整批校验、导演/大纲参数门、桥的 4 个新 op、`auto` 授权与吊销 UI）。
- 注册表：`build_registry()` 已注册 5 个编排工具（原先只有 struct/impl，**没有 register 行**，且 `debug_assert_eq!(privileged, ...)` 里已写入它们 → debug 构建必 panic）。修复后 `tools/list` 实测 22 项，顺序为 `chapter.write → director.advance → outline.generate → character.upsert → chapter.batch → export.run → memory.write`。
- 真机端到端（运行中的应用 + 真实 MCP HTTP 客户端）：`initialize` 200 且 `serverInfo.name=niko-buddy`；`notifications/initialized` 202；`tools/list` 22 项含全部 5 个新工具；read 档调 `director.advance` 被拒（`isError=true` +「权限不足：需要 scope="project"」）；在设置页点「授予 auto」后**同一会话** `director.advance` 返回 `isError=false` 与非空 `taskId`，`chapter.batch` 同样起任务。`pipeline.status` / `gate.run` 对该任务如实报「生成失败，没有门控结论」。
- 剩余外部阻塞：真实章节正文生成被上游以 `HTTP 401 Invalid API key` 拒绝（无 Authorization 头时报 `Missing API key`，有头但值无效时报 `Invalid API key`，E2E 拿到后者 ⇒ 应用确实带了非空但已失效的凭据）。这不是代码缺陷，需在设置页换有效的 provider 密钥后才能拿到「正文 + 门控结论」。

## 附：一窗口怎么接、怎么说话

（`docs/` 除 decision-log 外不入版本控制，故使用说明落在这里。）

1. **应用侧**：设置 →「外部控制」→ 选 `project`（或 `settings`）→ 打开开关，取出 `http://127.0.0.1:<port>/mcp` 与 bearer token。
2. **客户端侧**（任意 MCP HTTP 客户端）：

   ```bash
   claude mcp add --transport http niko-buddy http://127.0.0.1:<port>/mcp \
     --header "Authorization: Bearer <token>"
   ```

   等价 `mcpServers` 写法：`{"mcpServers":{"niko-buddy":{"type":"http","url":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer <token>"}}}}`。
3. **授权**：在会话列表对该会话点「授予自动编排」（`auto`）。要直写正式正文再单独授予「完整写入」（`full`）。

编排顺序固定为「立项 → 大纲 → 角色 → 逐章 → 门控 → 采纳」：`director.advance`（`maxPhases` 1–4）→ `outline.generate`（按需）→ `character.upsert`（按需）→ `chapter.batch`（≤10 章）→ `gate.run` / `pipeline.status` → 用户在应用内采纳。改参数走 `settings.*`，导出走 `export.run`。

一句话示例（可直接对窗口说）：「`director.advance` 推两阶段落大纲与角色；`chapter.batch` 起 11–13 章；每章跑完用 `gate.run` 看结论，一致性不过就停下报原因，别自己改正文。」

边界不变：产出只进草稿区（Draft-first）；门控结论只由管线产出；`auto` / `full` 都只能逐会话授予，随时可单独吊销。
