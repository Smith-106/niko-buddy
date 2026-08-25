# A-34 决策日志 — T19 反AI候选池 + TIER3_EXTENDED + 四统计因子

```yaml
date: 2026-08-24
task_id: TASK-P2-19
decision_type: feature
wave: W2-base
model: deepseek-v4-flash
verified: vitest 全绿（mechanical-slop/de-ai-rules/anti-ai-candidate-pool）+ tsc 0 错
```

## 决策

1. **TIER3_EXTENDED**：mechanical-slop-detector.ts 词库 23→48 条正则（AI 心理描写模板/叙事模板/对白模板/商战腔），spec 断言范围同步 10-20→40-60。
2. **de-ai-rules.ts 增强挂载非重建**：结构化规则 28→42 条（新增 14 条统计检测规则：标点指纹/n-gram/段落分布/句式熵 ×7 类别）；F-009 的 112 词三档表原样保留。
3. **anti-ai-candidate-pool.ts 新建**：中文语料候选池（加载 docs/p0/corpus/{human,ai} 语料）+ mutation testing（采纳 avoid-ai 严谨性）。
4. **四统计因子 warn 态**：n-gram 重合度 / 句式熵 / 标点指纹 / 段落长度分布——标定前只 warn 不 block，符合门控优先级 Consistency(P0)>Anti-AI(P1)>Quality(P2)。
5. **标定来源声明**：`source: "synthetic-degraded"` 入 report 元数据——基于种子语料的结论不得用于发版宣称。

## 边界

- pack 文件层归 T24 独建；本任务只建候选池与检测器。

## 主 agent 复核注记（2026-08-24）

- 清理 WIP 死脚手架：未消费的句长/段落长度缓存字段与对应 compute 函数、字符级 n-gram 死函数（检测器内联重算，字段从未被读）。
