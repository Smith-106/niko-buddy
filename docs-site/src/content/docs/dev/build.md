---
title: 本地构建
description: 从源码构建桌面版与发布版
---

# 本地构建

## 前置依赖

- **Node.js** 20+
- **Rust** (stable)
- [Tauri 2 开发环境](https://v2.tauri.app/start/prerequisites/)

## 开发命令

```bash
# 安装前端依赖
npm install

# 启动开发环境（前端 + Tauri 桌面窗口）
npm run tauri dev

# 仅启动前端开发服务器
npm run dev

# 类型检查
npm run typecheck

# 构建桌面便携版
npm run build:portable

# 构建 GitHub 发布版（含签名与 latest.json）
npm run build:github-release
```

## 构建产物

| 命令 | 产物 | 用途 |
|------|------|------|
| `npm run build:portable` | `release-portable/QMaiWrite-portable.exe` | 便携版，免安装 |
| `npm run build:github-release` | `release-github/` 下全套资产 | GitHub Release 上传 |

GitHub Release 产物包含：

- `QMaiWrite_2.4.1_windows_X64.exe` — NSIS 安装包
- `QMaiWrite_2.4.1_windows_X64.exe.sig` — 更新签名
- `QMaiWrite-portable.exe` — 便携版
- `latest.json` — Tauri Updater 更新清单

## 签名密钥

GitHub 发布版构建需要 Tauri 签名私钥，默认路径 `~/.tauri/qmai-updater.key`。也可通过环境变量 `TAURI_SIGNING_PRIVATE_KEY_PATH` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 指定。

## 代码规范

- 前端代码使用 TypeScript 严格模式
- Commit Message 遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范
- 新功能在 `src/lib/novel/` 中集中实现，避免散落到无关模块
- Rust 代码遵循 `cargo fmt` 和 `cargo clippy` 标准

## 项目结构

```
QMAI/
├── src/                  # 前端源码（components / lib / stores / i18n / commands）
├── src-tauri/            # Rust 后端
├── skills/               # 角色 SKILL 数据（运行时资源）
├── extension/            # 浏览器剪藏扩展
├── scripts/              # 构建与发布脚本
├── docs-site/             # 本文档站源码（Astro + Starlight）
├── .github/workflows/    # CI/CD 工作流
├── package.json
└── vite.config.ts
```
