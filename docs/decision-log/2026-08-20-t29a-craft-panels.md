# decision-log: T29a UI 三面板 F-06/F-07/F-08

| 字段 | 值 |
|------|-----|
| date | 2026-08-20 |
| task_id | TASK-P3-29a |
| decision_type | 基线值 / 裁决人 |
| value | 三面板按 review-center-view 子面板 tab 模式集成，不新增 activeView；ECharts 懒加载 React.lazy；@tanstack/react-table 装表；spec 按过滤器命名 craft-panels.spec.tsx |
| evidence_ref | review-center-view.tsx CorkboardView/PlotgridView/TimelineView 子面板模式参照 |

## 结构决定

1. **子面板集成**：三面板作为 review-center-view 的 craft tab（与 storyboard 并列），沿袭 F-010 故事板子面板模式（不新增 activeView，不新增路由条目）。
2. **数据源**：纯只读消费 T27/T27b 纯算术输出（arc-tracker/thrill-quantifier/technique-compiler），不修改上游模块。
3. **ECharts 懒加载**：`React.lazy(() => import("./thrill-echarts"))` 分离 echarts bundle（~1.1MB gzip 前），仅在 thrill-dashboard 首次渲染时加载。
4. **@tanstack/react-table**：新增依赖（`npm install @tanstack/react-table`），用于 thrill-dashboard 的量化 hit 表格。
5. **echarts**：新增依赖（`npm install echarts`），蓝图指定允许新增。

## 验收

- `npx vitest run craft-panels` 全绿
- `npx tsc --build` 0 错误