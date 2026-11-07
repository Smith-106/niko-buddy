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
| DEBT-20261108-01 | `workflowMode` 被接受但不生效（管线无深度参数） | 深章管线提供深度档位，或决定移除该字段（需改客户端 schema 与两处调用） | 下次动 `pipeline.run_chapter` 契约时 |
| DEBT-20261108-02 | `auto` 档目前只覆盖「设置 + 项目动作」；角色/大纲只写 `wiki/` 规划产物，尚无「人物关系账本」与「世界观蓝图」的独立外部工具 | `character-state` / `world-blueprint` 出现稳定的单点写入口 | 需要外部 Agent 驱动世界观阶段时 |
| DEBT-20261108-03 | 本地 Windows 上 `cargo test --lib` 的测试二进制启动即 `STATUS_ENTRYPOINT_NOT_FOUND`（未运行任何用例）；CI（ubuntu + windows runner）执行 `cargo test` | 本地能复现并定位到具体 DLL 导入，或改用容器化跑 Rust 测试 | 下次需要本地 Rust 测试证据时 |

## 验收证据

- Rust：`cargo check` 通过（0 error）；新增单测覆盖 `SessionScope::Auto` 的 `satisfies` / 逐会话授予 / `full` 优先于 `auto` / `clear` 归一，与 5 个工具的 `required_scope`、参数校验、无 app 句柄时的失败语义。
- TS：`npm run typecheck` 0 错误；`npx vitest run src/lib/mcp src/components/settings/sections/external-control-section.spec.tsx` 15 文件 / 257 用例全绿（含新增：批量整批校验、导演/大纲参数门、桥的 4 个新 op、`auto` 授权与吊销 UI）。

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
