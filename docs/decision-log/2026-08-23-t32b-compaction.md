# A-34 决策日志 — T32b LanceDB compaction + 版本保留

```yaml
date: 2026-08-23
task_id: TASK-P5-32b
decision_type: feature
wave: W1-launch
model: deepseek-v4-flash
verified: cargo test --lib 216 passed / 0 failed（含 compact 新测试）
```

## 决策

在 `src-tauri/src/commands/canon_store.rs` additive 实现 LanceDB compaction：

1. **触发条件**：N 批 ingest 计数（`ingest_count: AtomicU64`，阈值 `DEFAULT_COMPACTION_THRESHOLD = 100`）+ 章节里程碑 + 空闲窗口三类入口。
2. **版本保留**：`DEFAULT_RETAIN_VERSIONS = 5`——保留 K 个 manifest 版本，超限旧版本清理。
3. **磁盘指标**：`DiskUsage`（各表+合计 bytes）/ `CompactionReport`（fragments/文件/版本/bytes 变化）serde 结构体，供 50ch-telemetry 消费。

## 验证证据

- `cargo test --lib`：216 passed / 0 failed，新增 `canon_lancedb_compact_supersede_edge_query_correct`、`canon_lancedb_compact_tables_does_not_crash` 全绿。
- 仅动 canon_store.rs 锚点；canon_search.rs / canon_commands.rs 未触碰。

## 影响范围

- 上游：canon 双写（T15）ingest 计数累加点。
- 下游：50ch-telemetry 磁盘占用指标（P6-34 哨兵硬化将消费）。
