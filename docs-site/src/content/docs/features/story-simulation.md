---
title: 故事推演
description: 基于章节内容推演剧情走向、生成叙事框架与角色访谈的仿真工作台
---

# 🎲 故事推演

故事推演室（StorySimulationView）以五阶段状态机驱动：配置 → 框架确认 → 推演 → 报告 → 草稿。它帮助作者探索「如果这样发展会怎样」，支持分支对比、角色访谈与线索 / 流言时间线可视化，全部基于已摄取的章节内容，而非凭空生成。

## 主路径

- 在配置面板（SimulationConfigPanel）设定推演参数与范围，点击开始触发内容提取（extracting）与故事框架生成（framework-generating）
- 框架确认阶段（FrameworkConfirmPanel）审阅并保存叙事框架；可展开历史结果（HistoryResultsModal）复用既有框架
- 推演阶段（SimulatingTimelinePanel）以实时事件流推进（simulating）；开启对比模式（isCompareMode）时切换到 BranchCompareView 并列对比多个分支走向
- 报告阶段以多标签呈现（report / timeline / overview / rumors / clues，SimulationReportView）：时间线复盘、全局概览、流言传播与线索脉络
- 报告阶段可弹出 Agent 采访面板与角色对话（InterviewHistoryView / RumorPropagationPanel / ClueTimelinePanel），深入单点调查
- 草稿阶段（StoryDraftView）由生成结果落稿；分支的新建与管理可由 BranchManagerPanel 处理

## 能力构成

- 单栏全宽布局：框架列表已迁移到左侧 SidebarPanel，主区域按 phase 切换
- 分支管理：BranchManagerPanel 负责分支新建与编排，BranchCompareView 负责对比阅读
- 调查辅助：DetectiveBoardPanel（侦探看板）、RumorPropagationPanel（流言传播）、ClueTimelinePanel（线索时间线）支撑线索梳理
- 框架绑定：FrameworkBindingDialog / FrameworkList / FrameworkConfirmPanel 串联「绑定 → 列表 → 确认」流程

## 阶段与视图

主区域依据当前 phase 切换内容，五个推进阶段对应不同视图：

- `extracting` / `framework-generating`：ProgressPanel 展示提取与框架生成进度
- `framework-confirming`：FrameworkConfirmPanel + HistoryResultsModal（历史框架复用）
- `simulating`：SimulatingTimelinePanel 实时事件流；对比模式下为 BranchCompareView
- `report-viewing`：report / timeline / overview / rumors / clues 多标签（SimulationReportView）
- `draft-viewing`：StoryDraftView 落稿

## 状态与限制

- 空态：无历史结果时 HistoryResultsModal 显示空态；首次进入仅展示配置面板（未开始）
- 加载 / 错误：五阶段 `PROGRESS_PHASES` 进度条（extracting / framework-generating / simulating / report-generating / draft-generating）；出错时显示红色 `error` 条并附「返回」按钮清除当前状态
- 无权限：N/A（无 LLM 模型时由 `resolveDefaultModel` 兜底或报错，非权限语义）
- 已知限制：P2 — 推演历史 / 进度持久化分页未交付
