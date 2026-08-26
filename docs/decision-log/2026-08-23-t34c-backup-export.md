# A-34 决策日志 — T34c 一键备份/恢复/导出

```yaml
date: 2026-08-23
task_id: TASK-P6-34c
decision_type: feature
wave: W1-launch
model: ox-alpha-free + deepseek-v4-flash（修复接力）
verified: canon_export.rs 在库编译通过 + cargo test 全绿；backup-export-view.tsx 落盘；tsc 0 错
```

## 决策

1. **导出包构成**：`status.json + draft 目录 + canon LanceDB checkout 快照`，zip 打包 + sha2 校验和。
2. **零新依赖**：复用已装 zip-rs 2 / sha2 / tauri-plugin-dialog，不引云端。
3. **恢复语义**：校验和验证通过后原子替换；supersede/迁移前自动备份。
4. **口令可选**：本地 zip 可选口令加密，不强制。
5. **UI 入口**：`src/components/novel/backup-export-view.tsx` 项目级入口。

## 验证证据

- `src-tauri/src/canon_export.rs` 编译通过（cargo test --lib 216 全绿）。
- `backup-export-view.tsx`（18KB）+ spec 落盘。
- 执行注记：本任务经历 ox-alpha-free 超时终止 → 文件已落盘 → flash 接力收尾验证。

## 已知边界

- LanceDB checkout 快照依赖 T32b compaction 后的 manifest 稳定性。
- 恢复流程的端到端手工验收归入 P6-34 哨兵硬化波次复检。
