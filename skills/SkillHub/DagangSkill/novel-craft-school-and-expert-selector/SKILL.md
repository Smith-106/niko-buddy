---
name: novel-craft-school-and-expert-selector
description: "写作专家、大写作手法与角色体系自适应配装总控：新书立项、切换分卷风格、或不确定该启用哪些 Skills/Rules 时调用；按题材、阶段与叙事基调自动推荐最优专家+大手法+角色框架组合并规避风格冲突。"
---

# 自适应配装总控 · 写作专家 / 角色设定 / 大手法选型矩阵

## 何时使用
- 新书开坑立项、确立全书核心风格与写作配方时；
- 写到特殊章节（如突然需要写一场密室智斗、一场深度电影感离别戏、或一章解压轻喜剧过渡）需要临时切换副专家与手法时；
- 在 `niko-buddy`「设置 → 小说设置 → 任务提示词与技能」配置某本书专属技能名单时。

## 一、八大预设流派配装矩阵（直接按题材选型）

| 配方 ID | 流派名称 | 适配题材 | 主写作专家 | 辅专家 / 手法组合 | 角色设定核心 | 互斥避坑 |
|---|---|---|---|---|---|---|
| `cuttlefish-mystery` | **诡秘硬核设定流** | 克苏鲁/维多利亚/蒸汽奇幻/体系悬疑 | `expert-cuttlefish-hard-world-mystery` | `craft-multi-pov-and-information-asymmetry` + `craft-power-economy-and-map-escalation` | `character-ensemble-ecology-and-chemistry` + `novel-dual-kb-research-and-injection` | 禁混 `expert-subversive-comedy-chemistry` |
| `fox-folk-horror` | **道诡民俗异化流** | 中式民俗恐怖/暗黑修仙/规则怪谈 | `expert-fox-unreliable-sensory-horror` | `craft-cinematic-blocking-and-sensory-immersion` + `craft-foreshadowing-web-and-multi-twist` | `character-archetypes-and-flaw-engines` (A5) + `novel-ghost-wound-and-wish-motive-chain` | 禁混轻喜剧与甜宠吐槽 |
| `deathgame-智斗` (`deathgame-puzzle`) | **十日智斗循环流** | 死亡游戏/无限流/推理博弈/时间循环 | `expert-deathgame-puzzle-escalation` | `craft-foreshadowing-web-and-multi-twist` + `craft-multi-pov-and-information-asymmetry` | `character-ensemble-ecology-and-chemistry` + `character-antagonist-mirror-and-pressure` | 禁无铺垫机械降神 |
| `commercial-thrill` | **商业网文极致节奏流** | 玄幻修仙/都市高武/系统/现实讽刺爽文 | `expert-commercial-pacing-hook-master` | `novel-thrill-loop-delay-pacing` + `craft-power-economy-and-map-escalation` | `character-antagonist-mirror-and-pressure` + `character-archetypes-and-flaw-engines` (A1/A4/A7) | 禁前 3 章静态灌设定 |
| `female-emotion-arc` | **女频细腻拉扯与反杀流** | 重生复仇/豪门世情/古言宅斗/情感张力 | `expert-iceberg-dramatic-subtext` + `expert-commercial-pacing-hook-master` | `craft-emotional-catapult-and-midbook-recovery` + `craft-cinematic-blocking-and-sensory-immersion` | `character-archetypes-and-flaw-engines` (A3) + `character-voice-fingerprint-and-micro-actions` | 禁憋屈圣母与廉价咆哮 |
| `literary-wuxia-history` | **古风群像与历史正剧流** | 历史权谋/传统武侠/现实主义史诗 | `expert-iceberg-dramatic-subtext` | `craft-cinematic-blocking-and-sensory-immersion` + `craft-multi-pov-and-information-asymmetry` | `character-ensemble-ecology-and-chemistry` + `character-voice-fingerprint-and-micro-actions` + `novel-dual-kb-research-and-injection` | 禁现代网络热梗串味 |
| `subversive-comedy` | **反套路脱力轻喜剧流** | 异世界轻喜/沙雕群像/日常反套路 | `expert-subversive-comedy-chemistry` | `novel-thrill-loop-delay-pacing` + `craft-emotional-catapult-and-midbook-recovery` | `character-ensemble-ecology-and-chemistry` + `character-archetypes-and-flaw-engines` (A4) | 禁纯玩烂梗丢掉人物逻辑 |
| `rezero-despair-break` | **高压虐转爽史诗流** | 死亡回归/低魔逆袭/热血绝境破局 | `expert-iceberg-dramatic-subtext` | `craft-emotional-catapult-and-midbook-recovery` + `craft-foreshadowing-web-and-multi-twist` | `character-archetypes-and-flaw-engines` (A6) + `character-antagonist-mirror-and-pressure` | 禁连续压抑 > 2 章无微光 |

## 二、按「当前创作阶段」的动态配装步骤
1. **确认基础底座（永不关闭）**：P0 `novel-continuity-p0-gate-audit` > P1 `detect-ai-flavor-nine-signals` + `anti-ai-polish` > P2 `novel-finale-three-precepts-audit`（终局章必开）。
2. **锁定单书主配方**：从上表选 1 套主配方（可配合 `node scripts/apply-craft-preset.mjs --apply <id> --project <目录>` 一键写入项目）。
3. **单章临时微调上限**：每章正文同时仅保留 **1 位主专家 + ≤ 2 个大手法 + 1 套角色焦点**，绝不同时开启超过 2 位不同流派的写作专家。
4. **叠加角色灵魂（`skills/soulskill/`）**：为具体人物按气质绑定 `niko-buddy` 角色灵魂（如算账守底线参考 `chen-pingan-perspective`、权谋深沉参考 `cao-cao-perspective` / `zhang-liang-perspective`、冷峻讽刺参考 `lu-xun-perspective`、世情精明参考 `wang-xifeng-perspective`）。

## 绝对禁止项
- 禁止在同一章节把冲突专家（如民俗恐怖 + 脱力喜剧）无过渡硬拼在一起。
- 禁止在最终小说正文中输出本选型表或任何 Skill 名称。
