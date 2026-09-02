---
title: 连贯性检查
description: 结构/语义 lint 与记忆中心
---

# 🧠 连贯性检查

连贯性检查页面（侧栏 `lint` 入口，图标 Brain）由 `LintView` 组件承载，运行**结构化 lint**与可选的**语义 lint**。在小说模式（novelMode）下，它同时作为**记忆中心**（`MemoryCenterView`），用于浏览章节快照与六类记忆文件。

## 检查类型

| 类型 | 图标 | 说明 |
|------|------|------|
| orphan | Unlink | 无入链的孤立页面 |
| broken-link | Link2Off | 指向不存在页面的断链 |
| no-outlinks | ArrowUpRight | 无外链页面 |
| semantic | BrainCircuit | 语义一致性检查（需勾选「语义」且有可用 LLM） |

结构化检查由 `runStructuralLint` 执行；语义检查由 `runSemanticLint` 执行，需 `hasUsableLlm` 判定，无 LLM 时静默跳过。

## 主路径

- 点击「运行检查」执行结构化 lint，勾选「语义」后追加语义检查
- 结果按 warning / info 分组展示，卡片支持「打开 / 修复 / 删除」：
  - 孤立页可一键从 `index.md` 添加链接，或级联删除（含 embedding chunk 与所有引用）
  - 断链、无外链、语义问题转交审稿中心人工处理
- 小说模式：生成历史列表可展开查看每次检查结果
- 记忆中心：章节快照卡片展示角色状态/认知/伏笔/时间线变更与结尾钩子；六类记忆文件可直接编辑保存

## 修复动作

各类问题提供针对性的修复路径：

- **orphan**：从 `index.md` 添加 `[[页面名]]` 链接，或通过 `cascadeDeleteWikiPagesWithRefs` 级联删除（含向量 chunk 与 `related:` 引用）
- **broken-link**：转交审稿中心，提供「打开编辑 / 删除页面 / 跳过」
- **no-outlinks**：转交审稿中心，提示人工补交叉引用
- **semantic**：转交审稿中心人工裁决，附受影响页面列表

## 记忆中心（小说模式）

记忆中心展示两类内容：

- **章节快照**（`SnapshotCard`）：每章的角色状态变更、知识变更、伏笔变更、时间线事件与结尾钩子，标注记忆是否同步（`memorySynced`）
- **六类记忆文件**：角色状态、角色认知、伏笔跟踪、时间线、Canon 事实、冲突，可打开 `WikiReader` 编辑并保存

## 状态与限制

- 空态：未运行时显示「运行检查」提示；`hasRun && results.length===0` 时显示绿色「全部通过」
- 加载/错误：运行中按钮转圈显示「检查中...」；检查失败（`lintRun.error`）时显示红条错误文案（`lint.messages.runFailed`）
- 已知限制：`[未交付·P2]` lint 历次结果分页未交付（`listGenerationHistory` 无分页）；无可用 LLM 时语义 lint 静默跳过，仅执行结构化检查
