---
title: 互动影游
description: 节点图驱动的分支剧情设计与导出（ink/HTML 单文件），Play 试玩崩溃续玩幂等
---

# 🎬 互动影游

互动影游模块（v2.7.8，64 号实施）把故事组织为**节点图**并导出可玩文件：图模型 → 校验 → ink v1 子集导出 / 单文件 HTML 导出 → 情感路径评估。

## 节点图模型

- `knot` 入口场景 / `stitch` 子场景 / `choice` 选项节点 / `end` 结局
- 每条边（`InteractiveEdge`）带选项文本与目标节点
- 必须满足图校验：`startId` 存在、choice 出度 ≥1 且每条边有 label、end 出度 0、无孤儿节点

## 校验与导出

- **阻断诊断**：`missing_start` / `dangling_edge` / `empty_choice` 拦截脏导出（不写文件）
- `exportInteractiveInk`：ink v1 子集（`=== knot ===` / `= stitch` / `* [选项] -> 目标`）
- `exportInteractiveHtml`：单文件零外部依赖，文本经安全编码
- `exportInteractiveStory`（export.ts 接线）：`.ink` + `.html` 双文件落盘

## 情感评估

沿玩家路径逐节点累积三轴净值（valence / arousal / dominance），标签表驱动（喜/怒/哀/惧/惊/惑/决意 → 确定性映射，零 LLM）；净值 < -2 触发 `suspend`（过度负面体验提示转折）。

## Play 试玩

- `stepPlay`：每步推进一个节点，渲染当前帧（文本 + 选项列表）
- `replayPlay`：以保存的 PlayState 幂等重放已走路径（崩溃续玩）
- 情感走查：`evaluatePlayableEmotionPath` 输出逐节点净值轨迹（beats）

## 主路径

1. 设计节点图（入口 → 分支 → 结局）
2. 校验图（阻断诊断拦截非法结构）
3. 导出 `.ink` + `.html`（互动影游交付物）
4. 试玩验证结局覆盖与情感曲线
