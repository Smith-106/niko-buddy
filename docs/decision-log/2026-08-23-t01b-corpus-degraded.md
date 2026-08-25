# A-34 决策日志 — T01b 受控降级轨点火（synthetic-degraded 语料）

```yaml
date: 2026-08-23
task_id: TASK-P0-02 / TASK-P0-03（受控降级部分）
decision_type: process
wave: W1-launch
model: deepseek-v4-flash
verified: human 30 + ai 30 + gold 6 + MANIFEST.md + manifest.json(66 条) 落盘
```

## 决策

按 roadmap 三模型共识执行 T01b 受控降级：

1. **种子语料**：`docs/p0/corpus/{human,ai}/batch-20260821-001/` 各 30 篇（言情/古风/玄幻 各 10），每篇 300-800 字，全部标记 `synthetic-degraded`。
2. **黄金集雏形**：`docs/p0/corpus/gold/batch-20260821-001/` 每类型 2 篇标注反 AI 特征点，作为 P2-19 种子评测集。
3. **解锁语义**：种子语料仅解锁 P2-19 开工（标定前 warn 不阻塞）；P2-20 block 阈值标定仍等真实语料成熟。
4. **人工采集不终止**：≥100 授权中文人写 + ≥100 AI 的真实采集继续后台推进；成熟后增量重标定并重跑 P2-20。

## 版权安全

- 人写模拟库：自写高质量模拟文本 + 参考项目池内已授权内容提取。
- manifest 记录来源与字数，可追溯。

## 风险声明

- synthetic-degraded 语料上的任何标定结论不得作为产品发版的 anti-AI 效果宣称依据（Track L9/T36 审查时须核验语料成熟度）。
