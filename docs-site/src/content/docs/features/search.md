---
title: 剧情搜索
description: 关键词、向量、图谱等多维全局搜索
---

# 🔍 剧情搜索

全局搜索（侧栏独立按钮 `search` 入口）由 `SearchView` 组件承载。百科模式（wiki）下走「关键词 + 向量」混合检索并启用 rerank；小说模式（novelMode）下提供**五个筛选维度**，可组合命中剧情、图谱、近章与 Canon 正史。

## 检索维度

小说模式下五个筛选 chip（`keyword` / `vector` / `graph` / `recentChapters` / `canon`）：

- **keyword**：BM25 风格关键词匹配
- **vector**：语义级别相似内容检索
- **graph**：沿图谱关系边扩展相关节点
- **recentChapters**：最近章节窗口内容
- **canon**：强制注入的 Canon 正史规则

仅开启 keyword 时走 wiki 面板检索（`runWikiPanelSearch`，topK=20）；开启任一高级维度时切换 `runNovelPanelSearch` → `searchPlot` 适配器。

## 查询分词与排序

- 查询词经 `tokenizeSearchQuery` 分词：中文按二元组 + 单字展开，过滤停用词（如「的」「是」「the」）
- 结果按 RRF（倒数排名融合）降序排列
- 正文标题与摘要中的命中词经 `HighlightedText` 高亮

## 主路径

- 输入查询后按回车触发搜索，结果分为**图片区**与**页面区**两部分
- 图片区固定高度约 23rem（约两行缩略图），内部滚动；可展开显示「supporting」关联图片，页面区占据剩余空间独立滚动
- 点击图片卡片打开 `Lightbox` 大图（Radix Dialog），支持「跳转原文」定位到原始资料文件（`raw/sources/`）
- 点击结果卡片打开对应文件并跳转到 `wiki` 视图
- 搜索历史按项目隔离存储于 `localStorage`（`qmai_search_history_<projectId>`）

## 图片命中与 Lightbox

- 图片命中去重合并到一张卡片，标题（caption）命中查询词的优先展示
- caption 未命中的图片归入「supporting」，默认折叠，点击「显示全部」展开
- Lightbox 的「跳转原文」优先定位 `raw/sources/` 下的原始文件（PDF/DOCX/PPTX），找不到时才回退到 wiki 摘要页

## 状态与限制

- 空态：未搜索时显示「回车搜索」图标提示；搜索无结果时显示「无结果」并高亮查询词
- 加载/错误：搜索中显示「搜索中...」；搜索失败时捕获异常并清空结果、仅 `console.error`（**不显示显式错误条**）
- 已知限制：`[未交付·P2]` 搜索分页未交付——结果硬顶 `SEARCH_PAGE_TOP_K=20`，无「加载更多」；历史仅保留 `MAX_HISTORY=20` 条
