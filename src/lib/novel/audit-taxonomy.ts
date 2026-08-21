/**
 * audit-taxonomy.ts — T22 37 维审计注册表 + GATE_MAPPING + 文学提升维
 *
 * 蓝图 §6 T22 / F-15 / A-04.1:
 *   37 维审计维度覆盖 Consistency(P0) / Anti-AI(P1) / Quality(P2) 三门控，
 *   每维对应一个可机械检测或 LLM 辅助检测的审计项。
 *
 * GATE_MAPPING:
 *   3 gate 按 R4 优先级 (Consistency > Anti-AI > Quality) 排序，
 *   每 gate 含 dimensionIds 列表与门控配置。
 *
 * LITERARY_DIMS:
 *   文学提升维（≥4），独立于 37 维注册表，用于 Track B / L9 书稿质量评估。
 *   与 37 维无重叠（对照表见 decision-log/2026-08-21-t22-audit-taxonomy.md）。
 *
 * 机械层零模型调用 (ADR-19): 本文件只含纯数据常量与类型契约，
 * 无 IO / 无网络 / 无模型调用 / 无 Tauri 命令调用。
 *
 * @license MIT © QMAI
 */

// ============================================================================
// 维度 ID 类型 (37 维 + 文学维 互斥命名空间)
// ============================================================================

/** 37 维审计维度 ID (严格 37 值 union)。 */
export type AuditDimensionId =
  // ── Consistency Gate (P0) — 15 维 ──
  | "timeline_consistency"       // 时间线一致性
  | "character_consistency"      // 人设一致性
  | "setting_consistency"        // 设定一致性
  | "foreshadowing_integrity"    // 伏笔完整性
  | "plot_continuity"            // 剧情连续性
  | "causal_chain"               // 因果链
  | "knowledge_boundary"         // 认知边界
  | "memory_consistency"         // 记忆一致性
  | "location_consistency"       // 地点一致性
  | "ability_consistency"        // 能力体系一致性
  | "subplot_resolution"         // 支线闭环
  | "arc_structural"             // 弧线结构
  | "canon_alignment"            // 正典对齐
  | "secret_guarding"            // 秘密保护
  | "emotional_arc_consistency"  // 情绪弧一致性
  // ── Anti-AI Gate (P1) — 10 维 ──
  | "slop_explanation"           // 解释腔检测
  | "slop_summary"               // 总结腔检测
  | "slop_mechanical"            // 机械句式
  | "slop_emotion_abstract"      // 情绪概述
  | "statistical_ai_signature"   // 统计 AI 签名
  | "de_ai_residual"             // 去 AI 残留
  | "behavioral_repetition"      // 行为重复
  | "formulaic_transition"       // 公式化过渡
  | "generic_description"        // 泛化描述
  | "translationese"             // 翻译腔
  // ── Quality Gate (P2) — 12 维 ──
  | "thrill_density"             // 爽感密度
  | "reading_power"              // 阅读引力
  | "pacing_tension"             // 节奏张力
  | "dialogue_quality"           // 对话质量
  | "description_vividness"      // 描写生动性
  | "emotional_impact"           // 情绪冲击
  | "structural_balance"         // 结构平衡
  | "narrative_innovation"       // 叙事创新
  | "consistency_of_voice"       // 文风一致
  | "scene_craft"                // 场景技巧
  | "tension_curve"              // 张力曲线
  | "worldbuilding_immersion"    // 世界观沉浸

/** 文学提升维 ID (独立于 37 维)。 */
export type LiteraryDimId =
  | "payoff_closure"             // 爽点闭环
  | "arc_consistency"            // 弧光一致性
  | "hook_strength"              // 钩子强度
  | "significant_detail"         // 显著细节
  | "emotional_resonance"        // 情绪共鸣

/** 门控键 (R4 优先级排序)。 */
export type GateKey = "consistency" | "anti_ai" | "quality"

// ============================================================================
// 维度定义类型
// ============================================================================

export interface AuditDimensionDefinition {
  /** 维度唯一 ID (37 维之一)。 */
  id: AuditDimensionId
  /** 人类可读标签 (中文，用于 UI / 报告)。 */
  label: string
  /** 归属门控键。 */
  gate: GateKey
  /** 维度描述 (审计目的)。 */
  description: string
  /** 检测方式枚举: mechanical(纯机械) / llm(LLM辅助) / hybrid(混合)。 */
  detectionMethod: "mechanical" | "llm" | "hybrid"
  /** 严重级别基线: 该维发现问题时的默认严重度。 */
  defaultSeverity: "error" | "warning" | "info"
  /** 审计检查项列表 (≥1)。 */
  checks: string[]
}

export interface LiteraryDimDefinition {
  /** 文学维唯一 ID。 */
  id: LiteraryDimId
  /** 人类可读标签。 */
  label: string
  /** 维度描述。 */
  description: string
  /** 评估检查项。 */
  checks: string[]
}

export interface GateConfig {
  /** 门控键。 */
  key: GateKey
  /** 门控优先级 (0=P0 最高, 1=P1, 2=P2)。 */
  priority: 0 | 1 | 2
  /** 标签 (中文)。 */
  label: string
  /** 描述。 */
  description: string
  /** 归属此门的审计维度 ID 列表。 */
  dimensionIds: AuditDimensionId[]
  /** 触发阻断的 severity 阈值: "error" 及以上阻断。 */
  blockingSeverity: "error"
}

// ============================================================================
// 37 维完整注册表 (AUDIT_TAXONOMY)
// ============================================================================

/**
 * 37 维审计维度定义表。
 * 按 gate 分组: Consistency(15) / Anti-AI(10) / Quality(12) = 37。
 */
export const AUDIT_TAXONOMY: Record<AuditDimensionId, AuditDimensionDefinition> = {
  // ═══════════════════════════════════════════════════════════════════
  // Consistency Gate (P0) — 15 维
  // ═══════════════════════════════════════════════════════════════════
  timeline_consistency: {
    id: "timeline_consistency",
    label: "时间线一致性",
    gate: "consistency",
    description: "检查章节内与章节间的时间顺序、时长、日期是否一致，无前后矛盾。",
    detectionMethod: "mechanical",
    defaultSeverity: "error",
    checks: [
      "本章时间点与前一章结尾是否衔接",
      "事件顺序是否合乎逻辑（因果不倒置）",
      "时间跨度与章节内发生的事件量是否匹配",
      "日期/季节/天气等时间锚点是否与前后文一致",
    ],
  },
  character_consistency: {
    id: "character_consistency",
    label: "人设一致性",
    gate: "consistency",
    description: "检查角色行为、语言、决策是否符合已登记的人设、光环、认知状态。",
    detectionMethod: "hybrid",
    defaultSeverity: "error",
    checks: [
      "关键选择是否有动机支撑",
      "台词是否符合身份、性格和关系网",
      "角色是否知道了不该知道的信息",
      "变化是否有触发原因和过渡",
    ],
  },
  setting_consistency: {
    id: "setting_consistency",
    label: "设定一致性",
    gate: "consistency",
    description: "检查世界观规则、能力体系、组织架构等设定是否前后一致。",
    detectionMethod: "hybrid",
    defaultSeverity: "error",
    checks: [
      "能力、物品、组织、地点和规则是否违背旧设定",
      "新增规则是否有边界、代价和触发条件",
      "设定是否参与冲突和选择而非装饰",
      "是否存在作者硬送或临时开挂",
    ],
  },
  foreshadowing_integrity: {
    id: "foreshadowing_integrity",
    label: "伏笔完整性",
    gate: "consistency",
    description: "检查已登记的伏笔是否被适当回收或推进，未登记的潜在伏笔是否被遗忘。",
    detectionMethod: "mechanical",
    defaultSeverity: "warning",
    checks: [
      "已登记伏笔是否在预期章节内回收",
      "逾期伏笔是否被标记为逾期并触发提醒",
      "新引入的元素是否应登记为伏笔",
      "伏笔回收方式是否与原设定一致",
    ],
  },
  plot_continuity: {
    id: "plot_continuity",
    label: "剧情连续性",
    gate: "consistency",
    description: "检查章节之间的事件、状态、情绪是否连续衔接。",
    detectionMethod: "hybrid",
    defaultSeverity: "error",
    checks: [
      "开头是否承接上一章地点、状态、情绪和动作",
      "正文是否完成当前章纲目标",
      "事件是否有清晰因果链而非跳跃",
      "章节结尾是否为下一章留出合理入口",
    ],
  },
  causal_chain: {
    id: "causal_chain",
    label: "因果链",
    gate: "consistency",
    description: "检查事件发展是否遵循因果逻辑，无凭空产生的结果或无因果的转折。",
    detectionMethod: "mechanical",
    defaultSeverity: "warning",
    checks: [
      "每个重大事件是否有前因铺垫",
      "角色决策是否有合理动机而非剧情需要",
      "巧合使用是否适度（不超过 1 次/章关键事件）",
      "反转是否有足够铺垫而非机械降神",
    ],
  },
  knowledge_boundary: {
    id: "knowledge_boundary",
    label: "认知边界",
    gate: "consistency",
    description: "检查角色所知信息是否与其经历、身份、时间线一致，无超前知识。",
    detectionMethod: "mechanical",
    defaultSeverity: "error",
    checks: [
      "角色是否知道其不应该知道的信息",
      "机密/秘密信息是否被正确圈定在知情角色范围内",
      "角色认知状态是否随章节推进正确更新",
      "旁白/叙述是否泄露了角色不应知道的信息",
    ],
  },
  memory_consistency: {
    id: "memory_consistency",
    label: "记忆一致性",
    gate: "consistency",
    description: "检查角色对过往事件的记忆是否与正典记录一致，无遗忘或篡改。",
    detectionMethod: "mechanical",
    defaultSeverity: "error",
    checks: [
      "角色回忆的过往事件是否与正典记录一致",
      "角色间对同一事件的记忆是否存在不应有的分歧",
      "创伤/重要经历是否被角色正确记忆而非遗忘",
      "记忆偏差是否被合理标记（如不可靠叙述者）",
    ],
  },
  location_consistency: {
    id: "location_consistency",
    label: "地点一致性",
    gate: "consistency",
    description: "检查地点名称、空间关系、移动耗时等地理信息是否一致。",
    detectionMethod: "mechanical",
    defaultSeverity: "warning",
    checks: [
      "地点名称前后是否一致（无别名混用）",
      "角色移动时间是否与距离/交通方式匹配",
      "空间方位关系是否前后一致",
      "场景切换是否标记明确",
    ],
  },
  ability_consistency: {
    id: "ability_consistency",
    label: "能力体系一致性",
    gate: "consistency",
    description: "检查角色能力、技能、力量体系是否遵循已有设定，无突然增强/削弱。",
    detectionMethod: "hybrid",
    defaultSeverity: "error",
    checks: [
      "能力使用是否遵循已登记的边界与代价",
      "能力成长是否有合理训练/突破过程",
      "能力克制关系是否一致",
      "是否存在未经设定的新能力突然出现",
    ],
  },
  subplot_resolution: {
    id: "subplot_resolution",
    label: "支线闭环",
    gate: "consistency",
    description: "检查已开启的支线是否在合理周期内推进或闭环，无遗忘支线。",
    detectionMethod: "mechanical",
    defaultSeverity: "warning",
    checks: [
      "已开启的支线是否在预期章数内推进",
      "休眠支线是否被标记并安排后续登场",
      "支线与主线的关系是否清晰",
      "支线角色是否在支线休眠期间被合理提及",
    ],
  },
  arc_structural: {
    id: "arc_structural",
    label: "弧线结构",
    gate: "consistency",
    description: "检查故事弧线的起承转合是否完整，弧段边界是否清晰。",
    detectionMethod: "hybrid",
    defaultSeverity: "warning",
    checks: [
      "当前弧线是否处于正确阶段（起/承/转/合）",
      "弧段转换是否有明确的触发事件",
      "弧内章节是否服务于弧线主题",
      "多弧并行时切换是否清晰",
    ],
  },
  canon_alignment: {
    id: "canon_alignment",
    label: "正典对齐",
    gate: "consistency",
    description: "检查章节内容是否与正典存储（canon store）中的事实一致。",
    detectionMethod: "mechanical",
    defaultSeverity: "error",
    checks: [
      "本章事实是否与正典记录无冲突",
      "新引入的事实是否可注入正典",
      "正典中标记为 superseded 的事实是否未被引用",
      "invalidate 链是否完整",
    ],
  },
  secret_guarding: {
    id: "secret_guarding",
    label: "秘密保护",
    gate: "consistency",
    description: "检查故事中的秘密/机密信息是否在正确的时间点被正确角色揭露。",
    detectionMethod: "hybrid",
    defaultSeverity: "error",
    checks: [
      "秘密是否在正确的叙事节点揭露",
      "提前泄露是否被标记为作者失误",
      "揭露秘密时是否有足够的叙事冲击力",
      "秘密被揭露后其他角色的反应是否合理",
    ],
  },
  emotional_arc_consistency: {
    id: "emotional_arc_consistency",
    label: "情绪弧一致性",
    gate: "consistency",
    description: "检查角色情绪变化轨迹是否与前文情绪账本（emotion ledger）一致。",
    detectionMethod: "mechanical",
    defaultSeverity: "warning",
    checks: [
      "角色当前情绪状态是否与 emotion ledger 预测一致",
      "情绪突变是否有充足触发事件",
      "情绪恢复速度是否与角色性格和创伤程度匹配",
      "多角色情绪场互动是否合理",
    ],
  },

  // ═══════════════════════════════════════════════════════════════════
  // Anti-AI Gate (P1) — 10 维
  // ═══════════════════════════════════════════════════════════════════
  slop_explanation: {
    id: "slop_explanation",
    label: "解释腔检测",
    gate: "anti_ai",
    description: "检测模型是否通过旁白解释角色情绪/动机，而非通过行动和对话展示。",
    detectionMethod: "mechanical",
    defaultSeverity: "warning",
    checks: [
      "是否存在'他感到...''她意识到...'等直接情绪解释",
      "情绪是否通过动作、对话、环境描写间接展示",
      "是否存在作者跳出来解释设定的段落",
      "解释腔段落占比是否超过阈值",
    ],
  },
  slop_summary: {
    id: "slop_summary",
    label: "总结腔检测",
    gate: "anti_ai",
    description: "检测段落末尾是否出现总结性概括，破坏 show-don't-tell 原则。",
    detectionMethod: "mechanical",
    defaultSeverity: "warning",
    checks: [
      "段尾是否出现'这就是...''从此...'等总结句式",
      "事件描述后是否紧跟抽象概括",
      "对话后是否跟解释性旁白总结对话含义",
      "是否存在'这一幕展现了...'式元叙述",
    ],
  },
  slop_mechanical: {
    id: "slop_mechanical",
    label: "机械句式",
    gate: "anti_ai",
    description: "检测机械重复的句式结构、过渡词、套路化表达。",
    detectionMethod: "mechanical",
    defaultSeverity: "warning",
    checks: [
      "段落开头是否重复使用同一句式",
      "过渡词（然而/但是/突然/就在这时）频率是否过高",
      "是否存在模板化动作描写（他转过身/她点了点头）",
      "句式长度分布是否过于均匀（AI 特征）",
    ],
  },
  slop_emotion_abstract: {
    id: "slop_emotion_abstract",
    label: "情绪概述",
    gate: "anti_ai",
    description: "检测是否用抽象情绪词替代具体描写，如'他很生气'而非'他握紧拳头'。",
    detectionMethod: "mechanical",
    defaultSeverity: "warning",
    checks: [
      "抽象情绪词（生气/开心/悲伤/恐惧）出现频率是否过高",
      "情绪是否伴随具体身体反应描写",
      "是否存在连续抽象情绪堆积",
      "情绪词是否被具体动作替代",
    ],
  },
  statistical_ai_signature: {
    id: "statistical_ai_signature",
    label: "统计 AI 签名",
    gate: "anti_ai",
    description: "通过统计特征（词频分布、熵值、重复率）检测 AI 生成痕迹。",
    detectionMethod: "mechanical",
    defaultSeverity: "info",
    checks: [
      "词频分布是否偏离人类写作基线",
      "标点符号使用模式是否过于规整",
      "段落长度方差是否过小",
      "n-gram 重复率是否超过阈值",
    ],
  },
  de_ai_residual: {
    id: "de_ai_residual",
    label: "去 AI 残留",
    gate: "anti_ai",
    description: "检测去 AI 处理后的残留 AI 特征，用于双遍检测后的残余标记。",
    detectionMethod: "mechanical",
    defaultSeverity: "warning",
    checks: [
      "去 AI 处理后是否仍有 dualPassRecheck 标记",
      "1A 档高权重词是否仍有残留",
      "1B 档低权重词是否过度修正",
      "residual 标记是否需要人工审查",
    ],
  },
  behavioral_repetition: {
    id: "behavioral_repetition",
    label: "行为重复",
    gate: "anti_ai",
    description: "检测角色行为模式是否出现标签化重复，如反复出现同一动作/口头禅。",
    detectionMethod: "mechanical",
    defaultSeverity: "warning",
    checks: [
      "同一角色相同动作标签是否出现 ≥3 次/章",
      "口头禅/习惯动作是否过度使用",
      "角色互动模式是否固化",
      "差异化微动作替代是否不足",
    ],
  },
  formulaic_transition: {
    id: "formulaic_transition",
    label: "公式化过渡",
    gate: "anti_ai",
    description: "检测场景/段落之间的过渡是否使用套路化语句。",
    detectionMethod: "mechanical",
    defaultSeverity: "info",
    checks: [
      "场景切换是否使用'与此同时''另一边'等套路过渡",
      "时间跳跃是否使用'几天后''第二天'等机械标记",
      "过渡段是否缺乏文学性",
      "是否存在不必要的过渡填充",
    ],
  },
  generic_description: {
    id: "generic_description",
    label: "泛化描述",
    gate: "anti_ai",
    description: "检测描写是否过于泛化，缺乏具体感官细节和独特性。",
    detectionMethod: "hybrid",
    defaultSeverity: "info",
    checks: [
      "环境描写是否包含具体感官细节（视觉/听觉/嗅觉/触觉）",
      "描述是否过于模板化（'阳光明媚''乌云密布'）",
      "同一场景的描写是否每次都有新细节",
      "是否存在可替换到任何故事中的通用段落",
    ],
  },
  translationese: {
    id: "translationese",
    label: "翻译腔",
    gate: "anti_ai",
    description: "检测是否出现英译中常见的句式结构、语序倒置、欧化表达。",
    detectionMethod: "mechanical",
    defaultSeverity: "info",
    checks: [
      "是否存在'作为...''...之一'等欧化句式",
      "定语从句式长修饰语是否过多",
      "被动语态使用是否超出中文习惯",
      "人称代词使用频率是否偏高（英译中特征）",
    ],
  },

  // ═══════════════════════════════════════════════════════════════════
  // Quality Gate (P2) — 12 维
  // ═══════════════════════════════════════════════════════════════════
  thrill_density: {
    id: "thrill_density",
    label: "爽感密度",
    gate: "quality",
    description: "评估章节中爽点（打脸、反杀、成长、揭谜、奖励兑现）的密度与质量。",
    detectionMethod: "llm",
    defaultSeverity: "info",
    checks: [
      "爽点是否由主角选择、能力或决断推动",
      "压抑-释放链是否完整",
      "爽点密度是否在合理区间（不过密也不过疏）",
      "解释、重复和旁人代打是否削弱爽感",
    ],
  },
  reading_power: {
    id: "reading_power",
    label: "阅读引力",
    gate: "quality",
    description: "评估读者继续阅读的动力，含钩子效果、悬念强度、情绪停点。",
    detectionMethod: "llm",
    defaultSeverity: "info",
    checks: [
      "是否留下新危机、新目标、新反转或新信息",
      "下一章期待是否明确",
      "结尾是否停在高张力或强情绪点",
      "悬念是否有正文证据而非空钩子",
    ],
  },
  pacing_tension: {
    id: "pacing_tension",
    label: "节奏张力",
    gate: "quality",
    description: "评估章节的推进力、压力变化、信息密度与转折频率。",
    detectionMethod: "llm",
    defaultSeverity: "info",
    checks: [
      "每个场景是否有目标、阻力和结果",
      "张力是否升级或反转",
      "说明、内心和背景是否压过行动",
      "是否存在水文、重复、跳转过快或关键冲突没写足",
    ],
  },
  dialogue_quality: {
    id: "dialogue_quality",
    label: "对话质量",
    gate: "quality",
    description: "评估对话的自然度、个性化和子文本，是否服务于角色塑造和剧情推进。",
    detectionMethod: "llm",
    defaultSeverity: "info",
    checks: [
      "对话是否符合角色身份和性格",
      "对话是否包含潜台词而非直白陈述",
      "对话节奏是否自然（有停顿、打断、沉默）",
      "对话是否服务于角色塑造或剧情推进",
    ],
  },
  description_vividness: {
    id: "description_vividness",
    label: "描写生动性",
    gate: "quality",
    description: "评估描写的具象化程度、感官丰富度和独特性。",
    detectionMethod: "llm",
    defaultSeverity: "info",
    checks: [
      "描写是否调用多感官（视/听/嗅/触/味）",
      "比喻是否新颖而非陈词滥调",
      "环境描写是否服务于氛围和情绪",
      "是否存在过度描写（信息密度过低）",
    ],
  },
  emotional_impact: {
    id: "emotional_impact",
    label: "情绪冲击",
    gate: "quality",
    description: "评估关键场景的情绪冲击力和读者共鸣潜力。",
    detectionMethod: "llm",
    defaultSeverity: "info",
    checks: [
      "关键场景是否建立足够情绪铺垫",
      "情绪释放时机是否准确",
      "读者是否被带入角色视角而非旁观",
      "情绪曲线是否有起伏而非平铺直叙",
    ],
  },
  structural_balance: {
    id: "structural_balance",
    label: "结构平衡",
    gate: "quality",
    description: "评估章节内部结构（起承转合、场景分配、信息铺陈）是否合理。",
    detectionMethod: "llm",
    defaultSeverity: "info",
    checks: [
      "章节是否有明确的起承转合结构",
      "场景之间的篇幅分配是否合理",
      "信息铺陈密度是否均匀",
      "高潮位置是否在黄金分割点附近",
    ],
  },
  narrative_innovation: {
    id: "narrative_innovation",
    label: "叙事创新",
    gate: "quality",
    description: "评估叙事手法、视角、时间线组织等是否有创新性或突破常规的尝试。",
    detectionMethod: "llm",
    defaultSeverity: "info",
    checks: [
      "叙事视角是否一贯且合理",
      "时间线组织是否服务于叙事效果",
      "是否存在有创意的叙事手法",
      "创新手法是否服务于故事而非炫技",
    ],
  },
  consistency_of_voice: {
    id: "consistency_of_voice",
    label: "文风一致",
    gate: "quality",
    description: "评估全书/全卷的文风是否统一，语言风格是否与题材和基调匹配。",
    detectionMethod: "llm",
    defaultSeverity: "info",
    checks: [
      "文风是否与全书基调一致",
      "叙述语言是否与角色视角匹配",
      "是否存在风格突变（无合理理由）",
      "语言水平是否在全章保持一致",
    ],
  },
  scene_craft: {
    id: "scene_craft",
    label: "场景技巧",
    gate: "quality",
    description: "评估单个场景的构建技巧（进入/冲突/退出、信息铺陈、节奏控制）。",
    detectionMethod: "llm",
    defaultSeverity: "info",
    checks: [
      "场景是否有明确的进入点和退出点",
      "场景内冲突是否有层次地展开",
      "信息铺陈是否自然融入场景",
      "场景结尾是否为下一场景铺垫",
    ],
  },
  tension_curve: {
    id: "tension_curve",
    label: "张力曲线",
    gate: "quality",
    description: "评估章节内张力曲线的形状、峰值位置和恢复节奏是否合理。",
    detectionMethod: "llm",
    defaultSeverity: "info",
    checks: [
      "张力曲线是否有合理的上升-峰值-下降节奏",
      "峰值位置是否在章节后 1/3 段",
      "张力恢复是否有缓冲而非骤降",
      "是否存在张力空洞（过长无张力段落）",
    ],
  },
  worldbuilding_immersion: {
    id: "worldbuilding_immersion",
    label: "世界观沉浸",
    gate: "quality",
    description: "评估世界观细节是否自然融入叙事，而非信息倾倒。",
    detectionMethod: "llm",
    defaultSeverity: "info",
    checks: [
      "世界观信息是否通过行动和冲突展示而非旁白",
      "设定细节是否服务于当前场景而非单纯展示",
      "文化/社会/历史背景是否有机融入",
      "是否存在信息倾倒段落",
    ],
  },
}

// ============================================================================
// GATE_MAPPING — 3 gate 门控配置 (R4 优先级 Consistency > Anti-AI > Quality)
// ============================================================================

/** 门控优先级顺序 (索引 = 优先级, 0 最高)。 */
export const GATE_PRIORITY_ORDER: GateKey[] = ["consistency", "anti_ai", "quality"]

/**
 * 三 gate 配置映射。
 * 按 R4 优先级排序: Consistency(P0) > Anti-AI(P1) > Quality(P2)。
 * 门控优先级固定 (CLAUDE.md 硬约束 3): Quality 不得覆盖 Consistency 的失败。
 */
export const GATE_MAPPING: Record<GateKey, GateConfig> = {
  consistency: {
    key: "consistency",
    priority: 0,
    label: "设定一致性",
    description: "设定、叙事、角色的机械一致性门控 (P0，最高优先级)",
    dimensionIds: [
      "timeline_consistency",
      "character_consistency",
      "setting_consistency",
      "foreshadowing_integrity",
      "plot_continuity",
      "causal_chain",
      "knowledge_boundary",
      "memory_consistency",
      "location_consistency",
      "ability_consistency",
      "subplot_resolution",
      "arc_structural",
      "canon_alignment",
      "secret_guarding",
      "emotional_arc_consistency",
    ],
    blockingSeverity: "error",
  },
  anti_ai: {
    key: "anti_ai",
    priority: 1,
    label: "反 AI 味",
    description: "AI 味与机械模式检测门控 (P1)",
    dimensionIds: [
      "slop_explanation",
      "slop_summary",
      "slop_mechanical",
      "slop_emotion_abstract",
      "statistical_ai_signature",
      "de_ai_residual",
      "behavioral_repetition",
      "formulaic_transition",
      "generic_description",
      "translationese",
    ],
    blockingSeverity: "error",
  },
  quality: {
    key: "quality",
    priority: 2,
    label: "文学质量",
    description: "文学质量与阅读体验门控 (P2，永不覆盖 P0/P1)",
    dimensionIds: [
      "thrill_density",
      "reading_power",
      "pacing_tension",
      "dialogue_quality",
      "description_vividness",
      "emotional_impact",
      "structural_balance",
      "narrative_innovation",
      "consistency_of_voice",
      "scene_craft",
      "tension_curve",
      "worldbuilding_immersion",
    ],
    blockingSeverity: "error",
  },
}

// ============================================================================
// 门控配置导出
// ============================================================================

/** 所有门控键列表 (按优先级排序)。 */
export const ALL_GATE_KEYS: GateKey[] = GATE_PRIORITY_ORDER

/** 37 维 ID 完整列表 (按 gate 分组)。 */
export const ALL_AUDIT_DIMENSION_IDS: AuditDimensionId[] = [
  // Consistency (15)
  ...GATE_MAPPING.consistency.dimensionIds,
  // Anti-AI (10)
  ...GATE_MAPPING.anti_ai.dimensionIds,
  // Quality (12)
  ...GATE_MAPPING.quality.dimensionIds,
] as const

// 编译期守卫: 37 维总数验证
// 编译期守卫: 37 维总数验证 (spec 中运行时断言覆盖)

// ============================================================================
// LITERARY_DIMS — 文学提升维 (独立于 37 维，≥4)
// ============================================================================

/**
 * 文学提升维 — 独立于 37 维审计注册表，用于 Track B / L9 书稿质量评估。
 *
 * 与 37 维无重叠保证:
 *   1. 命名空间互斥: LiteraryDimId 与 AuditDimensionId 类型不交叉
 *   2. 关注层面不同: 37 维检测"有无问题"，文学维评估"有多好"
 *   3. 对照表: 详见 decision-log/2026-08-21-t22-audit-taxonomy.md
 */
export const LITERARY_DIMS: Record<LiteraryDimId, LiteraryDimDefinition> = {
  payoff_closure: {
    id: "payoff_closure",
    label: "爽点闭环",
    description: "评估爽点（压抑-释放链）是否完成闭环，读者获得完整的情绪释放体验。",
    checks: [
      "压抑是否有足够的累积强度",
      "释放是否有具体的动作/对话/事件",
      "闭环后是否有余韵（非立即进入下一场景）",
      "闭环是否服务于角色成长而非单纯爽",
    ],
  },
  arc_consistency: {
    id: "arc_consistency",
    label: "弧光一致性",
    description: "评估角色弧线在全卷/全书层面的连贯性和成长轨迹的可信度。",
    checks: [
      "角色弧线是否有明确的起点和终点",
      "弧线转变是否在全卷分布合理",
      "弧线主题是否与全书主题共振",
      "多角色弧线是否有机交织",
    ],
  },
  hook_strength: {
    id: "hook_strength",
    label: "钩子强度",
    description: "评估章节末尾钩子的情感冲击力和读者继续阅读的迫切感。",
    checks: [
      "钩子是否击中人性的核心欲望（好奇/恐惧/共情/正义）",
      "钩子是否与全书主线直接相关",
      "钩子是否留有合理的信息缺口",
      "钩子是否被后续章节有效承接",
    ],
  },
  significant_detail: {
    id: "significant_detail",
    label: "显著细节",
    description: "评估作品中令人印象深刻的细节密度，这些细节是读者记忆和传播的锚点。",
    checks: [
      "是否存在可被读者记住的'金句'或标志性场景",
      "细节是否服务于角色塑造或主题表达",
      "细节是否具有不可替代性（换一个故事就不成立）",
      "细节密度是否在关键场景中更高",
    ],
  },
  emotional_resonance: {
    id: "emotional_resonance",
    label: "情绪共鸣",
    description: "评估作品引发读者共情的深度和持久度，超越即时爽感的深层情感链接。",
    checks: [
      "角色困境是否具有普遍人类经验的基础",
      "情绪渲染是否克制而非煽情",
      "读者是否能从角色身上看到自己",
      "情绪记忆是否在阅读后仍然持续",
    ],
  },
}

/** 文学提升维 ID 列表 (保序)。 */
export const ALL_LITERARY_DIM_IDS: LiteraryDimId[] = [
  "payoff_closure",
  "arc_consistency",
  "hook_strength",
  "significant_detail",
  "emotional_resonance",
]

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 根据门控键获取该门控下的所有维度定义。
 */
export function getDimensionsByGate(gateKey: GateKey): AuditDimensionDefinition[] {
  return GATE_MAPPING[gateKey].dimensionIds.map((id) => AUDIT_TAXONOMY[id])
}

/**
 * 获取所有 37 维定义 (按 gate 分组排序)。
 */
export function getAllAuditDimensions(): AuditDimensionDefinition[] {
  return ALL_AUDIT_DIMENSION_IDS.map((id) => AUDIT_TAXONOMY[id])
}

/**
 * 统计各门控的维度数量分布。
 */
export function getGateDimensionCounts(): Record<GateKey, number> {
  return {
    consistency: GATE_MAPPING.consistency.dimensionIds.length,
    anti_ai: GATE_MAPPING.anti_ai.dimensionIds.length,
    quality: GATE_MAPPING.quality.dimensionIds.length,
  }
}

/**
 * 获取某个维度的门控键。
 */
export function getGateForDimension(id: AuditDimensionId): GateKey {
  return AUDIT_TAXONOMY[id].gate
}