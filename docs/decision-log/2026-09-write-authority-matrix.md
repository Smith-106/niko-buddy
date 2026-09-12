# 2026-09 真源写入权限矩阵（G-5）

- **状态**：Accepted
- **日期**：2026-09-12
- **范围**：跨项目移植专项（OpenWrite 2.0.1 / FeelFish 4.0.36 → QMAI）· OpenWrite W1 TASK-002
- **锚定**：`guidance-specification.md` §12.4 **G-5**（「谁可写 QM 未定义」）；`cross-role-review.md` §C-8
- **实现**：`src-tauri/src/canon/write_authority.rs`（`canon/mod.rs` 导出）
- **关联**：C-001 / C-002 / C-003 / C-006 / C-007 / C-010 / C-011；硬否决① 第二同步引擎、② 在线技能市场与可执行脚本通道

## 背景

本专项引入三条**新的外部 → 本地写入路径**：技能包导入（TASK-006）、WebDAV 拉取（TASK-008）、市场数据采集（TASK-012）。在任一路径落地前，必须先把「谁可写 `QM/` / `canon` / `.novel/status.json`」定义完毕，否则真源边界不可判定。跨项目共识（SA 视角三路合并）产出的 G-5 矩阵含 12 主体 × 10 资源，本决策把它压缩为**可执行的三态判定函数**。

## 决策

### D1：三态判定 + 五个来源

```rust
pub enum WriteSource { UserEdit, AiSuggestion, SkillImport, SyncPull, ExternalFetch }
pub enum WriteDecision { Allow, RequireGate, Deny }
pub fn may_write(source: WriteSource, target: &Path) -> WriteDecision
```

- `Allow` —— 可直接写（仍受原子写与单写者纪律约束）。
- `RequireGate` —— 必须先过门控 / 用户确认（Draft-first、信任复核）。
- `Deny` —— fail-closed 拒绝。

### D2：目标由**路径派生**，不从调用方传标签

`classify_target(&Path)` 从左到右找**第一个**库根标记段（`.novel` / `qm` / `canon`），按其后首段细分：

| 路径形态 | `WriteTarget` |
|---|---|
| `.novel/status.json` | `StatusJson` |
| `.novel/schema.md` | `SchemaDoc` |
| `.novel/drafts/**` | `Drafts` |
| `.novel/market/**` | `MarketCache` |
| `.novel/user-asset-refs.json` | `UserAssetRef` |
| `.novel/**`（其余） | `Procedure` |
| `QM/**` | `Reference` |
| `canon/**` | `Canon` |
| 段中含 `user-assets`（项目外） | `UserAssetBody` |
| 其余 | `Other` |

**理由**：调用方自报标签可被伪造；路径派生使判定**不可绕过**，且与 `status_watcher` 的既有观测面同源。大小写与分隔符归一（`qm\raw\x.json` 与 `QM/raw/x.json` 同判）。

### D3：硬规则（`assert_hard_rules()` 单一断言点）

1. **`SkillImport` / `SyncPull` / `ExternalFetch` 对真源四类**（`QM/`、`canon`、`.novel/status.json`、`.novel/schema.md`）**永不为 `Allow`**（只能 `Deny` / `RequireGate`）。
2. **`ExternalFetch` 对任何 canon 目标恒为 `Deny`**。
3. **`AiSuggestion` 对真源四类与用户资产引用永不为 `Allow`**（C-002 Draft-first）。

任一违反 → `assert_hard_rules()` 返回 `Err`（fail-loud），供启动自检与单测复用。`hard_rules_hold_for_all_combinations` 用 5 × 10 **全组合穷举**验证。

### D4：关键矩阵取值

| 来源 ＼ 目标 | status.json | schema.md | canon | QM/ | drafts | .novel/market | user-asset-refs | 资产本体 |
|---|---|---|---|---|---|---|---|---|
| `UserEdit` | Allow | Allow | Allow | Allow | Allow | Allow | Allow | **RequireGate** |
| `AiSuggestion` | Deny | Deny | Deny | Deny | Allow | RequireGate | Deny | Deny |
| `SkillImport` | Deny | Deny | Deny | Deny | RequireGate | RequireGate | RequireGate | **RequireGate** |
| `SyncPull` | Deny | Deny | **RequireGate** | **RequireGate** | Allow | Allow | Allow | Deny |
| `ExternalFetch` | Deny | Deny | **Deny** | **RequireGate** | RequireGate | **Allow** | RequireGate | Deny |

**判读要点**
- `ExternalFetch` 唯一 `Allow` 的落点是 `.novel/market/`（C-006 第三层：运行时 TTL 缓存、派生态、可 GC）；对 `QM/raw/` 只能 `RequireGate`（入库需门控 + provenance）。
- `SyncPull` 对 `canon` / `QM/` 是 `RequireGate` 而非 `Allow` —— **回填本身仍是写**（C-002），且单向、禁静默覆盖。
- `UserEdit` 对资产本体是 `RequireGate` 而非 `Allow` —— C-007 判据 D4：项目内**不得内联**用户资产本体，只允许引用。
- `SkillImport` 对资产本体是 **`RequireGate`** 而非 `Deny`（TASK-006 校定）：用户资产域是**包本体的正当落点**（C-007），但必须过导入确认门；该门由 `skill_bundle_import(..., confirmed: bool)` 机械承载，而非靠调用方自觉。`{StatusJson, SchemaDoc, Canon, Reference, Other}` 仍为 `Deny`。

**消费侧收紧（TASK-008 校定）**：矩阵给 `SyncPull` 只到 `RequireGate`，但一份**远端副本永非真值**，连「过门」的资格都没有 —— 同步拉取的本地落点守卫据此**只接受 `Allow`**（`sync_target::assert_local_target_allowed`），从而 `QM/`、`canon` 在同步链路上实际为硬拒。
这是「矩阵是下限、消费方可以更严」的刻意选择：**放宽只能在矩阵里发生，收紧可以在消费点发生**，反向不可。

### D5：审计接入

```rust
pub struct AuthorityAuditRecord { source, target, decision, path }
pub fn audit_record(source, target: &Path, decision) -> AuthorityAuditRecord
pub fn audit_line(record) -> String   // 单行 JSONL，手写序列化
```

记录四元组 `(source, target, decision, path)`，形态为 `{"kind":"write_authority",...}`。手写序列化（含 `"` `\` 与 `< 0x20` 控制字符转义）以避免为纯审计串引入 serde 依赖。

## 后果

**正向**
- 三条新写入路径获得**共同调用点**，真源边界从「文档约定」变为「可执行判定 + fail-loud 自检」。
- 判定为纯函数、无 I/O、无状态 → 可在任意层调用（IPC 命令层 / 内部服务层 / 测试）。
- 路径派生设计使「换个名字绕过权限」不可能。

**代价 / 约束**
- 以路径为唯一判据 ⇒ **目录语义即权限语义**：新增库根（若未来有）必须同步更新 `classify_target` 与 `assert_hard_rules`。
- 判定不处理**运行时身份**（当前用户是否持有 unlock 令牌）—— 身份校验属应用锁（B-F-004）职责，本模块只回答「这类来源对这类目标是否允许」。

## 未决 / 交给下游

1. **`status_watcher` 审计流接线**：`audit_line()` 已提供产物，接入既有审计流的实际调用点未提交（属 TASK-006/008/012 的落地集成，非本任务收敛判据）。
2. **`tauri.conf` capability 收窄**：派发层收口之外，仍须删除前端直写项目文件的 capability（SA-A/SA-B 补充要求）。
3. **hub 侧工具链盲区**（SA-B 残余风险①）：PowerShell 脚本与 Node CLI 在 Tauri 派发层之外可直写文件系统，本矩阵对其不生效 → 须纳入审计或出显式豁免清单。
4. **R1 注册表成员校验**（DA 槽位 B 替代路）：`PROJECTION_REGISTRY ∩ (QM/raw/** ∪ 用户资产域/**) = ∅` 须落为**注册时**运行时断言（而非自愈执行时）。

## 验证

| 判据 | 命令 | 结果 |
|---|---|---|
| `pub enum WriteSource` | `rg -n 'pub enum WriteSource' src-tauri/src/canon/write_authority.rs` | 命中 1 |
| `pub fn may_write` | `rg -n 'pub fn may_write' src-tauri/src/canon/write_authority.rs` | 命中 1 |
| 三来源标记 | `rg -n 'SkillImport\|SyncPull\|ExternalFetch' …/write_authority.rs` | 命中 ≥3 |
| 模块导出 | `rg -n 'write_authority' src-tauri/src/canon/mod.rs` | 命中 1 |
| 单测 | `cargo test --manifest-path src-tauri/Cargo.toml write_authority` | 见专项验收记录（含 `external_fetch_cannot_write_canon`、`sync_pull_cannot_write_status_json`） |
