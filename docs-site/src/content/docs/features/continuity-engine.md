---
title: 确定性连续性引擎
description: 零 LLM 机械层连续性预检
---

# 🔗 确定性连续性引擎

**v2.4.0+ 引入。** 零 LLM 的机械层连续性预检引擎，双层挂载在生成层与审查层之间，在 LLM 审查之前用确定性规则捕捉结构性连续性断裂。

## 双维度检测

- **角色缺席检测**（`detectAbsentCharacter`）：角色超过阈值章节未出场则报警
- **支线休眠检测**（`detectDormantThread`）：未 resolved 的 subplot 长期无推进则报警

## 情绪账本（emotion-ledger）

追踪角色情绪弧线变化，在生成层前置注入，防止角色情绪在章节间不合理跳变。

## 机械 AI 味检测（mechanical-slop-detector）

词库命中式 AI 味打分，在审查层前置惩罚。检测"标准化"模板化表达，识别哪些片段写得像 AI。

## 阈值校准

absent 与 dormant 的阈值经**真实中文长篇样本**校准：

- `absentThresholdChapters`：5 → 7（312 样本 P75 统计）
- `dormantThresholdChapters`：3 → 10（753 样本 P75 统计）

校准脚本 `scripts/calibrate-from-epub.mjs` 从真实章节文本统计，替换占位默认值，使阈值贴合中文长篇实际节奏。

## 机械层的能力边界

机械层能可靠做 **防退化与检测**，不能可靠做 **正向选优与语义判定**：

- ✅ fix-loop 候选选择能做防退化（当前 slop 高于前版 + 阈值则回退）
- ❌ 真正 Elo 选优需要 LLM judge（slop 低不等于质量高，deferred 交 LLM）
- ✅ P14 画像进化能做字段 === diff（字段值变化检测）
- ❌ 语义风格漂移检测需要语义比对（deferred 交 LLM）
- ✅ slop 检测能做 AI 味词库命中
- ❌ 质量评估（slop 低 ≠ 写得好）

超出机械层能力的部分标 deferred 交 LLM 审查层，不模糊边界。

## 门控优先级

整个审查体系遵循固定优先级：**Consistency（一致性，P0）> Anti-AI（去 AI 味，P1）> Quality（质量，P2）**。

- Consistency 失败必须修复，Quality pass 不能覆盖 Consistency fail
- 机械层检测先于语义层，机械层 fail 则短路不调语义层
- Quality 失败可降级为 warning 并标记 `quality_debt`
