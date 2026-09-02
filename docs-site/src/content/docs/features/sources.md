---
title: 资料来源与大纲
description: 资料来源与大纲的预览、批量摄入与大纲聊天
---

# 📁 资料来源与大纲

资料来源页面（侧栏 `sources` 入口）由 `SourcesView` 组件承载，用于预览**大纲与资料来源**。在小说模式（novelMode）下，页面顶部会显示 `OutlineActionToolbar`，支持批量摄入资料与打开大纲聊天面板，帮助你在动笔前整理设定与素材。

## 布局与组件

`SourcesView → PreviewPanel` + `OutlineChatPanel`（懒加载）+ `OutlineActionToolbar`（novelMode）：

- 顶部 header：标题 + 工具栏（仅小说模式显示）
- `bulkIngestResult` 提示条：批量摄入完成后展示结果或错误
- 主体：`PreviewPanel` 展示大纲内容；打开大纲聊天后右停靠（宽 360px）或底停靠（高 300px）
- 大纲聊天开关状态由 `outline-generation-store` 的 `panelOpen` 维护

## 主路径

- 选择大纲源文件后，`PreviewPanel` 展示对应大纲内容
- 小说模式：通过工具栏触发**批量摄入**，结果通过 `bulkIngestResult` 提示条展示
- 小说模式：打开 `OutlineChatPanel`，围绕大纲与资料进行对话
- 大纲聊天面板支持与主面板一致的可拖拽 resize（宽 360px / 高 300px，经 `clampChatWidth`/`clampChatHeight` 约束）

## 批量摄入

批量摄入用于将多份资料一次性解析入库：

- 摄入完成后在顶部提示条展示成功/失败结果
- 失败时在 `bulkIngestResult` 提示条中展示错误文案，不吞错
- 摄入后的资料进入 `wiki/sources/`，供大纲与正文写作引用

## 应用场景

- 动笔前集中导入设定、人物小传、参考资料
- 通过大纲聊天面板，让 AI 结合资料帮你梳理章节细纲
- 非小说模式下仅作大纲/资料预览，不显示工具栏与聊天面板

## 状态与限制

- 空态：无大纲源时，预览区显示空态
- 加载/错误：懒加载面板挂载时显示「加载中...」；批量摄入失败时在 `bulkIngestResult` 提示条中展示错误文案
- 已知限制：`[未交付·P1-2]` 来源长列表分页/筛选骨架尚未交付
