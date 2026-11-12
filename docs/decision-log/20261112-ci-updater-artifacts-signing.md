# 2026-11-12 CI updater 产物：手动 dispatch 补 `createUpdaterArtifacts` 单一旗标

- **状态**：Proposed（源码 + 聚焦回归已落；待 Root 独立复核，未提交、未派发）
- **日期**：2026-11-12（任务起始日；落档时本地已跨至 11-13 凌晨，按任务起始日归档）
- **范围**：新建 `QMAI/src-tauri/tauri.ci.conf.json`、`QMAI/.github/workflows/build.yml`（1 行）、新建 `QMAI/scripts/ci-updater-artifacts.spec.mjs`、本条目
- **会话/运行**：`20261109-ralph-expert-residuals` / `run-fe6288c0ce65`
- **基线**：`48bb9a36394121bc60156448899f82d8299efe97`（master，跟踪面干净；10 个 `scripts/l9-*` untracked 原样保留）

## 根因

`workflow_dispatch` 路径产出的 Windows NSIS 安装包**没有 updater 签名**（CI run `43235877301` attempt 1 结论 success、3/3 job 绿，artifact `13955831905` 仅含 1 个成员：安装包本体，无 `.exe.sig`），是**生产侧缺输入**，不是上传侧漏抓：

1. 基座 `src-tauri/tauri.conf.json:33-38` 的 `bundle` 只有 `active` / `targets:["nsis"]` / `resources` / `icon`，**没有** `createUpdaterArtifacts`；该字段默认 `false`（`node_modules/@tauri-apps/cli/config.schema.json:2119-2126`），因此 bundler 从不产出签名侧车文件。布尔 `true` 才是当前 v2 模式（同文件 `2405-2428`：`v1Compatible` 旧 zip 为显式 opt-in）。
2. 唯一的兜底签名调用在 `Publish Windows updater manifest` 步骤内（`build.yml:165` 起，`if: github.event_name == 'push' && matrix.label == 'windows-x64'`），`workflow_dispatch` 整步被跳过 —— 这正是 `.sig` 缺失的直接原因。
3. `Build Tauri app` 步骤（`build.yml:157-162`）**无事件 guard**，三个 `${{ secrets.* }}` 占位（`GITHUB_TOKEN` / `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）在 dispatch 路径已经就位；上传步骤与 glob 也已声明 `src-tauri/target/**/release/bundle/nsis/*.exe.sig`（`build.yml:49`、`:296-303`）。所以缺的只有一个 bundler 输入。

## 决策

| 字段 | 值 |
|------|-----|
| date | 2026-11-12 |
| task_id | ci-updater-artifacts-correction（`run-fe6288c0ce65`） |
| decision_type | 手设参数（未定稿，Proposed） |
| value | 新增 `src-tauri/tauri.ci.conf.json`，内容为唯一叶子 `{"bundle":{"createUpdaterArtifacts":true}}`（严格 JSON、2 空格缩进、末尾 LF、无 `$schema`/`version`/`targets`）；`build.yml:162` 的 `run:` 由 `npx tauri build ${{ matrix.tauri_args }}` 改为追加 ` --config src-tauri/tauri.ci.conf.json`。全仓唯一改动行，只给 CI 命令 opt-in。 |
| evidence_ref | `src-tauri/tauri.conf.json:33-38`（基座无该字段，改动前后一致）；`.github/workflows/build.yml:162`（唯一改动行）；`.github/workflows/build.yml:29,49,135,144,165,249,256,272,279,296-303`（`ci-gate`/glob/7 条 push-only guard/上传步骤，全部字节未变）；`node_modules/@tauri-apps/cli/config.schema.json:2119-2126,2405-2428`（默认 false；true=v2 产物）；`scripts/ci-updater-artifacts.spec.mjs`（11 条静态断言） |

### 所选方案

用 Tauri **已有的**配置合并机制（`-c/--config` 接受 JSON 文件路径，与默认配置合并；平台文件 `tauri.windows.conf.json` 默认先合并，`--config` 后合并胜出）把 `bundle.createUpdaterArtifacts=true` 只注入 CI 命令。相对路径按**进程 cwd**（CI 即仓库根）解析，且在参数解析阶段就读盘，路径写错会在 `beforeBuildCommand`/cargo 之前失败，不会白烧一次编译。

### 两个被拒替代

1. **直接改基座 `tauri.conf.json`**：会把 `createUpdaterArtifacts` 变成全局默认，使 `scripts/build-release-env.mjs` / `build-portable.mjs` 的普通本地 `tauri build` 也要求签名私钥 —— 破坏无密钥本地构建（基线行为 B1）。
2. **在 `run:` 行内联 JSON 字符串**（`--config '{"bundle":{"createUpdaterArtifacts":true}}'`）：少一个文件，但把 JSON 引号/转义风险塞回 YAML→shell→`npx.cmd`(Windows) 三层，正是文件覆盖方案要避免的脆弱点。仅当覆盖方案被证伪（且经 Root 重新裁决 + fresh 复核）时才考虑。

## 明确不改

- `src-tauri/tauri.conf.json`（version `2.27.2`、pubkey、endpoints、targets）与三个平台覆盖文件 **零改动**；overlay 是旗标唯一来源。
- 7 条 push-only guard（`build.yml:135,144,165,249,256,272,279`）、`needs: ci-gate`（`:29`）、`Publish Windows updater manifest` 里既有的 `npx tauri signer sign` 兜底（`Test-Path` 守卫，tag 路径上退化为 no-op）、上传步骤与 `artifact_globs`（`:47-49`、`:296-303`）全部字节不变。
- 无新 workflow / sign-only job / 依赖 / helper module / 缓存层；无本地签名；无版本 / CHANGELOG / `changelog.ts` / Cargo / generated 写入；不 import 不执行 `prepare-github-release.mjs`。
- 不读任何私钥、credential store 或 env 值；workflow 内只出现 `${{ secrets.* }}` 占位名。

## 验证（源码层，本 Run，真 RED→GREEN）

唯一聚焦命令：`npx vitest run scripts/ci-updater-artifacts.spec.mjs`（复用仓库已安装 vitest 4.1.11，未安装任何依赖）。

- **RED（改动前）**：**exit 1**，`3 failed | 8 passed (11)`。失败恰为三处，且**指名**缺口：
  - `src-tauri/tauri.ci.conf.json must exist`（×2：sole-flag 断言、canonical JSON 断言）
  - `build.yml must carry exactly one 'run: npx tauri build ${{ matrix.tauri_args }} --config src-tauri/tauri.ci.conf.json'`（计数 0）
- **GREEN（改动后，同一文件、同一条命令）**：**exit 0**，`11 passed (11)`。
- **回归方式**：纯源码文本读取（`readFileSync`）。生产文件（`build.yml`、各 `tauri*.conf.json`、`prepare-github-release.mjs`）**不 import、不执行**；无网络、无签名、无写 IO。所有读盘都在 `it()` 体内经「缺失返回 null」的读取器，缺文件表现为断言红而非模块加载崩溃。
- **断言覆盖面（11 条）**：①基座 `bundle.createUpdaterArtifacts` 为 `undefined`；②三个平台覆盖文件同样不含该键（`it.each`，计 3 条文件校验）；③overlay 整个对象 `toStrictEqual({bundle:{createUpdaterArtifacts:true}})` + `Object.keys` 恰为 `["bundle"]` —— 整对象严格相等即证明「唯一旗标 + 严格布尔 true」，无需 flatten 器或新 helper；④overlay 规范化字节形态（`JSON.stringify(x,null,2)+"\n"`、末尾单 LF）；⑤实际 CI 行恰 1 次、旧行 0 次、`--config` 全文件 1 次；⑥同一步骤 `env` 三个 secret 仍为占位形态（`secrets.` 恰 3 次，两条签名键行逐字相等 —— 无字面值可藏）；⑦7 条 push-only guard 精确行计数（2/3/1/1，合计 7）+ `needs: ci-gate` 1 次；⑧dispatch 上传步骤名/`path`/`if-no-files-found: warn`/`retention-days: 14` 与 `*.exe`/`*.exe.sig` glob 字面保留；⑨workflow 源码不含 ≥60 字符的 base64/hex 样密钥材料。

## 未声明（not claimed）

- 不声明 Goal 完成、G5、T09/T10、任何 canonical Run/Session 生命周期变更。
- 不声明 CI 真的产出了签名、安装包可用、真机安装/升级/重启、端到端 updater 流程（`latest.json`/endpoint 对齐）通过 —— 这些需要**一次**新的手动 dispatch 产物来实测，本条目只覆盖静态接线。
- 不声明 prompt 实效、六维评分或 L9 文学验收。
- 不声明与已发布 v2.27.2 资产（tag 指向 `59cfb725`）等价；本次是同版本 2.27.2 的**源码快照**修正。
- 不声明与旧安装包 `bb4e92ac…` 字节一致（NSIS 不保证可复现）。
- 不声明人审签字、独立复核结论或 Plan 模式确认；作者与复核者必须不同上下文。
