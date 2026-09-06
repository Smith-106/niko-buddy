---
title: 翻译工作台
description: 术语表驱动的多语种翻译执行链：分段续跑复用预算机，草稿 Draft-first 落盘
---

# 🌐 翻译工作台

翻译工作台（v2.7.8，64 号实施）提供长篇翻译的核心工程能力：**术语跨章一致性 + 进度状态机 + 可中断续跑的 LLM 执行链**。

## 术语表（Glossary）

- source→target 权威映射，四类：`name` / `place` / `term` / `org`
- 专有名词可登记 `allowDirectUse` 保留原文
- `upsertGlossaryEntry` 按 source upsert（唯一键）；`glossaryToPromptFragment` 渲染为翻译 prompt 约束段
- 残留检测 `checkGlossaryConsistency`：非允许直用术语出现原文 → warn（疑似漏译）；多字术语优先匹配避免误报

## 章节状态机

`pending → drafted → reviewed → finalized` 单向前进（可跳级，不可回退；重译显式 reset）。

## 执行链（LLM runner）

- `buildTranslationPrompt`：语言指令 + 术语表 + 原文（确定性拼装）
- `runTranslationProject`：每章一个预算任务（`translate-{n}`）——
  - 已完成段跳过（**续跑幂等**）
  - 预算不足 → `suspended` 保留已完成产物
  - 中止信号 → `aborted` 不丢产物
- LLM 只在注入端口（`TranslationLlmPort`）外，引擎层零 LLM 导入

## Draft-first

译文草稿落 `.novel/translation-drafts/{chapter}.md`（pending 区），finalized 后才允许进正式导出。与项目医生联动：草稿计数在 doctor 诊断中展示。

## 主路径

1. 建立术语表（人名/地名/术语/组织）
2. 启动翻译（每章一个预算任务，可中断）
3. 审阅草稿（残留检测提示漏译）
4. 推进状态机至 finalized → 正式导出
