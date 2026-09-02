---
title: Canon 一致性编辑器
description: 浏览与校正项目 Canon 事实边，守护叙事一致性与 POV 防泄密
---

# 📜 Canon 一致性编辑器

Canon 编辑器（CanonEditor）以双模式运行：浏览模式只读事实表（CanonFactTable，按 known_by / valid_at_chapter / edge_kinds 过滤并客户端分页 PAGE_SIZE=100）；校正模式由「校正」按钮进入，对事实边做认知轴（known_by 白名单 + revealed_at 时态不变量）校正，保存走 canon_supersede_edges（旧边封顶留痕 + 后继边校正）。三个命令面板（facts_known_by / get_revision / supersede_edges）复用 15-p1-1 草案，不重画。

## 主路径

- 浏览模式：查询 canon_query_batch 渲染事实表，支持 known_by / valid_at_chapter / edge_kinds 过滤与分页，只读展示 max_revision
- 点击「校正」进入校正模式：选择一条事实边，编辑 known_by（白名单 fail-closed）与 revealed_at（时态不变量守卫）
- 保存走 canon_supersede_edges，成功后自动重新 query 刷新边列表；移除知晓成员永不扩大知晓面（POV 安全方向，不做白名单限制）
- 冲突消解走 supersede_edges 写路径（Draft-first），已接线 content-area / icon-sidebar

## 能力构成

- CanonFactTable：事实边列表渲染，认知轴列含 known_by / valid_at_chapter / edge_kinds；客户端 `PAGE_SIZE=100` 硬分页
- 认知轴校正面板：known_by 白名单（项目角色注册表投影）fail-closed，白名单空 = 禁止一切增补（仅允许移除）；revealed_at 非空但 known_by 为空触发时态不变量违例
- canon-editor-client：封装 canon_query_batch 查询与 canon_supersede_edges 写；纯函数装配请求体并重算 digest

## 校正校验规则

校正模式在客户端做 fail-closed 校验，违规不入草稿、更不触达 IPC：

- `empty_pov`：known_by 含空白 POV 条目
- `duplicate_pov`：known_by 出现重复 POV
- `not_in_allowlist`：POV 不在项目角色白名单内（POV 防泄密，仅接受白名单成员增补）
- `revealed_without_known_by`：revealed_at 已登记但 known_by 为空——无人知晓的事实不可能被揭示

移除知晓成员永不扩大知晓面（POV 安全方向），不做白名单限制。

## 状态与限制

- 空态：无事实边时显示空表
- 加载 / 错误：Suspense「加载中...」+ query 进行中；写失败（如超出 CANON_SUPERSEDE_HARD_CAP）展示后端错误原文
- 无权限：校正模式 known_by 白名单为空 → 禁止一切增补（fail-closed，POV 防泄密），仅允许移除
- 已知限制：P1-1 — facts_known_by POV 面板与 revision diff viewer 未做（v2.8 P1-1）；P1-2 — facts_known_by 面板分页（默认 limit=200）与 canon 边筛选（buildCanonEdgeFilter）骨架占位，服务端 offset/limit+total 分页已实现但 UI 未接线（仍客户端 PAGE_SIZE=100 硬分页）；P2 — revision 对比 diff 算法未做
