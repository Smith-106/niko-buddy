# A-34 决策日志 — T31 P4 垂直切片全验收（三硬门之二）

```yaml
date: 2026-08-22
task_id: TASK-P4-31
decision_type: 基线值
wave: Wave-6 (P4)
model: ox-alpha
verified: node scripts/offline-replay.js EXIT=0 总判定 PASS + vitest offline-replay/control-kernel/e2e-chapter-hardgate 52/52 绿 + tsc --build 0 错 + 全量 test:mocks 9768 passed
```

## 决策

1. **A-10 全项判定 PASS**（三硬门之二）：authoritative 端到端 / 离线回放评分达标 / 崩溃注入 ×5 / 同章重放 ×2 一致 / 迁移前事实可查询，逐项证据见 `docs/p4/t31-vertical-slice-report.md` + `docs/p4/t31-acceptance-evidence.json`。
2. **离线回放评分基线值**：10 章真实 route() 决策状态序列，四因子 branchAgreement/selfConsistency/gatePass/wallClockNorm = 1.0/1.0/1.0/≈1.0，综合分 ≈1.0000 ≥ 达标线 0.9（PROVISIONAL，T02 候选值；本次为 T18 后首次实测基线记录，供后续阈值复核定稿参照）。
3. **warn 态 anti-AI 放行入埂（P2-21 共识条款执行）**：anti_ai=fail × mode=warn → judge 放行且 reason 注解留痕（触发因子 + 标定来源 synthetic-degraded）；block 档仍硬挡、P0 fail 永不放行——门控优先级不受放行条款削弱。该放行按任务共识不计 FAIL。
4. **验收基建落位**：`scripts/offline-replay.js`（driver：驱动证据 spec + T02 同源纯函数独立复算评分 + 非零码退出纪律）+ `src/lib/novel/offline-replay-t31-vertical-slice.spec.ts`（机械证据 spec，文件名纳入 `vitest run offline-replay` 既定验证过滤器）。
5. **崩溃注入 ×5 故障点口径固化**：ingest 中断 / digest 记录写失败（legacy 侧）/ canon 双写失败（canon 侧 SIGKILL, fail-before-commit 无半行悬空）/ journal 过期（stale 绝不复用）/ 投影 rebuild 失败（F-005 审计留痕 [failed→rebuild]）。与 T18 六类数据面故障矩阵互补，构成管线级 × 数据面双层故障覆盖。

## 边界

- canon_store 为内存去重模型（镜像 T11 `(chapter_number,digest)` 契约，与 T18 e2e 同 mock 策略）；Rust/LanceDB 真实面由 cargo test 口径另行保障。
- 评分墙钟因子为纯函数决策毫秒级墙钟，不代表端到端生成墙钟（归 T34 telemetry 校准）。
- 阈值 PROVISIONAL：改权重/阈值必须触发重基线（REBASE_REQUIRED_WHEN_WEIGHT_DRIFTS），重跑本 driver。

## 债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20260822-t31-01 | A-05.2 因子权重/达标阈值为 T02 候选值（PROVISIONAL），本次仅落实测基线未定稿 | 真实书稿回放语料积累后复核定稿（蓝图 §7 A-05.2 "T18 后复核"，实际顺延至 P4 收口评审） | P6 默认切换决策（T34b）前 |
