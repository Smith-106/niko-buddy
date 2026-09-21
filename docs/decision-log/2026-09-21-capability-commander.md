# Capability Commander：能力发现、规划与追踪闭环

- **Decision ID**: A-34
- **Date**: 2026-09-21
- **Status**: Accepted
- **Scope**: QMAI / niko-buddy
- **Owners**: Agent Architecture
- **Affected area**: Writing pre-plugin chain, capability selection, capability planning, execution trace
- **Supersedes**: `select_skills` 仅依赖确定性技能查表的选择机制
- **Related modules**:
  - `src/lib/agent/capability-retrieval.ts`
  - `src/lib/agent/capability-planner.ts`
  - `src/lib/agent/capability-trace-store.ts`
  - `src/lib/agent/plugins/select-skills-plugin.ts`
  - `src/lib/novel/bm25-ranking.ts`

## 1. Decision

在现有写作主链中引入 Capability Commander，将技能选择从确定性查表升级为以下闭环：

```text
Intent
  ↓
Capability Registry
  ↓
BM25 Retrieval
  ↓
Rule Filter
  ↓
Capability Planner
  ↓
Capability DAG Validation
  ↓
Execution
  ↓
Trace Persistence
```

Capability Commander 负责 assess → decide → dispatch 中的 decide 阶段。

本次不重写既有任务规划器、执行器和权限门控，而是复用现有组件：

- 复用 AiCapability、UserSkill、ToolRegistry 和 MCP 工具映射作为能力注册层。
- 复用 lib/novel/bm25-ranking.ts 完成候选能力召回。
- 复用 dynamic-agent-planner 的 LLM 结构化规划模式。
- 复用现有 tool-scope、required-tools-gate 和 tool.permission 执行边界。
- 使用 .novel/ 既有工件契约持久化能力选择 trace。

规划器产出的是 Capability DAG，不是 Task DAG。

Capability DAG 描述完成当前请求需要调用哪些能力、能力间的依赖关系、权限要求、选择理由以及是否需要最终复核。它不负责将用户目标拆成业务任务或大纲任务。

## 2. Context

原有写作链路已经具备：

- route-task 意图分类；
- build-context 上下文构建；
- dynamic-agent-planner 的 LLM DAG 规划能力；
- orchestrator 的计划验证、拓扑执行和依赖上下文注入；
- subAgent、工具注册、权限控制和 MCP 执行能力；
- BM25 排序基础设施。

但 select_skills 仍通过以下机制选择技能：

```text
intent
  ↓
inferSkillRoute
  ↓
getWritingSkillNames
  ↓
selectByShape
  ↓
预定义技能名清单
```

该机制可以稳定处理已知路径，但不能根据具体请求自主组合能力。

例如，请求可能同时需要：

- 人物一致性检查；
- 指定风格改写；
- 悬念增强；
- 结尾钩子生成；
- 最终结果复核。

固定的 intent → skill list 无法可靠表达这种动态组合，也无法表示能力之间的依赖顺序。

因此，系统缺少的不是新的任务规划器，而是连接能力注册表与执行层之间的 Commander 决策层。

## 3. Decision Drivers

本决策由以下要求驱动：

- **最小侵入** — 不改变 PrePlugin 主链接口，不重写 orchestrator，不替换现有执行器。
- **复用现有积木** — 使用现有 BM25、LLM 规划模式、权限闸和 .novel/ 工件目录，不引入新的 Agent 框架、向量数据库或图数据库。
- **Closed-world planning** — 规划器只能从召回并通过规则过滤的候选集中选择能力，不允许生成不存在的 capabilityId。
- **权限安全** — LLM 规划不能绕过既有 auto、confirm 权限边界。
- **可靠降级** — LLM 不可用、超时、输出解析失败、计划为空或计划验证失败时，不得阻断写作主链。
- **可观测性** — 需要记录召回、裁剪、规划及最终结果，为问题诊断和后续 Capability Selector 学习提供数据。
- **延迟边界** — fast 模式不能承担额外的 LLM 规划延迟。

## 4. Architecture

### 4.1 L0：Capability Registry

能力来源包括：

- AiCapability
- UserSkill
- ToolRegistry
- MCP 工具映射

不同来源首先归一化为统一的 CapabilityDoc，供召回、过滤和规划阶段使用。

能力检索文本由以下字段构建：

```text
name × 6
label × 5
tags × 3
description × 2
content × 1
```

字段重复用于表达 BM25 权重，不改变原始能力对象。

### 4.2 L1：BM25 Retrieval

capability-retrieval.ts 负责：

- 将 UserSkill 和 AiCapability 转换为 CapabilityDoc；
- 构建字段加权后的检索文本；
- 复用现有 BM25 排序；
- 使用中文 bigram 支持中文能力检索；
- 根据用户请求召回 Top K 候选能力；
- 当前默认召回上限为 8。

该层只负责缩小候选集，不直接决定最终能力链。

### 4.3 Rule Filter

BM25 召回后、LLM 规划前执行确定性过滤。

过滤维度包括：

- mode
- intent
- allowedSources
- autoOnly

过滤的作用是建立 Capability Sandbox，防止语义相关但当前请求无权使用的能力进入规划器。

每个被裁剪的能力都记录对应的 filteredOut 原因，用于调试和后续离线分析。

### 4.4 L2：Capability Planner

capability-planner.ts 接收：

- userMessage
- intent
- 通过 Rule Filter 的候选能力
- 必要的上下文摘要

规划器通过注入式 LLM seam 调用 streamChat，当前超时边界为 20 秒。

规划结果为：

```ts
interface CapabilityPlanNode {
  id: string
  capabilityId: string
  dependsOn: string[]
  permission: "auto" | "confirm"
  reason: string
  finalReview?: boolean
}
```

规划器必须遵守以下约束：

- capabilityId 必须属于传入的候选能力集合；
- 不得生成候选集外的能力；
- 能力节点必须具有唯一 ID；
- 依赖只能引用当前计划内已有节点；
- 计划最多包含 6 个节点。

解析器兼容以下输出差异：

- Markdown json 代码块包裹；
- camelCase capabilityId；
- snake_case capability_id；
- 合法 JSON 外围存在非结构化文本。

### 4.5 Capability DAG Validation

执行前通过 validateCapabilityPlan 验证：

- 节点 ID 唯一；
- capabilityId 属于候选集；
- 所有依赖节点存在；
- 不存在自依赖；
- 不存在循环依赖；
- 节点数量不超过上限；
- permission 值合法。

循环依赖使用 DFS 检测。

任何验证失败都不得进入执行阶段。

### 4.6 L3：Execution

验证通过的 Capability DAG 映射回：

- selectedSkills
- selectedCapabilities
- SelectedCapabilityTrace

实际执行继续复用既有组件：

- runner
- tool-executor
- tool-scope
- required-tools-gate
- tool.permission
- MCP agent consumer

权限行为保持不变：

```text
permission = auto   → 允许自动执行
permission = confirm → 进入既有确认门
```

Capability Planner 只提出能力计划，不授予额外权限。

### 4.7 Trace Persistence

capability-trace-store.ts 将每次能力决策以 append-only JSONL 形式写入：

```text
.novel/capability-traces/trace.jsonl
```

核心记录字段包括：

```json
{
  "query": "用户原始请求",
  "intent": "识别后的意图",
  "retrieved": [],
  "filteredOut": [],
  "planned": [],
  "outcome": "success | failed | fallback"
}
```

Trace 覆盖：

- 成功规划并执行；
- 规划器不可用；
- 规划超时；
- 输出解析失败；
- DAG 验证失败；
- 规划为空；
- 降级到原有查表路径；
- 执行失败。

Trace 当前用于审计、诊断和数据积累，不代表 Capability Selector 或偏好学习已经启用。

## 5. Feature Gate

Capability Commander 仅在以下条件同时成立时启用：

```text
planExecuteEnabled === true && mode !== "fast"
```

行为矩阵：

| 条件 | 行为 |
|------|------|
| planExecuteEnabled = false | 使用原有确定性查表 |
| planExecuteEnabled = true 且 mode = fast | 使用原有确定性查表 |
| planExecuteEnabled = true 且非 fast | 进入 Capability Commander |
| Commander 规划失败 | 降级到原有确定性查表 |

当前复用已有 planExecuteEnabled 灰度开关。

若后续需要独立发布节奏，应迁移为：

```text
novelConfig.capabilityPlannerEnabled
```

该迁移不是本次决策的组成部分。

## 6. Failure and Fallback Policy

以下情况统一进入降级路径：

- 没有可用 LLM；
- streamChat 超时；
- LLM 返回空响应；
- JSON 解析失败；
- 规划结果为空；
- 规划包含候选集外能力；
- 节点 ID 重复；
- 依赖不存在；
- 检测到循环依赖；
- 节点数超过上限；
- 其他计划验证失败。

降级目标是原有的确定性技能查表。

降级必须满足：

- 不阻断写作请求；
- 不执行未验证的 LLM 计划；
- 保留 fallback trace；
- 对外维持原有 selectedSkills 契约；
- 在无 LLM 环境下保持开关启用前后的结果兼容。

这里的 fallback 是安全兼容路径，不是异常成功路径。

## 7. Security and Safety Boundaries

### 7.1 Closed-world capability selection

规划器只能选择 Rule Filter 后的能力候选集。

```text
planned capabilityId ∈ filtered candidate set
```

这防止 LLM：

- 发明虚构能力；
- 引用未注册工具；
- 选择未被召回的能力；
- 绕过能力来源限制。

### 7.2 Rule Filter before LLM

权限和场景限制在 LLM 调用前执行，而不是依赖提示词要求模型自行遵守。

这确保：

```text
LLM 可见能力集合 ⊆ 当前请求允许使用的能力集合
```

### 7.3 Permission remains authoritative

Planner 返回的 permission 不得扩大注册能力自身的权限。

最终执行权限以能力注册信息和既有执行门控为准。

规划器不能将需要确认的工具提升为自动执行。

### 7.4 Draft-first boundary

Capability DAG 属于候选执行草案。

只有经过：

- 候选集约束；
- DAG 验证；
- required-tools gate；
- permission gate；

才能进入实际执行。

## 8. Alternatives Considered

### 8.1 继续扩展确定性技能查表

未选择。

优点：延迟低；行为稳定；易于理解。

缺点：技能组合数量增长后维护成本高；无法表达动态依赖；难以处理复合写作请求；每新增能力都可能要求修改路由代码；无法形成通用能力决策数据。

原查表仍保留为 fast 路径和失败降级路径。

### 8.2 使用向量数据库召回

当前未选择。

原因：当前能力规模不要求额外向量基础设施；BM25 已存在且可直接复用；技能名称、标签和描述具有较高词法信息密度；BM25 离线、可复现、易测试；本阶段优先验证 Commander 闭环，而不是优化召回基础设施。

若未来能力规模或语义召回质量表明 BM25 不足，可评估复用现有 ANN 模块。

### 8.3 构建静态 Capability Graph

当前未选择。

原因：写作能力组合具有较强上下文依赖；静态边难以覆盖全部有效组合；现有 LLM planner 已能生成并验证 DAG；静态图可能增加双重维护成本。

注册能力仍可提供约束元数据，但不要求提前穷举全部能力依赖边。

### 8.4 引入新的 Agent Framework

未选择。

原因：现有系统已具备规划器、orchestrator、执行器、权限门控和检索模块；缺口集中在能力决策层；引入新框架会扩大迁移范围和运行时复杂度；无法证明重写优于现有组件重组。

## 9. Consequences

### 9.1 Positive

- select_skills 从技能查表器升级为 Capability Commander 的接入点；
- 支持根据请求动态组合多个能力；
- 支持表达能力之间的 DAG 依赖；
- 候选集限制降低 LLM 发明能力的风险；
- Rule Filter 在规划前建立硬边界；
- 既有权限门控继续生效；
- fast 模式不增加 LLM 规划延迟；
- 失败时可降级，主链兼容性保持；
- Trace 提供完整的检索、过滤、规划和结果证据；
- 不新增外部基础设施。

### 9.2 Negative

- 非 fast 模式增加一次 LLM 规划调用；
- 规划质量依赖能力描述和候选召回质量；
- 字段权重和 Top K 参数需要通过真实 trace 持续校准；
- JSONL 会随执行次数持续增长；
- Trace 可能包含用户请求内容，需要遵守现有本地数据管理边界；
- 复用 planExecuteEnabled 会将任务计划与能力计划的灰度语义绑定。

### 9.3 Neutral

- 原有确定性技能表不会立即删除；
- Task DAG 与 Capability DAG 将长期共存；
- Trace 数据积累本身不会自动改善模型；
- Capability Learning 需要单独的清洗、评估和上线决策。

## 10. Validation Evidence

本次实现已经完成以下验证：

```text
tsc --noEmit
→ 0 errors

vitest src/lib/agent/
→ 20 files
→ 175 passed
→ 8 skipped
```

覆盖范围包括：

- BM25 召回排序；
- 字段加权；
- mode 裁剪；
- intent 裁剪；
- allowedSources 裁剪；
- autoOnly 裁剪；
- Top K limit；
- 空候选边界；
- 规划器 JSON 解析容错；
- capabilityId 与 capability_id 兼容；
- 候选集外能力拒绝；
- 依赖存在性验证；
- DFS 循环依赖检测；
- 节点上限；
- 无 LLM 降级；
- 超时和解析失败降级；
- trace append；
- trace 读取；
- trace 改写；
- 损坏记录容错；
- trace 截断。

现有测试结果显示，Capability Commander 接入后未在 src/lib/agent/ 测试范围内产生回归。

## 11. Operational Observability

每次 Commander 决策应至少能够回答：

- 用户请求是什么；
- 被识别为什么 intent；
- BM25 召回了哪些能力；
- 哪些能力被规则过滤；
- 每个能力为什么被过滤；
- Planner 最终选择了哪些能力；
- 能力之间存在什么依赖；
- 是否触发 permission gate；
- 是否发生 fallback；
- 最终 outcome 是成功、失败还是降级。

Trace 是后续调参与学习的事实来源，不应仅依赖日志文本或模型解释。

## 12. Follow-up Decisions

以下事项不属于本次已完成范围，需要分别决策：

### 12.1 独立灰度开关

评估是否新增 `novelConfig.capabilityPlannerEnabled`，以解除能力规划与 planExecuteEnabled 的发布绑定。

### 12.2 Trace retention

定义 JSONL 最大尺寸、轮转策略、保留周期、手动清理接口、项目导出时是否包含 trace。

### 12.3 Privacy minimization

评估是否对 query 保存原文、保存摘要、保存哈希、对敏感字段进行脱敏。

### 12.4 Offline evaluation

建立离线评价指标，至少包括：retrieval recall、filtered candidate ratio、plan validity rate、fallback rate、permission escalation rejection、execution success rate、用户接受或人工修正情况。

### 12.5 Capability Selector

只有在 Trace 数量和质量满足要求后，才评估：基于历史成功链的重排、规则权重自动校准、BM25 与 ANN 混合召回、planner 候选链提示、离线偏好学习、小模型 Capability Selector。

Capability Selector 不得仅以执行成功作为唯一正样本。执行成功不等于能力选择最优。

## 13. Invariants

后续修改不得破坏以下约束：

- Planner 不得选择候选集外能力；
- Rule Filter 必须发生在 LLM 规划之前；
- Capability DAG 必须验证后才能执行；
- Planner 不得绕过实际 capability permission；
- fast 模式默认不调用 Capability Planner；
- Planner 失败不得阻断原有写作主链；
- fallback 必须被记录；
- Trace 持久化失败不得导致主要写作任务失败；
- Task DAG 与 Capability DAG 必须保持概念和类型边界；
- 未验证的历史 Trace 不得直接成为在线执行策略。

## 14. Final Outcome

本次决策补全了 QMAI / niko-buddy 的 Commander 决策层：

```text
Assess
  ↓
Retrieve
  ↓
Filter
  ↓
Decide
  ↓
Validate
  ↓
Dispatch
  ↓
Observe
```

系统由固定的技能路由机制升级为受约束的动态能力规划机制，同时保留确定性查表作为 fast 路径和安全降级路径。

当前完整状态为：

```text
Capability Registry
  + BM25 Retrieval
  + Rule-based Sandbox
  + Closed-world Capability Planning
  + DAG Validation
  + Permission-gated Execution
  + Persistent Decision Trace
```

这构成 Capability Commander 的首个完整闭环。
