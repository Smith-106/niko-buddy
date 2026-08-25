# Decision Log — v2.6.2 CI Signing Secret 配置

> 蓝图 §9.7 / A-34 强制落档

## 条目

- **日期**: 2026-08-24
- **任务**: v2.6.2 发版 / 修复跨 3 版本的 release workflow Windows 签名失败
- **决策**: 在 `Smith-106/niko-buddy` 仓库配置 GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`（值 = 本地 `~/.tauri/qmai-updater.key` 全文，minisign 密钥 id `32437F1C2727B1F1`，密码为空）；`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 留空（密钥实际无密码）

## 背景

v2.6.0 / v2.6.1 / v2.6.2 的 `QMAI Multi-Platform Release` workflow（tag 触发）**全部 failure**，唯一失败点 = Windows job 的 `Publish Windows updater manifest` 步骤，报错：

```
Error incorrect updater private key password: Missing comment in secret key
```

三模型共识根因分析（deepseek-v4-flash 源码级 + 同 CLI 二进制逐字复现）证实：**该 secret 从未配置**（`gh secret list` 返回空），GitHub Actions 把缺失 secret 渲染为空字符串 → `tauri signer sign` 拿到空 key → minisign 解析器在 `secret_key.rs:199` 抛出 `Missing comment in secret key`（唯一触发条件 = base64 解码后文本为空）。

macOS 两个 job 用 `--no-sign` 且该步骤为 Windows-only，故从不消费 key——这就是"macOS 成功、Windows 失败"的机制（而非平台差异）。历史 v2.6.1 的 Windows `.exe` 是**本地手动签名上传**的（j2 路径 A），CI 从未成功过。

## 理由

- **不是密钥损坏 / 换行被剥 / 密码不对**——是 secret 根本没配（三层独立证据：仓库 secret 列表空、源码级唯一触发条件、本地同 CLI 逐字复现空输入报同错+正确值签名成功）
- 配置该 secret 是**一劳永逸**的修复：未来所有 tag 触发的 release 都会自动产出三平台签名资产，无需每次本地手动补签

## 替代方案（被拒绝）

- **路 1（本地手动签名补传）**：照 v2.6.1 先例，本地跑 `build:github-release` 后 `gh release upload`。被否——不可复现、每次发版都要手动、CI 仍持续 failure 无法作为自动化发版通道
- **路 2（修 CI secret + 重跑）**：采纳。`gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/qmai-updater.key`（stdin 直传，不经 shell 参数/历史/回显），重跑 `gh run rerun --failed`

## 影响

- **正面**：跨 3 版本（v2.6.0/v2.6.1/v2.6.2）的 release workflow Windows 签名失败彻底修复；未来 tag 触发的 release 全自动产出签名资产；v2.6.1 → v2.6.2 的 Windows 自动更新通道恢复（endpoint 200 + 签名链有效）
- **负面/风险**：secret 是只写不读的，无法备份现有值——但本次是首次配置（旧值不存在），无覆盖风险

## 验证（决定性验收门，j3 R4 铁律：绿 ≠ 可更新）

| 门 | 结果 |
|----|------|
| Windows job 结论 | success |
| release 资产 | 8 个（含 `.exe` + `.exe.sig` + `latest.json` + portable） |
| latest.json 内容 | version=2.6.2，url 指向 2.6.2 exe |
| endpoint | `releases/latest/download/latest.json` HTTP=200 |
| ★签名链铁证 | ed25519 主签名对 `blake2b(file_content)` 密码学验证 PASS；sig keynum `F1B127271C7F4332` → 显示 `32437F1C2727B1F1`，与 `tauri.conf.json` 内嵌 pubkey 配对一致 |

## 复发防护 / 操作指引（下次密钥轮换时）

1. **密钥对来源**：本地 `~/.tauri/qmai-updater.key`（私钥，348B 单行 base64）+ `.pub`（公钥）。私钥是唯一签名源，须安全备份
2. **轮换流程**：`npx tauri signer generate -w ~/.tauri/qmai-updater.key -p ""` 生成新密钥对 → 同步更新 `tauri.conf.json` 的 `plugins.updater.pubkey`（编译期嵌入客户端）→ `gh secret set TAURI_SIGNING_PRIVATE_KEY < 新.key` → 新版本客户端用新 pubkey 验签，旧版本客户端会拒更（需发布迁移说明）
3. **密钥格式**：`.key` 文件内容 = 整体再 base64 一次的 minisign 文本（tauri-cli 的 `generate_key()` 行为）；env `TAURI_SIGNING_PRIVATE_KEY` 期望与文件内容**完全一致**的单行 base64，不要预先解码、不要带换行
4. **密码**：当前密钥无密码，`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 保持空/缺失即可——**切勿填占位符**（会导致 `Wrong password for that key`）
5. **安全纪律**：`gh secret set` 用 stdin 直传，绝不经 `-b"内容"`（shell 历史）、绝不在日志/输出/模型上下文中出现密钥明文

## 关联

- 修复的 workflow：`.github/workflows/build.yml` `Publish Windows updater manifest` 步骤
- bump 落点：`src/lib/changelog.ts`（`currentVersionChangelog` if-chain + `allChangelog` 头插）、`changelog.spec.ts`（版本列表断言）、`changelog-section.spec.tsx`（mock pin）——每次发版须同步
- 三模型共识分析：deepseek-v4-flash（根因解码）/ x-preview-f-free（验收设计）/ hy3（风险审计 + 决策树）
