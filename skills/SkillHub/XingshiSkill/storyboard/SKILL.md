---
name: storyboard
description: Use when breaking a story into screenplay-style scenes with slug, dialogue, action, and optional emotional beat. Supports logline-to-scene layering for film-like narrative planning.
---

# 剧本分镜 Skill

## 适用范围

剧本化改写、场景分镜、影视化叙事规划；需要把小说章节拆成分场剧本或按 logline→角色→情节→对白分层规划时。

## 规则

1. 场景拆分：以地点/时间/人物在场变化为界，一个场景一个 slug（如 `内 夜 山洞`）。
2. 每场必含三要素：动作描述（行为推进）、对白（带说话人）、情绪基调；纯心理独白要转成可拍摄的动作或对白。
3. 分层生成顺序：logline（一句话高概念）→ 角色目标 → 情节节拍（转折/冲突/解决）→ 对白填充；后层必须服务于前层。
4. 场景格式校验：slug 唯一、场景数 ≥1、对白不悬挂（说话人必须明确）。
5. 分镜服务于正文：场景拆分结果可回注为正文写作的结构提示，但正文不照搬对白稿（保留叙述自由度）。

## 与引擎契约对齐

- 格式校验对齐 `screenplay-format.ts`（slug/场景数/对白完整性机械规则）。
- 回注正文的结构提示走既有 chapter-workspace 接线路径（不新建平行真源）。
- 与 interactive-film 的关系：storyboard 是线性影视分镜；互动分支图是另一形态（interactive-film Skill），不可混用。

## 禁止

- 不生成无动作支撑的对白墙；不写摄像机指令（推拉摇移）到正文。
- 不在小说正文中输出剧本格式（slug/场景标题）——分镜是规划产物不是正文。
- 不输出分析、说明、写作过程或 Skill 名称。
