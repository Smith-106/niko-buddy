# T33c 精品执行语义（GCR 循环 + 交叉共识门 + 双提案/双判官 optional）

| 字段 | 值 |
|------|-----|
| date | 2026-08-22 |
| task_id | TASK-P6-33c |
| decision_type | 定稿 |
| value | 见下方各条目 |
| evidence_ref | `src/lib/novel/premium-execution.ts` + `premium-execution.spec.ts` |

## 一、GCR 循环设计

| 字段 | 值 |
|------|-----|
| 封顶轮次 | 2 轮（MAX_GCR_ROUNDS=2） |
| 批判模型 | 异模型：`premiumConfig.fallbackChains.critic?.primary`，未配置时回退 writer 模型 |
| 0 新 route 分支 | 批判 prompt 复用 review-adapter 已有审查维度（人设崩坏/动机/时间线/伏笔/泄密/水文/钩子），不新增 route 常量 |
| 双提案集成 | dualProposal 启用时第 0 轮初始生成由 runDualProposal 替代，不走独立 generate |

## 二、交叉共识门设计

| 字段 | 值 |
|------|-----|
| 判定维度 | accept / foreshadowing_conflict / pov_risk（三维） |
| 判官模型 | judgeA = resolveRoleModel("judge")，judgeB = fallbackChains.judge?.primary（一致时复用主模型） |
| 一致放行条件 | 双判官三维度 severity 完全一致且全部为 pass |
| 分歧处理 | manualReview=true，标记分歧但不阻断执行 |
| 容错 | parseConsensusJudgments 容错无效 JSON 返回空数组 → 自动分歧 |

## 三、门控优先级铁律

| 字段 | 值 |
|------|-----|
| P0/P1 不被覆盖 | 共识门分歧时 pass=false 但继续执行，不 throw，不阻断 upstream 的 P0/P1 阻断逻辑 |
| P2 additive | 共识门仅提供 verdict 信息，调用方决定是否因 consensus 分歧而阻断 |
| 证据 | spec 测试 "门控优先级铁律" 三组用例已验证 |

## 四、双提案/双判官 optional 开关

| 字段 | 值 |
|------|-----|
| 配置源 | `premium-config.ts` 的 `PremiumModeTriggers`（dualProposal / dualJudge） |
| 双提案流程 | 双 writer 并行生成 → arbiter 仲裁选择 |
| 双判官流程 | 双 judge 并行判定 → arbiter 融合输出 |
| GCR 集成 | dualProposal 启用时在 GCR 第 0 轮内部调用 |

## 五、验证结果

```
✓ npx vitest run premium-execution premium-config → 91 passed (2 files)
✓ npx tsc --build → 0 errors
```

## 六、技术债

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20260822-01 | consensus 门共识分歧仅标记 manualReview，实际 manual_review 流程对接（UI/通知/阻塞）尚未实现 | 与手动审查流程集成时 | 对接手动审查工作流 |
| DEBT-20260822-02 | ModelPort config 注入使用 `as any` 绕过类型检查（LlmConfig 未从 wiki-store 导出） | wiki-store 导出 LlmConfig 接口或引入独立配置类型 | 后续类型清理 |