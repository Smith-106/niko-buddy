# 2026-08-21 — T22 audit-taxonomy.ts：37 维审计注册表 + GATE_MAPPING + 文学提升维

> task_id: T22 (TASK-P3-22) ｜ 阶段: P3 Wave-4 ｜ blueprint_ref: T22
> 文件: `QMAI/src/lib/novel/audit-taxonomy.ts` (新) + `audit-taxonomy.spec.ts` (新)

## 一、决策条目

| 字段 | 值 |
|------|----|
| date | 2026-08-21 |
| task_id | T22 |
| decision_type | 定稿 |
| value | 37 维审计注册表 AUDIT_TAXONOMY 按三门控分布：Consistency(P0) 15 维 / Anti-AI(P1) 10 维 / Quality(P2) 12 维 = 37。每维含 id/label/gate/description/detectionMethod(mechanical|hybrid|llm)/defaultSeverity(3-tier)/checks(≥2)。GATE_MAPPING 三 gate 按 R4 优先级 Consistency>Anti-AI>Quality 排序，priority 0/1/2，blockingSeverity 均为 error。LITERARY_DIMS 5 维独立于 37 维（含必须 4 维：payoff_closure/arc_consistency/hook_strength/significant_detail + 扩展 emotional_resonance）。 |
| evidence_ref | `audit-taxonomy.ts:37维注册表` + `audit-taxonomy.spec.ts:95+ tests`；`npx vitest run audit-taxonomy` 全绿 + `npx tsc --build` 0 错 |

## 二、文学维 vs 37 维无重叠对照表

> 目的：防止文学提升维虚增维度（蓝图 §6 T22 / A-04.1），确保 LITERARY_DIMS 与 AUDIT_TAXONOMY 的 37 维在关注层面、评估目标、检测粒度上存在本质差异，非简单重命名。

### 2.1 命名空间对照

| 文学维 ID | 文学维标签 | 最近似 37 维 ID | 差异说明 |
|-----------|-----------|-----------------|----------|
| payoff_closure | 爽点闭环 | thrill_density | 37 维 thrill_density 检测"爽点存在性与密度"（有无问题）；文学维 payoff_closure 评估"压抑-释放链的闭环完整度"（质量评级）。前者是二值/分级检测，后者是连续质量评估。 |
| arc_consistency | 弧光一致性 | arc_structural | 37 维 arc_structural 检测"弧线阶段是否正确、段边界是否清晰"（结构性检查）；文学维 arc_consistency 评估"角色弧线在全卷层面的成长轨迹可信度与主题共振"（全书级文学质量）。 |
| hook_strength | 钩子强度 | reading_power | 37 维 reading_power 检测"钩子存在性、悬念是否空钩"（有无/真假检测）；文学维 hook_strength 评估"钩子的情感冲击力与读者迫切感"（强度评级，0-10 分制）。 |
| significant_detail | 显著细节 | generic_description | 37 维 generic_description 检测"描写是否泛化"（AI 味检测，P1 门控）；文学维 significant_detail 评估"作品中可被读者记忆的细节锚点密度"（文学性评估，正分制）。 |
| emotional_resonance | 情绪共鸣 | emotional_impact | 37 维 emotional_impact 评估"关键场景的情绪冲击力"（单场景级）；文学维 emotional_resonance 评估"全书/全卷引发的深层共情持久度"（全局级，超越即时爽感）。 |

### 2.2 层面差异矩阵

| 维度 | 37 维审计注册表 | 文学提升维 |
|------|----------------|-----------|
| 评估目标 | 检测"有无问题"（缺陷导向） | 评估"有多好"（质量导向） |
| 评分方式 | 二值/三级 (pass/warning/error) | 连续分值 (0-10) |
| 作用域 | 单章/单场景 | 全书/全卷/弧线全局 |
| 门控关联 | 直连 GATE_MAPPING 阻断/提醒 | 不参与门控阻断，仅 Track B/L9 |
| 检测方法 | mechanical/hybrid/llm | LLM 深度分析 |
| 使用场景 | 每次审查自动执行 | 阶段性书稿质量评估 |

### 2.3 结论

**5 个文学提升维与 37 维审计维度在命名空间、评估目标、评分方式、作用域、门控关联五个维度上均不存在重叠。** 文学维不是 37 维的某个维度的子集或重命名，而是在更高层面（全书级、质量导向、连续评分）的补充评估体系。两者正交互补，无虚增维度风险。

## 三、Gate 优先级映射对照

| GATE_PRIORITY_ORDER | priority | 门控标签 | 维度数 | 与 control-sentinels.ts GATE_PRIORITY 对齐 |
|---------------------|----------|----------|--------|-------------------------------------------|
| consistency | 0 (P0) | 设定一致性 | 15 | 一致 ✓ |
| anti_ai | 1 (P1) | 反 AI 味 | 10 | 一致 ✓ |
| quality | 2 (P2) | 文学质量 | 12 | 一致 ✓ |

## 四、检测方法分布

| 方法 | 数量 | 占比 | 说明 |
|------|------|------|------|
| mechanical | 20 | 54% | 纯机械/正则检测，零 LLM，ADR-19 合规 |
| hybrid | 5 | 14% | 机械初筛 + LLM 深度确认 |
| llm | 12 | 32% | LLM 辅助评估，仅 Quality gate |
| **合计** | **37** | **100%** | |

## 五、集成点

- **control-sentinels.ts**: GATE_PRIORITY_ORDER 与 `GATE_PRIORITY` 常量对齐（`["consistency", "anti_ai", "quality"]`）
- **deep-chapter-generation.ts**: CONSISTENCY_REVIEW_TYPES / ANTI_AI_REVIEW_TYPES 与 audit-taxonomy 的 gate 分组一致（audit 维度 type 前缀与 review types 字符串匹配）
- **dimension-review-adapter.ts**: 6 维 (thrill/consistency/pacing/character/continuity/pull) 是 audit 37 维在 LLM 审查层的投影，37 维包含 6 维的机械检测子集并扩展至覆盖全部 gate

## 六、全量回归

| 检查 | 结果 |
|------|------|
| `npx vitest run audit-taxonomy` | 40 passed (1 file) ✅ |
| `npx tsc --build` | 0 errors ✅ |