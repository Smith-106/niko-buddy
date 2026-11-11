# 2026-11-11 README 交付元数据纠偏（版本真源 / Windows-only 矩阵 / 未证徽章 / 源码≠包）

- **状态**：Proposed（文档已落盘，**未提交**；独立语义复核 pending，本体不构成发布、验收或人工决策）
- **日期**：2026-11-11
- **范围**：仅 `README.md` 交付/版本自述三处（覆盖徽章、版本摘要口径、过期版本与矩阵脚注）+ 本条目；**无**源码、生成物、manifest、lock、CHANGELOG、CI、发布资产改动
- **锚定**：基线 HEAD `5f71a7fe`（`master`；已含 P1 修复 `0cf0815c` + atlas `5f71a7fe`）；`README.md` 上次变更来自本 Goal 的 `c1e5d92b`
- **会话/运行**：`20261109-ralph-expert-residuals` / `run-fe6288c0ce65`

## 背景

README @715–717 三行"当前版本"自述已过期且互相矛盾：

1. 声称"当前源码 tip 是 **v2.21.1** prerelease（2026-10-22，不进 Latest），当前 stable 仍是 **v2.21.0**"；
2. 声称"CI 已具备三平台构建 matrix（build.yml）"；
3. 声称"产品版本号以 `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`（均 2.21.1）为准"。

实测事实与之不符：三处 manifest 均为 **2.27.1**；`.github/workflows/build.yml` 的 `matrix.include` 只有 `windows-x64`（runner `windows-latest`），macOS/Linux 条目已按 2026-10-14 用户指令移除，残留的条件步骤不构成活跃 matrix 目标；v2.27.1 已是 stable 且接任 GitHub Latest（README 顶部 v2.27.1 节已如实登记）。

同时两处披露缺陷：

- 顶部 `coverage-100%` 徽章：P1 源码修复后**未重跑**当前源码全量覆盖率，该数字无现行证据支撑；
- 顶部版本摘要只摘选部分版本，`v2.26.5` / `v2.27.0` 有条目在 `CHANGELOG.md` 而 README 未收录，读者无从知道"摘选≠全集"。

第三处是**源码与已发布包**的边界：源码 tip 含 P1 角色行为路由归一修复（`0cf0815c`），而已发布的 v2.27.1 安装包**不含**该修复；旧脚注用"源码 tip 为准"一句混同两者。

## 决策

| 字段 | 值 |
|------|-----|
| date | 2026-11-11 |
| task_id | `n4-readme-delivery-metadata`（Run `run-fe6288c0ce65`） |
| decision_type | 统计口径 |
| value | 移除顶部 `coverage-100%` 徽章，**不**替换为任何新的当前覆盖率数字：当前源码覆盖率未重跑，任何数值都会是未证陈述。覆盖率如实状态的唯一出口是重跑后的新证据，不是徽章文案。 |
| evidence_ref | `README.md`（原第 19 行徽章已删除）；本 Run `work/n4/n4-readme.diff.txt`；覆盖率未重跑事实见下方「未执行」 |
| date | 2026-11-11 |
| task_id | `n4-readme-delivery-metadata` |
| decision_type | 基线值 |
| value | 版本号唯一真源 = `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` 三处 manifest（当前三处均 `2.27.1`）；README **不再**硬编码版本三元组，只声明真源位置。已发布的 v2.21.x 等版本表述从"当前 tip/stable"撤回，仅保留 v2.7.8 notes-only 历史事实。 |
| evidence_ref | `package.json:3` = 2.27.1；`package-lock.json:3` 与 `packages[""].version` = 2.27.1；`src-tauri/tauri.conf.json` `version` = 2.27.1；`src-tauri/Cargo.toml` `version = "2.27.1"`；`README.md`（新增脚注三项） |
| date | 2026-11-11 |
| task_id | `n4-readme-delivery-metadata` |
| decision_type | 外部佐证引用 |
| value | 当前活跃发布矩阵 = **仅 Windows x64**（`matrix.include` 唯一一行 `windows-x64` / `windows-latest`，`--bundles nsis`）；锁定 Windows-only 的产品支持结论不变。macOS/Linux 是否正式发版以 Releases 实际资产为准，条件性步骤/历史条目不得当作活跃目标。 |
| evidence_ref | `.github/workflows/build.yml` `strategy.matrix.include`（含"Windows-only 发布（2026-10-14 用户指令）"注释）；`README.md`（脚注改为 Windows x64 活跃目标 + `build.yml` 链接） |
| date | 2026-11-11 |
| task_id | `n4-readme-delivery-metadata` |
| decision_type | 外部佐证引用 |
| value | README 版本摘要为**摘选**：新增一句口径说明，指向 `CHANGELOG.md` 与 GitHub Releases 作为逐版完整历史（不复制 CHANGELOG 全文、不重建时间线）。`v2.26.5` / `v2.27.0` 等未收录条目不补写摘要。 |
| evidence_ref | `CHANGELOG.md:25`（`## [2.27.0] - 2026-11-09`）、`CHANGELOG.md:50`（`## [2.26.5] - 2026-11-07`）；`README.md`（`## v2.27.1` 前新增口径行）；README 标题清单中确无 v2.26.5 / v2.27.0 |
| date | 2026-11-11 |
| task_id | `n4-readme-delivery-metadata` |
| decision_type | 外部佐证引用 |
| value | 源码 tip ≠ 已发布安装包：`smith/master` 的 P1 角色行为路由归一修复（提交 `0cf0815c`，module-atlas `5f71a7fe`）只存在于源码，**不在**已发布的 v2.27.1 包内；README 明确该区分，并把当前发布状态/资产权威指回顶部 v2.27.1 节与 Releases。 |
| evidence_ref | `git log` 基线 `5f71a7fe` / `0cf0815c`；`docs/decision-log/20261111-p1-behavior-routing.md`（"已发布的 v2.27.1 产物**不含**本修正"）；`README.md`（脚注第 4 行） |

## N3（明确不改）

`package.json.version`、`package-lock.json.version`、`package-lock.json.packages[""].version` 三处已一致为 `2.27.1`，**不是当前缺陷**。本任务对三者只读：不修改、不"顺手对齐"、不制造修复痕迹（sha256 前后一致见本 Run `work/n4/n4-protected-before.sha256` 与 `n4-protected-after.sha256`）。

## 行尾与哈希（Git filter 行为显式化）

仓库 `.gitattributes` = `* text=auto eol=lf`，`git check-attr` 对 `README.md` 报 `text: auto` / `eol: lf`；工作区为 raw CRLF、索引/提交为规范化 LF。因此**同时**记录两份哈希，二者都以同一份被复核字节为准：

| 形态 | 字节 | SHA-256 | 说明 |
|------|------|---------|------|
| 修改前 raw（工作区 CRLF） | 75745 | `dc6cd19c8b57f5fb7f13f5680a63081f9ecaf67ac57240024e7a6c89d2f55dac` | 889 CRLF；标题基线 |
| 修改前 canonical LF（=HEAD blob） | 74856 | `24a621436b1eafdd46c45363d6a17c9c652430f527421e4783af61e701d91248` | HEAD blob oid `37757004ad7ff6a73575103ab4d0bf1e3100516b`；`git hash-object --path=README.md` 复核一致 |
| 修改后 raw（工作区 CRLF） | 76247 | `112b0fc591f2dfdde7958acb18581c08cb68255c2e70a5ed6eb3521967a073d1` | 891 行，CR 891 = LF 891（**未归一化全文**，仅改动 3 处区域） |
| 修改后 canonical LF（将入索引/提交） | 75356 | `56e5d1c7b3d46670933c4ae7baf613f367f82333b11b5a7527d0c5bb7155fd36` | 预期 blob oid `d2d5be3309f09377be2b93d6518e4dfccca84edc`（`git hash-object --path=README.md` 与 `git diff` index 行一致） |

`76247 − 891 = 75356`，即 CRLF 与 LF 两形态字节差恰等于行数，证明改动没有引入新的行尾混排、也没有为了省事把全文改成 LF。

## 未改 / 未执行（边界）

- 未改：任意 `src/`、`src-tauri/`、`scripts/`、`package.json`、`package-lock.json`、`src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json}`、`CHANGELOG.md`、生成物、`.github/`、`docs-site/`、`reference/`、书稿/草稿/状态/记忆、`.gitattributes`、发布标签/资产/节奏豁免、凭据。
- 未执行：全量 vitest / 覆盖率 / TS 类型检查 / Cargo / E2E / 生成器 / CI / 真实 provider / MCP 与书稿门控调用 / 依赖安装。无行为输入变化，P1 的 79/79、typecheck、atlas 与既有真包检查保持其原范围证据，不因本次文档改动重跑或改写。
- README 顶部 v2.27.1 节的包证明与"认证 MCP 回读仍 pending"披露**保持原样**，未据此下调或上调任何验收结论。
- 本条目**不**声明 G5 / L9 / Goal 完成，**不**改动 A4 台面行，**不**代表任何人工批准或节奏豁免变更。
- 未提交：本轮只留工作区改动（`README.md` 修改 + 本文件新增）供独立复核；提交与推送由获授权的发布者在 APPROVE 后执行。
