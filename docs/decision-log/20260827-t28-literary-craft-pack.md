# T28 literary-craft-pack + craft-rule-registry

| 字段 | 值 |
|------|----------------|
| date | 2026-08-27 |
| task_id | T28 (TASK-P3-28) |
| decision_type | 基线值 / 手设参数 |
| value | 14 文学规则 + 9 包 skill↔rule 映射 |
| evidence_ref | `src/lib/novel/packs/literary-craft-pack.ts` + `src/lib/novel/craft/craft-rule-registry.ts` |

## 一、规则设计决策

### 1. 14 条规则的门控归属

所有 14 条规则归属 **quality 门**（P2），默认 severity = "warning"。

理由：
- 文学提升检查属于文学质量面（P2），而非一致性（P0）或反 AI（P1）
- 终局章升格由 `craftFinaleEscalation` 统一处理，规则自身不感知升格逻辑
- 非终局章 warning 不会触发阻断，仅做诊断提示

### 2. 规则→T22 维度映射

| 规则 id | 映射维度 | 维度门 |
|---------|----------|--------|
| craft.thrill-density | thrill_density | quality |
| craft.thrill-spacing | thrill_density | quality |
| craft.delay-ratio | pacing_tension | quality |
| craft.arc-progression | emotional_arc_consistency | quality |
| craft.ghost-unrevealed | emotional_arc_consistency | quality |
| craft.opening-hook | reading_power | quality |
| craft.chapter-end-hook | reading_power | quality |
| craft.significant-detail | description_vividness | quality |
| craft.bridge-caliber | pacing_tension | quality |
| craft.ending-three-precepts | structural_balance | quality |
| craft.tension-relax-alternation | tension_curve | quality |
| craft.domino-closure-dangling-hooks | scene_craft | quality |
| craft.opening-red-line-five-categories | structural_balance | quality |
| craft.eight-fundamentals | character_consistency | quality |

注意：`eight-fundamentals` 映射到 `character_consistency`（consistency 门）而非 quality 门——但规则本身登记为 quality 门，因为它是文学提升规则而非一致性门控。dimensionId 的存在仅用于审计追踪，投影时以声明的 gate 为准。

### 3. 规则包工厂模式

采用 `createLiteraryCraftPack(data)` 工厂模式而非静态导出包对象：

- 数据依赖通过闭包注入，规则运行期可访问外部数据
- 工厂返回不可变 `RulePackDefinition`（与 `combinePacks` 契约兼容）
- 多次调用创建独立实例，互不干扰

### 4. 阈值参数

| 检查项 | 阈值 | 来源 |
|--------|------|------|
| 爽点密度 | 单桶 > 全书 30% = warning | 实践基线 |
| 爽点间隔 | 前 80% 最大间距 > 0.3 = warning | 实践基线 |
| 延宕比 | open/closed > 3:1 = warning | 实践基线 |
| 连续延宕跨度 | > 全书 50% = warning | 实践基线 |
| 张弛交替 | 连续上升 > 5 采样点 = warning | 实践基线 |
| 悬空钩子 | 伏笔 > 3 章未计划 payoff = warning | T27b 参数 |
| 显著细节 | 每个角色 ≤ 2 个 | T27b 参数 |
| 开篇红线 | 缺失 ≥ 3 类 = warning | 实践基线 |

## 二、skill↔rule 映射设计

### 1. 9 包映射规则

| T27b 技法包 | 关联文学规则 | 注入范围 |
|-------------|-------------|----------|
| craft.wish-motive-action | opening-red-line-five-categories | protagonist_brief, chapter_task_brief |
| craft.thrill-loop-crisis-delay | thrill-density, thrill-spacing, delay-ratio, tension-relax-alternation | chapter_task_brief, review_quality |
| craft.finale-three-precepts | ending-three-precepts | ending_guard, review_consistency |
| craft.mckee-eight-fundamentals | arc-progression, eight-fundamentals | protagonist_brief, chapter_task_brief |
| craft.mckee-ghost-wound | ghost-unrevealed | protagonist_brief, chapter_task_brief |
| craft.chapter-end-hooks-domino | chapter-end-hook, domino-closure-dangling-hooks | chapter_task_brief, review_quality |
| craft.opening-hook-promise | opening-hook, opening-red-line-five-categories | opening_audit, review_quality |
| craft.conflict-caliber-bridge | bridge-caliber | opening_audit, review_consistency |
| craft.significant-details | significant-detail | chapter_task_brief, review_quality |

### 2. 桥接规则表

| 叙事模式 | 推荐口径 | 守卫条件 |
|----------|---------|----------|
| snyder_commercial | edgerton | 冲突尽快落地，压缩稳定态 |
| longform_padding | gerke | 稳定已被撕开，不得纯前史开场 |

## 三、技术债

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20260827-01 | literary-craft-pack 的规则阈值参数缺乏实际数据验证，可能需在积累分析数据后调整 | 离线回放 harness 积累 ≥ 50 章分析数据后 | Stage 4 分析面加固 |
| DEBT-20260827-02 | 开篇红线 5 类全集规则（rule 13）目前仅检查缺失项，未做正向质量评估 | 实现 U-05 开篇承诺质量评估后 | Stage 5 文学提升 |
| DEBT-20260827-03 | 多弧并行时 arc-progression 规则只检查主弧，未检查从弧 | 实现多弧光追踪后 | Stage 5 弧光系统 |