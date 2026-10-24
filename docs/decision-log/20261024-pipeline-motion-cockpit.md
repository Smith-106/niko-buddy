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

## 2026-10-24 七層縱向拓撲 + 實況點亮 + 對賬誠實口徑（U-pipeline-5fix）

| 字段 | 值 |
|------|-----|
| date | 2026-10-24 |
| task_id | U-pipeline-5fix |
| decision_type | U-xx 定稿 |
| value | 自上而下 7 層縱向主幹（viewBox 0 0 1100 680）：L1 goal→evidence / L2 outline→chapter-plan / L3 draft / L4 self-gate→review / L5 審查 9 維芯片條 / L6 review-gate→ingest / L7 ingest(y=545)+deliver·reflow·retrospective(y=625) 雙行防重疊落位（L6 縱邊與 L7 四節點同排會重疊，故 L7 三終節點下沉 625，任務書 y=545 字面凍結為 ingest 單行）；ExternalNode 琥珀連線零長度 Bug 修復（舊 `x1===x2` 自連線，現 knowledge-base→evidence/chapter-plan、model-router→draft 有效長度虛線）；9 維芯片條自檢/審稿活躍時青藍點亮 + review 引線；回流環右侧大環、reflow/retrospective 活躍時實線 + 青綠 animateMotion 脈衝；回放末幀 finished 態顯示「↻ 重新回放 / 退出」；主控 motionOpen 默認 true + liveTrace=useMemo(buildTraceEntries(steps)) 實況點亮（onStep 無 updater 副作用）；vector reconcile skipped:true 誠實口徑（doctor-extras + health-card 均报「已跳過（無預置索引清單）」，禁报 reconcile ok/deleted=0；Rust ReconcileReport.skipped 字段本就存在，未改 Rust） |
| evidence_ref | `src/components/novel/pipeline-motion-panel.tsx`（TRUNK_ORDER/NODE_XY） / `src/components/novel/main-control-view.tsx:82`（liveTrace） / vitest 5 套件 38 綠（同進程順序跑） / `npm run typecheck` 0 錯 / eslint 9 文件 0 錯 |

## 债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20261024-pm01 | 演示事件流內置於 panel（demoEvents），非外部注入；將來如需多劇本需抽出 | 出現第二套演示劇本需求時 | 下一 UI 迭代前 |
