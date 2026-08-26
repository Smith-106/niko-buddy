# A-34 决策日志 — LE-4 persona sidecar 防火墙加固 + 规格对齐

```yaml
date: 2026-08-23
task_id: TASK-LE-4
decision_type: hardening
wave: W1-launch
model: deepseek-v4-flash
verified: npx vitest run persona-sidecar 35 passed / 0 failed
```

## 决策

1. **实读修正**：`persona-sidecar-runner.ts` + `persona-critique-panel.tsx` 已在前序 checkpoint 落地；本任务定位为防火墙加固 + ADR-34 规格对齐确认（非从零实现）。
2. **防火墙边界**：主链模块白名单从 4 → 13；mod.ts 零导出复核；路径隔离（sidecar 不得越权访问项目外路径）；输出 payload 结构断言；全状态覆盖测试。
3. **规格对齐**：runner 文件头标注 ADR-34 alignment CONFIRMED，防火墙文档引用入注释。

## 验证证据

- `npx vitest run persona-sidecar`：35 passed / 0 failed（含防火墙矩阵用例）。
- 工作树与 HEAD checkpoint 一致（加固内容已在 wave-2 WIP 内），本次为对齐复核 + 补档。

## 残留缺口

- 独立防火墙规格文档 `docs/epic-005-persona-sidecar-firewall.md` 未单独落盘——边界矩阵以 runner.spec.ts 测试清单为真源，不再另建第二份文档真源（符合"单一真源"纪律）。
