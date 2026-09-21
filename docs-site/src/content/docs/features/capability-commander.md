---
title: 能力指挥（Capability Commander）
description: 智能能力发现、规划与追踪闭环（A-34）
---

# 🧭 能力指挥（Capability Commander）

自 v2.11.0 起，niko-buddy 的技能选择从「固定技能查表」升级为**受约束的能力规划**——系统能根据你的具体写作请求，自主组合出一条能力执行链。

## 工作链路

```
意图识别
  ↓
能力注册表（技能 / 工具 / MCP）
  ↓
BM25 语义召回（中文 bigram，Top-K 候选）
  ↓
规则过滤（模式/意图/来源/权限 硬裁剪）
  ↓
能力规划器（LLM 生成能力 DAG）
  ↓
DAG 校验（依赖无环、候选集内、上限约束）
  ↓
权限门控执行
  ↓
决策 trace 持久化
```

## 三层保障

- **能力沙箱**：规则过滤在调用 LLM **之前**执行——规划器只能看到当前请求允许使用的能力，不会把联网、写库等越界能力塞进计划。
- **封闭世界规划**：规划器输出的每个 `capabilityId` 都必须落在召回候选集内，**不能凭空发明能力**。
- **权限不可提升**：规划器提议的 `confirm` 能力仍需用户确认；它只"提议"，不授予额外权限。

## 降级与灰度

- **灰度开关**：`planExecuteEnabled` 开启且非 `fast` 模式时才走能力规划。
- **降级路径**：LLM 不可用、超时、解析失败、计划为空或校验不通过时，自动回退到原有的确定性技能查表，**写作主链不受影响**。
- **fast 模式**：不调用能力规划器，保持最低延迟。

## 决策追踪

每次能力决策以 append-only JSONL 记录在 `.novel/capability-traces/trace.jsonl`，包含：用户请求、识别意图、召回候选、被过滤能力及原因、最终能力链、执行结果（success / failed / fallback）。这些数据是后续能力学习与问题诊断的事实来源。

> 详见决策记录 `docs/decision-log/2026-09-21-capability-commander.md` 与架构约束 `.workflow/specs/architecture-constraints-capability-commander.md`。
