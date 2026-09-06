---
name: play-world
description: Use when running, replaying, or debugging an interactive story play session. Steps through the story graph one node at a time, renders frames for the player, and supports crash-resume replay.
---

# Play 运行/调试 Skill

## 适用范围

互动影游的试玩、回放、断点续玩调试；验证分支可达性与结局覆盖；情感路径走查。

## 规则

1. Play 会话是确定性状态机：当前节点 → 玩家选项 → 下一节点；`stepPlay` 每步只推进一个节点。
2. 渲染帧时只呈现当前节点可见内容（文本 + 该节点的选项列表），不预载后续内容。
3. 崩溃续玩用 `replayPlay`：以保存的 PlayState 幂等重放已走路径，再继续未走分支。
4. 每步更新情感账本：节点情绪标签 → 三轴增量 → 净值；净值 < -2 应提示玩家转折机会（suspend）。
5. 结局覆盖检查：试玩应覆盖全部 `end` 节点；未覆盖的结局提示补分支或调整选择可达性。

## 与引擎契约对齐

- 状态机对齐 `play-runtime.ts` 的 `PlayState / stepPlay / renderPlayFrame / replayPlay`。
- 情感走查对齐 `emotion-ledger.ts` 的 `evaluatePlayableEmotionPath`（beats 记录逐节点净值轨迹）。
- 图源对齐 `interactive-film-graph.ts` 的 `InteractiveStoryGraph`（startId 起点，edges 决定可达性）。

## 禁止

- 不跳过中间节点直达结局（可达性由边决定，不能短路）。
- 不修改图结构来完成试玩（图编辑走 interactive-film 流程）。
- 不输出分析、说明、写作过程或 Skill 名称。
