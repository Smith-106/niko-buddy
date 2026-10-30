/**
 * de-ai-hit-labels.ts — 去AI味检测命中项的展示标签映射（RV-005 i18n）
 *
 * 背景：`DeAiDetectionHit.category` / `.suggestion` 的取值来自中文分级表与机械层词库
 * （`src/lib/novel/de-ai-tiered-table.ts` / `de-ai-adapter.ts`），是**数据**而非界面文案；
 * 界面若直接渲染这些中文值，英文 locale 下会出现中文泄漏。
 *
 * 做法（不改 lib 数据、不改解析契约）：lib 值当 id 用，本表把它们映射到 i18n key，
 * 对话框再经 `t()` 渲染。用户自定义/未来新增的表项没有映射时回退原文，
 * 不会出现「渲染出原始 key」的空白界面。
 */

/** 分级表分类标签 → i18n key（含机械层通用分类「机械词」） */
export const DE_AI_HIT_CATEGORY_KEYS: Readonly<Record<string, string>> = {
  "总结腔": "novel.deai.category.summaryTone",
  "解释腔": "novel.deai.category.explainingTone",
  "模板句首": "novel.deai.category.templateOpener",
  "空洞形容": "novel.deai.category.vagueDescription",
  "转折滥用": "novel.deai.category.overusedContrast",
  "AI特征词": "novel.deai.category.aiSignatureWord",
  "套话": "novel.deai.category.cliche",
  "机械句式": "novel.deai.category.mechanicalPattern",
  "叙事缺陷": "novel.deai.category.narrativeFlaw",
  "冗余": "novel.deai.category.redundancy",
  "装饰副词": "novel.deai.category.decorativeAdverb",
  "模糊限制": "novel.deai.category.hedging",
  "冗余修饰": "novel.deai.category.redundantModifier",
  "节奏拖沓": "novel.deai.category.sluggishPacing",
  "机械过渡": "novel.deai.category.mechanicalTransition",
  "平淡动作": "novel.deai.category.flatAction",
  "解释腔弱化": "novel.deai.category.mildExplaining",
  "轻度AI腔": "novel.deai.category.mildAiTone",
  "弱解释": "novel.deai.category.weakExplanation",
  "通用模糊": "novel.deai.category.genericVagueness",
  "夸大腔": "novel.deai.category.exaggeration",
  "格言腔": "novel.deai.category.aphorismTone",
  "二元对立": "novel.deai.category.binaryOpposition",
  "稻草人": "novel.deai.category.strawMan",
  "抽象总结": "novel.deai.category.abstractSummary",
  "情感虚饰": "novel.deai.category.emotionalDecoration",
  "机械词": "novel.deai.category.mechanicalTerm",
}

/** 改写建议 → i18n key（含机械层通用建议） */
export const DE_AI_HIT_SUGGESTION_KEYS: Readonly<Record<string, string>> = {
  "删掉或改为具体所指": "novel.deai.suggestion.removeOrSpecify",
  "删掉，让事实自己说话": "novel.deai.suggestion.deleteLetFactsSpeak",
  "删掉，直接陈述": "novel.deai.suggestion.deleteStateDirectly",
  "删掉，用具体情节替代": "novel.deai.suggestion.deleteUseConcreteScene",
  "删掉，信任读者判断": "novel.deai.suggestion.deleteTrustReader",
  "小说中禁用，直接推进": "novel.deai.suggestion.novelBannedAdvance",
  "删掉，信息自然嵌入叙事": "novel.deai.suggestion.deleteEmbedInfo",
  "删掉，直接呈现": "novel.deai.suggestion.deleteShowDirectly",
  "删掉，让描写替代结论": "novel.deai.suggestion.deleteLetDescriptionConclude",
  "删掉，小说世界不需要外提示": "novel.deai.suggestion.deleteNoOutsideHint",
  "删掉，直接推进叙事": "novel.deai.suggestion.deleteAdvanceNarrative",
  "删掉，信任读者理解": "novel.deai.suggestion.deleteTrustComprehension",
  "删掉，直接说": "novel.deai.suggestion.deleteSayPlainly",
  "删掉，只保留一种表达": "novel.deai.suggestion.deleteKeepOnePhrasing",
  "删掉，保持叙事统一": "novel.deai.suggestion.deleteKeepVoiceConsistent",
  "替换为'即'或直接删": "novel.deai.suggestion.replaceWithJi",
  "删掉，不重复解释": "novel.deai.suggestion.deleteNoReexplain",
  "删掉，用叙事呈现本质": "novel.deai.suggestion.deleteShowEssence",
  "删掉，直接推进": "novel.deai.suggestion.deleteAdvance",
  "每章 ≤1 次，换'同时'或直接续写": "novel.deai.suggestion.limitOncePerChapterMeanwhile",
  "删掉，动作直接衔接": "novel.deai.suggestion.deleteJoinActions",
  "每章 ≤1 次，换具体时间提示": "novel.deai.suggestion.limitOncePerChapterTimeHint",
  "删掉，直接写事件": "novel.deai.suggestion.deleteWriteEvent",
  "用具体细节替代'复杂'": "novel.deai.suggestion.replaceComplexWithDetail",
  "用具体动作/环境替代": "novel.deai.suggestion.replaceWithActionOrSetting",
  "删掉，用具体描写呈现": "novel.deai.suggestion.deleteShowConcretely",
  "用具体特征替代'独特'": "novel.deai.suggestion.replaceUniqueWithTrait",
  "用具体细节替代'特殊'": "novel.deai.suggestion.replaceSpecialWithDetail",
  "一段内不超过 1 个转折": "novel.deai.suggestion.oneContrastPerParagraph",
  "一段内不超过 1 个'但是'": "novel.deai.suggestion.oneButPerParagraph",
  "合理语境保留，过度使用(≥3次/段)删": "novel.deai.suggestion.keepUnlessOverusedPerParagraph",
  "换'像'或直接描写": "novel.deai.suggestion.useSimileOrDescribe",
  "每章 ≤2 次，换'像'或直接描写": "novel.deai.suggestion.limitTwicePerChapter",
  "小说中禁用，信息自然嵌入": "novel.deai.suggestion.novelBannedEmbedInfo",
  "小说中禁用，直接呈现": "novel.deai.suggestion.novelBannedShowDirectly",
  "删掉，信任读者": "novel.deai.suggestion.deleteTrustReaderShort",
  "换具体动作描写": "novel.deai.suggestion.replaceWithConcreteAction",
  "换具体感官细节": "novel.deai.suggestion.replaceWithSensoryDetail",
  "用动作/对白替代情绪总结": "novel.deai.suggestion.replaceEmotionWithAction",
  "用行动展示坚定": "novel.deai.suggestion.showResolveThroughAction",
  "删掉，直接写结果": "novel.deai.suggestion.deleteWriteOutcome",
  "用具体对峙细节替代": "novel.deai.suggestion.replaceWithStandoffDetail",
  "删掉解释，信任读者": "novel.deai.suggestion.deleteExplanation",
  "用动作/对白表现失望": "novel.deai.suggestion.showDisappointment",
  "用动作/对白表现欣慰": "novel.deai.suggestion.showRelief",
  "用具体细节替代情绪总结": "novel.deai.suggestion.replaceMoodSummaryWithDetail",
  "用动作/对白呈现情绪": "novel.deai.suggestion.showEmotionThroughAction",
  "用具体层面替代'维度'": "novel.deai.suggestion.replaceDimension",
  "用具体描写替代": "novel.deai.suggestion.replaceWithConcreteDescription",
  "换'显出'或'体现'": "novel.deai.suggestion.useShowVerb",
  "用具体细节让读者自己判断": "novel.deai.suggestion.letReaderJudge",
  "非必要即删，保留风格用法": "novel.deai.suggestion.cutUnlessStylistic",
  "换具体程度或删": "novel.deai.suggestion.replaceDegreeOrCut",
  "合理语境保留，过度使用删": "novel.deai.suggestion.keepUnlessOverused",
  "用具体程度替代或删": "novel.deai.suggestion.replaceDegreeOrDelete",
  "直接写时间点或删": "novel.deai.suggestion.writeTimepointOrCut",
  "每章 ≤1 次，保留悬念用法": "novel.deai.suggestion.limitOnceKeepSuspense",
  "一段内不超过 1 次": "novel.deai.suggestion.oncePerParagraph",
  "直接写结果或删": "novel.deai.suggestion.writeResultOrCut",
  "用具体动作或对白替代": "novel.deai.suggestion.replaceWithActionOrDialogue",
  "保留必要用法，过度使用删": "novel.deai.suggestion.keepNecessaryCutExcess",
  "合理语境保留，过频(≥3次/章)删": "novel.deai.suggestion.keepUnlessFrequentPerChapter",
  "删掉或少用，直接陈述": "novel.deai.suggestion.cutOrStateDirectly",
  "用具体名词替代'某种'": "novel.deai.suggestion.replaceSomeKind",
  "用具体程度替代": "novel.deai.suggestion.replaceWithDegree",
  "用具体所指替代": "novel.deai.suggestion.replaceWithReferent",
  "用感官动词替代'感觉'": "novel.deai.suggestion.replaceFeelVerb",
  "删掉绝对化，用具体事件呈现": "novel.deai.suggestion.dropAbsolutes",
  "删掉，直接写变化本身": "novel.deai.suggestion.writeChangeItself",
  "用具体节点替代抽象里程碑": "novel.deai.suggestion.replaceMilestone",
  "删掉，让情节自己说明": "novel.deai.suggestion.letPlotSpeak",
  "叙事中慎用总结式格言": "novel.deai.suggestion.avoidAphorismInNarration",
  "删掉，直接呈现事实": "novel.deai.suggestion.showFactsDirectly",
  "避免非此即彼的绝对化选择": "novel.deai.suggestion.avoidBinaryChoice",
  "删掉，呈现中间可能": "novel.deai.suggestion.showMiddleGround",
  "避免自设靶子，直接写观点": "novel.deai.suggestion.avoidStrawMan",
  "删掉，让叙事自己收束": "novel.deai.suggestion.letNarrativeClose",
  "用具体感官替代情绪总结": "novel.deai.suggestion.replaceEmotionWithSensory",
  "用具体情节替代情绪总结": "novel.deai.suggestion.replaceEmotionWithScene",
  "建议删除或替换为具体生动的描写": "novel.deai.suggestion.mechanicalReplaceWithVivid",
}

/** 分级徽标：1A / 1B / 3 走插值 key，slop（机械层正则/词库命中）单独一条 */
export const DE_AI_TIER_LABEL_KEY = "novel.deai.tierLabel"
export const DE_AI_TIER_MECHANICAL_KEY = "novel.deai.tierMechanicalLayer"

/** slopClass 徽标（clean / warn / block） */
export const DE_AI_SLOP_CLASS_KEYS: Readonly<Record<string, string>> = {
  clean: "novel.deai.slopClassClean",
  warn: "novel.deai.slopClassWarn",
  block: "novel.deai.slopClassBlock",
}
