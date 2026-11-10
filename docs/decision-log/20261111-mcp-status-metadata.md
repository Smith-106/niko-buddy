# 2026-11-11 MCP `app.status` 只读口径 + `chapter.write` 草稿目录元数据

- **状态**：Proposed（源码已落、库测试通过且独立源码复核 approve；正式发版待补充授权，**不含**新包与真机回读证据）
- **日期**：2026-11-11
- **范围**：应用内 MCP 控制面的两处**元数据**（`src-tauri/src/mcp_server/tools.rs`、`src-tauri/src/mcp_server/mod.rs`）
- **锚定**：v2.27.0（HEAD `e3a91a77`）已发布产物**不含**本次修补；五档 scope / 逐会话 grant 语义见 `docs/decision-log/20261108-mcp-auto-scope-fullflow.md`
- **会话/运行**：`20261109-ralph-expert-residuals` / `run-fe6288c0ce65`

## 背景

两处「元数据说谎」，都是客户端唯一可见的线索，因此都直接误导外部 Agent：

1. `app.status` 的 `readOnly` 恒为 `true`（`tools.rs` 硬编码）。会话拿到 `full` 后读到的仍是「只读」，与权限闸门实际放行的事实相反。
2. `chapter.write` 的描述写 `.novel/drafts`，而现行草稿目录是 `.qm-drafts`（`src/lib/novel/lifecycle-types.ts:19` `DRAFTS_DIR = ".qm-drafts"`，`src/lib/novel/draft-manager.ts:6,13` 复用该常量）。写到哪儿与说写到哪儿不一致。

根因：`ToolContext` 只持运行时资源（`app` / 桥 / 端口），没有「谁在调」；`handle_tools_call` 用共享 `state.ctx` 调注册表，而 caller 只用于闸门比对，没有进入工具。

## 决策

| 字段 | 值 |
|------|-----|
| date | 2026-11-11 |
| task_id | `mcp-metadata-repair`（Run `run-fe6288c0ce65`） |
| decision_type | 统计口径 |
| value | `app.status.readOnly` = **本次请求**有效 scope 为 `Read`；同时回 `scope`（read/settings/project/auto/full）说明「非只读 ≠ 可直写正文」。caller 由 `handle_tools_call` 已有的 `caller: SessionScope` 经**请求局部** `ToolContext::for_caller` 带入，共享 `ServerState.ctx` 保持基线 `Read` 不被改写。 |
| evidence_ref | `src-tauri/src/mcp_server/mod.rs` `handle_tools_call`（`for_caller` 调用点）、`start`（共享 ctx 基线）；`src-tauri/src/mcp_server/tools.rs` `ToolContext::caller_scope` / `for_caller` / `AppStatusTool::call` |
| date | 2026-11-11 |
| task_id | `mcp-metadata-repair` |
| decision_type | 外部佐证引用 |
| value | `chapter.write` 描述中的草稿目录更正为 `.qm-drafts`。单一真源为前端常量 `DRAFTS_DIR`（`src/lib/novel/lifecycle-types.ts:19`，由 `draft-manager.ts:6,13` 复用），Rust 侧**不**另建目录常量、不复制扫描逻辑。 |
| evidence_ref | `src/lib/novel/lifecycle-types.ts:19`；`src/lib/novel/draft-manager.ts:6,13`；`src-tauri/src/mcp_server/tools.rs` `ChapterWriteTool::description`；`src-tauri/src/mcp_server/tools.rs` 测试 `chapter_write_metadata_points_at_qm_drafts` |

### D1：为什么 scope 走请求局部上下文，而不是写进 `ServerState`

`state.ctx` 是全局共享句柄，被所有会话的请求复用；把某个会话的 scope 写进去，后续请求就会读到别人的授权（跨会话权限串味）。因此每次 `tools/call` 从共享 ctx **派生**一个局部副本（`AppHandle` / `StateBridgeState` 克隆均不复制状态，桥内部是 `Arc`），只替换 `caller_scope` 后再交给注册表。

### D2：caller 的唯一来源不变

`handle_tools_call` 的 `caller` 在 HTTP 路径上已经来自 `SessionRegistry::effective_scope`（授权叠加 `full` / `auto`，未知/缺失 session id 为 `Read`）。本次**只做传递**，没有新增解析器、没有改 `SessionScope::satisfies`、`effective_scope`、Bearer 鉴权、任何工具的 `required_scope`、写入权威矩阵、快照/审计与前端状态桥。

### D3：`readOnly` 与 `scope` 的分工

`readOnly=false` 只表示「该会话有某项写授权」，**不**表示可直写正文（那是 `full` 的逐会话授权）。为避免这种误读，`app.status` 同时回 `scope` 字符串；`readOnly` 的名称、类型与 `version` / `mode` / `listen` 及 JSON-RPC `content` 结构都不变。

## 验证（源码层，本 Run）

- `cargo test --manifest-path src-tauri/Cargo.toml --lib mcp_server::`（从 QMAI 根，既有 Windows tests-only SxS manifest workaround）：**103 passed / 0 failed / 0 ignored / 506 filtered out，exit 0**。含本项新增 6 个测试与既有权限边界测试。
- 覆盖点：默认 `dispatch` → `readOnly=true, scope=read`；`dispatch_as` 五档逐一正确且共享 ctx 未被污染、随后默认 Read 请求仍只读；HTTP 入口经 `grant_auto` / `grant_full` / `revoke_full` / `revoke_auto` 变档、第二会话不被连带升级；缺失/未知 session id 仍 `Read` 且不隐式建会话；`tools/list` 中 `chapter.write` 描述含 `.qm-drafts`、不含 `.novel/drafts`、`required_scope` 仍 `Project`。
- `rustfmt --check` 仅针对改动两文件：通过。`git diff --check`：通过。

## 独立源码复核

- 独立 Reviewer：`agent://5f2a8cab-db33-4fc1-bb07-a13a3b69a3fd`，结论 **approve（仅源码层）**，覆盖两源码及本 log **3/3**，无源可证 material finding。冻结 diff SHA256：`8e6561ff41fd7b1646dac9770d35c756a4cd38d78026dfeb5f4197eccf209210`；机械验证 JSON SHA256：`cf1892c0431087786f2dae242197bcf67fee88db5950c51c4502490fe69e3b0a`。
- 已核对同一 caller 用于权限检查与状态回报、请求局部 ctx 不改共享实例、桥的 Clone 共享原 pending 表、HTTP grant/revoke 与未知/缺失 session 的 Read 降级不变。复用原始 103/103 测试日志，未重跑。OCR CLI 未安装，改用独立 exact-diff 与定向源码审核，未安装依赖。
- 三项 low 记录、不另开修正门：HTTP 未直接覆盖 Settings/Project 基线握手；忽略 `scope` 的外部客户端可能误读 `readOnly=false`（D3 已限定语义）；Executor 的过滤器比计划宽且格式化前后各测一次。多客户端并发压测与前端真机联动未执行。
- 此处只补记审核结果，不改变 D1–D3 或两 Rust 源码，不使原测试失效；冻结 Executor 证据保持原样。

## 仍未验证 / 交付要求（不得当作已完成）

- 已发布的 v2.27.0 **不会**因源码修补而改变。真实新 Windows 包、安装/更新后的 MCP 回读（`app.status` 实测 `scope` / `readOnly`、`tools/list` 描述）仍是交付要求，不能用源码 approve 或库测试替代。
- 版本号 / CHANGELOG / generated 未改；提交、push、tag、发布均未执行。新版本、稳定渠道与必要节奏豁免须按现行发布规范取得相应明确授权。
- 不据此声明文学门控 PASS、作者 accept、记忆回填或整个 Goal 完成。
