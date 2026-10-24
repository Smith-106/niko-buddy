# 2026-10-24 控制面真源接入（volumeArc + budget 台账）

- 背景：`collectDoctorExtras` 里 volumeArc 是占位（`volumeNumber=1` / `segment=null` / 卷内计数=全局章节号），budget 只映射单 `current_task`，诊断里两处“占位项”未消除。
- 变更：
  - `src/lib/doctor-extras.ts`：volumeArc 改走真源 `getChapterVolumes(pp, chapterNumber)` 定位当前卷（`volume_number` + `chapter_range_*` frontmatter）+ `allocateVolumeArc` / `arcSegmentForChapter` 派段，卷内计数改为卷内相对值（`chapterNumber - start + 1`）；失败降级 null（无卷=诚实空态）。budget 新增 `budgetTotals`（`stage_metrics` tokenCost/latencyMs/条数累计，status.json 真源，只读）。
  - `src/lib/novel/doctor.ts`：`DoctorContext` 加 `budgetTotals?`（additive optional），`budget-ledger` 文案追加累计口径（有条目才拼接，无条目文案不变，旧 spec 不动）；`runProjectDoctor` 从 extras 透传。
  - spec：`doctor-extras.spec.ts` mock 卷纲（第2卷 1-10章）+ stage_metrics，断言卷号/段（承）/卷内计数/budget 累计。
- 验证：`npm run typecheck` 0 错；eslint 0 错；4 套件 70 全绿（doctor-extras/doctor/doctor-panel/dashboard-view）。
