---
name: interactive-film
description: Use when designing or exporting interactive film / choose-your-path game stories. Structures story as ink-compatible node graph (knot/stitch/choice/end) with choices and emotional evaluation.
---

# 互动影游 Skill

## 适用范围

互动叙事、分支剧情、多结局剧本、文字冒险；需要把故事组织成节点图并导出可玩文件时。

## 规则

1. 故事组织为节点图：`knot`（入口场景）、`stitch`（子场景）、`choice`（选项节点）、`end`（结局）。
2. 每个场景节点必须携带情绪标签（喜/怒/哀/惧/惊/惑/决意），供情感评估器做三轴（valence/arousal/dominance）累积评估。
3. 必须满足图校验：有且仅有一个 start；choice 出度 ≥1 且每条边有选项文本；end 出度 0；不允许孤儿节点。
4. 分支设计原则：选项要有后果差异（不能殊途同归）；结局 2-4 个为宜；关键抉择点间隔 3-5 个场景。
5. 导出 ink 时遵循 ink v1 子集：`=== knot ===` / `= stitch` / `* [选项] -> 目标` / `-> END`。
6. 情绪路径评估：沿玩家路径逐节点累积净值；净值低于 -2 触发 suspend（过度负面体验，需提供转折）。

## 与引擎契约对齐

- 图结构对齐 `interactive-film-graph.ts` 的 `InteractiveStoryGraph`（nodes/edges/startId，InkNodeKind 六节点）。
- 校验/导出对齐 `validateInteractiveGraph` + `exportInteractiveInk` + `exportInteractiveHtml`（单文件零依赖）。
- 情感评估对齐 `emotion-ledger.ts` 的 `evaluatePlayableEmotionPath`（表驱动标签→三轴映射，确定性零 LLM）。

## 禁止

- 不生成空选项（choice 无出度）；不产生悬空边（from/to 指向不存在的节点）。
- 不在导出的 HTML 中内嵌脚本执行用户文本（文本经 encodeURIComponent 安全编码）。
- 不输出分析、说明、写作过程或 Skill 名称。
