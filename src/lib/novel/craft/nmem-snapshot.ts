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
export const NMEM_SNAPSHOT_VERSION = 1

/** 快照采集时点（nmem /health 探活通过时刻，UTC ISO 8601）。 */
export const NMEM_SNAPSHOT_CAPTURED_AT = "2026-08-21T15:30:23Z"

/** 采集时 nmem server 版本（/health → version 字段实测值）。 */
export const NMEM_SERVER_VERSION = "0.10.67"

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

/** 编译期快照整体形态。 */
export interface NmemSnapshot {
  readonly snapshotVersion: number
  readonly capturedAt: string
  readonly serverVersion: string
  readonly spaceId: string
  readonly memories: readonly NmemSnapshotMemory[]
  readonly skills: readonly NmemSnapshotSkill[]
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
      version: 1,
      contentHash: "219c319a3b1b79038b3f288d28f24cf1e35996ddc91aa525db0d43ef8416091e",
      stage: "active",
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

  return { ok: violations.length === 0, violations }
}
