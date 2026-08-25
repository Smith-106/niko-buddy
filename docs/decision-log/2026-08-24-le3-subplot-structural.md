# A-34 决策日志 — LE-3 SubplotBoard.targetResolutionChapter 结构化

```yaml
date: 2026-08-24
task_id: TASK-LE-3（LE-1 Phase 3）
decision_type: feature
wave: W2-base
model: deepseek-v4-flash
verified: 281 tests 全绿（10 files）+ tsc 0 错 + 主 agent 全量 vitest 9554/9554 复核
```

## 决策

1. **生产端写入**：chapter-ingest.ts 新增 `applySubplotChangesToStore`——从 foreshadowingChanges/events 解析 subplot 解决/废弃事件，写入 `targetResolutionChapter`/`abandoned`；接入 ingest 投影与 rebuild 双路径，同 snapshot 幂等（fold_rebuildable）。
2. **引擎接入**：detectOverdueThread 结构化优先——`abandoned===true` → critical；`targetResolutionChapter ≤ current` → critical；均 undefined → data_gap info 降级（IC-02，ADR-31 additive-only，旧 store 兼容）。
3. **串行纪律**：chapter-ingest.ts 在 LE-2 之后串行执行（同文件区域），lastSeenChapter/isAlive/deathChapter 写入路径零改动。

## 影响范围

- W3 聚合波 P2-20/P2-21 的 warn 接线将消费本结构化字段。
