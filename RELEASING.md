# RELEASING — Niko Buddy 发布规范

> 生态建设 P0（2026-08-29 三模型共识 ecoA）。目标：消除单日灌版噪音、统一资产命名、恢复用户信任。

## 版本策略（语义化）

> 本项目以 minor 承载破坏性/架构级变更（2.x 不升 major），与严格 SemVer 的 major 语义有意偏离。

| 变更类型 | 版本位 | 示例 |
|---|---|---|
| 破坏性变更 / 架构级 | minor | 2.8.0 |
| 新功能（向后兼容） | minor | 2.8.0 |
| 修复 / 小改进 | patch | 2.7.5 |

- 版本号三处一致：`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`。
- **单写者红线（P0-2f）与 commit 纪律（P0-2g）**：版本号/CHANGELOG/generated 写入权限与 commit 拆分规则以 `.workflow/PARALLEL-PACT.md` 地盘表「单写者红线」+ P16 为准。
- **禁止跳号**：每个 tag 必须对应一次真实构建；构建失败不发布、不移动或删除已公开的 tag。

## 发布节奏

- **stable：每周 ≤1 个**。候选版一律走 `prerelease` 标记（内测渠道），验证通过后再提升为 stable。
- **节奏硬检已机械检查化**：`npm run release:cadence`（`scripts/check-release-cadence.mjs`）审 Latest（或 `--tag` 指定版本），判 ISO 周 stable ≤1 / 同日重复 = 0 / 近 30 天 ≤4 / Latest 资产与主干；门禁只判被审版本，历史违规以 INFO 输出。渠道定义与豁免流程见 `docs/decision-log/20261018-release-channel-cadence.md`，豁免必须登记在 `release-cadence-exemptions.json` 且 `scope` 逐条列出规则键。
- **fix-forward 豁免（2026-09-07 第二轮 9 票共识，decision-record-20260907b 决策 3）**：资产补齐/断链修复类补救性发布（如 v2.7.9 补 v2.7.8 的 0 资产缺口）可豁免「每周 ≤1」与「近 30 天 ≤4」硬检，条件：① 发布目的为修复更新链路（notes-only 资产补齐/错版本资产处置）；② 用户明确批准（含渠道=stable 决策记录）；③ 发布后承诺窗口内（至 10/2）不再发 stable；④ 豁免登记写入 release body。豁免不改变「同日重复 tag = 0」与「主干校验」硬检。
- 同日重复 tag：无 CI 自动门禁，靠人工纪律执行（重复 tag 一律拒绝；候选版如需走 `prerelease`，由发布者手动加 `--prerelease` 标记）。
- 发布前检查：
  - **typecheck 唯一口径（硬检，68 号 P1-9）**：`npm run typecheck`（= `tsc --build --force --pretty`）必须 0 错误；**禁止裸 `npx tsc --noEmit`**——根 tsconfig `files:[]` 纯 references 结构下为空操作假阴性（66 号 §3 实锤）。typecheck 红主干禁止发版（v2.7.5/2.7.7/2.7.8 门失败仍发布先例不得重演）。
  - `npm run lint`（硬检，= `eslint . && node scripts/check-boundaries.mjs`；eslint 0 error，warning 容忍）
  - `npm run test:mocks` 全绿（与 CI `.github/workflows/checks.yml` 同口径：character-aura lint + vitest mock 套件，排除 real-llm/bench）+ 真机冒烟（安装/更新/重启）。

## 资产命名（唯一规范）

```
niko-buddy_<version>_windows_X64.exe
niko-buddy_<version>_windows_X64.exe.sig
niko-buddy_<version>_windows_X64_portable.zip
niko-buddy_<version>_macOS_AppleSilicon.dmg / .app.tar.gz
niko-buddy_<version>_macOS_Intel.dmg / .app.tar.gz
niko-buddy_<version>_linux_X64.AppImage / .deb   # Linux 补发后
latest.json
```

- **禁止 QMaiWrite_* / Niko.Buddy_* 前缀**（历史残留见清理脚本 `scripts/cleanup-release-assets.mjs`）。
- 签名：`.sig` 必须与资产一一对应；latest.json 内嵌 signature 与文件名一致。

## Release 标题与正文

- 标题：`Niko Buddy v<version>`（统一格式，禁止裸版本号/描述混用）。
- 正文：用户可读 changelog（新功能 / 修复 / 下载链接），技术细节移入附录。

## 平台覆盖

- **当前活跃目标：仅 Windows x64**（nsis 安装包 + portable）——`.github/workflows/build.yml` 的 `matrix.include` 只有 `windows-x64` / `windows-latest`（2026-10-14 用户指令锁定 Windows-only）。
- 每个**活跃**目标资产齐全才发布；活跃目标缺失或未补齐须在正文标注原因，未成为活跃目标的平台不计入发布门槛。
- 注：上方 macOS（AppleSilicon + Intel）/ Linux（AppImage + deb）命名仅为潜在平台的命名约定，**不代表已交付支持**；恢复需先在 build.yml 恢复对应 matrix 条目，是否正式发版以 Releases 实际资产为准。

## 草稿晋升

- 手动触发（`workflow_dispatch`）走独立的 `build-unsigned` job，仅上传未签名的 Windows 安装包。该 job 不进入签名环境，不使用正式 updater 私钥，也不创建发布草稿。
- 只有 `Smith-106/niko-buddy` 的 tag push 通过同提交 CI、`v<version>` 匹配及 `master` 祖先校验后才使用正式 updater 私钥。签名 job 绑定 `windows-release-signing`，从该环境读取 `WINDOWS_RELEASE_TAURI_KEY` 和 `WINDOWS_RELEASE_TAURI_PASSWORD`；不要将这两个密钥设为仓库级或组织级 secrets。
- 签名环境只允许 `v*` tag，配置独立审批并阻止自审；tag 规则仅允许发布维护者创建、禁止更新或删除。首发前须单独核实这些保护，迁走旧仓库级签名密钥，并确认已获准的提交绑定同一次 CI 与草稿。源码声明不代表远端配置已生效。
- 旧 tag 跑旧 workflow——历史 tag 上的旧流水线无法被当前代码约束，晋升前须按本文件重新核验：远端 tag 剥皮 SHA 精确匹配、草稿四资产 sha256/digest 与签名校验复跑、同 commit CI 绿、release cadence 通过，之后才走外部授权晋升。
- 核验任何一环存疑即不晋升，保留旧 Latest。草稿创建后若核验失败，保持未公开，交由维护者人工检查，不自动清理。
- 草稿节奏检查使用 `npm run release:cadence -- --tag vX.Y.Z --draft-promotion`，相当于以运行时刻模拟晋升；使用鉴权发布 API 按 release ID 读取草稿资产并检查上传状态和摘要元数据；该检查不会发布，也不替代签名、SHA 实值、远端绑定与同提交 CI 核验。

## 发布后检查清单

1. `gh release view v<version>` — 标题/资产/签名齐全
2. latest.json 指向最新版本且签名匹配
3. 本机 updater 检测到新版本（真机验证）
4. 历史 release 无 QMaiWrite_* 残留（`gh release list` 抽查）
5. **节奏审计（硬检，65 号共识 G5）**：`npm run release:cadence`（机械检查：同周 stable ≤1、同日重复 tag = 0、近 30 天 stable ≤4、Latest 资产齐全、tag 已回流主干）；脚本 exit ≠ 0 则本次发布作废重排期，历史违规只看 INFO 不重复计罚
6. **主干校验（硬检，65 号共识 G5）**：`git merge-base --is-ancestor <tag> smith/master` 必须为真（tag 不得悬在 side 分支）；不通过则先完成 master 回流再确认
