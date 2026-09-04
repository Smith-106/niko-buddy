---
title: 下载安装
description: 下载 Niko Buddy 最新版本安装包
---

# 下载安装

## 最新版本

**v2.7.7**（2026-09-04 发布，参考池覆盖 v2：55 号设计全链 + 覆盖度 L1-L3 100%）

前往 [GitHub Releases](https://github.com/Smith-106/niko-buddy/releases) 下载最新 Windows 安装包（macOS/Linux planned）。

### v2.7.7 更新亮点（2026-09-04，参考池覆盖 v2）

- ✅ **genre 单真源全链** — NovelConfig.genre + genre-codes 9 码映射 + 三调用点透传
- ✅ **数值事实检查** — numeric-fact-checker 14 类（warn-only，中文数字 CN_NUM_RE 处理）
- ✅ **自重复率激活** — rep_2/3/4 第 5 因子（阈值 0.35 warn-only，2026-09-04 激活）
- ✅ **CJK 切分增强** — cjk_clauses 层 + chunk-fingerprint v1: 版本位（URL/时间不误切）
- ✅ **mojibake 修复默认开启** — UTF-8 双重编码乱码自动还原（正常文本零变更）
- ✅ **RAG 注入安全审计** — 12 层矩阵 11/12 覆盖（license 先核纪律）
- ✅ **humanizer 115 条模式矩阵** — 45 覆盖/68 豁免/2 缺口（索引回流 + 一致性归零）
- ✅ **覆盖度 100%** — L1 34/34 / L2 9/9 / L3 40/40（声纹激活 + 编辑影响分析 + 9 项重新判定）
- ✅ **EPUB 往返验收 PASS** — PYTHONIOENCODING=utf-8 修复 GBK 乱码根因

### v2.6.4 更新亮点（2026-08-26，检测对抗强化）

- ✅ **对抗回归集框架** — 作弊样本库分层召回 + 诚实报告（stub 显式标注）
- ✅ **双向似然接口** — LLR 计算/降级语义/因子注册表
- ✅ **原笔指纹** — 作者笔迹 DNA 抽取 + 漂移检测

### v2.6.0 更新亮点

- ✅ **EPUB/HTML 摄取** — 特化摄取管线 + 提取器注册表，导入素材按文档类型自动分派
- ✅ **跨页 chunk 指纹去重** — SHA-256 指纹索引，重复片段只入库一次
- ✅ **图谱双层精度过滤** — 机械层校验 + 语义层复核，拦截幻觉边
- ✅ **Compaction** — chunk 表自动压缩碎片化记录 + 纯函数对账
- ✅ **断点 TTL 配置 + 伏笔废弃态** — 断点过期自动清理；abandoned 不再计入活跃债务
- ✅ **决策回放面板** — 上下文包逐条展示组入记忆与取舍依据
- ✅ **角色工作台** — 角色档案/状态/认知/关系集中视图
- ✅ **章节自评估** — 输出 `{score, gap, fix}` 三要素，返修前锁定问题点

### v2.5.1 更新亮点（2026-08-21，notes-only）

- CI 工程卫生、文档站部署链修复、CHANGELOG 补齐（详见应用内 changelog）

### v2.5.0 更新亮点（历史，2026-08-18）

**v2.5.0**（2026-08-18 发布，源码 tip 与安装包资产对齐）

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
