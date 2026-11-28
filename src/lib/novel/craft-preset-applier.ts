// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * craft-preset-applier.ts — Phase 3 四文件两阶段原子工艺预设事务引擎。
 *
 * 管辖 4 个项目内受管文件：
 *   1. `.niko-buddy/writing-skills.json`（技能启停 + 互斥专家防串味 + selectedSkillId 刷新）
 *   2. `.novel/book-rules.json`（无损合并默认题材锁/建议禁项，保留既有用户规则）
 *   3. `.niko-buddy/novel-config.json`（更新 taskSkillNames、fenced 围栏无损合并 writing 附加提示、写入 activeCraftPresetId）
 *   4. `.niko-buddy/preset-journal.json`（落盘事务日志与时间戳备份目录索引，支持一键回滚）
 *
 * 备份落点：`.niko-buddy/preset-backups/<YYYYMMDDTHHMMSSZ>-<txId>/`
 * 失败语义：任一写盘失败立即按 Phase 1 快照恢复已修改文件并抛出错误（零静默半态）。
 */

import { createDirectory, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { toErrorMessage } from "@/lib/utils"
import { DEFAULT_NOVEL_CONFIG, type NovelConfig } from "@/stores/wiki-store"
import {
  BOOK_RULES_FILE,
  BOOK_RULES_SCHEMA_VERSION,
  EMPTY_BOOK_RULES,
  normalizeBookRules,
  type BookRules,
} from "./book-rules"
import {
  USER_SKILL_CONFIG_FILE,
  ensureBuiltinSkills,
  normalizeUserSkillConfig,
  type UserSkillConfig,
} from "./user-skill-store"
import type { UserSkill } from "./skill-library"

export const NOVEL_CONFIG_RELATIVE_FILE = ".niko-buddy/novel-config.json"
export const PRESET_JOURNAL_FILE = ".niko-buddy/preset-journal.json"
export const PRESET_BACKUPS_DIR = ".niko-buddy/preset-backups"
export const CUSTOM_CRAFT_PRESETS_FILE = ".niko-buddy/custom-craft-presets.json"

export interface CraftPresetDefinition {
  readonly id: string
  readonly name: string
  readonly genres: readonly string[]
  readonly tone: string
  readonly primaryExpert: string
  readonly secondaryExpert: string | null
  readonly craftSkills: readonly string[]
  readonly characterSkills: readonly string[]
  readonly suggestedSoulSkills: readonly string[]
  readonly coreRules: readonly string[]
  readonly avoidExperts: readonly string[]
  readonly taskSkillNames: {
    readonly outline: readonly string[]
    readonly writing: readonly string[]
    readonly review: readonly string[]
  }
  readonly extraPromptHint: string
  /** 可选默认题材禁项（无损追加到 BookRules，不覆盖已有项）。 */
  readonly defaultProhibitions?: readonly string[]
}

export interface CraftPresetJournalEntry {
  txId: string
  presetId: string
  presetName: string
  appliedAt: string
  backupDir: string
  status: "committed" | "rolled_back"
  rolledBackAt?: string
  files: Array<{
    relativePath: string
    backupFileName: string
    existedBefore: boolean
  }>
}

export interface CraftPresetJournalFile {
  version: 1
  entries: CraftPresetJournalEntry[]
}

export interface ApplyCraftPresetOptions {
  /** 可选外部 linked 技能模板池（例如来自导入的 linked-skills-config-snippet.json）。 */
  extraSkills?: readonly UserSkill[]
  /** 可选覆盖当前内存中的 novelConfig，作为未落盘项目时的基线。 */
  baseNovelConfig?: Partial<NovelConfig>
  /** 自定义事务时间戳（测试可注入固定时间）。 */
  now?: Date
}

export interface ApplyCraftPresetResult {
  txId: string
  preset: CraftPresetDefinition
  backupDir: string
  addedSkills: string[]
  disabledExperts: string[]
  updatedNovelConfig: NovelConfig
  updatedBookRules: BookRules
  updatedUserSkillConfig: UserSkillConfig
}

export interface RollbackCraftPresetResult {
  txId: string
  presetId: string
  presetName: string
  restoredFiles: string[]
}

/** 12 套内置离线流派工艺预设（与 nmem 导出 craft-presets.json 同步，零网络离线可用）。 */
export const BUILT_IN_CRAFT_PRESETS: readonly CraftPresetDefinition[] = [
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
    characterSkills: ["character-archetypes-and-flaw-engines", "character-antagonist-mirror-and-pressure", "character-voice-fingerprint-and-micro-actions"],
    suggestedSoulSkills: ["chen-pingan-perspective", "fan-xian-perspective", "lv-shu-perspective"],
    coreRules: ["novel-craft-school-adaptive-routing", "novel-power-system-cost-and-ecology", "novel-dialogue-status-and-subtext-turn", "novel-thrill-pacing-delay-curve", "ai-prose-review-15"],
    avoidExperts: ["expert-fox-unreliable-sensory-horror", "expert-fenghuo-lyric-jianghu-ensemble"],
    taskSkillNames: {
      outline: [
        "novel-craft-school-and-expert-selector",
        "craft-power-economy-and-map-escalation",
        "novel-thrill-loop-delay-pacing",
        "craft-opening-hook-promise-and-inciting-incident",
      ],
      writing: ["long-form-drafting", "expert-satirical-capitalist-cultivation", "craft-dialogue-sparring-and-status-play", "craft-flashback-timejump-and-cold-open"],
      review: [
        "novel-continuity-p0-gate-audit",
        "detect-ai-flavor-nine-signals",
        "aigc-platform-compliance-kit",
        "craft-self-editing-revision-and-prose-tightening",
      ],
    },
    extraPromptHint: "保持仙侠口语脆爽，去AI味；把剥削规则落到具体契约条款、租金账目与漏洞反制上，沿用前文人物口癖与契约术语。",
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
    characterSkills: ["character-archetypes-and-flaw-engines", "character-graceful-exit-and-legacy-arc", "character-antagonist-mirror-and-pressure"],
    suggestedSoulSkills: ["han-fei-perspective", "zhang-liang-perspective", "charlie-munger-perspective"],
    coreRules: ["novel-craft-school-adaptive-routing", "novel-power-system-cost-and-ecology", "novel-combat-cost-and-information-win", "novel-flashback-restraint-and-scene-entry", "novel-continuity-p0-hard-gate"],
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
      review: ["novel-continuity-p0-gate-audit", "detect-ai-flavor-nine-signals", "novel-finale-three-precepts-audit"],
    },
    extraPromptHint: "主角对外展露战力控制在五成以内；遇事先算风险与退路，战斗重地形与预案耗敌，大跨度闭关用物候切片一笔跳过。",
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
    characterSkills: ["character-ensemble-ecology-and-chemistry", "character-voice-fingerprint-and-micro-actions", "novel-dual-kb-research-and-injection"],
    suggestedSoulSkills: ["zhang-liang-perspective", "han-fei-perspective", "charlie-munger-perspective"],
    coreRules: ["novel-craft-school-adaptive-routing", "novel-continuity-p0-hard-gate", "novel-power-system-cost-and-ecology", "novel-information-asymmetry-and-pov-gate", "novel-kb-routing-contract"],
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
    extraPromptHint: "超凡能力须体现代价与扮演内化；时代背景通过货币、饮食、物件、报刊切片自然透出；多用信息差与克制潜台词，禁全知科普。",
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
    characterSkills: ["character-archetypes-and-flaw-engines", "character-darkening-and-corruption-arc", "novel-ghost-wound-and-wish-motive-chain"],
    suggestedSoulSkills: ["lu-xun-perspective", "zhuang-zi-perspective"],
    coreRules: ["novel-craft-school-adaptive-routing", "novel-cinematic-show-dont-tell-gate", "novel-emotional-curve-and-antimelodrama", "novel-continuity-p0-hard-gate"],
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
      review: ["novel-continuity-p0-gate-audit", "detect-ai-flavor-nine-signals"],
    },
    extraPromptHint: "用日常符号的 10% 致命错位与生理级非视觉感官（嗅觉/痛觉/温差）制造恐怖；严禁廉价恐怖形容词与出戏网络吐槽。",
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
    characterSkills: ["character-ensemble-ecology-and-chemistry", "character-antagonist-mirror-and-pressure", "character-voice-fingerprint-and-micro-actions"],
    suggestedSoulSkills: ["han-fei-perspective", "zhuge-liang-perspective", "cao-cao-perspective"],
    coreRules: ["novel-craft-school-adaptive-routing", "novel-continuity-p0-hard-gate", "novel-information-asymmetry-and-pov-gate", "novel-combat-cost-and-information-win", "novel-character-voice-and-flaw-consistency"],
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
    extraPromptHint: "规则与倒计时前置透明；动作战重地形视野与伤痛成本，拒绝机械重复微动作标签；大反转须 ≥2 处前置物理线索。",
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
    characterSkills: ["character-ensemble-ecology-and-chemistry", "character-graceful-exit-and-legacy-arc", "character-voice-fingerprint-and-micro-actions"],
    suggestedSoulSkills: ["fan-xian-perspective", "su-shi-perspective", "zhang-liang-perspective"],
    coreRules: ["novel-craft-school-adaptive-routing", "novel-faction-agency-and-positive-sum-conspiracy", "novel-dialogue-status-and-subtext-turn", "novel-emotional-curve-and-antimelodrama"],
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
    extraPromptHint: "权谋重阳谋二选一与利益制衡；对白兼顾松弛机锋与紧要关头的骨气锋芒；金句必须蓄满日常事实后轻落收束。",
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
    characterSkills: ["character-graceful-exit-and-legacy-arc", "character-ensemble-ecology-and-chemistry", "novel-ghost-wound-and-wish-motive-chain"],
    suggestedSoulSkills: ["chen-pingan-perspective", "xiao-feng-perspective", "li-bai-perspective"],
    coreRules: ["novel-craft-school-adaptive-routing", "novel-cinematic-show-dont-tell-gate", "novel-emotional-curve-and-antimelodrama", "novel-combat-cost-and-information-win"],
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
    extraPromptHint: "出剑前先交代因果债与各自道理；宏大意象旁须配泥土烟火细节锚点；重要配角退场做到微小愿望前置 + 压低音量留白。",
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
    characterSkills: ["character-antagonist-mirror-and-pressure", "character-archetypes-and-flaw-engines"],
    suggestedSoulSkills: ["chen-pingan-perspective", "fan-xian-perspective", "lv-shu-perspective"],
    coreRules: ["novel-craft-school-adaptive-routing", "novel-thrill-pacing-delay-curve", "novel-power-system-cost-and-ecology", "ai-prose-review-15"],
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
      review: ["novel-continuity-p0-gate-audit", "detect-ai-flavor-nine-signals", "aigc-platform-compliance-kit"],
    },
    extraPromptHint: "每章必须推进期待感蓄力或兑现爽点收益；延宕比 ≤ 3:1，主角受压期间须保持主动筹谋；章末落四型强断章。",
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
    characterSkills: ["character-romance-tension-and-bonds", "character-archetypes-and-flaw-engines", "character-voice-fingerprint-and-micro-actions"],
    suggestedSoulSkills: ["wang-xifeng-perspective", "lin-daiyu-perspective", "wu-zetian-perspective", "jane-austen-perspective"],
    coreRules: ["novel-craft-school-adaptive-routing", "novel-emotional-curve-and-antimelodrama", "novel-dialogue-status-and-subtext-turn", "ai-prose-review-15"],
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
    extraPromptHint: "强化言在此而意在彼的潜台词交锋与四阶双强信任演化；拒绝廉价嘶吼与工业糖精，反杀落到实际筹码与体面碾压。",
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
    characterSkills: ["character-ensemble-ecology-and-chemistry", "character-graceful-exit-and-legacy-arc", "novel-dual-kb-research-and-injection"],
    suggestedSoulSkills: ["cao-cao-perspective", "li-shimin-perspective", "lu-xun-perspective", "wang-yangming-perspective"],
    coreRules: ["novel-craft-school-adaptive-routing", "novel-cinematic-show-dont-tell-gate", "novel-emotional-curve-and-antimelodrama", "novel-kb-routing-contract"],
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
    extraPromptHint: "历史制度与器物细节经资料参考核对后切片植入；景物连写 ≤3 句；晚进早出、压低音量、零现代网梗。",
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
    characterSkills: ["character-ensemble-ecology-and-chemistry", "character-archetypes-and-flaw-engines", "character-voice-fingerprint-and-micro-actions"],
    suggestedSoulSkills: ["lv-shu-perspective", "fan-xian-perspective", "sun-wukong-perspective"],
    coreRules: ["novel-craft-school-adaptive-routing", "novel-character-voice-and-flaw-consistency", "novel-dialogue-status-and-subtext-turn", "ai-prose-review-15"],
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
      review: ["novel-continuity-p0-gate-audit", "detect-ai-flavor-nine-signals"],
    },
    extraPromptHint: "笑点必须从角色固执性格与滚雪球失控里长出来；严禁堆砌过时网络热梗；偶尔闪现护短真心稳住长篇留存。",
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
    characterSkills: ["character-darkening-and-corruption-arc", "character-archetypes-and-flaw-engines", "novel-ghost-wound-and-wish-motive-chain"],
    suggestedSoulSkills: ["chen-pingan-perspective", "nezha-perspective", "hua-mulan-perspective"],
    coreRules: ["novel-craft-school-adaptive-routing", "novel-emotional-curve-and-antimelodrama", "novel-continuity-p0-hard-gate", "novel-opening-redline-finale-precepts"],
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
    extraPromptHint: "宣泄前先给具象微光锚点再阶梯剥夺；连续压抑不超 2 章须穿插微光喘息；用插叙三句熔断保持当下窒息张力。",
  },
] as const

const FENCED_PRESET_HINT_RE = /<!--\s*preset-hint:start:[^\s>]+\s*-->[\s\S]*?<!--\s*preset-hint:end:[^\s>]+\s*-->/g

/**
 * 剥离任意已有预设围栏块，完整保留用户手写的其他附加提示词。
 */
export function stripFencedPresetHint(existingExtra: string | undefined): string {
  if (!existingExtra) return ""
  return existingExtra.replace(FENCED_PRESET_HINT_RE, "").replace(/\n{3,}/g, "\n\n").trim()
}

/**
 * 无损围栏合并：把预设提示词放进 `<!-- preset-hint:start:<id> -->...<!-- preset-hint:end:<id> -->`
 * 围栏内，切换预设时仅替换围栏块，绝不覆盖用户围栏外的手写提示。
 */
export function mergeFencedPresetHint(
  existingExtra: string | undefined,
  presetId: string,
  hint: string,
): string {
  const userText = stripFencedPresetHint(existingExtra)
  const cleanHint = hint.trim()
  if (!cleanHint) return userText
  const fenced = [
    `<!-- preset-hint:start:${presetId} -->`,
    cleanHint,
    `<!-- preset-hint:end:${presetId} -->`,
  ].join("\n")
  return userText ? `${userText}\n\n${fenced}` : fenced
}

function formatUtcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
}

function makeTxId(date: Date): string {
  return `tx-${date.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export function findCraftPresetById(
  presetId: string,
  catalog: readonly CraftPresetDefinition[] = BUILT_IN_CRAFT_PRESETS,
): CraftPresetDefinition | undefined {
  return catalog.find((p) => p.id === presetId)
}

export async function loadCraftPresetJournal(projectPath: string): Promise<CraftPresetJournalFile> {
  const root = normalizePath(projectPath).replace(/\/+$/, "")
  try {
    const raw = await readFile(`${root}/${PRESET_JOURNAL_FILE}`)
    const parsed = JSON.parse(raw) as Partial<CraftPresetJournalFile>
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.entries)) {
      return { version: 1, entries: parsed.entries }
    }
  } catch {
    // 无历史日志返回空
  }
  return { version: 1, entries: [] }
}

interface SnapshotRecord {
  relativePath: string
  backupFileName: string
  existedBefore: boolean
  rawContent: string | null
}

async function readManagedFileSnapshot(
  root: string,
  relativePath: string,
  backupFileName: string,
): Promise<SnapshotRecord> {
  const absPath = `${root}/${relativePath}`
  try {
    const exists = await fileExists(absPath)
    if (!exists) {
      return { relativePath, backupFileName, existedBefore: false, rawContent: null }
    }
    const content = await readFile(absPath)
    return { relativePath, backupFileName, existedBefore: true, rawContent: content }
  } catch {
    // 兼容未实现 fileExists 的 mock 环境：直接尝试 readFile
    try {
      const content = await readFile(absPath)
      return { relativePath, backupFileName, existedBefore: true, rawContent: content }
    } catch {
      return { relativePath, backupFileName, existedBefore: false, rawContent: null }
    }
  }
}

/**
 * 4 文件两阶段原子事务应用流派工艺预设：
 * Phase 1：完整快照 4 个受管文件并写入时间戳备份目录 `.niko-buddy/preset-backups/<ts>-<txId>/`；
 * Phase 2：原子更新 writing-skills.json / book-rules.json / novel-config.json / preset-journal.json；
 * 任一步骤失败立即用 Phase 1 快照恢复全部已改动文件并抛出错误。
 */
export async function applyCraftPresetToProject(
  projectPath: string,
  presetOrId: string | CraftPresetDefinition,
  options: ApplyCraftPresetOptions = {},
): Promise<ApplyCraftPresetResult> {
  const preset = typeof presetOrId === "string" ? findCraftPresetById(presetOrId) : presetOrId
  if (!preset) {
    throw new Error(`未找到流派工艺预设：${String(presetOrId)}`)
  }
  if (!projectPath?.trim()) {
    throw new Error("缺少有效的项目路径，无法应用工艺预设")
  }

  const root = normalizePath(projectPath).replace(/\/+$/, "")
  const now = options.now ?? new Date()
  const txId = makeTxId(now)
  const backupRelDir = `${PRESET_BACKUPS_DIR}/${formatUtcStamp(now)}-${txId}`
  const backupAbsDir = `${root}/${backupRelDir}`

  // Phase 1：读取 4 个受管文件的当前快照
  const snapshots = await Promise.all([
    readManagedFileSnapshot(root, USER_SKILL_CONFIG_FILE, "writing-skills.json"),
    readManagedFileSnapshot(root, BOOK_RULES_FILE, "book-rules.json"),
    readManagedFileSnapshot(root, NOVEL_CONFIG_RELATIVE_FILE, "novel-config.json"),
    readManagedFileSnapshot(root, PRESET_JOURNAL_FILE, "preset-journal.json"),
  ])

  const [skillsSnap, rulesSnap, novelCfgSnap, journalSnap] = snapshots

  // 构建目标状态（纯计算，未落盘前无副作用）
  const baseSkillsCfg = ensureBuiltinSkills(
    normalizeUserSkillConfig(skillsSnap.rawContent ? JSON.parse(skillsSnap.rawContent) : null),
  )
  const extraByName = new Map((options.extraSkills ?? []).map((s) => [s.name, s]))
  const existingById = new Map(baseSkillsCfg.skills.map((s) => [s.id, s]))
  const existingByName = new Map(baseSkillsCfg.skills.map((s) => [s.name, s]))

  const wantedNames = new Set<string>([
    "novel-craft-school-and-expert-selector",
    preset.primaryExpert,
    ...(preset.secondaryExpert ? [preset.secondaryExpert] : []),
    ...preset.craftSkills,
    ...preset.characterSkills,
    ...preset.taskSkillNames.outline,
    ...preset.taskSkillNames.writing,
    ...preset.taskSkillNames.review,
  ])

  const nextSkills = [...baseSkillsCfg.skills]
  const addedSkills: string[] = []
  for (const name of wantedNames) {
    const candidate = extraByName.get(name)
    if (!candidate) continue
    if (!existingById.has(candidate.id) && !existingByName.has(candidate.name)) {
      nextSkills.push(candidate)
      existingById.set(candidate.id, candidate)
      existingByName.set(candidate.name, candidate)
      addedSkills.push(candidate.name)
    }
  }

  const allExpertNames = new Set(
    BUILT_IN_CRAFT_PRESETS.flatMap((p) => [p.primaryExpert, ...(p.secondaryExpert ? [p.secondaryExpert] : [])]),
  )
  const avoidSet = new Set(preset.avoidExperts)
  const disabledSet = new Set(baseSkillsCfg.disabledSkillIds)
  const disabledExperts: string[] = []

  for (const skill of nextSkills) {
    if (wantedNames.has(skill.name)) {
      disabledSet.delete(skill.id)
    } else if (avoidSet.has(skill.name) || allExpertNames.has(skill.name)) {
      disabledSet.add(skill.id)
      disabledExperts.push(skill.name)
    }
  }
  for (const slug of avoidSet) {
    const syntheticId = `nmem-linked:${slug}`
    disabledSet.add(syntheticId)
  }

  const primarySkill = nextSkills.find((s) => s.name === preset.primaryExpert)
  const updatedUserSkillConfig = normalizeUserSkillConfig({
    ...baseSkillsCfg,
    selectedSkillId: primarySkill?.id ?? baseSkillsCfg.selectedSkillId,
    disabledSkillIds: [...disabledSet],
    skills: nextSkills,
  })

  // BookRules 无损合并：保留既有用户规则，未设 genreLock 时补入 preset 首选题材，追加可选默认禁项
  const existingBookRules =
    (rulesSnap.rawContent ? normalizeBookRules(JSON.parse(rulesSnap.rawContent)) : null)
    ?? { ...EMPTY_BOOK_RULES, version: BOOK_RULES_SCHEMA_VERSION }
  const mergedProhibitions = [
    ...new Set([
      ...existingBookRules.prohibitions,
      ...(preset.defaultProhibitions ?? []),
    ]),
  ]
  const updatedBookRules: BookRules = {
    ...existingBookRules,
    version: existingBookRules.version || BOOK_RULES_SCHEMA_VERSION,
    prohibitions: mergedProhibitions,
    genreLock: existingBookRules.genreLock ?? (
      preset.genres.length > 0
        ? { primary: preset.genres[0], forbidden: [] }
        : undefined
    ),
  }

  // NovelConfig 无损合并：更新 taskSkillNames（outline/writing/review），围栏合并 writing.extra，记 activeCraftPresetId
  const parsedExistingNovelCfg = novelCfgSnap.rawContent
    ? (JSON.parse(novelCfgSnap.rawContent) as Partial<NovelConfig>)
    : (options.baseNovelConfig ?? {})
  const updatedNovelConfig: NovelConfig = {
    ...DEFAULT_NOVEL_CONFIG,
    ...parsedExistingNovelCfg,
    activeCraftPresetId: preset.id,
    taskSkillNames: {
      ...DEFAULT_NOVEL_CONFIG.taskSkillNames,
      ...(parsedExistingNovelCfg.taskSkillNames ?? {}),
      outline: [...preset.taskSkillNames.outline],
      writing: [...preset.taskSkillNames.writing],
      review: [...preset.taskSkillNames.review],
    },
    taskPrompts: {
      ...DEFAULT_NOVEL_CONFIG.taskPrompts,
      ...(parsedExistingNovelCfg.taskPrompts ?? {}),
      writing: {
        extra: mergeFencedPresetHint(
          parsedExistingNovelCfg.taskPrompts?.writing?.extra,
          preset.id,
          preset.extraPromptHint,
        ),
      },
    },
  }

  const existingJournal: CraftPresetJournalFile = journalSnap.rawContent
    ? (JSON.parse(journalSnap.rawContent) as CraftPresetJournalFile)
    : { version: 1, entries: [] }

  const journalEntry: CraftPresetJournalEntry = {
    txId,
    presetId: preset.id,
    presetName: preset.name,
    appliedAt: now.toISOString(),
    backupDir: backupRelDir,
    status: "committed",
    files: snapshots.slice(0, 3).map((s) => ({
      relativePath: s.relativePath,
      backupFileName: s.backupFileName,
      existedBefore: s.existedBefore,
    })),
  }
  const updatedJournal: CraftPresetJournalFile = {
    version: 1,
    entries: [...(Array.isArray(existingJournal.entries) ? existingJournal.entries : []), journalEntry],
  }

  // Phase 1 落盘：创建目录与备份快照
  await createDirectory(`${root}/.niko-buddy`)
  await createDirectory(`${root}/.novel`)
  await createDirectory(backupAbsDir)
  for (const snap of snapshots) {
    if (snap.existedBefore && snap.rawContent !== null) {
      await writeFileAtomic(`${backupAbsDir}/${snap.backupFileName}`, snap.rawContent)
    }
  }
  await writeFileAtomic(
    `${backupAbsDir}/manifest.json`,
    `${JSON.stringify({ txId, presetId: preset.id, appliedAt: now.toISOString(), files: journalEntry.files }, null, 2)}\n`,
  )

  // Phase 2 落盘：依次原子提交 4 个受管文件，任何失败自动按 Phase 1 快照恢复
  const writePlan: Array<{ snap: SnapshotRecord; payload: string }> = [
    { snap: skillsSnap, payload: `${JSON.stringify(updatedUserSkillConfig, null, 2)}\n` },
    { snap: rulesSnap, payload: `${JSON.stringify(updatedBookRules, null, 2)}\n` },
    { snap: novelCfgSnap, payload: `${JSON.stringify(updatedNovelConfig, null, 2)}\n` },
    { snap: journalSnap, payload: `${JSON.stringify(updatedJournal, null, 2)}\n` },
  ]

  const written: SnapshotRecord[] = []
  try {
    for (const step of writePlan) {
      await writeFileAtomic(`${root}/${step.snap.relativePath}`, step.payload)
      written.push(step.snap)
    }
  } catch (err) {
    // 自动回滚已写入的受管文件
    for (const snap of written.reverse()) {
      try {
        if (snap.existedBefore && snap.rawContent !== null) {
          await writeFileAtomic(`${root}/${snap.relativePath}`, snap.rawContent)
        } else if (snap.relativePath === BOOK_RULES_FILE) {
          await writeFileAtomic(`${root}/${snap.relativePath}`, `${JSON.stringify(EMPTY_BOOK_RULES, null, 2)}\n`)
        } else if (snap.relativePath === USER_SKILL_CONFIG_FILE) {
          await writeFileAtomic(`${root}/${snap.relativePath}`, `${JSON.stringify(baseSkillsCfg, null, 2)}\n`)
        } else if (snap.relativePath === NOVEL_CONFIG_RELATIVE_FILE) {
          await writeFileAtomic(`${root}/${snap.relativePath}`, `${JSON.stringify(parsedExistingNovelCfg, null, 2)}\n`)
        }
      } catch {
        // 尽最大努力恢复全部文件，保留主错误上报
      }
    }
    throw new Error(`应用工艺预设「${preset.name}」失败（已自动回滚 ${written.length} 个文件）：${toErrorMessage(err)}`)
  }

  return {
    txId,
    preset,
    backupDir: backupRelDir,
    addedSkills,
    disabledExperts: [...new Set(disabledExperts)],
    updatedNovelConfig,
    updatedBookRules,
    updatedUserSkillConfig,
  }
}

/**
 * 一键回滚最近一次已提交的工艺预设事务。
 */
export async function rollbackLastCraftPreset(projectPath: string): Promise<RollbackCraftPresetResult> {
  const root = normalizePath(projectPath).replace(/\/+$/, "")
  const journal = await loadCraftPresetJournal(projectPath)
  const targetIdx = [...journal.entries].reverse().findIndex((e) => e.status === "committed")
  if (targetIdx < 0) {
    throw new Error("当前项目没有可回滚的工艺预设记录")
  }
  const actualIdx = journal.entries.length - 1 - targetIdx
  const entry = journal.entries[actualIdx]!
  const restoredFiles: string[] = []

  for (const file of entry.files) {
    if (file.existedBefore) {
      const backupRaw = await readFile(`${root}/${entry.backupDir}/${file.backupFileName}`)
      await writeFileAtomic(`${root}/${file.relativePath}`, backupRaw)
      restoredFiles.push(file.relativePath)
    } else if (file.relativePath === BOOK_RULES_FILE) {
      await writeFileAtomic(`${root}/${file.relativePath}`, `${JSON.stringify(EMPTY_BOOK_RULES, null, 2)}\n`)
      restoredFiles.push(file.relativePath)
    } else if (file.relativePath === NOVEL_CONFIG_RELATIVE_FILE) {
      await writeFileAtomic(`${root}/${file.relativePath}`, `${JSON.stringify(DEFAULT_NOVEL_CONFIG, null, 2)}\n`)
      restoredFiles.push(file.relativePath)
    } else if (file.relativePath === USER_SKILL_CONFIG_FILE) {
      await writeFileAtomic(
        `${root}/${file.relativePath}`,
        `${JSON.stringify(ensureBuiltinSkills(normalizeUserSkillConfig(null)), null, 2)}\n`,
      )
      restoredFiles.push(file.relativePath)
    }
  }

  const nextEntries = journal.entries.map((item, idx) =>
    idx === actualIdx
      ? { ...item, status: "rolled_back" as const, rolledBackAt: new Date().toISOString() }
      : item,
  )
  await writeFileAtomic(
    `${root}/${PRESET_JOURNAL_FILE}`,
    `${JSON.stringify({ version: 1, entries: nextEntries }, null, 2)}\n`,
  )

  return {
    txId: entry.txId,
    presetId: entry.presetId,
    presetName: entry.presetName,
    restoredFiles,
  }
}

/** 计算某个工艺预设在当前项目可用技能库中尚未安装的技能名（去重保序）。 */
export function computeMissingPresetSkills(
  preset: CraftPresetDefinition,
  availableSkills: readonly UserSkill[],
): string[] {
  const installed = new Set<string>()
  for (const skill of availableSkills) {
    if (skill.name?.trim()) installed.add(skill.name.trim())
    if (skill.id?.trim()) installed.add(skill.id.trim())
  }
  const required = [
    ...(preset.taskSkillNames.outline ?? []),
    ...(preset.taskSkillNames.writing ?? []),
    ...(preset.taskSkillNames.review ?? []),
    preset.primaryExpert,
    ...(preset.secondaryExpert ? [preset.secondaryExpert] : []),
  ]
  const missing: string[] = []
  const seen = new Set<string>()
  for (const raw of required) {
    const name = raw?.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    if (!installed.has(name)) missing.push(name)
  }
  return missing
}

function normalizeStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return []
  return val
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
}

/** 解析用户导入的自定义 `craft-presets.json`（支持 `{ presets: [...] }` 或顶层数组）。 */
export function parseCustomCraftPresetsJson(rawJson: string): CraftPresetDefinition[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch (err) {
    throw new Error(`预设 JSON 解析失败：${toErrorMessage(err)}`)
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === "object" && Array.isArray((parsed as { presets?: unknown }).presets))
      ? (parsed as { presets: unknown[] }).presets
      : null
  if (!list || list.length === 0) {
    throw new Error("预设文件格式无效：需要非空的 presets 数组")
  }
  const result: CraftPresetDefinition[] = []
  const seenIds = new Set<string>()
  for (let i = 0; i < list.length; i += 1) {
    const raw = list[i]
    if (!raw || typeof raw !== "object") continue
    const rec = raw as Record<string, unknown>
    const id = typeof rec.id === "string" ? rec.id.trim() : ""
    const name = typeof rec.name === "string" ? rec.name.trim() : ""
    if (!id || !name || seenIds.has(id)) continue
    seenIds.add(id)
    const rawTaskNames = (rec.taskSkillNames && typeof rec.taskSkillNames === "object")
      ? (rec.taskSkillNames as Record<string, unknown>)
      : {}
    result.push({
      id,
      name,
      genres: normalizeStringArray(rec.genres),
      tone: typeof rec.tone === "string" ? rec.tone.trim() : "",
      primaryExpert: typeof rec.primaryExpert === "string" ? rec.primaryExpert.trim() : "",
      secondaryExpert: typeof rec.secondaryExpert === "string" && rec.secondaryExpert.trim()
        ? rec.secondaryExpert.trim()
        : null,
      craftSkills: normalizeStringArray(rec.craftSkills),
      characterSkills: normalizeStringArray(rec.characterSkills),
      suggestedSoulSkills: normalizeStringArray(rec.suggestedSoulSkills),
      coreRules: normalizeStringArray(rec.coreRules),
      avoidExperts: normalizeStringArray(rec.avoidExperts),
      taskSkillNames: {
        outline: normalizeStringArray(rawTaskNames.outline),
        writing: normalizeStringArray(rawTaskNames.writing),
        review: normalizeStringArray(rawTaskNames.review),
      },
      extraPromptHint: typeof rec.extraPromptHint === "string" ? rec.extraPromptHint.trim() : "",
      ...(Array.isArray(rec.defaultProhibitions)
        ? { defaultProhibitions: normalizeStringArray(rec.defaultProhibitions) }
        : {}),
    })
  }
  if (result.length === 0) {
    throw new Error("预设文件中未找到包含有效 id 与 name 的预设条目")
  }
  return result
}

export async function loadCustomCraftPresets(projectPath: string): Promise<CraftPresetDefinition[]> {
  const root = normalizePath(projectPath).replace(/\/+$/, "")
  const targetPath = `${root}/${CUSTOM_CRAFT_PRESETS_FILE}`
  try {
    if (!(await fileExists(targetPath))) return []
    const raw = await readFile(targetPath)
    if (!raw.trim()) return []
    return parseCustomCraftPresetsJson(raw)
  } catch {
    return []
  }
}

export async function saveCustomCraftPresets(
  projectPath: string,
  presets: readonly CraftPresetDefinition[],
): Promise<void> {
  const root = normalizePath(projectPath).replace(/\/+$/, "")
  const dirPath = `${root}/.niko-buddy`
  try {
    await createDirectory(dirPath)
  } catch {
    // 目录已存在时忽略
  }
  await writeFileAtomic(
    `${root}/${CUSTOM_CRAFT_PRESETS_FILE}`,
    `${JSON.stringify({ schemaVersion: 1, presets }, null, 2)}\n`,
  )
}
