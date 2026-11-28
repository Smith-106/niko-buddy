#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
/**
 * export-nmem-to-niko-buddy.mjs — Nowledge Mem 小说创作 Skills、Rules 与自适应流派配方一键导出器。
 *
 * 职责：
 *   从 Nowledge Mem（本地或远程 v0.10.124+）拉取活跃小说创作 Skills 与 `space` 核心 Rules，
 *   按 `niko-buddy` 原生契约生成模块化可自由选配的产物（严格遵守 `pack-format.ts` 单包 ≤ 64 条限制）：
 *     1. `linked-skills/<slug>/SKILL.md` + `linked-skills-config-snippet.json`（供 `source: "linked"` 热更新）
 *     2. `packs/*.nbskill.json`（按专题拆分且自动防超限的单文件技能包）：
 *        - `nmem-novel-core-engine.nbskill.json`（核心门禁 + 自适应配装总控）
 *        - `nmem-novel-writing-experts.nbskill.json`（10 位可选写作专家流派）
 *        - `nmem-novel-character-systems.nbskill.json`（多样化角色设定、关系羁绊、退场与黑化系统）
 *        - `nmem-novel-major-crafts.nbskill.json`（九大支柱级大写作手法 + 叙事/场景专题）
 *        - `nmem-novel-space-rules.nbskill.json`（全部活跃 `space` 写作硬规则）
 *        - `nmem-novel-full-craft.nbskill.json`（若总数 > 64 则自动拆为 `part1`/`part2`，零丢弃）
 *     3. `craft-presets.json`（12 套经过互斥冲突消解的开箱流派配方，配 `scripts/apply-craft-preset.mjs` 使用）
 *     4. `de-ai-skill.txt`（融合内置 12 硬门槛 + `ai-prose-review-15` 双锚 + `detect-ai-flavor-nine-signals`）
 *     5. `DEDUP-AND-USAGE-GUIDE.md`（流派选型手册 + 与仓内 SkillHub 逐条去重对照）
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { deflateRawSync } from "node:zlib"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "..")
const MAX_PROMPTS_PER_PACK = 256
const PACKAGE_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"))
    return String(pkg?.version || "2.32.0")
  } catch {
    return "2.32.0"
  }
})()

// 非小说创作的工程/量化/工具类 Skill，默认不混入小说写作包
const NON_NOVEL_SKILL_SLUGS = new Set([
  "batch-pdf-extract-pipeline",
  "maestro-kg-index-first",
  "rules-gate-generation",
  "configure-nmem-workspace",
  "quant-challenger-acceptance",
  "tasktype-expert-routing",
  "long-session-compact-resume",
  "multi-model-role-review",
])

const MANGA_ONLY_SLUGS = new Set(["manga-visual-pacing-transition-pages"])

// 核心引擎 + 配装总控
const CORE_ENGINE_SKILL_SLUGS = new Set([
  "novel-craft-school-and-expert-selector",
  "novel-continuity-p0-gate-audit",
  "novel-thrill-loop-delay-pacing",
  "novel-ghost-wound-and-wish-motive-chain",
  "novel-finale-three-precepts-audit",
  "novel-dual-kb-research-and-injection",
  "detect-ai-flavor-nine-signals",
  "aigc-platform-compliance-kit",
])

// 10 位可选写作专家流派
const WRITING_EXPERT_SLUGS = new Set([
  "expert-cuttlefish-hard-world-mystery",
  "expert-fox-unreliable-sensory-horror",
  "expert-deathgame-puzzle-escalation",
  "expert-iceberg-dramatic-subtext",
  "expert-commercial-pacing-hook-master",
  "expert-subversive-comedy-chemistry",
  "expert-satirical-capitalist-cultivation",
  "expert-mortal-steadfast-cultivation",
  "expert-maoni-court-epigram-epic",
  "expert-fenghuo-lyric-jianghu-ensemble",
])

// 多样化角色设定与弧光系统包
const CHARACTER_SYSTEM_SLUGS = new Set([
  "character-ensemble-ecology-and-chemistry",
  "character-archetypes-and-flaw-engines",
  "character-antagonist-mirror-and-pressure",
  "character-voice-fingerprint-and-micro-actions",
  "character-romance-tension-and-bonds",
  "character-graceful-exit-and-legacy-arc",
  "character-darkening-and-corruption-arc",
  "novel-ghost-wound-and-wish-motive-chain",
  "shape-characters-and-environments-with-significant-details",
  "design-protagonist-onion-layering-likability",
  "design-antagonist",
  "define-stereoscopic-characters-via-core-traits-and-contradiction",
  "write-character-biography-and-research",
  "drive-plot-with-relationship-four-elements",
  "time-modes-for-character-depth",
])

// 九大支柱级大写作手法专题包
const MAJOR_CRAFT_SLUGS = new Set([
  "craft-multi-pov-and-information-asymmetry",
  "craft-foreshadowing-web-and-multi-twist",
  "craft-power-economy-and-map-escalation",
  "craft-cinematic-blocking-and-sensory-immersion",
  "craft-emotional-catapult-and-midbook-recovery",
  "craft-faction-politics-and-conspiracy",
  "craft-combat-tactics-and-terrain-chess",
  "craft-dialogue-sparring-and-status-play",
  "craft-flashback-timejump-and-cold-open",
  "novel-thrill-loop-delay-pacing",
  "write-strong-opening-with-resonance-levers",
  "edit-minded-opening-structure-writing",
  "create-suspense-with-story-problem-and-time-fuse",
  "write-vivid-scenes-with-conflict-rhyming",
  "rebuild-narrative-scene-with-lens-and-evidence",
  "transform-reference-material-into-scenes",
  "calibrate-scene-realism-with-body-chemistry",
  "write-dialogue-with-subtext-layers",
  "diagnose-scene-subtext",
  "worldbuilding-detail-reveal",
  "bury-climax-skills-rhythm-forks",
  "reverse-plot-from-ending",
  "rearrange-scene-structure-with-cards",
  "craft-opening-hook-promise-and-inciting-incident",
  "craft-scene-sequel-beats-and-pov-discipline",
  "craft-mystery-clue-fairplay-and-red-herring",
  "craft-worldview-coherence-and-belief-arc",
  "craft-midbook-midpoint-and-climax-architecture",
  "craft-self-editing-revision-and-prose-tightening",
  "craft-emotional-tension-and-crisis-escalation",
])

// 12 套经过互斥消解的开箱流派配装配方（供 apply-craft-preset.mjs 与写作选型使用）
const CRAFT_PRESETS = [
  {
    id: "satirical-xiuxian",
    name: "现实痛点黑色讽刺修仙流（租赁/KPI/赛博修仙）",
    genres: ["现代讽刺修仙", "赛博仙侠", "系统反套路", "底层社畜逆袭"],
    tone: "仙侠口语脆爽、荒诞冰冷合同术语、精明算账卡漏洞反杀、黑色幽默",
    primaryExpert: "expert-satirical-capitalist-cultivation",
    secondaryExpert: "expert-commercial-pacing-hook-master",
    craftSkills: [
      "craft-dialogue-sparring-and-status-play",
      "craft-power-economy-and-map-escalation",
      "novel-thrill-loop-delay-pacing",
      "craft-opening-hook-promise-and-inciting-incident",
    ],
    characterSkills: [
      "character-archetypes-and-flaw-engines",
      "character-antagonist-mirror-and-pressure",
      "character-voice-fingerprint-and-micro-actions",
    ],
    suggestedSoulSkills: ["chen-pingan-perspective", "fan-xian-perspective", "lv-shu-perspective"],
    coreRules: [
      "novel-craft-school-adaptive-routing",
      "novel-power-system-cost-and-ecology",
      "novel-dialogue-status-and-subtext-turn",
      "novel-thrill-pacing-delay-curve",
      "ai-prose-review-15",
    ],
    avoidExperts: ["expert-fox-unreliable-sensory-horror", "expert-fenghuo-lyric-jianghu-ensemble"],
    taskSkillNames: {
      outline: [
        "novel-craft-school-and-expert-selector",
        "craft-power-economy-and-map-escalation",
        "novel-thrill-loop-delay-pacing",
        "craft-opening-hook-promise-and-inciting-incident",
      ],
      writing: [
        "long-form-drafting",
        "expert-satirical-capitalist-cultivation",
        "craft-dialogue-sparring-and-status-play",
        "craft-flashback-timejump-and-cold-open",
      ],
      review: [
        "novel-continuity-p0-gate-audit",
        "detect-ai-flavor-nine-signals",
        "aigc-platform-compliance-kit",
        "craft-self-editing-revision-and-prose-tightening",
      ],
    },
    extraPromptHint:
      "保持仙侠口语脆爽，去AI味；把剥削规则落到具体契约条款、租金账目与漏洞反制上，沿用前文人物口癖与契约术语。",
  },
  {
    id: "mortal-cultivation",
    name: "凡人苟道稳健长生流（资源精算/暗手保命）",
    genres: ["凡人流修仙", "苟道长生", "散修求生", "宗门经营换地图"],
    tone: "冷静权衡、深藏底牌、灵石丹药精算、善后抹痕、以时间复利熬死风暴",
    primaryExpert: "expert-mortal-steadfast-cultivation",
    secondaryExpert: "expert-cuttlefish-hard-world-mystery",
    craftSkills: [
      "craft-power-economy-and-map-escalation",
      "craft-combat-tactics-and-terrain-chess",
      "craft-flashback-timejump-and-cold-open",
      "craft-worldview-coherence-and-belief-arc",
    ],
    characterSkills: [
      "character-archetypes-and-flaw-engines",
      "character-graceful-exit-and-legacy-arc",
      "character-antagonist-mirror-and-pressure",
    ],
    suggestedSoulSkills: ["han-fei-perspective", "zhang-liang-perspective", "charlie-munger-perspective"],
    coreRules: [
      "novel-craft-school-adaptive-routing",
      "novel-power-system-cost-and-ecology",
      "novel-combat-cost-and-information-win",
      "novel-flashback-restraint-and-scene-entry",
      "novel-continuity-p0-hard-gate",
    ],
    avoidExperts: ["expert-subversive-comedy-chemistry", "expert-fox-unreliable-sensory-horror"],
    taskSkillNames: {
      outline: [
        "novel-craft-school-and-expert-selector",
        "craft-power-economy-and-map-escalation",
        "novel-continuity-p0-gate-audit",
        "craft-worldview-coherence-and-belief-arc",
      ],
      writing: [
        "long-form-drafting",
        "expert-mortal-steadfast-cultivation",
        "craft-combat-tactics-and-terrain-chess",
        "craft-flashback-timejump-and-cold-open",
        "craft-scene-sequel-beats-and-pov-discipline",
      ],
      review: [
        "novel-continuity-p0-gate-audit",
        "detect-ai-flavor-nine-signals",
        "novel-finale-three-precepts-audit",
      ],
    },
    extraPromptHint:
      "主角对外展露战力控制在五成以内；遇事先算风险与退路，战斗重地形与预案耗敌，大跨度闭关用物候切片一笔跳过。",
  },
  {
    id: "cuttlefish-mystery",
    name: "诡秘硬核设定流（乌贼/维多利亚神秘学）",
    genres: ["西方奇幻", "克苏鲁", "蒸汽维多利亚", "硬核体系悬疑", "幕后黑手"],
    tone: "慢热厚重、冷静克制、强设定与多势力信息差博弈、生活细节考据质感",
    primaryExpert: "expert-cuttlefish-hard-world-mystery",
    secondaryExpert: "expert-iceberg-dramatic-subtext",
    craftSkills: [
      "craft-multi-pov-and-information-asymmetry",
      "craft-power-economy-and-map-escalation",
      "craft-foreshadowing-web-and-multi-twist",
      "craft-worldview-coherence-and-belief-arc",
      "craft-mystery-clue-fairplay-and-red-herring",
    ],
    characterSkills: [
      "character-ensemble-ecology-and-chemistry",
      "character-voice-fingerprint-and-micro-actions",
      "novel-dual-kb-research-and-injection",
    ],
    suggestedSoulSkills: ["zhang-liang-perspective", "han-fei-perspective", "charlie-munger-perspective"],
    coreRules: [
      "novel-craft-school-adaptive-routing",
      "novel-continuity-p0-hard-gate",
      "novel-power-system-cost-and-ecology",
      "novel-information-asymmetry-and-pov-gate",
      "novel-kb-routing-contract",
    ],
    avoidExperts: ["expert-subversive-comedy-chemistry", "expert-fox-unreliable-sensory-horror"],
    taskSkillNames: {
      outline: [
        "novel-craft-school-and-expert-selector",
        "craft-power-economy-and-map-escalation",
        "craft-foreshadowing-web-and-multi-twist",
        "novel-dual-kb-research-and-injection",
        "craft-worldview-coherence-and-belief-arc",
        "craft-mystery-clue-fairplay-and-red-herring",
      ],
      writing: [
        "long-form-drafting",
        "expert-cuttlefish-hard-world-mystery",
        "craft-multi-pov-and-information-asymmetry",
        "craft-cinematic-blocking-and-sensory-immersion",
        "craft-scene-sequel-beats-and-pov-discipline",
      ],
      review: [
        "novel-continuity-p0-gate-audit",
        "detect-ai-flavor-nine-signals",
        "novel-finale-three-precepts-audit",
        "craft-self-editing-revision-and-prose-tightening",
      ],
    },
    extraPromptHint:
      "超凡能力须体现代价与扮演内化；时代背景通过货币、饮食、物件、报刊切片自然透出；多用信息差与克制潜台词，禁全知科普。",
  },
  {
    id: "fox-folk-horror",
    name: "道诡民俗异化流（不可靠叙述/中式恐怖）",
    genres: ["中式民俗恐怖", "暗黑修仙", "规则怪谈", "双世界精神异化", "黑暗悬疑"],
    tone: "认知撕裂、痛觉与嗅觉压迫、喜庆符号扭曲、泥泞中的微弱人性执念",
    primaryExpert: "expert-fox-unreliable-sensory-horror",
    secondaryExpert: "expert-iceberg-dramatic-subtext",
    craftSkills: [
      "craft-cinematic-blocking-and-sensory-immersion",
      "craft-foreshadowing-web-and-multi-twist",
      "craft-combat-tactics-and-terrain-chess",
      "craft-worldview-coherence-and-belief-arc",
      "craft-emotional-tension-and-crisis-escalation",
    ],
    characterSkills: [
      "character-archetypes-and-flaw-engines",
      "character-darkening-and-corruption-arc",
      "novel-ghost-wound-and-wish-motive-chain",
    ],
    suggestedSoulSkills: ["lu-xun-perspective", "zhuang-zi-perspective"],
    coreRules: [
      "novel-craft-school-adaptive-routing",
      "novel-cinematic-show-dont-tell-gate",
      "novel-emotional-curve-and-antimelodrama",
      "novel-continuity-p0-hard-gate",
    ],
    avoidExperts: ["expert-subversive-comedy-chemistry", "expert-commercial-pacing-hook-master"],
    taskSkillNames: {
      outline: [
        "novel-craft-school-and-expert-selector",
        "craft-foreshadowing-web-and-multi-twist",
        "novel-ghost-wound-and-wish-motive-chain",
        "craft-worldview-coherence-and-belief-arc",
      ],
      writing: [
        "long-form-drafting",
        "expert-fox-unreliable-sensory-horror",
        "craft-cinematic-blocking-and-sensory-immersion",
        "craft-scene-sequel-beats-and-pov-discipline",
        "craft-emotional-tension-and-crisis-escalation",
      ],
      review: [
        "novel-continuity-p0-gate-audit",
        "detect-ai-flavor-nine-signals",
      ],
    },
    extraPromptHint:
      "用日常符号的 10% 致命错位与生理级非视觉感官（嗅觉/痛觉/温差）制造恐怖；严禁廉价恐怖形容词与出戏网络吐槽。",
  },
  {
    id: "deathgame-puzzle",
    name: "十日智斗悬疑博弈流（死亡游戏/无限流/都市暗战）",
    genres: ["死亡游戏", "无限流副本", "时间循环", "高智商博弈", "都市悬疑动作"],
    tone: "规则清晰高压、死局倒计时、伏笔接力、地形对抗与公平多重反转",
    primaryExpert: "expert-deathgame-puzzle-escalation",
    secondaryExpert: "expert-commercial-pacing-hook-master",
    craftSkills: [
      "craft-foreshadowing-web-and-multi-twist",
      "craft-multi-pov-and-information-asymmetry",
      "craft-combat-tactics-and-terrain-chess",
      "craft-mystery-clue-fairplay-and-red-herring",
      "craft-midbook-midpoint-and-climax-architecture",
      "craft-emotional-tension-and-crisis-escalation",
    ],
    characterSkills: [
      "character-ensemble-ecology-and-chemistry",
      "character-antagonist-mirror-and-pressure",
      "character-voice-fingerprint-and-micro-actions",
    ],
    suggestedSoulSkills: ["han-fei-perspective", "zhuge-liang-perspective", "cao-cao-perspective"],
    coreRules: [
      "novel-craft-school-adaptive-routing",
      "novel-continuity-p0-hard-gate",
      "novel-information-asymmetry-and-pov-gate",
      "novel-combat-cost-and-information-win",
      "novel-character-voice-and-flaw-consistency",
    ],
    avoidExperts: ["expert-subversive-comedy-chemistry"],
    taskSkillNames: {
      outline: [
        "novel-craft-school-and-expert-selector",
        "expert-deathgame-puzzle-escalation",
        "craft-foreshadowing-web-and-multi-twist",
        "craft-mystery-clue-fairplay-and-red-herring",
        "craft-midbook-midpoint-and-climax-architecture",
      ],
      writing: [
        "long-form-drafting",
        "expert-deathgame-puzzle-escalation",
        "craft-combat-tactics-and-terrain-chess",
        "character-voice-fingerprint-and-micro-actions",
        "craft-scene-sequel-beats-and-pov-discipline",
        "craft-emotional-tension-and-crisis-escalation",
      ],
      review: [
        "novel-continuity-p0-gate-audit",
        "detect-ai-flavor-nine-signals",
        "novel-finale-three-precepts-audit",
        "craft-self-editing-revision-and-prose-tightening",
      ],
    },
    extraPromptHint:
      "规则与倒计时前置透明；动作战重地形视野与伤痛成本，拒绝机械重复微动作标签（如高频指节发白/夜色如墨）；大反转须 ≥2 处前置物理线索。",
  },
  {
    id: "maoni-court-epigram",
    name: "庙堂江湖哲思毒舌流（猫腻/权谋书院风）",
    genres: ["架空权谋历史", "庙堂朝争", "大男主成长史诗", "思想交锋群像"],
    tone: "松弛毒舌日常与突然拔刀立意强烈反差，礼法体面背后见刀斧与理想微光",
    primaryExpert: "expert-maoni-court-epigram-epic",
    secondaryExpert: "expert-iceberg-dramatic-subtext",
    craftSkills: [
      "craft-faction-politics-and-conspiracy",
      "craft-dialogue-sparring-and-status-play",
      "craft-multi-pov-and-information-asymmetry",
      "craft-midbook-midpoint-and-climax-architecture",
    ],
    characterSkills: [
      "character-ensemble-ecology-and-chemistry",
      "character-graceful-exit-and-legacy-arc",
      "character-voice-fingerprint-and-micro-actions",
    ],
    suggestedSoulSkills: ["fan-xian-perspective", "su-shi-perspective", "zhang-liang-perspective"],
    coreRules: [
      "novel-craft-school-adaptive-routing",
      "novel-faction-agency-and-positive-sum-conspiracy",
      "novel-dialogue-status-and-subtext-turn",
      "novel-emotional-curve-and-antimelodrama",
    ],
    avoidExperts: ["expert-fox-unreliable-sensory-horror"],
    taskSkillNames: {
      outline: [
        "novel-craft-school-and-expert-selector",
        "craft-faction-politics-and-conspiracy",
        "character-ensemble-ecology-and-chemistry",
        "craft-midbook-midpoint-and-climax-architecture",
      ],
      writing: [
        "long-form-drafting",
        "expert-maoni-court-epigram-epic",
        "craft-dialogue-sparring-and-status-play",
        "character-voice-fingerprint-and-micro-actions",
        "craft-scene-sequel-beats-and-pov-discipline",
      ],
      review: [
        "novel-continuity-p0-gate-audit",
        "detect-ai-flavor-nine-signals",
        "novel-finale-three-precepts-audit",
        "craft-self-editing-revision-and-prose-tightening",
      ],
    },
    extraPromptHint:
      "权谋重阳谋二选一与利益制衡；对白兼顾松弛机锋与紧要关头的骨气锋芒；金句必须蓄满日常事实后轻落收束。",
  },
  {
    id: "fenghuo-jianghu-epic",
    name: "诗意江湖与宏大群像流（烽火/剑来武侠史诗）",
    genres: ["新派武侠江湖", "仙侠剑气群像", "历史边塞风云", "宗师落幕史诗"],
    tone: "大小人物同台生辉、文白顿挫气魄与泥土烟火锚点、问道理与因果承负",
    primaryExpert: "expert-fenghuo-lyric-jianghu-ensemble",
    secondaryExpert: "expert-iceberg-dramatic-subtext",
    craftSkills: [
      "craft-combat-tactics-and-terrain-chess",
      "craft-faction-politics-and-conspiracy",
      "craft-cinematic-blocking-and-sensory-immersion",
      "craft-worldview-coherence-and-belief-arc",
      "craft-emotional-tension-and-crisis-escalation",
    ],
    characterSkills: [
      "character-graceful-exit-and-legacy-arc",
      "character-ensemble-ecology-and-chemistry",
      "novel-ghost-wound-and-wish-motive-chain",
    ],
    suggestedSoulSkills: ["chen-pingan-perspective", "xiao-feng-perspective", "li-bai-perspective"],
    coreRules: [
      "novel-craft-school-adaptive-routing",
      "novel-cinematic-show-dont-tell-gate",
      "novel-emotional-curve-and-antimelodrama",
      "novel-combat-cost-and-information-win",
    ],
    avoidExperts: ["expert-subversive-comedy-chemistry", "expert-satirical-capitalist-cultivation"],
    taskSkillNames: {
      outline: [
        "novel-craft-school-and-expert-selector",
        "character-graceful-exit-and-legacy-arc",
        "craft-faction-politics-and-conspiracy",
        "craft-worldview-coherence-and-belief-arc",
      ],
      writing: [
        "long-form-drafting",
        "expert-fenghuo-lyric-jianghu-ensemble",
        "craft-combat-tactics-and-terrain-chess",
        "craft-cinematic-blocking-and-sensory-immersion",
        "craft-emotional-tension-and-crisis-escalation",
      ],
      review: [
        "novel-continuity-p0-gate-audit",
        "detect-ai-flavor-nine-signals",
        "novel-finale-three-precepts-audit",
        "craft-self-editing-revision-and-prose-tightening",
      ],
    },
    extraPromptHint:
      "出剑前先交代因果债与各自道理；宏大意象旁须配泥土烟火细节锚点；重要配角退场做到微小愿望前置 + 压低音量留白。",
  },
  {
    id: "commercial-thrill",
    name: "商业网文极致节奏流（高留存升级爽文）",
    genres: ["男频玄幻修仙", "都市高武", "系统流", "起点/番茄商业连载"],
    tone: "开篇快钩、期待感阶梯拉满、先抑后扬不憋屈、实打实战利品与强断章",
    primaryExpert: "expert-commercial-pacing-hook-master",
    secondaryExpert: null,
    craftSkills: [
      "novel-thrill-loop-delay-pacing",
      "craft-power-economy-and-map-escalation",
      "craft-emotional-catapult-and-midbook-recovery",
      "craft-opening-hook-promise-and-inciting-incident",
      "craft-midbook-midpoint-and-climax-architecture",
    ],
    characterSkills: [
      "character-antagonist-mirror-and-pressure",
      "character-archetypes-and-flaw-engines",
    ],
    suggestedSoulSkills: ["chen-pingan-perspective", "fan-xian-perspective", "lv-shu-perspective"],
    coreRules: [
      "novel-craft-school-adaptive-routing",
      "novel-thrill-pacing-delay-curve",
      "novel-power-system-cost-and-ecology",
      "ai-prose-review-15",
    ],
    avoidExperts: [],
    taskSkillNames: {
      outline: [
        "novel-craft-school-and-expert-selector",
        "novel-thrill-loop-delay-pacing",
        "craft-power-economy-and-map-escalation",
        "craft-opening-hook-promise-and-inciting-incident",
        "craft-midbook-midpoint-and-climax-architecture",
      ],
      writing: [
        "long-form-drafting",
        "expert-commercial-pacing-hook-master",
        "novel-thrill-loop-delay-pacing",
        "craft-scene-sequel-beats-and-pov-discipline",
      ],
      review: [
        "novel-continuity-p0-gate-audit",
        "detect-ai-flavor-nine-signals",
        "aigc-platform-compliance-kit",
      ],
    },
    extraPromptHint:
      "每章必须推进期待感蓄力或兑现爽点收益；延宕比 ≤ 3:1，主角受压期间须保持主动筹谋；章末落四型强断章。",
  },
  {
    id: "female-emotion-arc",
    name: "女频细腻拉扯与反杀流（世情/古言/双强重生）",
    genres: ["女频古言宅斗", "重生复仇", "豪门世情", "双强情感拉扯", "知乎短篇爆款"],
    tone: "清醒独立、情绪暗涌与四阶信赖拉扯、精准戳穿虚伪、克制下刀与痛快反杀",
    primaryExpert: "expert-iceberg-dramatic-subtext",
    secondaryExpert: "expert-commercial-pacing-hook-master",
    craftSkills: [
      "craft-dialogue-sparring-and-status-play",
      "craft-emotional-catapult-and-midbook-recovery",
      "craft-faction-politics-and-conspiracy",
      "craft-opening-hook-promise-and-inciting-incident",
      "craft-emotional-tension-and-crisis-escalation",
    ],
    characterSkills: [
      "character-romance-tension-and-bonds",
      "character-archetypes-and-flaw-engines",
      "character-voice-fingerprint-and-micro-actions",
    ],
    suggestedSoulSkills: ["wang-xifeng-perspective", "lin-daiyu-perspective", "wu-zetian-perspective", "jane-austen-perspective"],
    coreRules: [
      "novel-craft-school-adaptive-routing",
      "novel-emotional-curve-and-antimelodrama",
      "novel-dialogue-status-and-subtext-turn",
      "ai-prose-review-15",
    ],
    avoidExperts: ["expert-fox-unreliable-sensory-horror"],
    taskSkillNames: {
      outline: [
        "novel-craft-school-and-expert-selector",
        "character-romance-tension-and-bonds",
        "craft-emotional-catapult-and-midbook-recovery",
        "craft-opening-hook-promise-and-inciting-incident",
      ],
      writing: [
        "long-form-drafting",
        "expert-iceberg-dramatic-subtext",
        "craft-dialogue-sparring-and-status-play",
        "character-voice-fingerprint-and-micro-actions",
        "craft-emotional-tension-and-crisis-escalation",
      ],
      review: [
        "novel-continuity-p0-gate-audit",
        "detect-ai-flavor-nine-signals",
        "aigc-platform-compliance-kit",
        "craft-self-editing-revision-and-prose-tightening",
      ],
    },
    extraPromptHint:
      "强化言在此而意在彼的潜台词交锋与四阶双强信任演化；拒绝廉价嘶吼与工业糖精，反杀落到实际筹码与体面碾压。",
  },
  {
    id: "literary-wuxia-history",
    name: "历史正剧与冷峻写实流（电影感/考据/群像）",
    genres: ["历史正剧", "传统武侠", "社会派现实主义", "深度文戏群像"],
    tone: "冷峻节制、压低音量、时代器物制度可信、多视点沉稳剪辑、余韵深厚",
    primaryExpert: "expert-iceberg-dramatic-subtext",
    secondaryExpert: "expert-cuttlefish-hard-world-mystery",
    craftSkills: [
      "craft-cinematic-blocking-and-sensory-immersion",
      "craft-faction-politics-and-conspiracy",
      "craft-multi-pov-and-information-asymmetry",
      "craft-midbook-midpoint-and-climax-architecture",
    ],
    characterSkills: [
      "character-ensemble-ecology-and-chemistry",
      "character-graceful-exit-and-legacy-arc",
      "novel-dual-kb-research-and-injection",
    ],
    suggestedSoulSkills: ["cao-cao-perspective", "li-shimin-perspective", "lu-xun-perspective", "wang-yangming-perspective"],
    coreRules: [
      "novel-craft-school-adaptive-routing",
      "novel-cinematic-show-dont-tell-gate",
      "novel-emotional-curve-and-antimelodrama",
      "novel-kb-routing-contract",
    ],
    avoidExperts: ["expert-subversive-comedy-chemistry", "expert-satirical-capitalist-cultivation"],
    taskSkillNames: {
      outline: [
        "novel-craft-school-and-expert-selector",
        "craft-faction-politics-and-conspiracy",
        "novel-dual-kb-research-and-injection",
        "craft-midbook-midpoint-and-climax-architecture",
      ],
      writing: [
        "long-form-drafting",
        "expert-iceberg-dramatic-subtext",
        "craft-cinematic-blocking-and-sensory-immersion",
        "character-voice-fingerprint-and-micro-actions",
        "craft-scene-sequel-beats-and-pov-discipline",
      ],
      review: [
        "novel-continuity-p0-gate-audit",
        "detect-ai-flavor-nine-signals",
        "novel-finale-three-precepts-audit",
        "craft-self-editing-revision-and-prose-tightening",
      ],
    },
    extraPromptHint:
      "历史制度与器物细节经 WeKnora 小说素材与人文库（lore）核对后切片植入；景物连写 ≤3 句；晚进早出、压低音量、零现代网梗。",
  },
  {
    id: "subversive-comedy",
    name: "反套路脱力轻喜剧流（美好世界/沙雕群像）",
    genres: ["异世界轻喜剧", "反套路冒险", "沙雕日常群像", "职场轻喜"],
    tone: "一本正经搞荒诞、全员偏科缺陷互补、三拍冷吐槽、小聪明反英雄破局",
    primaryExpert: "expert-subversive-comedy-chemistry",
    secondaryExpert: "expert-commercial-pacing-hook-master",
    craftSkills: [
      "craft-dialogue-sparring-and-status-play",
      "novel-thrill-loop-delay-pacing",
      "craft-emotional-catapult-and-midbook-recovery",
      "craft-opening-hook-promise-and-inciting-incident",
    ],
    characterSkills: [
      "character-ensemble-ecology-and-chemistry",
      "character-archetypes-and-flaw-engines",
      "character-voice-fingerprint-and-micro-actions",
    ],
    suggestedSoulSkills: ["lv-shu-perspective", "fan-xian-perspective", "sun-wukong-perspective"],
    coreRules: [
      "novel-craft-school-adaptive-routing",
      "novel-character-voice-and-flaw-consistency",
      "novel-dialogue-status-and-subtext-turn",
      "ai-prose-review-15",
    ],
    avoidExperts: ["expert-fox-unreliable-sensory-horror"],
    taskSkillNames: {
      outline: [
        "novel-craft-school-and-expert-selector",
        "character-ensemble-ecology-and-chemistry",
        "expert-subversive-comedy-chemistry",
        "craft-opening-hook-promise-and-inciting-incident",
      ],
      writing: [
        "long-form-drafting",
        "expert-subversive-comedy-chemistry",
        "craft-dialogue-sparring-and-status-play",
        "craft-scene-sequel-beats-and-pov-discipline",
      ],
      review: [
        "novel-continuity-p0-gate-audit",
        "detect-ai-flavor-nine-signals",
      ],
    },
    extraPromptHint:
      "笑点必须从角色固执性格与「如果+而且」滚雪球失控里长出来；严禁堆砌过时网络热梗；偶尔闪现护短真心稳住长篇留存。",
  },
  {
    id: "rezero-despair-break",
    name: "高压虐转爽史诗流（死亡回归/黑化边缘破局）",
    genres: ["死亡回归/轮回", "低魔硬核生存", "凡躯逆袭史诗", "极境救赎"],
    tone: "阶梯剥夺拉满孤立感、黑化边缘自我拉回、以血肉代价换取震慑人心的破局宣泄",
    primaryExpert: "expert-iceberg-dramatic-subtext",
    secondaryExpert: "expert-deathgame-puzzle-escalation",
    craftSkills: [
      "craft-emotional-catapult-and-midbook-recovery",
      "craft-foreshadowing-web-and-multi-twist",
      "craft-flashback-timejump-and-cold-open",
      "craft-midbook-midpoint-and-climax-architecture",
      "craft-emotional-tension-and-crisis-escalation",
    ],
    characterSkills: [
      "character-darkening-and-corruption-arc",
      "character-archetypes-and-flaw-engines",
      "novel-ghost-wound-and-wish-motive-chain",
    ],
    suggestedSoulSkills: ["chen-pingan-perspective", "nezha-perspective", "hua-mulan-perspective"],
    coreRules: [
      "novel-craft-school-adaptive-routing",
      "novel-emotional-curve-and-antimelodrama",
      "novel-continuity-p0-hard-gate",
      "novel-opening-redline-finale-precepts",
    ],
    avoidExperts: ["expert-subversive-comedy-chemistry"],
    taskSkillNames: {
      outline: [
        "novel-craft-school-and-expert-selector",
        "craft-emotional-catapult-and-midbook-recovery",
        "character-darkening-and-corruption-arc",
        "craft-midbook-midpoint-and-climax-architecture",
      ],
      writing: [
        "long-form-drafting",
        "expert-iceberg-dramatic-subtext",
        "craft-emotional-catapult-and-midbook-recovery",
        "craft-emotional-tension-and-crisis-escalation",
      ],
      review: [
        "novel-continuity-p0-gate-audit",
        "detect-ai-flavor-nine-signals",
        "novel-finale-three-precepts-audit",
        "craft-self-editing-revision-and-prose-tightening",
      ],
    },
    extraPromptHint:
      "宣泄前先给具象微光锚点再阶梯剥夺；连续压抑不超 2 章须穿插微光喘息；用插叙三句熔断保持当下窒息张力。",
  },
]

const BUILTIN_OVERLAP_HINTS = {
  "premise-to-writable-outline": "内置 `outline-master-builder` 已覆盖商业总纲流程，本技能侧重创意前提转化",
  "build-act-skeleton-with-checklist": "内置 `story-goal-ladder` / `outline-master-builder` 已覆盖卷纲骨架，本技能适合三幕/四幕结构体检",
  "design-protagonist-onion-layering-likability": "内置 `character-design` 已覆盖主角基础，本技能深化洋葱剥层与共情好感",
  "define-stereoscopic-characters-via-core-traits-and-contradiction": "内置 `character-design` 已覆盖基础塑造，本技能强化核心特质与内在矛盾",
  "write-character-biography-and-research": "内置 `character-design` 已覆盖人物小传，本技能补充调研型角色档案",
  "design-antagonist": "与 `character-antagonist-mirror-and-pressure` 互补，侧重单点反派快建",
  "drive-plot-with-relationship-four-elements": "与 `character-romance-tension-and-bonds` 互补，侧重关系网四元素拆解",
  "write-dialogue-with-subtext-layers": "与 `craft-dialogue-sparring-and-status-play` 互补，侧重潜台词句子打磨",
  "rewrite-novel-draft": "内置 `long-form-drafting` / `anti-ai-polish` 已覆盖常规改写，本技能适合全稿系统化重修",
  "revise-narrative-language": "内置 `anti-ai-polish` 侧重去 AI 味，本技能侧重叙事语言动词与节奏打磨",
  "worldbuilding-detail-reveal": "内置 `world-rules` 侧重规则搭建，本技能侧重正文细节无痕揭示",
  "create-suspense-with-story-problem-and-time-fuse": "内置 `foreshadowing-suspense` 已覆盖伏笔悬念，本技能补充故事问题与定时炸弹模型",
  "write-strong-opening-with-resonance-levers": "内置 `chapter-outline-builder` 已覆盖开章结构，本技能专攻前三章共鸣杠杆",
}

const SKILL_ROUTE_META = {
  "novel-craft-school-and-expert-selector": { categoryId: "skill-category:outline", kind: ["planning", "structure"], stages: ["planning"], modes: ["standard", "strict"], priority: 10, phase: "⓪ 自适应流派配装总控" },
  "novel-continuity-p0-gate-audit": { categoryId: "skill-category:outline", kind: ["review", "structure"], stages: ["planning", "review"], modes: ["standard", "strict"], priority: 12, phase: "⑥ P0/P1/P2 门禁审查与改稿" },
  "novel-thrill-loop-delay-pacing": { categoryId: "skill-category:outline", kind: ["planning", "structure"], stages: ["planning", "drafting", "review"], modes: ["standard", "strict"], priority: 15, phase: "② 大纲、结构与节奏编排" },
  "novel-ghost-wound-and-wish-motive-chain": { categoryId: "skill-category:character", kind: ["knowledge", "structure"], stages: ["planning", "drafting"], modes: ["standard", "strict"], priority: 16, phase: "③ 多样化角色设定与弧光" },
  "novel-finale-three-precepts-audit": { categoryId: "skill-category:outline", kind: ["review", "structure"], stages: ["planning", "review"], modes: ["standard", "strict"], priority: 14, phase: "⑥ P0/P1/P2 门禁审查与改稿" },
  "novel-dual-kb-research-and-injection": { categoryId: "skill-category:setting", kind: ["knowledge", "planning"], stages: ["planning", "drafting"], modes: ["standard", "strict"], priority: 18, phase: "① 立项、高概念与世界观" },
  "detect-ai-flavor-nine-signals": { categoryId: "skill-category:writing", kind: ["review", "rewrite", "style"], stages: ["review", "rewrite", "output"], modes: ["standard", "strict"], priority: 14, phase: "⑥ P0/P1/P2 门禁审查与改稿" },
  "aigc-platform-compliance-kit": { categoryId: "skill-category:outline", kind: ["review", "output"], stages: ["review", "output"], modes: ["strict"], priority: 22, phase: "⑦ 发布合规与风控对冲" },
  "expert-cuttlefish-hard-world-mystery": { categoryId: "skill-category:writing", kind: ["style", "structure"], stages: ["planning", "drafting"], modes: ["standard", "strict"], priority: 20, phase: "★ 写作专家流派矩阵（10 位可选）" },
  "expert-fox-unreliable-sensory-horror": { categoryId: "skill-category:writing", kind: ["style", "structure"], stages: ["drafting", "rewrite"], modes: ["standard", "strict"], priority: 20, phase: "★ 写作专家流派矩阵（10 位可选）" },
  "expert-deathgame-puzzle-escalation": { categoryId: "skill-category:outline", kind: ["planning", "structure"], stages: ["planning", "drafting"], modes: ["standard", "strict"], priority: 20, phase: "★ 写作专家流派矩阵（10 位可选）" },
  "expert-iceberg-dramatic-subtext": { categoryId: "skill-category:writing", kind: ["style", "rewrite"], stages: ["drafting", "rewrite"], modes: ["standard", "strict"], priority: 20, phase: "★ 写作专家流派矩阵（10 位可选）" },
  "expert-commercial-pacing-hook-master": { categoryId: "skill-category:writing", kind: ["planning", "style"], stages: ["planning", "drafting"], modes: ["standard", "strict"], priority: 20, phase: "★ 写作专家流派矩阵（10 位可选）" },
  "expert-subversive-comedy-chemistry": { categoryId: "skill-category:writing", kind: ["style", "structure"], stages: ["drafting", "rewrite"], modes: ["standard", "strict"], priority: 20, phase: "★ 写作专家流派矩阵（10 位可选）" },
  "expert-satirical-capitalist-cultivation": { categoryId: "skill-category:writing", kind: ["style", "structure"], stages: ["planning", "drafting"], modes: ["standard", "strict"], priority: 20, phase: "★ 写作专家流派矩阵（10 位可选）" },
  "expert-mortal-steadfast-cultivation": { categoryId: "skill-category:writing", kind: ["planning", "style"], stages: ["planning", "drafting"], modes: ["standard", "strict"], priority: 20, phase: "★ 写作专家流派矩阵（10 位可选）" },
  "expert-maoni-court-epigram-epic": { categoryId: "skill-category:writing", kind: ["style", "structure"], stages: ["drafting", "rewrite"], modes: ["standard", "strict"], priority: 20, phase: "★ 写作专家流派矩阵（10 位可选）" },
  "expert-fenghuo-lyric-jianghu-ensemble": { categoryId: "skill-category:writing", kind: ["style", "structure"], stages: ["drafting", "rewrite"], modes: ["standard", "strict"], priority: 20, phase: "★ 写作专家流派矩阵（10 位可选）" },
  "character-ensemble-ecology-and-chemistry": { categoryId: "skill-category:character", kind: ["planning", "structure"], stages: ["planning", "drafting"], modes: ["standard", "strict"], priority: 17, phase: "③ 多样化角色设定与弧光" },
  "character-archetypes-and-flaw-engines": { categoryId: "skill-category:character", kind: ["planning", "knowledge"], stages: ["planning"], modes: ["standard", "strict"], priority: 18, phase: "③ 多样化角色设定与弧光" },
  "character-antagonist-mirror-and-pressure": { categoryId: "skill-category:character", kind: ["planning", "structure"], stages: ["planning", "drafting"], modes: ["standard", "strict"], priority: 17, phase: "③ 多样化角色设定与弧光" },
  "character-voice-fingerprint-and-micro-actions": { categoryId: "skill-category:character", kind: ["style", "rewrite"], stages: ["drafting", "rewrite"], modes: ["standard", "strict"], priority: 18, phase: "③ 多样化角色设定与弧光" },
  "character-romance-tension-and-bonds": { categoryId: "skill-category:character", kind: ["planning", "structure"], stages: ["planning", "drafting"], modes: ["standard", "strict"], priority: 18, phase: "③ 多样化角色设定与弧光" },
  "character-graceful-exit-and-legacy-arc": { categoryId: "skill-category:character", kind: ["planning", "structure"], stages: ["planning", "drafting", "review"], modes: ["standard", "strict"], priority: 17, phase: "③ 多样化角色设定与弧光" },
  "character-darkening-and-corruption-arc": { categoryId: "skill-category:character", kind: ["planning", "structure"], stages: ["planning", "drafting"], modes: ["standard", "strict"], priority: 18, phase: "③ 多样化角色设定与弧光" },
  "craft-multi-pov-and-information-asymmetry": { categoryId: "skill-category:outline", kind: ["structure", "planning"], stages: ["planning", "drafting"], modes: ["standard", "strict"], priority: 19, phase: "◆ 九大大写作手法专题" },
  "craft-foreshadowing-web-and-multi-twist": { categoryId: "skill-category:foreshadowing", kind: ["planning", "structure"], stages: ["planning", "drafting", "review"], modes: ["standard", "strict"], priority: 19, phase: "◆ 九大大写作手法专题" },
  "craft-power-economy-and-map-escalation": { categoryId: "skill-category:setting", kind: ["knowledge", "structure"], stages: ["planning"], modes: ["standard", "strict"], priority: 19, phase: "◆ 九大大写作手法专题" },
  "craft-cinematic-blocking-and-sensory-immersion": { categoryId: "skill-category:writing", kind: ["style", "rewrite"], stages: ["drafting", "rewrite"], modes: ["standard", "strict"], priority: 19, phase: "◆ 九大大写作手法专题" },
  "craft-emotional-catapult-and-midbook-recovery": { categoryId: "skill-category:outline", kind: ["planning", "structure"], stages: ["planning", "drafting", "review"], modes: ["standard", "strict"], priority: 19, phase: "◆ 九大大写作手法专题" },
  "craft-faction-politics-and-conspiracy": { categoryId: "skill-category:faction", kind: ["planning", "structure"], stages: ["planning", "drafting"], modes: ["standard", "strict"], priority: 19, phase: "◆ 九大大写作手法专题" },
  "craft-combat-tactics-and-terrain-chess": { categoryId: "skill-category:writing", kind: ["style", "structure"], stages: ["drafting", "rewrite"], modes: ["standard", "strict"], priority: 19, phase: "◆ 九大大写作手法专题" },
  "craft-dialogue-sparring-and-status-play": { categoryId: "skill-category:writing", kind: ["style", "rewrite"], stages: ["drafting", "rewrite"], modes: ["standard", "strict"], priority: 19, phase: "◆ 九大大写作手法专题" },
  "craft-flashback-timejump-and-cold-open": { categoryId: "skill-category:writing", kind: ["structure", "rewrite"], stages: ["drafting", "rewrite"], modes: ["standard", "strict"], priority: 19, phase: "◆ 九大大写作手法专题" },
  "shape-characters-and-environments-with-significant-details": { categoryId: "skill-category:writing", kind: ["style", "structure"], stages: ["drafting", "rewrite"], modes: ["standard", "strict"], priority: 24, phase: "③ 多样化角色设定与弧光" },
}

function inferSkillMeta(slug) {
  if (SKILL_ROUTE_META[slug]) return SKILL_ROUTE_META[slug]
  if (/opening|suspense|hook|time-fuse/.test(slug)) {
    return { categoryId: "skill-category:foreshadowing", kind: ["structure", "planning"], stages: ["planning", "drafting"], modes: ["standard", "strict"], priority: 35, phase: "④ 开篇与悬念钩子" }
  }
  if (/character|protagonist|antagonist|relationship|biography/.test(slug)) {
    return { categoryId: "skill-category:character", kind: ["knowledge", "planning"], stages: ["planning", "drafting"], modes: ["standard", "strict"], priority: 38, phase: "③ 多样化角色设定与弧光" }
  }
  if (/outline|act-skeleton|plot|storyboard|cards|climax|subplots|premise|idea|fantasy|conflict-brainstorm/.test(slug)) {
    return { categoryId: "skill-category:outline", kind: ["planning", "structure"], stages: ["planning"], modes: ["standard", "strict"], priority: 36, phase: "② 大纲、结构与节奏编排" }
  }
  if (/worldbuilding|reference-material/.test(slug)) {
    return { categoryId: "skill-category:worldbuilding", kind: ["knowledge", "style"], stages: ["planning", "drafting"], modes: ["standard", "strict"], priority: 40, phase: "① 立项、高概念与世界观" }
  }
  if (/rewrite|revise|refine|credibility/.test(slug)) {
    return { categoryId: "skill-category:writing", kind: ["review", "rewrite", "style"], stages: ["review", "rewrite"], modes: ["standard", "strict"], priority: 42, phase: "⑥ P0/P1/P2 门禁审查与改稿" }
  }
  return { categoryId: "skill-category:writing", kind: ["style", "structure"], stages: ["drafting", "rewrite"], modes: ["standard", "strict"], priority: 40, phase: "⑤ 场景、对白与正文沉浸感" }
}

function parseArgs(argv) {
  const opts = {
    baseUrl: null,
    apiKey: null,
    outDir: resolve(REPO_ROOT, "..", "niko-buddy-nmem-pack"),
    fromLinkedDir: null,
    spaceId: "space",
    includeManga: false,
    includeAll: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--base-url") opts.baseUrl = argv[++i] ?? null
    else if (a === "--api-key") opts.apiKey = argv[++i] ?? null
    else if (a === "--out-dir") opts.outDir = resolve(argv[++i] ?? opts.outDir)
    else if (a === "--from-linked") opts.fromLinkedDir = resolve(argv[++i] ?? opts.outDir)
    else if (a === "--space") opts.spaceId = argv[++i] ?? "space"
    else if (a === "--include-manga") opts.includeManga = true
    else if (a === "--include-all") opts.includeAll = true
    else if (a === "--help" || a === "-h") opts.help = true
    else throw new Error(`未知参数: ${a}`)
  }
  return opts
}

function loadLocalNmemConfig() {
  const cfgPath = join(homedir(), ".nowledge-mem", "config.json")
  if (!existsSync(cfgPath)) return {}
  try {
    return JSON.parse(readFileSync(cfgPath, "utf8"))
  } catch {
    return {}
  }
}

async function fetchJson(baseUrl, apiKey, path) {
  const headers = { Accept: "application/json" }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const res = await fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(25_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} (${path})`)
  return res.json()
}

function extractFrontmatterDescription(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return ""
  const desc = m[1].match(/^description:\s*(.+)$/m)
  return desc ? desc[1].trim().replace(/^["']|["']$/g, "") : ""
}

function stripFrontmatter(md) {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim()
}

function clampPromptId(rawId) {
  const clean = String(rawId).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return (clean || "prompt").slice(0, 64)
}

function clampPromptBody(body) {
  const trimmed = String(body || "").trim()
  if (trimmed.length <= 39_800) return trimmed
  return `${trimmed.slice(0, 39_700)}\n\n（注：超出单条技能包 40,000 字符上限已安全截断，完整原文见 linked-skills 目录或 Nowledge Mem。）`
}

function buildNbskillPack({ name, version, author, prompts }) {
  return {
    schemaVersion: 2,
    kind: "nbskill",
    name: name.slice(0, 64),
    version,
    author,
    tools: [
      {
        name: "novel_context_read",
        category: "readable-state",
        description: "只读参考小说上下文、专家技法与规则约束，不执行外部命令或写盘。",
      },
    ],
    prompts: prompts.slice(0, MAX_PROMPTS_PER_PACK).map((p) => ({
      id: clampPromptId(p.id),
      ...(p.name ? { name: String(p.name).slice(0, 128) } : {}),
      ...(p.description ? { description: String(p.description).slice(0, 1000) } : {}),
      body: clampPromptBody(p.body),
      ...(Array.isArray(p.kind) && p.kind.length > 0 ? { kind: p.kind.slice(0, 16) } : {}),
      ...(Array.isArray(p.stages) && p.stages.length > 0 ? { stages: p.stages.slice(0, 16) } : {}),
      ...(Array.isArray(p.modes) && p.modes.length > 0 ? { modes: p.modes.slice(0, 8) } : {}),
      ...(typeof p.priority === "number" ? { priority: Math.max(1, Math.min(100, Math.round(p.priority))) } : {}),
      ...(Array.isArray(p.tags) && p.tags.length > 0 ? { tags: p.tags.slice(0, 32) } : {}),
      ...(p.categoryId ? { categoryId: String(p.categoryId).slice(0, 128) } : {}),
    })),
    trustLevel: "reviewed",
  }
}

/** 若单个合集超过 v2 pack-format.ts 256 条上限，自动拆为 part1 / part2，保证零静默丢弃。 */
function writeChunkedPack(packsRoot, { baseFile, baseName, version, author, prompts }) {
  if (prompts.length === 0) return []
  const written = []
  if (prompts.length <= MAX_PROMPTS_PER_PACK) {
    const packObj = buildNbskillPack({ name: baseName, version, author, prompts })
    writeFileSync(join(packsRoot, baseFile), `${JSON.stringify(packObj, null, 2)}\n`, "utf8")
    written.push({ file: baseFile, name: packObj.name, count: prompts.length, schemaVersion: 2 })
    return written
  }
  const stem = baseFile.replace(/\.nbskill\.json$/, "")
  const totalParts = Math.ceil(prompts.length / MAX_PROMPTS_PER_PACK)
  for (let i = 0; i < totalParts; i += 1) {
    const slice = prompts.slice(i * MAX_PROMPTS_PER_PACK, (i + 1) * MAX_PROMPTS_PER_PACK)
    const partSuffix = `-part${i + 1}`
    const file = `${stem}${partSuffix}.nbskill.json`
    const packName = `${baseName}${partSuffix}`
    const packObj = buildNbskillPack({ name: packName, version, author, prompts: slice })
    writeFileSync(join(packsRoot, file), `${JSON.stringify(packObj, null, 2)}\n`, "utf8")
    written.push({ file, name: packObj.name, count: slice.length, schemaVersion: 2 })
  }
  return written
}

const CRC32_TABLE = (() => {
  const tbl = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    tbl[n] = c >>> 0
  }
  return tbl
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex")
}

/** 精确镜像 Rust `canon/archive.rs::compute_content_digest`（按内容去重 + hash 升序）。 */
function computeArchiveContentDigest(entries) {
  const byHash = new Map()
  for (const item of entries) {
    const hash = sha256Hex(item.bytes)
    if (!byHash.has(hash)) byHash.set(hash, item.bytes.length)
  }
  const ordered = [...byHash.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const digest = createHash("sha256")
  const sizeBuf = Buffer.alloc(8)
  for (const [hash, size] of ordered) {
    digest.update(Buffer.from(hash, "utf8"))
    digest.update(Buffer.from([0]))
    sizeBuf.writeBigUInt64LE(BigInt(size))
    digest.update(sizeBuf)
    digest.update(Buffer.from([0x0a]))
  }
  return digest.digest("hex")
}

/** 零外部依赖标准 PKZIP 打包器（DEFLATE），输出兼容 Rust `zip::ZipArchive`。 */
function createZipBuffer(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const { name, bytes } of entries) {
    const nameBuf = Buffer.from(name, "utf8")
    const crc = crc32(bytes)
    const compressed = deflateRawSync(bytes)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4) // version needed
    localHeader.writeUInt16LE(0x0800, 6) // UTF-8 filename flag
    localHeader.writeUInt16LE(8, 8) // DEFLATE
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(bytes.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28)
    localParts.push(localHeader, nameBuf, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(8, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(bytes.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    centralParts.push(centralHeader, nameBuf)

    offset += localHeader.length + nameBuf.length + compressed.length
  }

  const centralDir = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDir, eocd])
}

/** 构造与 Rust `skill_bundle_verify` 字节级兼容的 `nbskill/1` `.nbskill.zip` + `.sha256` sidecar。 */
function writeNbskillZipBundle({ bundleId, source, skillFiles, outZipPath }) {
  const sortedSkillFiles = [...skillFiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const contentHash = computeArchiveContentDigest(sortedSkillFiles)
  const manifest = {
    schema: "nbskill/1",
    schema_version: 1,
    id: bundleId,
    name: bundleId,
    version: PACKAGE_VERSION,
    content_hash: contentHash,
    source,
    trust_level: "untrusted",
    min_nb_version: PACKAGE_VERSION,
    deps: [],
    allowlist: {
      readable_state: [],
      writable_artifacts: [],
    },
    files: sortedSkillFiles.map((item) => ({
      path: item.path,
      hash: sha256Hex(item.bytes),
      size: item.bytes.length,
    })),
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8")
  const manifestSha256 = sha256Hex(manifestBytes)
  const allEntries = [
    { name: "manifest.json", bytes: manifestBytes },
    ...sortedSkillFiles.map((f) => ({ name: f.path, bytes: f.bytes })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  mkdirSync(dirname(outZipPath), { recursive: true })
  const zipBuf = createZipBuffer(allEntries)
  writeFileSync(outZipPath, zipBuf)
  writeFileSync(`${outZipPath}.sha256`, `${manifestSha256}  ${basename(outZipPath)}\n`, "utf8")
  return {
    file: basename(outZipPath),
    id: bundleId,
    fileCount: sortedSkillFiles.length,
    totalBytes: sortedSkillFiles.reduce((sum, f) => sum + f.bytes.length, 0),
    contentHash,
    manifestSha256,
  }
}

/** 离线从已有 linked-skills 目录与旧 space-rules 包读取数据，允许无远端 nmem 时直接升级为 v2 + zip 包。 */
function loadOfflineBundlesFromLinkedDir(sourceDir) {
  const linkedRoot = existsSync(join(sourceDir, "linked-skills"))
    ? join(sourceDir, "linked-skills")
    : sourceDir
  if (!existsSync(linkedRoot)) {
    throw new Error(`未找到 linked-skills 目录: ${linkedRoot}`)
  }
  const bundles = []
  for (const slug of readdirSync(linkedRoot).sort()) {
    const dir = join(linkedRoot, slug)
    if (!statSync(dir).isDirectory()) continue
    const skillMdPath = join(dir, "SKILL.md")
    if (!existsSync(skillMdPath)) continue
    const files = [{ path: "SKILL.md", content: readFileSync(skillMdPath, "utf8") }]
    const docsDir = join(dir, "docs")
    if (existsSync(docsDir) && statSync(docsDir).isDirectory()) {
      for (const docName of readdirSync(docsDir).sort()) {
        const docPath = join(docsDir, docName)
        if (statSync(docPath).isFile() && docName.toLowerCase().endsWith(".md")) {
          files.push({ path: docName, content: readFileSync(docPath, "utf8") })
        }
      }
    }
    bundles.push({
      meta: { id: slug, slug, title: slug, space_id: "space" },
      id: slug,
      slug,
      bundle: { version: 1, files },
    })
  }

  let spaceRules = []
  const existingRulesPack = join(sourceDir, "packs", "nmem-novel-space-rules.nbskill.json")
  if (existsSync(existingRulesPack)) {
    try {
      const parsed = JSON.parse(readFileSync(existingRulesPack, "utf8"))
      if (Array.isArray(parsed?.prompts)) {
        spaceRules = parsed.prompts.map((p) => {
          const titleMatch = String(p.body || "").match(/^#\s+(.+)$/m)
          const prioMatch = String(p.body || "").match(/优先级：(\d+)/)
          const cleanBody = String(p.body || "").replace(/^#[^\n]*\n+(?:-\s+[^\n]*\n+)+/, "").trim()
          return {
            id: p.id,
            title: titleMatch?.[1]?.trim() || p.name || p.id,
            priority: prioMatch ? Number(prioMatch[1]) : 80,
            spaceId: "space",
            body: cleanBody || String(p.body || ""),
          }
        })
      }
    } catch {
      // 忽略损坏旧包
    }
  }
  return { bundles, spaceRules }
}

function listBuiltinSkillHubNames() {
  const root = join(REPO_ROOT, "skills", "SkillHub")
  const names = new Set()
  if (!existsSync(root)) return names
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (entry === "SKILL.md") {
        const txt = readFileSync(full, "utf8")
        const m = txt.match(/^name:\s*(.+)$/m)
        if (m) names.add(m[1].trim().replace(/^["']|["']$/g, ""))
      }
    }
  }
  walk(root)
  return names
}

function buildFusedDeAiSkillTxt({ baseDeAiMd, aiRule, nineSignalsMd, serverVersion, exportedAt }) {
  const baseBody = stripFrontmatter(baseDeAiMd)
  const nineBody = stripFrontmatter(nineSignalsMd || "")
  const ruleBody = aiRule?.body?.trim() || ""

  return [
    `# 去 AI 味融合规则（niko-buddy 原生 12 硬门槛 + Nowledge Mem P1 双锚与九信号手术法）`,
    `# 导出时间：${exportedAt} | Nowledge Mem：v${serverVersion} | 放置位置：<小说项目根目录>/de-ai-skill.txt`,
    ``,
    `---`,
    ``,
    `## 一、niko-buddy 原生去 AI 味硬门槛（基础底座）`,
    ``,
    baseBody,
    ``,
    `---`,
    ``,
    `## 二、Nowledge Mem P1 硬门禁：ai-prose-review-15（双锚阈值与机械 slop 阻断）`,
    ``,
    ruleBody || "（未在远端读取到 ai-prose-review-15，请检查 space 规则状态）",
    ``,
    `---`,
    ``,
    `## 三、九信号 AI 味诊断与八步手术式重写（detect-ai-flavor-nine-signals）`,
    ``,
    nineBody || "（未在远端读取到 detect-ai-flavor-nine-signals，请检查技能激活状态）",
    ``,
  ].join("\n")
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(`用法: node scripts/export-nmem-to-niko-buddy.mjs [options]
  --base-url <url>      Nowledge Mem API 基址
  --api-key <token>     Bearer Token
  --out-dir <dir>       导出输出目录（默认: ${opts.outDir}）
  --from-linked <dir>   离线从已有导出目录重建 v2 .nbskill.json 与 .nbskill.zip 包
  --space <id>          规则空间（默认: space）
  --include-manga       同时导出漫画专向 Skill
  --include-all         导出所有活跃 Skill`)
    return 0
  }

  const localCfg = loadLocalNmemConfig()
  let baseUrl = String(opts.baseUrl || process.env.NMEM_API_URL || localCfg.apiUrl || "http://127.0.0.1:14242").replace(/\/+$/, "")
  const apiKey = opts.apiKey || process.env.NMEM_API_KEY || localCfg.apiKey || ""
  const exportedAt = new Date().toISOString()

  let serverVersion = "offline"
  let bundles = []
  let spaceRules = []

  if (opts.fromLinkedDir) {
    baseUrl = `offline:${opts.fromLinkedDir}`
    console.log(`[export-nmem] 离线模式：从 ${opts.fromLinkedDir} 重建 v2 技能包与 .nbskill.zip`)
    const loaded = loadOfflineBundlesFromLinkedDir(opts.fromLinkedDir)
    bundles = loaded.bundles
    spaceRules = loaded.spaceRules
    console.log(`[export-nmem] 已载入离线 Skills ${bundles.length} 个 + 规则 ${spaceRules.length} 条`)
  } else {
    console.log(`[export-nmem] 连接 Nowledge Mem: ${baseUrl}`)
    const health = await fetchJson(baseUrl, apiKey, "/health")
    if (health?.status !== "ok") throw new Error(`健康检查未通过: ${JSON.stringify(health)}`)
    serverVersion = String(health.version || "")
    if (!serverVersion) {
      try {
        const openapi = await fetchJson(baseUrl, apiKey, "/openapi.json")
        serverVersion = String(openapi?.info?.version || "unknown")
      } catch {
        serverVersion = "unknown"
      }
    }
    console.log(`[export-nmem] 服务健康 ✅ version=${serverVersion}`)

    const skillsResp = await fetchJson(baseUrl, apiKey, "/skills?stage=active&limit=300")
    const allActiveSkills = Array.isArray(skillsResp)
      ? skillsResp
      : Array.isArray(skillsResp?.skills)
        ? skillsResp.skills
        : Array.isArray(skillsResp?.items)
          ? skillsResp.items
          : []

    const selectedSkills = allActiveSkills.filter((s) => {
      const slug = String(s.slug || s.title || s.name || "")
      if (opts.includeAll) return true
      if (NON_NOVEL_SKILL_SLUGS.has(slug)) return false
      if (!opts.includeManga && MANGA_ONLY_SLUGS.has(slug)) return false
      return true
    })
    console.log(`[export-nmem] 活跃 Skills: ${allActiveSkills.length} 个，筛出小说创作 Skills: ${selectedSkills.length} 个`)

    const CONCURRENCY = 6
    for (let i = 0; i < selectedSkills.length; i += CONCURRENCY) {
      const batch = selectedSkills.slice(i, i + CONCURRENCY)
      const results = await Promise.all(
        batch.map(async (s) => {
          const id = String(s.id || s.skill_id)
          const slug = String(s.slug || s.title || s.name || id)
          const bundle = await fetchJson(baseUrl, apiKey, `/skills/${encodeURIComponent(id)}/bundle`)
          return { meta: s, id, slug, bundle }
        }),
      )
      bundles.push(...results)
    }

    const rulesResp = await fetchJson(baseUrl, apiKey, "/settings/rules")
    const allRules = Array.isArray(rulesResp?.rules) ? rulesResp.rules : Array.isArray(rulesResp) ? rulesResp : []
    spaceRules = allRules
      .filter((r) => r.status === "active" && r.spaceId === opts.spaceId)
      .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0))
    console.log(`[export-nmem] 活跃 ${opts.spaceId} 规则: ${spaceRules.length} 条（全库 ${allRules.length} 条）`)
  }

  const linkedRoot = join(opts.outDir, "linked-skills")
  const packsRoot = join(opts.outDir, "packs")
  const bundlesRoot = join(opts.outDir, "bundles")
  mkdirSync(linkedRoot, { recursive: true })
  mkdirSync(bundlesRoot, { recursive: true })
  // 清理旧 packs/*.nbskill.json，避免切分 part 后残留陈旧整包
  if (existsSync(packsRoot)) {
    for (const f of readdirSync(packsRoot)) {
      if (f.endsWith(".nbskill.json")) rmSync(join(packsRoot, f), { force: true })
    }
  } else {
    mkdirSync(packsRoot, { recursive: true })
  }

  const builtinSkillHub = listBuiltinSkillHubNames()
  const linkedEntries = []
  const corePrompts = []
  const expertPrompts = []
  const characterPrompts = []
  const majorCraftPrompts = []
  const fullPrompts = []
  const manifestRows = []
  let nineSignalsMd = ""

  for (const item of bundles) {
    const { meta, id, slug, bundle } = item
    const files = Array.isArray(bundle?.files) ? bundle.files : []
    const skillFile = files.find((f) => f.path === "SKILL.md")
    const skillMd = String(skillFile?.content || "").trim()
    if (!skillMd) continue

    if (slug === "detect-ai-flavor-nine-signals") nineSignalsMd = skillMd

    const dir = join(linkedRoot, slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "SKILL.md"), `${skillMd}\n`, "utf8")

    const refFiles = files.filter(
      (f) => f.path !== "SKILL.md" && !f.path.startsWith("evals/") && f.path.toLowerCase().endsWith(".md"),
    )
    if (refFiles.length > 0) {
      const docsDir = join(dir, "docs")
      mkdirSync(docsDir, { recursive: true })
      for (const rf of refFiles) {
        writeFileSync(join(docsDir, rf.path.replace(/[\\/]+/g, "_")), `${String(rf.content || "").trim()}\n`, "utf8")
      }
    }

    const routeMeta = inferSkillMeta(slug)
    const description = extractFrontmatterDescription(skillMd) || String(meta.description || meta.title || slug)
    const version = Number(bundle?.version || meta?.verification?.version || 1)
    const contentHash = String(meta?.verification?.content_hash || bundle?.bundle_hash || "")
    const isCoreEngine = CORE_ENGINE_SKILL_SLUGS.has(slug)
    const isExpert = WRITING_EXPERT_SLUGS.has(slug)
    const isCharacter = CHARACTER_SYSTEM_SLUGS.has(slug)
    const isMajorCraft = MAJOR_CRAFT_SLUGS.has(slug)
    const inBuiltinSkillHub = builtinSkillHub.has(slug)
    const overlapHint = BUILTIN_OVERLAP_HINTS[slug] || ""

    const packGroup = isExpert ? "expert" : isCoreEngine ? "core-engine" : isCharacter ? "character" : isMajorCraft ? "major-craft" : "craft"
    const skillTags = ["nmem", packGroup, ...(meta.space_id ? [String(meta.space_id)] : [])]
    linkedEntries.push({
      id: `nmem-linked:${slug}`,
      name: slug,
      description,
      kind: routeMeta.kind,
      stages: routeMeta.stages,
      modes: routeMeta.modes,
      content: "",
      source: "linked",
      linkedPath: dir,
      priority: routeMeta.priority,
      tags: skillTags,
      categoryId: routeMeta.categoryId,
    })

    const packItem = {
      id: slug,
      name: slug,
      description,
      body: stripFrontmatter(skillMd),
      kind: routeMeta.kind,
      stages: routeMeta.stages,
      modes: routeMeta.modes,
      priority: routeMeta.priority,
      tags: skillTags,
      categoryId: routeMeta.categoryId,
    }
    fullPrompts.push(packItem)
    if (isCoreEngine) corePrompts.push(packItem)
    if (isExpert) expertPrompts.push(packItem)
    if (isCharacter) characterPrompts.push(packItem)
    if (isMajorCraft) majorCraftPrompts.push(packItem)

    manifestRows.push({
      skillId: id,
      slug,
      version,
      contentHash,
      phase: routeMeta.phase,
      packGroup,
      categoryId: routeMeta.categoryId,
      isCoreEngine,
      isExpert,
      inBuiltinSkillHub,
      dedupStatus: inBuiltinSkillHub ? "in_builtin_skillhub" : overlapHint ? "overlap_enhance" : "complementary",
      overlapHint,
      linkedPath: dir,
    })
  }

  // 全集排序：专家与核心优先在 part1，常规在 part2
  fullPrompts.sort((a, b) => {
    const pa = inferSkillMeta(a.id).priority
    const pb = inferSkillMeta(b.id).priority
    return pa - pb || a.id.localeCompare(b.id)
  })

  const dateVer = exportedAt.slice(0, 10).replace(/-/g, ".")
  const packSpecs = [
    { baseFile: "nmem-novel-core-engine.nbskill.json", baseName: "nmem-novel-core-engine", prompts: corePrompts },
    { baseFile: "nmem-novel-writing-experts.nbskill.json", baseName: "nmem-novel-writing-experts", prompts: expertPrompts },
    { baseFile: "nmem-novel-character-systems.nbskill.json", baseName: "nmem-novel-character-systems", prompts: characterPrompts },
    { baseFile: "nmem-novel-major-crafts.nbskill.json", baseName: "nmem-novel-major-crafts", prompts: majorCraftPrompts },
    {
      baseFile: "nmem-novel-space-rules.nbskill.json",
      baseName: "nmem-novel-space-rules",
      prompts: spaceRules.map((r) => ({
        id: r.id,
        name: r.id,
        description: r.title,
        body: `# ${r.title}\n\n- 优先级：${r.priority}\n- 规则 ID：\`${r.id}\`\n- 来源空间：\`${r.spaceId}\`\n\n${r.body}`,
        kind: ["review", "structure"],
        stages: ["planning", "drafting", "review"],
        modes: ["standard", "strict"],
        priority: 12,
        tags: ["nmem", "space-rule", String(r.spaceId || "space")],
        categoryId: "skill-category:writing",
      })),
    },
    { baseFile: "nmem-novel-full-craft.nbskill.json", baseName: "nmem-novel-full-craft", prompts: fullPrompts },
  ]

  const writtenPacks = []
  for (const ps of packSpecs) {
    const files = writeChunkedPack(packsRoot, { ...ps, version: dateVer, author: "niko (Nowledge Mem)" })
    writtenPacks.push(...files)
  }

  // 生成与 Rust `skill_bundle_verify` 完全兼容的 `nbskill/1` `.nbskill.zip` + `.sha256` 离线包
  const collectZipEntriesForSlugs = (slugList) => {
    const out = []
    for (const slug of slugList) {
      const safeSlug = clampPromptId(slug)
      const dir = join(linkedRoot, slug)
      const skillMdPath = join(dir, "SKILL.md")
      if (existsSync(skillMdPath)) {
        out.push({ path: `skills/${safeSlug}/SKILL.md`, bytes: readFileSync(skillMdPath) })
      }
      const docsDir = join(dir, "docs")
      if (existsSync(docsDir) && statSync(docsDir).isDirectory()) {
        for (const docName of readdirSync(docsDir).sort()) {
          if (!docName.toLowerCase().endsWith(".md")) continue
          const docPath = join(docsDir, docName)
          if (statSync(docPath).isFile()) {
            out.push({ path: `skills/${safeSlug}/docs/${docName}`, bytes: readFileSync(docPath) })
          }
        }
      }
    }
    return out
  }

  const writtenZipBundles = []
  const allBundleSlugs = manifestRows.map((r) => r.slug)
  if (allBundleSlugs.length > 0) {
    writtenZipBundles.push(
      writeNbskillZipBundle({
        bundleId: "nmem-novel-craft-bundle",
        source: "nmem-export",
        skillFiles: collectZipEntriesForSlugs(allBundleSlugs),
        outZipPath: join(bundlesRoot, "nmem-novel-craft-bundle.nbskill.zip"),
      }),
    )
  }
  const expertBundleSlugs = manifestRows.filter((r) => r.isExpert).map((r) => r.slug)
  if (expertBundleSlugs.length > 0) {
    writtenZipBundles.push(
      writeNbskillZipBundle({
        bundleId: "nmem-novel-experts-bundle",
        source: "nmem-export",
        skillFiles: collectZipEntriesForSlugs(expertBundleSlugs),
        outZipPath: join(bundlesRoot, "nmem-novel-experts-bundle.nbskill.zip"),
      }),
    )
  }

  writeFileSync(
    join(opts.outDir, "craft-presets.json"),
    `${JSON.stringify({ schemaVersion: 1, exportedAt, serverVersion, presets: CRAFT_PRESETS }, null, 2)}\n`,
    "utf8",
  )

  writeFileSync(
    join(opts.outDir, "linked-skills-config-snippet.json"),
    `${JSON.stringify(
      {
        _note: "可将 skills 数组合并进 <小说项目>/.niko-buddy/writing-skills.json 的 skills 字段；也可直接用 scripts/apply-craft-preset.mjs 一键按流派配装。",
        exportedAt,
        serverVersion,
        count: linkedEntries.length,
        skills: linkedEntries,
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  writeFileSync(
    join(opts.outDir, "export-manifest.json"),
    `${JSON.stringify(
      {
        exportedAt,
        baseUrl,
        serverVersion,
        spaceId: opts.spaceId,
        skillsCount: manifestRows.length,
        coreEngineCount: corePrompts.length,
        expertsCount: expertPrompts.length,
        characterSystemsCount: characterPrompts.length,
        majorCraftsCount: majorCraftPrompts.length,
        spaceRulesCount: spaceRules.length,
        presetsCount: CRAFT_PRESETS.length,
        packSchemaVersion: 2,
        writtenPacks,
        writtenZipBundles,
        skills: manifestRows,
        rules: spaceRules.map((r) => ({
          id: r.id,
          title: r.title,
          priority: r.priority,
          spaceId: r.spaceId,
          evidenceCount: Array.isArray(r.evidenceMemoryIds) ? r.evidenceMemoryIds.length : 0,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  const baseDeAiPath = join(REPO_ROOT, "skills", "de-ai-writing", "SKILL.md")
  const baseDeAiMd = existsSync(baseDeAiPath) ? readFileSync(baseDeAiPath, "utf8") : ""
  const aiRule = spaceRules.find((r) => r.id === "ai-prose-review-15")
  const fusedDeAi = buildFusedDeAiSkillTxt({ baseDeAiMd, aiRule, nineSignalsMd, serverVersion, exportedAt })
  writeFileSync(join(opts.outDir, "de-ai-skill.txt"), `${fusedDeAi}\n`, "utf8")

  const guideLines = [
    `# Nowledge Mem → niko-buddy 模块化技能包、写作专家与流派配装手册`,
    ``,
    `- **导出时间**：${exportedAt}`,
    `- **远端源**：\`${baseUrl}\`（Nowledge Mem \`v${serverVersion}\`）`,
    `- **当前资产规模**：活跃小说创作 Skills **${manifestRows.length} 个**（含 **${expertPrompts.length} 位写作专家**、**${characterPrompts.length} 个角色设定技能**、**${majorCraftPrompts.length} 个大写作手法技能**）+ \`${opts.spaceId}\` 活跃硬规则 **${spaceRules.length} 条** + **${CRAFT_PRESETS.length} 套开箱流派配方**`,
    ``,
    `## 一、按需导入的模块化 .nbskill.json（v2，支持 ≤ 256 条 + 完整元数据）与 .nbskill.zip 技能包`,
    ``,
    `| 文件名 | 条数 | 说明 |`,
    `|---|---:|---|`,
    ...writtenPacks.map((wp) => `| \`packs/${wp.file}\` | ${wp.count} | \`${wp.name}\` (v2) |`),
    ...writtenZipBundles.map((zb) => `| \`bundles/${zb.file}\` | ${zb.fileCount} 文件 | \`nbskill/1\` 离线校验包 (\`.sha256\`) |`),
    ``,
    `## 二、12 套一键流派配方（\`craft-presets.json\` + \`apply-craft-preset.mjs\`）`,
    ``,
    `| 配方 ID | 流派名称 | 适配题材 | 主写作专家 |`,
    `|---|---|---|---|`,
    ...CRAFT_PRESETS.map((p) => `| \`${p.id}\` | **${p.name}** | ${p.genres.slice(0, 3).join(" / ")} | \`${p.primaryExpert}\` |`),
    ``,
    `一键查看或应用到某本小说项目：`,
    `\`\`\`powershell`,
    `node scripts/apply-craft-preset.mjs --list`,
    `node scripts/apply-craft-preset.mjs --show satirical-xiuxian`,
    `node scripts/apply-craft-preset.mjs --apply satirical-xiuxian --project "<your-novel-project-dir>"`,
    `\`\`\``,
    ``,
    `## 三、全部导出 Skills 与 niko-buddy 内置 SkillHub 去重对照表`,
    ``,
    `| 分类阶段 | Skill Slug | 版本 | 状态 | 去重 / 使用建议 |`,
    `|---|---|---|---|---|`,
    ...manifestRows
      .sort((a, b) => a.phase.localeCompare(b.phase) || a.slug.localeCompare(b.slug))
      .map((r) => {
        const badge =
          r.dedupStatus === "in_builtin_skillhub"
            ? "✅ 已内置 SkillHub"
            : r.dedupStatus === "overlap_enhance"
              ? "⚠️ 增强互补"
              : "🆕 全新互补"
        const note =
          r.dedupStatus === "in_builtin_skillhub"
            ? "已直接集成到仓内 SkillHub，无需重复通过外部包导入"
            : r.overlapHint || "与内置 SkillHub 无重叠，按流派按需启用"
        return `| ${r.phase} | \`${r.slug}\` | v${r.version} | ${badge} | ${note} |`
      }),
    ``,
  ]
  writeFileSync(join(opts.outDir, "DEDUP-AND-USAGE-GUIDE.md"), `${guideLines.join("\n")}\n`, "utf8")

  console.log(`[export-nmem] ✅ 导出完成 → ${opts.outDir}`)
  for (const wp of writtenPacks) console.log(`  - packs/${wp.file} (${wp.count} prompts, schemaVersion=2)`)
  for (const zb of writtenZipBundles) console.log(`  - bundles/${zb.file} (${zb.fileCount} files, nbskill/1 + .sha256)`)
  console.log(`  - craft-presets.json (${CRAFT_PRESETS.length} presets)`)
  console.log(`  - linked-skills/: ${manifestRows.length} 个 SKILL.md 目录`)
  console.log(`  - de-ai-skill.txt (${fusedDeAi.length} chars)`)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[export-nmem] ❌ 失败:`, err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
