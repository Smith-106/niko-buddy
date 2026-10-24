# pipeline-motion 深色終端拓撲大屏（U-pipeline-motion）

| 字段 | 值 |
|------|-----|
| date | 2026-10-24 |
| task_id | U-pipeline-motion |
| decision_type | U-xx 定稿 |
| value | pipeline-motion-panel 升級為 huashu-art-motion 風格深色駕駛艙：6 層正交拓撲（13 主階段 + 2 琥珀外部依賴）+ KPI 矩陣 + 審查維度芯片條 + 返工環/回流環 + 發光脈衝（animateMotion 圓點，不碰 dasharray 契約）+ session log 終端 + CLI 膠囊欄 + 700ms 回放/演示；主控 run Tab 可折疊掛 PipelineMotionView（默認收起）+ 實況頁頂部掛 PipelineMotionPanel；nav 入口已可達（content-area/workbench/store + 中英 i18n 恒等），不新建 |
| evidence_ref | `src/components/novel/pipeline-motion-panel.tsx:381`（motion-replay-toggle） / vitest 41 綠 / `npm run typecheck` 0 錯 / eslint 0 錯 |

## 契約死守記錄

- 既有色值/線型斷言零改：激活返工紅保持 `#f85149`、非激活 dasharray 保持 `"4 3"`，只加 glow 濾鏡 + 發光圓點。
- 空態口徑不變：零事件且未開回放/演示 → `motion-empty` + `motion-log-empty`，不渲染 `motion-diagram`。
- `motion-stats` 完整文本保留（單測配對不動）。

## 债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20261024-pm01 | 演示事件流內置於 panel（demoEvents），非外部注入；將來如需多劇本需抽出 | 出現第二套演示劇本需求時 | 下一 UI 迭代前 |
