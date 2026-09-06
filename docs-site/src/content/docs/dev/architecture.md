---
title: 架构概览
description: 8 层架构设计
---

# 架构概览

niko-hub 是桌面优先、中文优先的长篇写作工作台。架构分 8 层，从交互层到本地文件系统。

## 架构分层

```
┌─────────────────────────────────────────────────┐
│                   前端 UI 层                      │
│   React 19 + TypeScript + Tailwind CSS + Vite    │
├─────────────────────────────────────────────────┤
│                  状态管理层                        │
│          Zustand (wiki-store, review-store...)    │
├─────────────────────────────────────────────────┤
│                 业务逻辑层                        │
│  novel/ (记忆引擎, 上下文包, 摄取, 审查, 图谱,    │
│         拆书分析, 文风提取, 角色一致性)            │
│  lib/ (LLM客户端, 嵌入, 搜索, 去重, 持久化)      │
├─────────────────────────────────────────────────┤
│              Tauri IPC 通信层                     │
├─────────────────────────────────────────────────┤
│                Rust 后端命令层                     │
│  文件系统 / 向量存储 / PDF提取 / 进程管理 / 代理   │
├─────────────────────────────────────────────────┤
│                  本地文件系统                      │
│        项目目录 (Markdown + JSON + 向量索引)      │
└─────────────────────────────────────────────────┘
```

## 技术栈

| 层级 | 技术选型 |
|------|----------|
| 桌面框架 | Tauri 2 |
| 前端 | React 19, TypeScript, Vite 8 |
| 样式 | Tailwind CSS 4 |
| 状态管理 | Zustand 5 |
| 富文本编辑 | Milkdown 7 |
| 图谱渲染 | Sigma.js 3 + Graphology |
| 图表/流程图 | Mermaid |
| 简繁转换 | OpenCC |
| 拼音匹配 | pinyin-pro |
| 后端 | Rust |
| 向量存储 | LanceDB |
| PDF 解析 | PDFium |
| 自动更新 | tauri-plugin-updater |
| CI/CD | GitHub Actions |

## 关键技术亮点

- **混合检索引擎**：关键词 + 向量 + 图谱三路融合，RRF 排序；v2.7.8 起叠加查询分解（意图分类 → 子查询计划）与 multi-query 多路融合
- **Token 预算控制**：上下文包自动裁剪，发送前按模型真实输入上限二次裁剪并重试
- **多文件原子事务（v2.7.8）**：Rust `write_files_atomic`（fs.rs）——文件集 temp 写入 + 统一 rename，任一步失败零 rename 回滚；配套 `write_file_atomic` 冒烟用例
- **FTS5 bigram 持久索引（v2.7.8）**：中文 bigram 倒排 + BM25，`rebuildWikiFtsIndex` 可重建
- **RAG 注入审计（v2.7.8）**：`prompt-injection-auditor` 9 规则零 LLM 机械扫描，注入审计矩阵 12/12 层全覆盖（layer-8 回注）
- **零接线收口（v2.7.8）**：retrieval-trace→search-adapter / chapter-backup→chat-panel+draft-importer / plot-forecast→deep-chapter-generation / book-rules→lint / chapter-workspace→chat-panel / cover-brief→workbench
- **增量式图谱构建**：每次摄取只更新变化部分
- **本地优先架构**：所有数据存储在本地，无需联网（LLM 调用除外）
- **草稿隔离机制**：未确认内容不会污染正式记忆库
- **角色一致性闭环**：从别名拼音/简繁模糊匹配到分段并行审查再到返修复审

## 设计基线

UI 设计基线不是通用 SaaS 仪表盘，而是**桌面优先、中文优先**的结构化写作工作台。默认布局支撑四类高频任务在同一工作区连续切换：查看结构、编辑正文、查看审查结果、核对运行证据。正文区始终保持第一视觉优先级；侧栏和辅助面板服务于正文。移动端仅做降级访问，不反向牵引桌面信息架构退化为单栏拼页。
