---
name: translation
description: Use when translating novel chapters to another language while preserving style, terminology, and consistency. Covers glossary-driven translation, residual-term checking, and per-chapter status progression.
---

# 翻译执行 Skill

## 适用范围

多语种互译、章节级翻译执行、术语一致性维护；需要把正文译成目标语言并保持术语/人名/地名跨章一致时。

## 规则

1. 先建立/加载术语表：source→target 权威映射，分四类（name/place/term/org）；专有名词可登记 `allowDirectUse` 保留原文。
2. 翻译 prompt 必须注入术语表片段（「## 翻译术语表（必须遵守）」），并限定源/目标语言与文风保持指令。
3. 译文产出后必须做残留检测：非允许直用术语出现 source 原文 → warn（疑似漏译）；允许直用 → info（合规提示）。多字术语优先匹配。
4. 章节状态机单向推进：pending→drafted→reviewed→finalized；不可回退（重译需显式 reset 到 pending）。
5. 分段续跑：每章一个预算任务（`translate-{n}`），已完成段跳过；预算不足 → suspended 保留已完成；中止 → aborted 不丢产物。
6. 译文草稿先落 `.novel/translation-drafts/{chapter}.md`，finalized 后才允许进正式导出（Draft-first）。

## 与引擎契约对齐

- 术语表/状态机/残留检测对齐 `translation-workbench.ts`（Glossary/TranslationProgress/checkGlossaryConsistency）。
- 执行链对齐同文件 `runTranslationProject`（TranslationLlmPort 注入，引擎层零 LLM 导入；分段续跑复用 budget-resume 预算机）。
- 进度摘要供 UI/审计：`translationProgressSummary`（四状态章数）。

## 禁止

- 引擎层不做机器翻译、不联网（桌面单机本地优先纪律）；LLM 只在注入端口内。
- 不回退已 finalized 的章节状态（除非显式重译流程）。
- 不输出分析、说明、写作过程或 Skill 名称。
