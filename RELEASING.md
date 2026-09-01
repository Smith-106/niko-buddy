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
- **禁止跳号**：每个 tag 必须对应一次真实构建；构建失败不发布（删除失败 tag 后重发）。

## 发布节奏

- **stable：每周 ≤1 个**。候选版一律走 `prerelease` 标记（内测渠道），验证通过后再提升为 stable。
- 同日重复 tag：无 CI 自动门禁，靠人工纪律执行（重复 tag 一律拒绝；候选版如需走 `prerelease`，由发布者手动加 `--prerelease` 标记）。
- 发布前检查：`npm run typecheck` 0 错误 + `npx vitest run` 全绿 + 真机冒烟（安装/更新/重启）。

## 资产命名（唯一规范）

```
niko-buddy_<version>_windows_X64.exe
niko-buddy_<version>_windows_X64.exe.sig
niko-buddy_<version>_windows_X64_portable.exe
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

- Windows（nsis + portable）+ macOS（AppleSilicon + Intel）+ Linux（AppImage + deb，matrix 已就绪）。
- 每个平台资产齐全才发布；缺失平台在正文标注原因。
- 注：CI 已具备三平台构建 matrix（build.yml），本地 tauri.conf targets 默认仅 nsis；历史发布资产为 Windows-only。macOS/Linux 是否正式发版以 Releases 为准。

## 发布后检查清单

1. `gh release view v<version>` — 标题/资产/签名齐全
2. latest.json 指向最新版本且签名匹配
3. 本机 updater 检测到新版本（真机验证）
4. 历史 release 无 QMaiWrite_* 残留（`gh release list` 抽查）
