/**
 * nmem-snapshot.ts — nmem 技法语料编译期快照（T27b / F-20 / A-04.6）。
 *
 * 职责（蓝图 §5 验收列 + §8 P3 风险行 + T27b 完成定义）：
 *   把 technique-compiler 编译所需的 nmem space（写作技巧语料）最小面
 *   **编译期固化入仓**，使 nmem server 不可用时规则包可从本快照离线编译、
 *   功能不退化（蓝图原文：「编译期快照入仓 craft/nmem-snapshot.ts（含
 *   memory_id+version）；runtime 永不直连；健康探活失败优雅中止；CI 守卫
 *   测试基于提交快照通过」）。
 *
 * 定位与边界：
 *   - 纯数据模块：零 IO、零 LLM、零 Tauri invoke、零网络调用（ADR-19 同型态；
 *     与 canon-craft-fields.ts 的「纯契约」边界一致）。
 *   - **runtime 永不直连 nmem**：本文件是 nmem space 与代码的唯一静态边界之一
 *     （另一边界是 technique-compiler 的显式注入式 live 抓取助手，仅限编译期
 *     工具链使用，见 technique-compiler.ts 头注）。运行时生成路径只允许消费
 *     编译产物，不允许 import 网络抓取。
 *   - 版本语义（蓝图 §8：「记忆 schema 变更 → 全量重编译 + 版本号升」）：
 *     nmem memories 不暴露可变版本计数器，故记忆级版本 = 快照版本号
 *     {@link NMEM_SNAPSHOT_VERSION}（重编译时整体 +1）；skill 级版本用 nmem
 *     原生 `verification.version` + `content_hash` 承载。追溯键 =
 *     (snapshotVersion, memoryId)。
 *   - contentExcerpt 只收录编译所需的最小操作口径（非全文搬运，控制体积与
 *     版权面）；全文真源仍在 nmem server。
 *
 * Draft-first（ADR-08）：纯新增数据模块，不写运行时会话状态，不触及草稿正式层。
 */

// ============================================================================
// 快照元数据
// ============================================================================

/** 快照版本号：每次全量重编译 +1（蓝图 §8 P3 风险行）。 */
export const NMEM_SNAPSHOT_VERSION = 5

/** 快照采集时点（nmem /health 探活通过时刻，UTC ISO 8601）。 */
export const NMEM_SNAPSHOT_CAPTURED_AT = "2026-11-27T12:40:00.000Z"

/** 采集时 nmem server 版本（/health 或 /openapi.json → version 字段实测值）。 */
export const NMEM_SERVER_VERSION = "0.10.124"

/** 采集空间 id（nmem space `space` = 写作技巧语料）。 */
export const NMEM_SPACE_ID = "space"

// ============================================================================
// 快照条目类型
// ============================================================================

/** 单条 nmem 记忆的快照投影（memory_id + 版本溯源 + 最小编译语料面）。 */
export interface NmemSnapshotMemory {
  /** nmem 记忆 id（原样保留，含 nmem 侧非 uuid 形态 id）。 */
  readonly memoryId: string
  /** 记忆标题。 */
  readonly title: string
  /**
   * 内容摘要：编译所需的操作口径最小面（非全文；全文真源在 nmem server）。
   */
  readonly contentExcerpt: string
  /** 记忆创建时间（nmem created_at 原值，UTC ISO 8601）。 */
  readonly createdAt: string
  /** nmem importance [0,1]。 */
  readonly importance: number
  /** nmem unit_type（learning/procedure/...）。 */
  readonly unitType: string
  /** nmem 标签（去 label_ 前缀后的展示名）。 */
  readonly labels: readonly string[]
}

/** 单条 nmem skill 的快照投影（skill 自带原生 version + content_hash）。 */
export interface NmemSnapshotSkill {
  /** nmem skill id。 */
  readonly skillId: string
  /** skill 标题（slug 形态）。 */
  readonly title: string
  /** nmem 原生版本号（verification.version）。 */
  readonly version: number
  /** nmem 内容哈希（verification.content_hash，SHA-256 hex）。 */
  readonly contentHash: string
  /** 生命周期阶段（active/...）。 */
  readonly stage: string
}

/** Phase 3 v5：通用 nmem space 写作规则快照条目（13 条全流派硬/软规则）。 */
export interface NmemSnapshotUniversalRule {
  readonly ruleId: string
  readonly title: string
  readonly priority: "P0" | "P1" | "P2"
  readonly injectionScope:
    | "protagonist_brief"
    | "chapter_task_brief"
    | "opening_audit"
    | "ending_guard"
    | "review_quality"
    | "review_consistency"
  readonly summary: string
}

/** 编译期快照整体形态。 */
export interface NmemSnapshot {
  readonly snapshotVersion: number
  readonly capturedAt: string
  readonly serverVersion: string
  readonly spaceId: string
  readonly memories: readonly NmemSnapshotMemory[]
  readonly skills: readonly NmemSnapshotSkill[]
  /** v5 新增：13 条通用 space 规则（可选以保持旧快照构造器向后兼容）。 */
  readonly universalRules?: readonly NmemSnapshotUniversalRule[]
}

// ============================================================================
// 提交快照（2026-08-21 实测采集自 nmem space=space，探活 v0.10.67）
// ============================================================================

/**
 * 入仓快照：9 条技法源 = 8 条 memory + 1 条 skill。
 *
 * 选源依据（蓝图 §5 技法集成映射表逐行对应）：
 *   - 20de3c24        愿望—动机—行动范式（王祥）→ F-21/F-27 canon 字段
 *   - 04644331        对抗延宕、爽点循环与结局三戒（王祥）→ F-22/F-23/F-28
 *   - 84c7f90a        麦基主人公八素质/善中 → F-21 arc_fundamentals（U-04 回填命名）
 *   - akers-ghost…    「鬼魂」概念（埃克斯）→ F-21 mckee_ghost
 *   - 28dc7918        十一种场景结尾钩子与多米诺（维兰德）→ F-24 章末钩子注册表
 *   - 786b0422        开篇的承诺与禁忌（莫雷尔）→ F-24 开端钩子注册表
 *   - edgerton-…      埃杰顿诱发事件开篇 + 格尔克桥接分流 → F-26 桥接口径
 *   - 94a6af29        显著细节（科扎克）→ F-25 significant_details
 *   - skill_f8e81e05  显著细节 skill（v1）→ F-25 S8 注册
 */
export const NMEM_SNAPSHOT: NmemSnapshot = {
  snapshotVersion: NMEM_SNAPSHOT_VERSION,
  capturedAt: NMEM_SNAPSHOT_CAPTURED_AT,
  serverVersion: NMEM_SERVER_VERSION,
  spaceId: NMEM_SPACE_ID,
  memories: [
    {
      memoryId: "20de3c24-0000-4000-8000-000000000000",
      title: "故事构成的核心驱动力：愿望—动机—行动范式",
      contentExcerpt:
        "主角在自己的愿望动机驱使下开始行动→得到伙伴帮助→遇到敌人阻碍→战胜困难达到目标。" +
        "wish（想要什么）与 motive（为什么要）强制区分；主要人物间相互冲突的愿望—动机—行动建构对抗性情节。" +
        "不知道情节如何发展时，问主要人物现在有何愿望、有何动机。",
      createdAt: "2026-07-10T08:41:04+00:00",
      importance: 0.75,
      unitType: "learning",
      labels: ["网文", "叙事技巧", "写作技巧", "故事结构", "欲望叙事"],
    },
    {
      memoryId: "04644331-0000-4000-8000-000000000000",
      title: "对抗延宕、爽点循环与结局三戒",
      contentExcerpt:
        "爽点循环：主角从一个阶段性胜利向另一个爽点前进，每个对抗—冲突循环可看作单独故事进程。" +
        "危机延宕：对抗爆发之初让敌人得意、主角承压——读者有多紧张，战胜快感就有多强；但不可让压抑长久不疏解。" +
        "张弛交替：激烈冲突后插入次要线索或喜剧舒缓。终局高潮由主角连续行动完成，结局必是主角行为结果，不可依赖巧合。" +
        "结局三戒：主角不在场的结局、主角失控的结局、主角逃避最终选择的结局都损害声誉。",
      createdAt: "2026-08-06T08:57:33+00:00",
      importance: 0.75,
      unitType: "procedure",
      labels: ["网文", "叙事技巧", "悬念构建", "写作技巧", "故事结构", "情节", "节奏"],
    },
    {
      memoryId: "84c7f90a-0000-4000-8000-000000000000",
      title: "麦基：主人公八素质、善中与陪衬人物七功用",
      contentExcerpt:
        "主人公八项基本素质：①意志力（穷尽意志应对终极两难）②多才多艺（行动非他莫属）③下风狗位置" +
        "（对抗力量压倒性压过主人公，仅存一线希望）④移情本质/善中（故事中心深处的正价值负荷）⑤心机" +
        "（内心矛盾品质冲突）⑥长度与深度（高压选择暴露潜意识动机）⑦改变容量（越强的弧光越具象征性）" +
        "⑧洞察力/顿悟（最强冲突迫使无知→有知）。",
      createdAt: "2026-08-05T10:10:28+00:00",
      importance: 0.8,
      unitType: "learning",
      labels: ["人物塑造", "主角设计", "叙事技巧", "配角设计", "写作技巧", "卡司设计", "罗伯特·麦基"],
    },
    {
      memoryId: "akers-ghost-concept-char wound",
      title: "「鬼魂」概念：驱动英雄的过去创伤与背景故事的区别",
      contentExcerpt:
        "鬼魂是顶在英雄背后、驱使他不得不前进的过去创伤——不是普通背景故事，而是「英雄鞋里的石子」。" +
        "背景故事解释人物为什么是这个样子；鬼魂是其中那个核心伤口，一直驱使人物的现在行为。" +
        "鬼魂不必直接展示，但必须存在于水面之下；它为英雄的欲望（想要什么）和需要（真正需要什么）提供情感根基。",
      createdAt: "2026-08-19T10:51:58+00:00",
      importance: 0.7,
      unitType: "learning",
      labels: ["人物塑造", "人物心理", "写作技巧", "剧本"],
    },
    {
      memoryId: "28dc7918-0000-4000-8000-000000000000",
      title: "十一种场景结尾钩子与多米诺效应：让读者翻页",
      contentExcerpt:
        "每个场景和章节结尾都应提出有力的问题。十一种钩子：预示冲突、秘密、重要决定或誓言、宣布震惊事件、" +
        "激烈情绪、足以颠覆小说的突转、新想法、未回答的问题、神秘对白、预言、转折点。" +
        "小说应像多米诺方阵环环相扣，每个场景都影响后续场景；无法推动情节或可删除的场景要删去或合并。",
      createdAt: "2026-07-11T16:55:22+00:00",
      importance: 0.75,
      unitType: "procedure",
      labels: ["叙事技巧", "悬念构建", "写作技巧", "故事结构"],
    },
    {
      memoryId: "786b0422-0000-4000-8000-000000000000",
      title: "开篇的承诺与禁忌：用钩子锁定读者",
      contentExcerpt:
        "开篇向读者许下承诺：你将进入一个值得投入情感的世界。有效开篇建立可信度、引入人物、暗示冲突、" +
        "营造氛围并用具体感觉细节沉浸。好开篇方案：对话、逸事、疑问、悬念、主题、设定、有力首句、人物描写、" +
        "转机、伏笔。投稿禁忌九类：乡间小路（风景无冲突）、突击速成（信息过载）、哑炮引子、镜子镜子" +
        "（照镜子自我描写）、几无进展、对号入座、耸人听闻、快车道、泪痕。",
      createdAt: "2026-07-12T00:44:16+00:00",
      importance: 0.7,
      unitType: "learning",
      labels: ["叙事技巧", "写作技巧", "开头"],
    },
    {
      memoryId: "edgerton-hooked-start-at-inciting-incident",
      title: "埃杰顿：当代故事从诱发事件开篇，压缩甚至省略稳定态",
      contentExcerpt:
        "稳定态+诱发事件=不稳定+为恢复稳定而斗争=新稳定。当代差异：稳定态大幅压缩甚至整段省略，" +
        "故事从「将贯穿全书的麻烦第一次发生」之处开始。桥接分流：投稿与商业节奏优先埃杰顿式（麻烦尽快落地）；" +
        "长篇若用格尔克长铺垫（先铺约30页常态再丢原子弹），仍须让读者在开篇功能上感到「稳定已被撕开」。",
      createdAt: "2026-08-15T16:01:13+00:00",
      importance: 0.8,
      unitType: "procedure",
      labels: ["叙事技巧", "写作技巧", "故事结构", "开头", "情节"],
    },
    {
      memoryId: "94a6af29-0000-4000-8000-000000000000",
      title: "显著细节：高效塑造人物与环境",
      contentExcerpt:
        "显著细节是对人物、地点或心境的简短描述，却能让人愉悦、恐惧、紧张或唤起记忆。" +
        "用一两个鲜明、出乎意料的细节替代完整生平（少即是多）；避免「漂亮」「帅」「美」「丑」等广告词，" +
        "寻找新鲜、具体的描述方式。解决冗余信息综合征与「斯蒂夫是谁」困境。",
      createdAt: "2026-07-12T00:23:49+00:00",
      importance: 0.7,
      unitType: "learning",
      labels: ["人物塑造", "写作技巧", "推理小说", "环境描写"],
    },
  ],
  skills: [
    {
      skillId: "skill_f8e81e050000",
      title: "shape-characters-and-environments-with-significant-details",
      version: 4,
      contentHash: "ece939b443d40d8590ec8fd4c0d5aaa09fc8a275c33c83f80df27459232dd04d",
      stage: "active",
    },
    {
      skillId: "skill_34b8da3fc971",
      title: "novel-continuity-p0-gate-audit",
      version: 2,
      contentHash: "08cc5f45193b4560f004dad3c0875f277cd8bc6849ab8a8e1b69d9f58a29f822",
      stage: "active",
    },
    {
      skillId: "skill_6bfdc4f3b916",
      title: "novel-thrill-loop-delay-pacing",
      version: 2,
      contentHash: "3d33310cf9d6022bc27b82efd81521f9152e112ce167050005a29a4023d79307",
      stage: "active",
    },
    {
      skillId: "skill_1f395eb26e7e",
      title: "novel-ghost-wound-and-wish-motive-chain",
      version: 2,
      contentHash: "43b8b11ead00b293e05200197fa8a87682b3de55223a300c3849518e054091d0",
      stage: "active",
    },
    {
      skillId: "skill_c115a9cef595",
      title: "novel-finale-three-precepts-audit",
      version: 2,
      contentHash: "364afa296b4b45ff4c33bd360270a41f54f102b80163c48f3727a247c2ba4037",
      stage: "active",
    },
    {
      skillId: "skill_ad222a51ebdc",
      title: "novel-dual-kb-research-and-injection",
      version: 2,
      contentHash: "a6322b89c17c35f9ffd2921394a046613a3e110958b97ca51516dc1804b5465e",
      stage: "active",
    },
    {
      skillId: "skill_05a7cc9d09d6",
      title: "detect-ai-flavor-nine-signals",
      version: 2,
      contentHash: "6bdd6a0f6466be8dc3d4cdba69779f870d1979ea28b9a590a3905692a9ded30e",
      stage: "active",
    },
    {
      skillId: "skill_303834196af4",
      title: "aigc-platform-compliance-kit",
      version: 2,
      contentHash: "62096ad6f1d5d6cf2f79272ee9c7fa63326b6feee465352a5c1243c2b3912f73",
      stage: "active",
    },
    {
      skillId: "skill_c071a8e8fe12",
      title: "novel-craft-school-and-expert-selector",
      version: 2,
      contentHash: "038127547818d9c094369de6f8a3af55d1454082cea43db24db8729c87375d92",
      stage: "active",
    },
    {
      skillId: "skill_76e61c2db391",
      title: "character-ensemble-ecology-and-chemistry",
      version: 2,
      contentHash: "a5a3efcb32905809c3632d4522275d8f80e23d7c6eec5ce4aa83346b1c72f6b4",
      stage: "active",
    },
    {
      skillId: "skill_adcd68a9ac71",
      title: "character-antagonist-mirror-and-pressure",
      version: 2,
      contentHash: "d42efa48d6773647308ca417052dce5e167becad8078dd32c04b00ca8ad8e230",
      stage: "active",
    },
    {
      skillId: "skill_b5213cc9196f",
      title: "character-voice-fingerprint-and-micro-actions",
      version: 2,
      contentHash: "57022872c0c6618a57288f5e497d341345cd5a6f033445b2be55c761e3060b12",
      stage: "active",
    },
    {
      skillId: "skill_bfda7587df41",
      title: "craft-power-economy-and-map-escalation",
      version: 2,
      contentHash: "05920093193232f13c003888d3275a4410564ae9ddc3ec926264f2b6ba6bbaaf",
      stage: "active",
    },
    {
      skillId: "skill_9dab6cee6365",
      title: "craft-cinematic-blocking-and-sensory-immersion",
      version: 2,
      contentHash: "b438b112c3793907e3c12066dc4bffb1477565741c4df77681009b77e421c2a7",
      stage: "active",
    },
    {
      skillId: "skill_190e3a5dce09",
      title: "character-graceful-exit-and-legacy-arc",
      version: 2,
      contentHash: "b9ca3b34a2e64c4ac7ee5c36a5a9c61544805d1a60baa0405efc04b91ebd38e1",
      stage: "active",
    },
    {
      skillId: "skill_4da20cc16b68",
      title: "craft-faction-politics-and-conspiracy",
      version: 2,
      contentHash: "fe002aaa8aa0a1dcec1c39209f62386864c6785134e7802d0ea76e4dc5993310",
      stage: "active",
    },
    {
      skillId: "skill_af91619243bd",
      title: "craft-combat-tactics-and-terrain-chess",
      version: 2,
      contentHash: "40e5348a05a20ac79416b5bffb7993a3162f8d480f65efc10a5e56713600ca46",
      stage: "active",
    },
    {
      skillId: "skill_ca3125a66185",
      title: "craft-dialogue-sparring-and-status-play",
      version: 2,
      contentHash: "920540e664d91f4a3d9f4fb3e39f942971e81f6e0da16a5b3ebe70b904bca8e7",
      stage: "active",
    },
  ],
  universalRules: [
    {
      ruleId: "novel-continuity-p0-hard-gate",
      title: "P0 正典与时空连续性硬门禁",
      priority: "P0",
      injectionScope: "review_consistency",
      summary: "一致性优先于反 AI 与文采；已死/退场角色、物品归属、时间线与境界不可无因果回跳。",
    },
    {
      ruleId: "novel-information-asymmetry-and-pov-gate",
      title: "POV 信息差与防全知泄密门禁",
      priority: "P0",
      injectionScope: "review_consistency",
      summary: "当前视角人物只能基于已知情报决策，严禁未揭晓真相泄漏进主角内心独白或行动。",
    },
    {
      ruleId: "novel-kb-routing-contract",
      title: "双库分工与离线考据路由契约",
      priority: "P0",
      injectionScope: "chapter_task_brief",
      summary: "过程库 .novel 管事实账本，资料库 QM/wiki 管世界观与参考切片；运行时永不直连外部记忆库。",
    },
    {
      ruleId: "ai-prose-review-15",
      title: "去 AI 味 15 项正文审稿基线",
      priority: "P1",
      injectionScope: "review_quality",
      summary: "压制总结腔、翻译腔、空洞副词堆砌与模板过渡句，用具体动作与感官锚点替代抽象评价。",
    },
    {
      ruleId: "novel-craft-school-adaptive-routing",
      title: "写作流派与专家自适应路由规则",
      priority: "P2",
      injectionScope: "chapter_task_brief",
      summary: "按题材选主副专家，互斥流派不混装，防止民俗恐怖与脱力轻喜剧串味打架。",
    },
    {
      ruleId: "novel-power-system-cost-and-ecology",
      title: "力量体系代价、经济账与地图升级守恒",
      priority: "P2",
      injectionScope: "chapter_task_brief",
      summary: "任何超凡能力与资源获取须对应可审计代价、稀缺约束与社会生态后果。",
    },
    {
      ruleId: "novel-thrill-pacing-delay-curve",
      title: "爽点循环与延宕比节奏红线",
      priority: "P2",
      injectionScope: "chapter_task_brief",
      summary: "压抑蓄力延宕比受控且主角保持主动筹谋，激烈冲突后穿插舒缓张弛交替。",
    },
    {
      ruleId: "novel-opening-redline-finale-precepts",
      title: "开篇禁忌与结局三戒守卫",
      priority: "P2",
      injectionScope: "ending_guard",
      summary: "开篇规避风景无冲突与信息过载；终局严守主角在场、掌控与直面最终选择三戒。",
    },
    {
      ruleId: "novel-dialogue-status-and-subtext-turn",
      title: "对话地位博弈与潜台词转折",
      priority: "P2",
      injectionScope: "chapter_task_brief",
      summary: "核心对白须包含立场试探、信息隐瞒或权势位移，避免直白说明式台词。",
    },
    {
      ruleId: "novel-combat-cost-and-information-win",
      title: "战斗地形视野与伤痛成本约束",
      priority: "P2",
      injectionScope: "chapter_task_brief",
      summary: "胜负由地形、视野、预案与信息差决定，禁止零伤痛数值对波与凭空爆种。",
    },
    {
      ruleId: "novel-cinematic-show-dont-tell-gate",
      title: "电影感场面调度与感官展示门禁",
      priority: "P2",
      injectionScope: "review_quality",
      summary: "优先具体物理动作、非视觉感官与显著细节，景物连写受控，拒绝抽象情绪标签。",
    },
    {
      ruleId: "novel-character-voice-and-flaw-consistency",
      title: "人物声纹指纹与缺陷驱动一致性",
      priority: "P2",
      injectionScope: "protagonist_brief",
      summary: "角色语言节律、口癖、微动作与核心缺陷必须跨章稳定，防止全员同一 AI 腔。",
    },
    {
      ruleId: "novel-emotional-curve-and-antimelodrama",
      title: "情绪蓄力曲线与反煽情留白规则",
      priority: "P2",
      injectionScope: "review_quality",
      summary: "高光宣泄前须铺具象锚点与阻力代价，关键退场与情感转折压低音量留白。",
    },
  ],
}

// ============================================================================
// 机械校验（零 LLM 纯谓词，供 CI 守卫测试与编译入口前置检查）
// ============================================================================

const ISO_LIKE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** {@link validateNmemSnapshot} 的单条违规描述。 */
export interface NmemSnapshotViolation {
  path: string
  message: string
}

/** 校验结果：ok=false 时 violations 非空。 */
export interface NmemSnapshotValidation {
  ok: boolean
  violations: NmemSnapshotViolation[]
}

/**
 * 校验快照结构完整性（机械检查，零 LLM）：
 *   - 元数据四值（snapshotVersion/capturedAt/serverVersion/spaceId）非空且时点为 ISO 形态；
 *   - 每条 memory：memoryId/title/contentExcerpt 非空、createdAt ISO 形态、importance ∈ [0,1]；
 *   - memoryId 全局唯一；
 *   - 每条 skill：skillId/title/contentHash 非空、version 为正整数。
 */
export function validateNmemSnapshot(snapshot: NmemSnapshot): NmemSnapshotValidation {
  const violations: NmemSnapshotViolation[] = []

  if (!Number.isInteger(snapshot.snapshotVersion) || snapshot.snapshotVersion < 1) {
    violations.push({
      path: "snapshotVersion",
      message: `snapshotVersion 必须是正整数，实际=${String(snapshot.snapshotVersion)}`,
    })
  }
  if (!ISO_LIKE_RE.test(snapshot.capturedAt)) {
    violations.push({ path: "capturedAt", message: `capturedAt 必须是 ISO 8601 形态，实际=${snapshot.capturedAt}` })
  }
  if (snapshot.serverVersion.length === 0) {
    violations.push({ path: "serverVersion", message: "serverVersion 不得为空" })
  }
  if (snapshot.spaceId.length === 0) {
    violations.push({ path: "spaceId", message: "spaceId 不得为空" })
  }

  const seenIds = new Set<string>()
  snapshot.memories.forEach((memory, i) => {
    const at = `memories[${i}]`
    if (memory.memoryId.length === 0) {
      violations.push({ path: `${at}.memoryId`, message: "memoryId 不得为空" })
    } else if (seenIds.has(memory.memoryId)) {
      violations.push({ path: `${at}.memoryId`, message: `memoryId 重复：${memory.memoryId}` })
    }
    seenIds.add(memory.memoryId)
    if (memory.title.length === 0) violations.push({ path: `${at}.title`, message: "title 不得为空" })
    if (memory.contentExcerpt.length === 0) {
      violations.push({ path: `${at}.contentExcerpt`, message: "contentExcerpt 不得为空（离线编译语料面）" })
    }
    if (!ISO_LIKE_RE.test(memory.createdAt)) {
      violations.push({ path: `${at}.createdAt`, message: `createdAt 必须是 ISO 8601 形态，实际=${memory.createdAt}` })
    }
    if (typeof memory.importance !== "number" || !Number.isFinite(memory.importance) || memory.importance < 0 || memory.importance > 1) {
      violations.push({ path: `${at}.importance`, message: `importance 必须是 [0,1] 内有限数字，实际=${String(memory.importance)}` })
    }
  })

  snapshot.skills.forEach((skill, i) => {
    const at = `skills[${i}]`
    if (skill.skillId.length === 0) violations.push({ path: `${at}.skillId`, message: "skillId 不得为空" })
    if (skill.title.length === 0) violations.push({ path: `${at}.title`, message: "title 不得为空" })
    if (!Number.isInteger(skill.version) || skill.version < 1) {
      violations.push({ path: `${at}.version`, message: `version 必须是正整数，实际=${String(skill.version)}` })
    }
    if (skill.contentHash.length === 0) violations.push({ path: `${at}.contentHash`, message: "contentHash 不得为空" })
  })

  if (snapshot.universalRules !== undefined) {
    const seenRuleIds = new Set<string>()
    snapshot.universalRules.forEach((rule, i) => {
      const at = `universalRules[${i}]`
      if (!rule.ruleId.trim()) {
        violations.push({ path: `${at}.ruleId`, message: "ruleId 不得为空" })
      } else if (seenRuleIds.has(rule.ruleId)) {
        violations.push({ path: `${at}.ruleId`, message: `ruleId 重复：${rule.ruleId}` })
      }
      seenRuleIds.add(rule.ruleId)
      if (!rule.title.trim()) violations.push({ path: `${at}.title`, message: "title 不得为空" })
      if (!rule.summary.trim()) violations.push({ path: `${at}.summary`, message: "summary 不得为空" })
    })
  }

  return { ok: violations.length === 0, violations }
}
