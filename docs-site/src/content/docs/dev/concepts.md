---
title: 核心概念
description: status.json 真源、Draft-first、门控优先级
---

# 核心概念

理解 niko-hub 的三个核心设计约束，能帮你更有效地使用它。

## status.json：运行时唯一真源

`.novel/status.json` 是会话状态的**唯一真源**。编排层与生成层共同读取、分层写入。

实践含义：

- 不要手动编辑 `.novel/status.json`，它由应用在写作流程中维护
- 会话恢复（resume）依赖它——意外中断后重启，应用从 status.json 恢复到中断前状态
- 草稿状态也序列化在 `.novel/draft.json`，但 status.json 是权威

## Draft-first：写作安全边界

所有 AI 输出先进 pending/ready 草稿，**accept 后才回填正式正文与正式记忆**。

这是 niko-hub 区别于"AI 直写正式内容"工具的根本设计：

- AI 生成的内容默认是草稿，你可以预览、编辑、重新生成、审稿
- 只有你点确认后，草稿才升级为正式章节，触发记忆摄取
- 草稿不会污染正式记忆库——AI 的幻觉、错误不会进入后续上下文

:::tip
长篇创作中，"先草稿后确认"的流程能避免 AI 错误像滚雪球一样污染后续章节。遇到不满意的内容，直接重新生成或编辑草稿，不影响已确认的正式记忆。
:::

## 门控优先级：Consistency > Anti-AI > Quality

章节审查遵循固定优先级：

1. **Consistency（一致性，P0）**：设定自洽、时间线、人物状态、伏笔一致性。失败必须修复。
2. **Anti-AI（去 AI 味，P1）**：模板化表达、AI 味词汇。机械层检测在前。
3. **Quality（质量，P2）**：爽感、节奏、追读引力。可降级为 warning。

关键规则：

- Consistency 失败**必须修复**，Quality pass 不能覆盖 Consistency fail
- 机械层检测（零 LLM，正则/规则/统计）先于语义层（LLM 审查）
- 机械层 fail 则短路，不调语义层——节省成本且避免语义审查被可量化噪声干扰
- Quality 失败可降级为 warning 并标记 `quality_debt`，不阻塞发布

## 草稿-确认-摄取模式

写作流程的完整闭环：

1. **草稿**：AI 生成进入 pending/ready 草稿状态
2. **确认**：用户审阅草稿，满意后 accept
3. **摄取**：accept 触发 ChapterSnapshot 提取，记忆入正式库，图谱增量更新

草稿机制将"写"和"记"解耦——AI 尽可以自由生成，记忆库只接受人工确认的内容。

## 章节 source 五标签（v2.7.8，64 号实施）

正式章节的 provenance 分五类：`manual`（手写）/ `llm`（AI 生成）/ `campaign`（批量连写）/ `template`（模板导入）/ `migrated`（迁移），旧三标签无损兼容。备份按标签分类存档，审计可溯源。

## run 快照 8 种（v2.7.8，64 号实施）

run kind 扩展至 8 种：既有（生成/修订）+ `lint` / `review` / `snapshot-summary` / `snapshot-emotion` / `snapshot-characters` / `snapshot-foreshadowing`（快照类 meta 不含正文，体积可控）。

## Draft-first 工件路径（v2.7.8 扩展）

- `.novel/translation-drafts/` — 翻译草稿（finalized 前不进正式层）
- `.novel/covers/` — 封面产物（accept 移动由调用方执行）
- `.novel/fanfic-merge-pending.json` — 同人正典合并提案（accept 前不写正式 wiki）
