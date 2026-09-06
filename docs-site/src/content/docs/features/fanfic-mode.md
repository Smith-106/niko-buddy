---
title: 同人模式
description: 同人四模式机械校验（canon/au/ooc/cp）与正典合并导入器（Draft-first）
---

# 🎭 同人模式

同人模式（v2.7.8，64 号实施）为同人创作提供**四模式机械校验**与**正典合并导入器**，全部确定性规则零 LLM。

## 四模式语义

| 模式 | 规则 |
|---|---|
| `canon` | 正典名册锁：禁止把角色写成新身份（性格锁被否定改写 → `fanfic_canon_lock` error） |
| `au` | 设定分叉白名单：`auDeviations` 并入 `allowedDeviations` 后跑词面检测（人设锁仍生效） |
| `ooc` | 命中性格锁必须显式 OOC 标记（`(OOC)` / `（OOC）` / `【OOC】`…），否则 `fanfic_ooc_unmarked` error |
| `cp` | 配对双方必须同时出现，缺一方 → `fanfic_cp_missing_pair` warn（群像章不误杀） |

规则引擎：`validateFanficChapter`（四模式确定性规则 + 既有词面校验叠加）；prompt 注入：`bookRulesToPromptFragment` 按模式输出约束段。

## 正典合并导入器

- `proposeCanonMerge`：源书拆书角色 vs 目标书正典名册**确定性匹配**（重名 → `bind_existing`；新名 → `create_new`；源内多名同现 → `skip` + conflict）
- **Draft-first**：合并提案落 `.novel/fanfic-merge-pending.json`，accept 前不写正式 wiki
- 与项目医生联动：悬挂提案在 doctor 诊断中显示 warn（fanfic-merge-pending 检查项）

## 主路径

1. 设置 `fanficMode`（book-rules 配置）
2. 生成合并提案（拆书库 → 正典名册匹配）
3. 审阅提案（pending 工件）→ accept 后回填正式 wiki
4. 写作期：每章校验四模式约束（error 阻断 / warn 提示）
