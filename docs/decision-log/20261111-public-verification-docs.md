# 2026-11-11 公开验证与发布声明纠偏（质量门槛四事实 / 平台覆盖活跃目标）

- **状态**：Proposed（文档已落盘，**未提交**；独立只读复核 pending，本体不构成发布、验收或人工批准）
- **日期**：2026-11-11
- **范围**：仅 `README.md` `### 质量门槛` 段内已知四条声明 + 既有 manifest 权威脚注一处精度 + `RELEASING.md` `## 平台覆盖` 三行 + 本条目；**无**代码、测试、`vite.config.ts`、package/lock/version、`CHANGELOG.md`、`.github/`、生成物、发布资产或凭据改动
- **锚定**：基线 HEAD `0eaecdb46a988f7a25df89f780b5987814b8ef37`（`master`，已推送；含 N4 交付元数据提交 `0eaecdb4`）
- **会话/运行**：`20261109-ralph-expert-residuals` / `run-fe6288c0ce65`

## 背景

N4 复核提出两条（RV-001 medium「质量门声明不实」、RV-002 low「改动脚注精度不足」），根因同属「公开文档 → 现行工程调用/覆盖率配置 / 锁定发布矩阵」这一条共享界面；核查源码时又确认同一质量段内两条相邻不实声明，故合并为本轮唯一一次整体修正，不再按发现逐条开启修正链。

实测事实（只读源码确认，未为复查事实重跑套件）：

1. `package.json` 有 `lint`（`eslint . && node scripts/check-boundaries.mjs`）与 `typecheck`（`tsc --build --force --pretty`）两个真实 script；`.github/workflows/checks.yml` 中 `Typecheck (tsc, force)` 执行 `npm run typecheck:force`、`Lint (eslint, 68 号 P1-9 接入)` 执行 `npm run lint`，随后还跑 `consistency` / `test:mocks` / `gen:check`。
2. `test:mocks` = `scripts/lint-character-aura.mjs` + vitest（排除 real-llm/bench 等，`graph-view.spec.tsx` 被排除后以 `--no-file-parallelism` 串行补跑），**不含 `--coverage`**；覆盖率只在 `test:coverage` 里以显式 `--coverage` 开启。
3. `vite.config.ts` 的 `test.coverage.thresholds` 现行四维 = statements `99.9` / branches `97` / functions `99.5` / lines `99.9`；注释中的 `80/75/80/80` 是共识下限，不是现行运行元组；统计范围由 `coverage.include`/`exclude` 白名单决定，不是「全口径 src/」。
4. `.github/workflows/build.yml` 的 `matrix.include` 现行**只有** `windows-x64` / `windows-latest`（`--bundles nsis`），macOS/Linux 条目已按 2026-10-14 用户指令移除；残留条件步骤不等于活跃目标。

## 决策

| 字段 | 值 |
|------|-----|
| date | 2026-11-11 |
| task_id | `public-verification-docs`（Run `run-fe6288c0ce65`，S3 合并任务） |
| decision_type | 统计口径 |
| value | `### 质量门槛` 不再声明任何固定 `2 skipped` / `N passed \| 2 skipped` 计数，也不把 `test:mocks` 称作「Vitest 全量」：通过/跳过数取决于实际调用命令、排除项与环境，`test:mocks` 是 mock 套件（排除 real-llm/bench，graph-view 串行补跑）。 |
| evidence_ref | `package.json:19-20`（`test` 链式三命令 + `test:mocks` 完整排除集）；`README.md:853` |
| date | 2026-11-11 |
| task_id | `public-verification-docs` |
| decision_type | 统计口径 |
| value | 凭证门控块明示「**skipped ≠ PASS**」：缺 env 自动跳过时 EXIT=0 只说明被跳过；示例只保留 env **名称**（不读取、不引用任何实际 env 或凭据值），真实 LLM / 真实 fs 写盘需显式前置条件。 |
| evidence_ref | `README.md:854`（「skipped ≠ PASS」句）；原 env 名称清单 `README.md:855-858` 保留未改；`vite.config.ts:153-155`（`.env.test.local` loader 语义为 no-op 缺失安全） |
| date | 2026-11-11 |
| task_id | `public-verification-docs` |
| decision_type | 统计口径 |
| value | 覆盖率不再抄写阈值元组：`test:mocks` 不采集覆盖率，须显式 `npm run test:coverage`；统计范围与四维阈值统一指向 `vite.config.ts` 的 `test.coverage` 为唯一真源，文档**不复制数字、不声明任何当前实测覆盖率**。 |
| evidence_ref | `vite.config.ts:183-218`（`coverage.include`/`exclude`/`reporter` + `thresholds` 四维）；`package.json:40`（`test:coverage` 单一 `--coverage` 入口）；`README.md:859` |
| date | 2026-11-11 |
| task_id | `public-verification-docs` |
| decision_type | 基线值 |
| value | 类型门口径 = `npm run typecheck`（= `tsc --build --force --pretty`）；明示裸 `tsc --noEmit` 为**空操作假阴性**（根 tsconfig 纯 references + `files: []`），不作为静态检查主口径。 |
| evidence_ref | `package.json:12`；`tsconfig.json`（`files: []` + references）；`.github/workflows/checks.yml:69-71`（CI 用 `typecheck:force`，命令同形）；`README.md:860` |
| date | 2026-11-11 |
| task_id | `public-verification-docs` |
| decision_type | 外部佐证引用 |
| value | 撤销「本仓库不设 lint script / lint CI 门」的旧论断，改为陈述现状：`npm run lint` 存在且是 CI 硬门（`checks.yml` 显式执行，要求 0 error）；静态风格检查以 `eslint` + `scripts/check-boundaries.mjs` 为准，**不新增也不删除任何门**。 |
| evidence_ref | `package.json:15`；`.github/workflows/checks.yml:79-80`；`eslint.config.js`（已存在配置）；`README.md:861` |
| date | 2026-11-11 |
| task_id | `public-verification-docs` |
| decision_type | 统计口径 |
| value | `README.md:718` 脚注精度限定为「**本段**不硬编码版本三元组」，并声明其余段落（含顶部徽章/版本摘要）中的版本编号只是叙述性摘选、不构成版本权威；三处 manifest 指针与「源码 tip ≠ 已发布包」披露保持原样。 |
| evidence_ref | `README.md:718`（本轮精度限定）；N4 原始决策 `docs/decision-log/20261111-readme-delivery-metadata.md`（manifest 真源 / 摘选口径 / 源码≠包三条保持有效） |
| date | 2026-11-11 |
| task_id | `public-verification-docs` |
| decision_type | 外部佐证引用 |
| value | `## 平台覆盖` 改述**当前活跃目标仅 Windows x64**（`matrix.include` 唯一 `windows-x64` / `windows-latest`，2026-10-14 用户指令锁定）；发布门槛改为「每个**活跃**目标资产齐全才发布」；macOS/Linux 的 dmg/AppImage/deb 命名降级为**潜在平台命名约定**（不代表已交付支持），恢复需先在 build.yml 恢复 matrix 条目，是否发版以 Releases 实际资产为准。 |
| evidence_ref | `.github/workflows/build.yml:39-47`（`matrix.include` 唯一 `windows-x64` 条目 + 「Windows-only 发布（2026-10-14 用户指令）」注释）；`RELEASING.md:52-54`；`RELEASING.md` 资产命名节（命名约定保留） |

## 边界与不变项

- `README.md` `### 质量门槛` 内的**记忆引擎专项**（862）与**评测基线门 B/C**（863-866）段落逐字未改；顶部 v2.27.1 节的包证明与「认证 MCP 回读仍 pending」披露逐字未改；其余 README 段落（发布节、历史、下载、功能说明）零改动。
- `RELEASING.md` 的版本策略、发布节奏（含 cadence 硬检与 fix-forward 豁免）、资产命名、签名规则、发布后检查清单逐字未改——本次只改 `## 平台覆盖` 三行。
- 未改：任意 `src/`、`src-tauri/`、`scripts/`、`tests/`、`e2e/`、`package.json`、`package-lock.json`、`src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json}`、`vite.config.ts`、`eslint.config.js`、`tsconfig*.json`、`.github/`、`CHANGELOG.md`、生成物、`docs-site/`、`reference/`、书稿/草稿/状态/记忆、`.gitattributes`、发布标签/资产/节奏豁免、凭据。
- 未执行：lint / typecheck / vitest / 覆盖率 / 一致性门 / 生成物门 / Cargo / E2E / CI / 网络 / provider / MCP / 书稿门控调用。本轮为纯文档声明改动，不使既有代码检查失效；此前 N4/P1/code 的通过证据按其原范围复用，不因本次改动重跑或改写，也**不**把旧 README 的原始哈希沿用于新文件（见下表）。

## 行尾与哈希（raw 与 canonical 分别记录）

仓库 `.gitattributes` = `* text=auto eol=lf`：`README.md` 工作区为 raw CRLF、索引/提交为规范化 LF；`RELEASING.md` 与新增条目本身为 LF。二者**不做**整文件归一化。

| 文件 | 形态 | 字节 | SHA-256 | 说明 |
|------|------|------|---------|------|
| `README.md` | 修改前 raw（CRLF） | 76247 | `112b0fc591f2dfdde7958acb18581c08cb68255c2e70a5ed6eb3521967a073d1` | CR 891 / LF 891，891 行 |
| `README.md` | 修改前 canonical LF（=HEAD blob） | 75356 | `56e5d1c7b3d46670933c4ae7baf613f367f82333b11b5a7527d0c5bb7155fd36` | blob `d2d5be3309f09377be2b93d6518e4dfccca84edc` |
| `README.md` | 修改后 raw（CRLF） | 76807 | `d1e5e62291b21bb210ad6abe53f9bf67db844094bab5d3ebcb30d00680929a84` | CR 891 = LF 891（行数未变，仅 6 行替换） |
| `README.md` | 修改后 canonical LF | 75916 | `afaac329175be9ba1048af71d5fcee2490719c85ba4153d5bbca3e2e28e8b52f` | `git hash-object --path=README.md` = `d54596a2868f5782153d36518afaae7b091f7f0c` |
| `RELEASING.md` | 修改前 raw = canonical（LF） | 4982 | `74e299e88756339281606169410aaf6c9abe24e83f3ce2cfa01fd8a37942dc71` | CR 0 / LF 63；blob `5f11903945e347f3cd4ce133d1fa1363726fd207` |
| `RELEASING.md` | 修改后 raw = canonical（LF） | 5236 | `39fdfc200a62904afeb965364ea1baac71fa0c230fbdb34d4ed6c84eabe1f742` | CR 0 / LF 63（行数未变，仅 3 行替换）；blob `79bd665219cdcdcb8b82ea4ce859c2d80fb1fc19` |

`README.md` 的 `76807 − 891 = 75916`，即 CRLF 与 LF 两形态字节差恰等于行数，证明未引入行尾混排、未整文件改 LF。

## 未声明事项

- 本条目为**任务快照**，不新增政策、不改变发布节奏/豁免、不代表人工批准；`Proposed` 状态待独立复核裁决。
- 不声明 G5 / L9 / Goal 完成；不改动 A4 台面行、tracker 或生命周期状态。
- 未提交、未推送：本轮只留工作区改动（`README.md`、`RELEASING.md` 修改 + 本文件新增）供独立复核，提交与推送由获授权发布者在 APPROVE 后执行。
