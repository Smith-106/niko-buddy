---
title: 写作工作区
description: 编辑器、预览与聊天面板一体的主创作界面
---

# ✍️ 写作工作区

写作工作区是 niko-hub 的默认主界面（侧栏 `wiki` 入口），由 `WritingWorkspace` 组件承载。它的核心是占据主体的**预览/编辑面板**（`PreviewPanel`），可随时在右侧或底部停靠一个**聊天面板**（`ChatPanel`），形成「边写边问」的创作环境。默认状态下聊天面板收起（`chatExpanded=false`），编辑区占满整屏。

## 布局与组件

`WritingWorkspace → PreviewPanel` + `ChatPanel`（懒加载）：

- 聊天面板收起：`PreviewPanel` 占满并独立滚动
- 右停靠：`PreviewPanel` + 拖拽分隔条 + `ChatPanel`（默认宽 360px，`col-resize`）
- 底停靠：`PreviewPanel` + 拖拽分隔条 + `ChatPanel`（默认高 260px，`row-resize`）
- 停靠位置与尺寸由 `chatExpanded` / `chatDockPosition` 控制，拖拽尺寸经 `clampChatWidth` / `clampChatHeight` 约束后记忆在 `localStorage`

## 编辑器模式

`PreviewPanel` 按文件路径自动判定读写模式（`inferEditorMode`）：

- 章节（`wiki/chapters/`）与大纲（`wiki/outlines/`）进入**编辑模式**，走 `WikiEditor`
- 其余 Markdown 走只读的 `WikiReader`
- 非 Markdown 文件走 `FilePreview`（图片、PDF 等二进制预览）

## 主路径

- 打开任意文件后，预览区按文件类型渲染对应视图
- 在章节编辑器中撰写正文，保存时经 `writeFileAtomic` 落盘
- 章节**保存为正式章节**时触发记忆摄取，将内容结构化为图谱、快照与检索索引
- 展开聊天面板后可围绕当前章节对话，写作前由上下文引擎自动组装 ContextPack
- 聊天面板尺寸与停靠位置在下次打开时沿用

## 应用场景

- 逐章写作：在编辑器内完成正文，边写边通过聊天面板提问
- 大纲整理：打开大纲文件，配合右侧聊天面板推敲结构
- 回收站：`trash` 视图复用本工作区，展示回收项列表与选中项预览

## 状态与限制

- 空态：未选中任何文件时，预览区显示空态提示（`preview.empty`）
- 加载/错误：聊天面板懒加载挂载时显示「加载中...」；读取文件失败时预览区显示 `Error loading file` 错误文案
- 已知限制：`[未交付·P2]` 章节机械门控进度条尚未交付
