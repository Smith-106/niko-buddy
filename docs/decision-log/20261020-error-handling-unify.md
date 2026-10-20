# 2026-10-20 请求错误处理最小收敛（DRY）

| 字段 | 值 |
|------|-----|
| date | 2026-10-20 |
| task_id | err-unify-min（Todo #369-#371，用户选定“最小收敛”） |
| decision_type | 定稿 |
| value | 合入 37 文件：web-search.ts 三 provider 错误模板收敛为 2 私有 helper（文案逐字保留）；36 组件文件 65 处 err-message 内联归一为既有 utils.ts:20 toErrorMessage；纠正专家重复造轮子（format-operation-error.ts 恢复 HEAD）。llm/embedding/rerank/research/invoke 因重试·文案·降级·写回语义各异，明确不碰 |
| evidence_ref | `npm run typecheck` exit 0；全量 vitest 1192 文件/15394 用例绿；`git show --stat HEAD` +121/−93 |

## 债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20261020-04 | llm-client 分类器与 transport-error 分类器语义重叠零共享；rerank/search/embedding 拼串同形不同通道；invoke 无统一归一 | 需改用户可见错误文案或重试语义时一并设计 | 按需（完整统一属中风险，需单独立项） |
