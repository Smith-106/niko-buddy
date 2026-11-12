# 2026-11-12 DEBT-10-A：本地更新清单按标签固定下载地址

- **状态**：Proposed（源码与聚焦回归已落；独立复核待 Root 消费，未提交、未发布）
- **日期**：2026-11-12（本地时区；对应 UTC 2026-11-11）
- **范围**：`QMAI/scripts/prepare-github-release.mjs`（1 行）、新建 `QMAI/scripts/prepare-github-release.spec.mjs`、本条目
- **会话/运行**：`20261109-ralph-expert-residuals` / `run-fe6288c0ce65`

## 根因

本地 GitHub 发版准备脚本把**不可变**的版本文件名 `niko-buddy_${pkg.version}_windows_X64.<ext>` 挂在**移动**别名 `releases/latest/download/` 下（`scripts/prepare-github-release.mjs:67`）。GitHub Latest 会随发布移动，因此本地 staging 生成的 `latest.json` 中的下载地址并不指向它自己声明的 `pkg.version` 标签。

CI 清单写入器早已按标签固定（`.github/workflows/build.yml:212` 用 `releases/download/${{ github.ref_name }}/$assetName`），本地 `--github-release` 准备路径是唯一仍用 Latest 别名的写入点。

## 决策

| 字段 | 值 |
|------|-----|
| date | 2026-11-12 |
| task_id | DEBT-10-A（`run-fe6288c0ce65`） |
| decision_type | 技术债条目 |
| value | 本地清单 `platforms."windows-x86_64".url` 由 `https://github.com/Smith-106/niko-buddy/releases/latest/download/${releaseAssetName}` 改为 `https://github.com/Smith-106/niko-buddy/releases/download/v${pkg.version}/${releaseAssetName}`。清单的 version / notes / pub_date / signature / 平台键、updater 资产选择与复制、`release-notes.txt` 输出、签名调用与 staging（先删后建 `release-github/`）行为一律不变。 |
| evidence_ref | `scripts/prepare-github-release.mjs:67`（改动前）；`.github/workflows/build.yml:212`（既有按标签固定写法）；`scripts/prepare-github-release.spec.mjs` |

### 明确不改

- 应用侧更新发现端点 `src-tauri/tauri.conf.json:53` 的 `releases/latest/download/latest.json` **是刻意的移动清单入口**，保持不变。
- CI `build.yml` 不动；无新依赖、无新 helper API、无重构、无版本/CHANGELOG/generated 写入。

## 验证（源码层，本 Run）

- `npx vitest run scripts/prepare-github-release.spec.mjs`：**8 passed / 0 failed，exit 0**。
- 回归方式：**不 import、不执行** `prepare-github-release.mjs`（执行会删除 staging 并调用签名器）；仅从其源码提取唯一 `url:` 模板字面量，在隔离作用域内代入 `pkg.version` + 文件名求值。
- 覆盖：稳定版 `2.27.2` 与预发布版 `2.28.0-beta.1`，`exe` / `msi` / `zip` 三种文件名；断言生成地址为 `releases/download/v<version>/<exact-filename>`、不含 `/releases/latest/`，且不同版本产生不同地址（移动 Latest 无法改变已定标签路径）。
- 失败基线：同一 spec 在改动前的原源码上 **8 failed / exit 1**（失败全部来自 URL 断言），随后改 1 行转绿。

## 限制（DEBT-10-B，未由本次修复偿还）

- 被忽略的本地历史缓存 `QMAI/release-github/`（v2.26.5 的 exe/sig/portable/latest.json/notes）**原样保留**，其 `latest.json` SHA256 仍为 `d19e4025c8e56894d874c945345f5e4c8eafdd7c0c1711ef2ba181b4360de856`（3109 B）。
- 该缓存的本地-vs-已发布字节差异是**历史证据**，本次 URL 源修复既不刷新也不对账它，不得声称二者一致。
- 本次**未**改动任何已发布资产、远程 release/tag/body、签名产物或应用运行时；未重跑全量测试、typecheck、coverage、lint、gen、构建/签名/安装/更新/节奏或付费门控。
- 不据此声明独立复核、Goal 完成、G5、human-gold、MCP 或手稿验收。
