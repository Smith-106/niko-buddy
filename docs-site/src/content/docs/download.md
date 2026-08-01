---
title: 下载安装
description: 下载 niko-hub 最新版本安装包
---

# 下载安装

## 最新版本

**v2.4.2**（2026-07-25 发布）

前往 [GitHub Releases](https://github.com/Smith-106/niko-hub/releases) 下载最新 Windows 安装包（macOS/Linux planned）。

## Windows 安装包

下载 [`QMaiWrite_2.4.2_windows_X64.exe`](https://github.com/Smith-106/niko-hub/releases/latest/download/QMaiWrite_2.4.2_windows_X64.exe)（约 33 MB），双击运行 NSIS 安装程序即可。

## 便携版

下载 [`QMaiWrite-portable.exe`](https://github.com/Smith-106/niko-hub/releases/latest/download/QMaiWrite-portable.exe)（约 148 MB），解压后直接运行，无需安装，适合 U 盘随身携带或免安装场景。

## 系统要求

- **操作系统**：Windows 10 及以上（主要支持平台）、macOS（planned）、Linux（planned）
- **LLM 服务**：需配置至少一个大语言模型 API（支持 OpenAI 兼容接口、Ollama 等）

## 自动更新

内置 Tauri Updater，启动时自动检测 GitHub Releases 新版本并提示更新。Windows 平台更新前会等待主程序释放文件句柄，避免"无法卸载"错误。

:::note[关于已装 v2.4.1（2026-07-21 版）的用户]
该版本的更新通道在编译期指向了旧仓库地址，自动更新无法到达新版本。请手动前往 [Releases](https://github.com/Smith-106/niko-hub/releases) 下载 v2.4.2 覆盖安装——v2.4.2 已将更新通道修正至本仓库，此后即可正常接收自动更新。
:::

## 数据管理

支持一键导出/导入全部数据（AI 会话、大纲、模型、记忆），重装系统可完美恢复。
