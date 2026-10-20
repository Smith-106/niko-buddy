# 2026-10-20 四阶段重构（P1/P2 清单实施 + grok-4.7 终审）

| 字段 | 值 |
|------|-----|
| date | 2026-10-20 |
| task_id | audit-refactor-P1P2（四阶段 goal 043780e9，已 verified done） |
| decision_type | 裁决人（grok-4.7 终审 ACCEPT-WITH-CHANGES，2 项整改已落实） |
| value | 合入 13 改 1 删：P2-5 阶段表合并；P2-6 markdown 插件常量抽取；P2-8 删 types/saved-model.ts；P2-7 chat-panel 改用 useChatAutoScroll；P1-1 graph 定时器句柄；P2-9 typeCounts useMemo；P1-3 滚动 setState 守卫；P1-2 embedding 两阶段并行（5 路 HTTP＋指纹单写者＋页串行） |
| evidence_ref | `C:/tmp/grok-final-review.md`；`npm run typecheck` exit 0；全量 vitest 1192 文件/15394 用例绿；`npm run gen:check` 6/6 PASS |

## 债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20261020-01 | P1-4 story-simulation 废弃字段仍序列化（中风险契约迁移，未做） | 定出兼容读＋停写方案 | 下次重构窗口 |
| DEBT-20261020-02 | 三巨文件（chat-panel/chapter-ingest/graph-view）仅薄抽取，未拆分 | 改动半径触及该文件核心逻辑时 | 按需 |
| DEBT-20261020-03 | embedding 并行 console.warn 顺序随并发交错（仅诊断输出，状态已确定化） | 有用户报障混淆时改为收尾重放 | 按需 |
