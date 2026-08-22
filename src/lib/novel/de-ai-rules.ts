/**
 * 中文小说去AI味规则（整合 Stop Slop + AI Flavor Remover + 中文小说特性）
 *
 * 参考资源：
 * - Stop Slop: https://github.com/drm-collab/stop-slop
 * - AI Flavor Remover: https://github.com/hylarucoder/ai-flavor-remover
 * - Writing Humanizer: https://github.com/shyuan/writing-humanizer
 */

export const CHINESE_NOVEL_DE_AI_RULES = `# 中文小说去 AI 味补充规则

## 一、AI味识别清单（必须消除）

### 1. 禁用词汇（Slop Words）
**总结腔**：这一切、显然、事实上、实际上、毫无疑问、无可否认
**解释腔**：其实、说白了、换句话说、简单来说、通俗点讲
**模板句首**：与此同时、紧接着、就在这时、恰在此时、正当此刻
**空洞形容**：复杂、微妙、深刻、独特、特殊、某种程度上
**转折滥用**：然而、但是、不过、可是（每段都用）
**AI特征词**：似乎、仿佛、如同、宛如、犹如（过度使用）

### 2. 机械句式（必须打破）
- 每段都是"起承转合"四段式
- 连续3句以上相同句式结构
- "目光交汇的瞬间"
- "空气仿佛凝固"
- "心中五味杂陈"
- "眼神变得坚定"
- 机械排比：既...又...、不仅...还...（工整过度）

### 3. 叙事缺陷（必须修复）
- 过度解释动机："他这么做是因为..."
- 总结情绪："她感到失望/欣慰/复杂"
- 固定场景模板：环境→人物→对话→内心
- 无意义转场："时间一分一秒过去"
- 概括式冲突："双方陷入僵持"

## 二、去AI味核心方法

### 方法1：删减原则
**必删内容**：
- Filler短语：可以说、某种意义上、在某种程度上
- 多余情绪总结：用动作和对白代替
- 重复转折词：一段内不超过1个"但是"
- 装饰性副词：缓缓、慢慢、轻轻（除非必要）
- 无效铺垫：删掉不影响理解的句子

### 方法2：具体化
**用具体替代抽象**：
❌ 他很生气 → ✅ 他拍桌而起
❌ 她很难过 → ✅ 她别过脸去
❌ 气氛紧张 → ✅ 没人说话，只有钟摆声
❌ 他很犹豫 → ✅ 他攥紧又松开拳头

### 方法3：断句
**长句拆分**：
❌ 他看着她，眼神复杂，既有愧疚又有无奈，还夹杂着一丝不甘
✅ 他看着她。愧疚，无奈，还有不甘。

### 方法4：破坏工整
- 段落长度不对称
- 句式结构不整齐
- 允许单句成段
- 允许突然转场
- 允许留白和省略

### 方法5：对话真实化
- 人物说半句话，不把话说完整
- 答非所问、顾左右而言他
- 紧张时重复、结巴
- 保留"呃""嗯""那个"
- 不解释潜台词，让读者自己体会

## 三、执行流程

### 步骤1：识别文本功能
先判断这段是什么：
- **叙事推进** → 精简直接，删除修饰
- **人物对白** → 口语化，避免书面腔
- **心理描写** → 感官细节代替"他觉得"
- **场景描写** → 选择性描写，不面面俱到
- **动作场面** → 短句、动词、节奏快
- **情绪爆发** → 破坏平衡，允许突兀
- **悬疑铺垫** → 留白，不解释
- **章节收束** → 悬念钩子，不总结

### 步骤2：逐句检查
- 这句删了影响理解吗？→ 不影响就删
- 同义重复了吗？→ 删一个
- 铺垫过度了吗？→ 直接进入正题

### 步骤3：变化句式
- 禁止连续3句主谓宾
- 主语可省略（中文特性）
- 允许倒装、插入、破折号

### 步骤4：信任读者
- 不解释显而易见的情绪
- 不总结已经发生的事
- 不提醒读者应该有的感受

## 四、保留内容（不可删改）

**必须保留**：
1. 剧情事实、人物关系、时间线
2. 视角人称、角色声线
3. 伏笔、章节钩子
4. 原有对话和关键动作
5. 不增删剧情点，只改写作方式

**中文小说适配注意**：
- 保留角色声线、对白毛边、叙事节奏和必要停顿
- 不要按非虚构文章规则硬删副词或压缩到固定字数
- 小说中的"似乎""仿佛""缓缓"等词在特定语境下是风格，不是AI味
- 情感描写可以有一定修饰，不必强制精简到极致

## 五、最终检查（10项）

处理完后逐条确认：
1. ✓ 删除了禁用词汇
2. ✓ 打破了工整句式
3. ✓ 情绪用动作/环境表现而非总结
4. ✓ 对话保留口语特征和潜台词
5. ✓ 没有每段转折、每句修饰
6. ✓ 快慢节奏有变化
7. ✓ 保留了原有剧情、人物、伏笔
8. ✓ 章节钩子没被删除
9. ✓ 没为了"自然"增加新情节
10. ✓ 读起来不像AI，也不刻意反AI

---

**核心理念**：好的去AI味是让文字为故事服务。删掉一切不推进故事、不塑造人物、不制造氛围的东西。`

// ============================================================================
// S1e 双层结构化 de-ai (roadmap S1 P1 机械层 · R05 结构化 de-ai 组织)
//
// 参考 (reference/ 只读): prosecreator-design 的 Human Authenticity Markers —
//   14 流派 × 7 类别 × 4 严重度 三维结构 (设计稿, 无规则数据, 结构可借)。
// 本项目按 7 类别 × 4 严重度组织语义层规则, 并加 web-novel genre 基线开关
// (14 流派只做 genre 感知开关, 不整搬 14 套规则)。
//
// 双层结构:
//   机械层 (零 LLM): mechanical-slop-detector.ts TIER1/2/3 词库 + 密度统计
//   语义层 (LLM):   本文件结构化规则 (category × severity × genre) → prompt
//
// de-ai-rules.ts 保持向后兼容: CHINESE_NOVEL_DE_AI_RULES 字符串仍为默认
// 语义层 prompt (deep-chapter-prompts 引用不变); 新增结构化数据供需要
// genre 感知/严重度过滤的调用方使用。
// ============================================================================

/** 7 类别 (prosecreator 7 categories 中文适配: 词汇/句式/叙事/对白/心理/场景/节奏) */
export const DE_AI_CATEGORIES = [
  "词汇",
  "句式",
  "叙事",
  "对白",
  "心理",
  "场景",
  "节奏",
] as const
export type DeAiCategory = (typeof DE_AI_CATEGORIES)[number]

/** 4 严重度 (prosecreator 4 severity: Critical/High/Medium/Low) */
export const DE_AI_SEVERITIES = ["critical", "high", "medium", "low"] as const
export type DeAiSeverity = (typeof DE_AI_SEVERITIES)[number]

/** 结构化语义规则条目: 类别 × 严重度 × 规则描述 */
export interface DeAiStructuredRule {
  category: DeAiCategory
  severity: DeAiSeverity
  /** 规则一句话 (进 prompt 给 LLM) */
  rule: string
  /** 正向示例 (可选) */
  example?: string
}

/** 完整 7×4 结构化规则矩阵 (语义层; 与机械层 TIER 词库互补不重复) */
export const DE_AI_STRUCTURED_RULES: readonly DeAiStructuredRule[] = [
  // ── 词汇 (mechanical 层覆盖禁用词; 语义层管上下文性用法) ──
  { category: "词汇", severity: "critical", rule: "总结腔/解释腔词汇 (这一切/显然/事实上/毫无疑问/总而言之) 必须删除或改写", example: "❌ 显然他赢了 → ✅ 他赢了" },
  { category: "词汇", severity: "high", rule: "空洞形容 (复杂/微妙/深刻/独特/某种程度) 改为具体细节", example: "❌ 气氛微妙 → ✅ 没人说话，只有钟摆声" },
  { category: "词汇", severity: "medium", rule: "装饰性副词 (缓缓/慢慢/轻轻) 非必要即删; 保留口癖约束: 特定语境下是风格非 AI 味" },
  { category: "词汇", severity: "low", rule: "AI 特征词 (似乎/仿佛/如同) 过度使用才罚, 合理语境保留" },
  // ── 句式 ──
  { category: "句式", severity: "critical", rule: "连续 3 句以上相同句式结构必须打破" },
  { category: "句式", severity: "high", rule: "机械排比 (既...又.../不仅...还... 工整过度) 拆散" },
  { category: "句式", severity: "medium", rule: "每段起承转合四段式必须变化; 允许单句成段/突然转场/留白" },
  { category: "句式", severity: "low", rule: "长句拆分: 复合句断为短句, 保留中文短句节奏" },
  // ── 叙事 ──
  { category: "叙事", severity: "critical", rule: "过度解释动机 (他这么做是因为...) 删除, 信任读者" },
  { category: "叙事", severity: "high", rule: "总结情绪 (她感到失望/欣慰/复杂) 用动作和环境代替" },
  { category: "叙事", severity: "medium", rule: "无意义转场 (时间一分一秒过去) 删除" },
  { category: "叙事", severity: "low", rule: "概括式冲突 (双方陷入僵持) 改为具体对峙细节" },
  // ── 对白 ──
  { category: "对白", severity: "critical", rule: "书面腔对白口语化: 保留呃/嗯/那个, 允许半句话/答非所问" },
  { category: "对白", severity: "high", rule: "不解释潜台词, 让读者自己体会" },
  { category: "对白", severity: "medium", rule: "紧张时重复/结巴是真实化特征, 不删" },
  { category: "对白", severity: "low", rule: "保留角色声线/对白毛边, 不按非虚构规则统一" },
  // ── 心理 ──
  { category: "心理", severity: "critical", rule: "总结式心理标签 (内心五味杂陈/百感交集/情绪复杂) 必须删除, 用动作、对白或感官细节呈现", example: "❌ 他心里五味杂陈 → ✅ 他攥紧又松开拳头" },
  { category: "心理", severity: "high", rule: "心理描写用感官细节代替 '他觉得'; 不总结已经发生的事" },
  { category: "心理", severity: "medium", rule: "不提醒读者应该有的感受" },
  { category: "心理", severity: "low", rule: "情感描写允许一定修饰, 不强制精简到极致" },
  // ── 场景 ──
  { category: "场景", severity: "critical", rule: "与情节推进无关的环境铺陈必须删除; 场景只保留有信息量的细节", example: "❌ 窗外云卷云舒 → ✅ 窗外那辆黑车还停着" },
  { category: "场景", severity: "high", rule: "固定场景模板 (环境→人物→对话→内心) 必须打破" },
  { category: "场景", severity: "medium", rule: "场景描写选择性描写, 不面面俱到" },
  { category: "场景", severity: "low", rule: "动作场面: 短句/动词/快节奏" },
  // ── 节奏 ──
  { category: "节奏", severity: "critical", rule: "段落节奏单一 (连续多段等长/每章收束雷同) 必须变化; 禁止整章注水原地打转" },
  { category: "节奏", severity: "high", rule: "高潮前铺垫过长 (连续 3 段以上无推进) 必须压缩" },
  { category: "节奏", severity: "medium", rule: "段落长度不对称, 快慢节奏有变化" },
  { category: "节奏", severity: "low", rule: "悬疑铺垫留白不解释; 章节收束用悬念钩子不总结" },
  // ── TASK-P2-19 (T19): 增强反 AI 统计检测规则 (synthetic-degraded 语料标定) ──
  // 词汇: 标点指纹规则 (AI 倾向标点使用模式)
  { category: "词汇", severity: "medium", rule: "句号密度过高 (>85% 句末标点) 且问号/感叹号/省略号稀疏, 提示 AI 句式机械" },
  { category: "词汇", severity: "medium", rule: "连续冒号/引号模式 (对话标签过度模板化: 他说/她说/他说道) 须打破" },
  // 句式: n-gram 重合度规则 (AI 候选池句级重复)
  { category: "句式", severity: "high", rule: "句级 3-gram 与 AI 语料重合度 >40% 提示 AI 句式模板, 须改写" },
  { category: "句式", severity: "medium", rule: "高频 2-gram 短语 (心中暗道/嘴角勾起/深吸一口气) 集中出现 >5 次/千字, 提示 AI 腔" },
  // 叙事: 段落分布规则
  { category: "叙事", severity: "medium", rule: "段落长度标准差 <15 字符且连续 5 段以上, 提示 AI 段落模板" },
  { category: "叙事", severity: "low", rule: "句子长度熵 <3.5 bits (句长过于均匀), 提示句式多样性不足" },
  // 对白: 标点指纹与 n-gram 规则
  { category: "对白", severity: "medium", rule: "对话标签模式单一 (>80% 为 '他说/她说') 须变化位置与省略" },
  { category: "对白", severity: "low", rule: "对白中 AI 腔句首 ('好了' / '没事' / '就这样') 过度使用, 须替换" },
  // 心理: 句式熵规则
  { category: "心理", severity: "high", rule: "情绪词 (心中/感到/觉得/充满) 集中出现 >3 次/段, 提示 AI 心理概括模板" },
  { category: "心理", severity: "medium", rule: "否定式心理描写 (不知道/无法/不能) 连续出现, 提示 AI 叙事规避" },
  // 场景: 段落长度分布规则
  { category: "场景", severity: "medium", rule: "场景段落长度过于均匀 (CV <0.3), 提示 AI 场景模板" },
  { category: "场景", severity: "low", rule: "环境描写以 '阳光透过'/ '夜色如墨'/ '月光洒在' 等模板开头, 须具体化" },
  // 节奏: 标点指纹规则
  { category: "节奏", severity: "medium", rule: "感叹号密度 <0.5%/千字且问号 <1%/千字, 提示 AI 情感表达不足" },
  { category: "节奏", severity: "low", rule: "省略号/破折号密度 >3%/千字, 提示 AI 堆砌留白" },
] as const

/** 网文 genre 基线 (prosecreator 14 流派中的 web-novel 常用; genre 感知开关) */
export const WEB_NOVEL_GENRES = [
  "玄幻", "仙侠", "都市", "历史", "科幻", "悬疑", "言情", "武侠",
  // TASK-201: 6 新流派 (内部编码约定, 与既有 8 流派同量级; 不改变既有流派判定路径)
  "女频现言", "无限流", "种田", "职场商战", "异能末世", "轻小说二次元",
] as const
export type WebNovelGenre = (typeof WEB_NOVEL_GENRES)[number]

/** genre → 基线倾向 (仅影响低严重度规则, 不改变 critical/high 硬规则) */
export interface GenreBaseline {
  genre: WebNovelGenre
  /** 节奏倾向: 快节奏 (爽文) / 慢节奏 (言情/悬疑铺陈) */
  pacing: "fast" | "slow"
  /** 对白口语化强度: 强 (都市/武侠) / 中 (玄幻/仙侠) / 弱 (历史) */
  dialogue: "strong" | "medium" | "weak"
  /** 心理描写保留: 言情/历史保留更多内心戏 */
  introspection: "keep" | "trim"
}

export const GENRE_BASELINES: readonly GenreBaseline[] = [
  { genre: "玄幻", pacing: "fast", dialogue: "medium", introspection: "trim" },
  { genre: "仙侠", pacing: "fast", dialogue: "medium", introspection: "trim" },
  { genre: "都市", pacing: "fast", dialogue: "strong", introspection: "trim" },
  { genre: "历史", pacing: "slow", dialogue: "weak", introspection: "keep" },
  { genre: "科幻", pacing: "fast", dialogue: "medium", introspection: "trim" },
  { genre: "悬疑", pacing: "slow", dialogue: "medium", introspection: "keep" },
  { genre: "言情", pacing: "slow", dialogue: "strong", introspection: "keep" },
  { genre: "武侠", pacing: "fast", dialogue: "strong", introspection: "trim" },
  // TASK-201: 6 新流派基线 (内部编码约定, 保守值, 与既有条目同量级)
  { genre: "女频现言", pacing: "slow", dialogue: "strong", introspection: "keep" },
  { genre: "无限流", pacing: "fast", dialogue: "medium", introspection: "trim" },
  { genre: "种田", pacing: "slow", dialogue: "weak", introspection: "keep" },
  { genre: "职场商战", pacing: "fast", dialogue: "medium", introspection: "trim" },
  { genre: "异能末世", pacing: "fast", dialogue: "medium", introspection: "trim" },
  { genre: "轻小说二次元", pacing: "fast", dialogue: "strong", introspection: "keep" },
] as const

/** 按 genre 查基线 (未知 genre 返回 undefined — 调用方用默认) */
export function getGenreBaseline(genre: string): GenreBaseline | undefined {
  return GENRE_BASELINES.find((b) => b.genre === genre)
}

/**
 * 按严重度过滤结构化规则 (供调用方选择注入强度)。
 * 默认只注入 critical+high+medium (low 为可选微调)。
 */
export function filterRulesBySeverity(
  rules: readonly DeAiStructuredRule[],
  minSeverity: DeAiSeverity = "medium",
): DeAiStructuredRule[] {
  const order: Record<DeAiSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 }
  const minOrder = order[minSeverity]
  return rules.filter((r) => order[r.severity] <= minOrder)
}

/**
 * 构建结构化语义层 prompt (genre 感知)。
 * 机械层已由 mechanical-slop-detector 前置; 本 prompt 只含语义层规则。
 * 与 CHINESE_NOVEL_DE_AI_RULES 字符串等价但结构化 — 调用方二选一。
 */
export function buildStructuredDeAiRules(genre?: string, minSeverity: DeAiSeverity = "medium"): string {
  const rules = filterRulesBySeverity(DE_AI_STRUCTURED_RULES, minSeverity)
  const baseline = genre ? getGenreBaseline(genre) : undefined
  const lines: string[] = []
  lines.push("# 中文小说去 AI 味语义层规则 (结构化)")
  lines.push("")
  lines.push(`类别 × 严重度: ${DE_AI_CATEGORIES.length} 类 × ${DE_AI_SEVERITIES.length} 级`)
  lines.push("")
  if (baseline) {
    lines.push(`流派基线: ${baseline.genre} — 节奏: ${baseline.pacing} / 对白口语化: ${baseline.dialogue} / 心理描写: ${baseline.introspection}`)
    lines.push("")
  }
  lines.push("## 规则矩阵 (按类别分组)")
  for (const category of DE_AI_CATEGORIES) {
    const catRules = rules.filter((r) => r.category === category)
    /* v8 ignore next */
    if (catRules.length === 0) continue
    lines.push(`### ${category}`)
    for (const r of catRules) {
      lines.push(`- [${r.severity}] ${r.rule}${r.example ? ` (${r.example})` : ""}`)
    }
    lines.push("")
  }
  lines.push("## 保留内容 (不可删改)")
  lines.push("1. 剧情事实、人物关系、时间线、伏笔、章节钩子")
  lines.push("2. 视角人称、角色声线、对白毛边")
  lines.push("3. 不增删剧情点, 只改写作方式")
  lines.push("4. 特定语境下的 '似乎/仿佛/缓缓' 是风格, 不是 AI 味")
  return lines.join("\n")
}

/** 结构化规则统计 (供 spec/审计) */
export function deAiStructuredStats(): {
  categoryCount: number
  severityCount: number
  ruleCount: number
  genreCount: number
} {
  return {
    categoryCount: DE_AI_CATEGORIES.length,
    severityCount: DE_AI_SEVERITIES.length,
    ruleCount: DE_AI_STRUCTURED_RULES.length,
    genreCount: WEB_NOVEL_GENRES.length,
  }
}
