---
title: 下载安装
description: 下载 Niko Buddy 最新版本安装包
---

# 下载安装

## 最新版本

**v2.5.1**（2026-08-21 发布，notes-only：工程卫生 + 文档对齐）

前往 [GitHub Releases](https://github.com/Smith-106/niko-buddy/releases) 下载最新 Windows 安装包（macOS/Linux planned）。

### v2.5.1 更新亮点

- ✅ **CI 口径统一** — typecheck 统一为 `npm run typecheck`（T00 步骤⑥）
- ✅ **文档站部署链修复** — deploy-docs 触发分支改回 master，修复线上文档站停留在 v2.4.4 的脱节
- ✅ **CHANGELOG 补齐** — 补记缺失的 [2.5.0] 条目（Wave 1-5 发布叙事）
- ✅ **仓库卫生** — 回收 94GB 构建产物，清理临时文件与缓存

### v2.5.0 更新亮点（2026-08-18）

- ✅ **用户记忆（Wave 1）** — 跨会话用户偏好/事实记忆，写作偏好自动沉淀
- ✅ **@引用（Wave 2）** — 正文/大纲/记忆三域 @引用，上下文精准注入
- ✅ **计划模式（Wave 3）** — 章节计划驱动生成，长文写作确定性提升
- ✅ **批量去 AI 味（Wave 4）** — 多章节批量 de-ai 处理，风格一致性增强
- ✅ **上下文用量圆环（Wave 5）** — 实时上下文用量可视化，防超限

> 源码 tip 与安装包资产同步（`smith/master`）；以 [Releases](https://github.com/Smith-106/niko-buddy/releases) 资产为准。

### v2.4.7 更新亮点（历史）

- ✅ **Roadmap 3-session 执行管线** — 质量门控 + 连续性约束 + 检索智能
- ✅ **S1 机械层硬化** — 零宽字符/同形字还原、格式规范化、hybrid_search 多信号融合、facts 时间窗表、de-ai 双层规则
- ✅ **S2 连续性深化** — 四维反查 + 伏笔逾期、chase_debt 追读债务、Story Threads 6 态状态机、测量指纹契约
- ✅ **S3 质量** — Gate v2 加权 P2 参考 + reading_power、i18n parity（修复 194 翻译缺口）、伪端点契约测试
- ✅ **EPIC-005 persona 侧车** — 人物认知错误 UX + 侧边栏 UI

### v2.4.6 更新亮点（历史）

- ✅ **Tip-aligned 安装包重建** — NSIS + 便携版与 mid-loop 源码对齐
- ✅ **Avoid-AI 全量 patterns** — Track B 软诊断（非产品硬门）
- ✅ **文学金标 / skill hooks / 测量指纹** — 创作链路可观测增强
- ✅ **Headless 脚本** — pack export / gold smoke / formal LLM extract

### 历史里程碑

| 版本 | 说明 |
|------|------|
| v2.4.5 | Quality Foundation v1（记忆/结构过程） |
| v2.4.4 | 角色光环、MIT 合规、性能基准 |
| v2.4.0 | 确定性连续性引擎 |

## Windows 安装包

下载 [`QMaiWrite_2.5.0_windows_X64.exe`](https://github.com/Smith-106/niko-buddy/releases/download/v2.5.0/QMaiWrite_2.5.0_windows_X64.exe)（约 33 MB，v2.5.1 为 notes-only 源码版本，安装包沿用 v2.5.0 资产），双击运行 NSIS 安装程序即可。

## 便携版

下载 [`QMaiWrite-portable.exe`](https://github.com/Smith-106/niko-buddy/releases/download/v2.5.0/QMaiWrite-portable.exe)（约 148 MB），解压后直接运行，无需安装，适合 U 盘随身携带或免安装场景。

## 系统要求

- **操作系统**：Windows 10 及以上（主要支持平台）、macOS（planned）、Linux（planned）
- **LLM 服务**：需配置至少一个大语言模型 API（支持 OpenAI 兼容接口、Ollama 等）

## 自动更新

内置 Tauri Updater，启动时自动检测 GitHub Releases 新版本并提示更新。Windows 平台更新前会等待主程序释放文件句柄，避免“无法卸载”错误。

:::note[关于已装 v2.4.1（2026-07-21 版）的用户]
该版本的更新通道在编译期指向了旧仓库地址，自动更新无法到达新版本。请手动前往 [Releases](https://github.com/Smith-106/niko-buddy/releases) 下载最新版覆盖安装——v2.4.2+ 已将更新通道修正至本仓库，此后即可正常接收自动更新。
:::

## 数据管理

支持一键导出/导入全部数据（AI 会话、大纲、模型、记忆），重装系统可完美恢复。
