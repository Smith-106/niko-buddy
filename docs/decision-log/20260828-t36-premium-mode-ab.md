# decision-log: T36 精品模式 A/B 验收（终端硬门）

## 一、决策条目

| 字段 | 值 |
|------|----------------|
| date | 2026-08-28（初版）/ 2026-08-22（真实补验轮） |
| task_id | TASK-P6-36（T36） |
| decision_type | 统计口径 / 裁决人 |
| value | 精品模式保持 opt-in 默认关闭（真实补验轮：门槛①③ 均 FAIL） |
| evidence_ref | `docs/p6/premium-mode-ab-report.md` + `docs/p6/ab-evidence/` 全部证据文件 |

## 二、五门裁决详情

### 门槛① 六维 overall 中位差（精品臂−基线臂 ≥+0.5 且 95%CI 不含 0）

| 子项 | 初版 | 真实补验轮 |
|------|------|-----------|
| 判定 | PENDING（fixture-mock） | **FAIL** |
| 证据 | 中位差 +0.65, 95%CI [+0.60, +0.70] | 综合中位差 0.0, 95%CI [-0.5, 0.0], CI 含 0 |
| 评审 | — | J1=deepseek-v4-flash, J2=ox-alpha-free |

### 门槛② 一致性非劣（Track A 机械门两臂全 PASS）

| 子项 | 值 |
|------|-----|
| 判定 | **PASS**（不变） |
| 理由 | 基线臂与精品臂各 40 章经 composeCoreRulePacks→combinePacks→runRuleStack 真跑，两臂 consistency errors=0、anti_ai errors=0 |
| 证据 | baselineTrackA.allPass=true, premiumTrackA.allPass=true |

### 门槛③ 盲评 κ≥0.6

| 子项 | 初版 | 真实补验轮 |
|------|------|-----------|
| 判定 | PENDING（环境不可达） | **FAIL** |
| 证据 | — | Po=0.50, Pe=0.505, κ≈-0.01 |
| 评审 | — | J1=deepseek-v4-flash, J2=ox-alpha-free |

### 门槛④ 墙钟 ≤45min/章

| 子项 | 值 |
|------|-----|
| 判定 | **PASS**（不变） |
| 理由 | per-stage 预算表（装配3/拆解2/brief2/draft20/review10/revision5/gate1/缓冲2）合计恰 45min；基线臂与精品臂推演均 ≤45min |
| 证据 | checkChapterWallclockGate(45min).pass=true, baseline.allWithinBudget=true, premium.allWithinBudget=true |

### 门槛⑤ 无写入风暴/预算违例

| 子项 | 值 |
|------|-----|
| 判定 | **PASS**（不变） |
| 理由 | status-write-merge 合并写在 40 章 × 3 次写/章 = 120 次提交流上实测：非关键小写被合并吸收，关键转移全部落盘，flush 后无 pending；各角色 token 硬封顶零违例 |
| 证据 | hasPendingAfterFlush=false, orderPreserved=true, hardCapBreaches=0 |

## 三、债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 | 状态 |
|-------|------|----------|----------|------|
| DEBT-20260828-t36-01 | 门槛① 六维中位差（已补验：FAIL） | 已补验——未通过 | 归档 | **已偿还（FAIL）** |
| DEBT-20260828-t36-02 | 门槛③ 盲评 κ（已补验：FAIL） | 已补验——未通过 | 归档 | **已偿还（FAIL）** |
| DEBT-20260828-t36-03 | 门槛④ 墙钟推演需 50ch-telemetry 真实 LLM 计时确认 | 50ch-telemetry 真实 LLM 计时数据积累 | P6 收口 | 开放 |

## 四、真实补验轮执行命令

```powershell
cd QMAI
node scripts/ab-prepare-evidence.cjs          # 准备盲评材料
node scripts/ab-prepare-judge-pool.cjs        # 生成评审模板
# 评审 J1, J2 独立完成评分
node scripts/ab-score-aggregate.cjs           # 统计计算
```

## 五、引用

- 蓝图 T36
- `docs/p6/premium-mode-ab-report.md`
- `docs/p6/ab-evidence/` 全部证据文件
- `scripts/offline-replay.js`（`--ab` 模式）
- `src/lib/novel/offline-replay-t36-ab-pair.spec.ts`
- `src/lib/novel/offline-replay-config.ts`
- `scripts/ab-score-aggregate.cjs`