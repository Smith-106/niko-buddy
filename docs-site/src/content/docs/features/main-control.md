---
title: 主控 Agent
description: 一句话目标 → 只读取证 → 草稿产出，全程可回放
---

# 🤖 主控 Agent（v2.17.1+）

工作台 → **主控 Agent**：给它一句话目标（例如「给第 12 章补一段夜市追逐戏」），它自己规划、取证、起草。

## 运行方式

```
目标 → 规划 → 只读工具取证 → 起草到草稿区 → 轨迹与证据落盘
```

取证工具覆盖：章节正文、章节列表、记忆、大纲、上下文包、任务路由。起草只走 `write_chapter`。

## Draft-first 是硬边界

主控 Agent 的工具白名单**只有只读工具 + `write_chapter(draftMode=true)`**：

| 工具 | 是否注册 | 原因 |
|---|---|---|
| `read_chapter` / `list_chapters` / `read_memory` / `read_outline` 等 | ✅ | 只读取证 |
| `write_chapter`（草稿模式） | ✅ | 产出进草稿区 |
| `write_memory` | ❌ | 正式记忆只能由 accept 后回填 |
| `write_outline_node` | ❌ | 大纲变更必须人工确认 |
| `run_chapter_workflow` | ❌（阶段 1） | 需注入深章流水线，留给后续阶段 |

所以 AI 产出**永远**先进草稿：accept 之前，正式正文与正式记忆都不会被改写。

## 质量自主迭代闭环

主控 Agent 可以挂上六维质量闭环（`quality-iteration.ts`）：

| 参数 | 默认 | 说明 |
|---|---|---|
| 目标中位 | 9.0 | 对齐书稿 L9 硬门 |
| 最大轮数 | 3 | 超轮即停 |
| 最小增益 | 0.1 | 重写没有实质提升立即停止 |

循环：六维评分 → 定向重写（只点名缺口最大的 4 个维度，并明写「Consistency 不可牺牲」）→ 再评分。

两条安全阀：

- **中位达标但仍有弱维 → 不放行**（防止被高分维度掩盖）
- **重写变差 → 保留历史最佳稿**（绝不越改越差）

闭环结果转成运行事件写入事件账本：每轮评分 `gate-run`（critic）、每次重写 `retry`（reviser）、收口 `accept` / `stage`（arbiter）。

## 运行轨迹与证据回放

每次运行都能逐步回放：

- 输入摘要（参数 JSON 截断到 240 字符）
- 完整工具结果（面板里点「展开原始证据」看全文，上限 4000 字符）
- 耗时、失败原因、语义明细

快照落 `.novel/telemetry/main-control-trace.json`（best-effort：写盘失败不抛，损坏快照返回 null），**重开面板自动载入上一次运行**，不需要重跑。

## 当前阶段边界

阶段 1 只做「只读取证 + 草稿产出」。以下尚未接进 UI，属已知缺口：

- 真实 LLM 驱动的 `score_chapter` / `revise_chapter`（工具依赖由调用方注入 `QualityToolDeps`）
- `run_chapter_workflow`（需注入 `runDeepChapterGeneration`）
- 真实模型端到端「读上下文 → 起草 → 产出草稿」的真机联调
