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

## 四、语义诊断七问（吸收自 inkos story-deslop semantic-cleanup rubric · 23-inkos-coverage R-inkos-2）

对每个疑似 AI 味段落逐问诊断（与上文词表/句式规则互补，语义级）：
1. 这一段的故事功能是什么？（推进/塑造/氛围/张力）
2. 该功能是否通过动作、意象、证据、选择或后果可见？
3. 叙述者是否解释了已经演示出的情绪？
4. 角色可替换性：把角色名换成任何其他角色/故事，句子是否原样成立？成立则无角色特异性，必须重写为该角色专属的行为、口癖与思维方式。
5. 细节是否承载证据、关系、压力或声音？纯装饰性细节删除。
6. 对话是否有动机？伪装成对白的说明文必须改。
7. 节奏-场景匹配：句子节奏是否匹配场景的物理与情感运动？追逐/冲突用短促句，沉思/哀伤用舒缓句，禁止匀速。

**反机械删除警示**：不要机械删除所有转场、比喻、三段式排比或命中的词——先判断它是否承担故事功能。重复可以是节奏，抽象可以是风格，短句可以是压迫感。

## 五、保留内容（不可删改）

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

## 六、最终检查（10项）

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
  { category: "叙事", severity: "low", rule: "句子长度分布过度均匀 (归一化熵 <0.7), 提示句式多样性不足" },
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
  // ── R-inkos-2 (23-inkos-coverage): 吸收 inkos story-deslop 净增量维度（差异审计去重后：Q4/Q7 本地无对应，其余五问与既有规则重叠不归并）──
  { category: "叙事", severity: "high", rule: "角色可替换性: 角色名替换为任意角色后句子仍原样成立, 则描写无角色特异性, 必须重写为角色专属行为/口癖/思维", example: "❌ 她很生气 ✅ 她把他的杯子转了半圈, 没喝" },
  { category: "节奏", severity: "high", rule: "句子节奏匹配场景的物理与情感运动: 追逐冲突用短促句, 沉思哀伤用舒缓句, 禁止全程匀速", example: "❌ 追逐场景连续 40 字长句 ✅ 他跑。鞋跟砸地。身后脚步更近。" },
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

// ============================================================================
// F-009: 去 AI 分级替换表 + 两遍检测 (runDeAiDualPass)
//
// detect → rewrite → re-detect 强制两遍检测。
// 第二遍结果写 dualPassRecheck 字段，仍命中标 residual 供人工审查。
// 保持「信号非证据」立场 (误报率 >60%)，1B 低权重仅轻提示不升压为硬门控。
// ============================================================================

import { detectTieredDeAi, filterTieredDeAiHitsByTier, type TieredDeAiHit } from "./de-ai-tiered-table"

/** 两遍检测结果 */
export interface DualPassResult {
  /** 第一遍: 检测命中 */
  pass1: {
    hits: TieredDeAiHit[]
    /** 1A 高权重命中数 */
    highCount: number
    /** 1B 低权重命中数 */
    lowCount: number
    /** 3 弱提示命中数 */
    weakCount: number
    /** 加权总分 (1A×1.0 + 1B×0.4 + 3×0.1) */
    weightedScore: number
  }
  /** 第二遍: 重检结果 */
  dualPassRecheck: {
    /** 仍命中的残留条目 (标 residual) */
    residual: TieredDeAiHit[]
    /** 已清除的条目 */
    cleared: number
    /** 残留率 */
    residualRate: number
    /** 改写建议 */
    rewriteSuggestions: string[]
  }
  /** 是否建议人工审查 (残留率 >0.3 或 1A 残留 >0) */
  needsReview: boolean
}

/**
 * 模拟改写: 对 1A 高权重命中生成替换方案 (不实际改原文, 仅生成建议)。
 * 返回改写后的文本 (模拟) 和改写建议列表。
 */
function simulateRewrite(text: string, hits: TieredDeAiHit[]): { rewrittenText: string; suggestions: string[] } {
  const suggestions: string[] = []
  let rewritten = text
  // 按权重降序处理 (先处理高权重)
  const sorted = [...hits].sort((a, b) => b.entry.weight - a.entry.weight)
  for (const hit of sorted) {
    if (hit.entry.tier === "1A" && hit.entry.weight >= 0.8) {
      suggestions.push(`替换 "${hit.entry.term}" (×${hit.count}): ${hit.entry.suggestion}`)
      // 只替换首次出现作为示例
      rewritten = rewritten.replace(hit.entry.term, `【已替换:${hit.entry.suggestion}】`)
    } else if (hit.entry.tier === "1A") {
      suggestions.push(`考虑 "${hit.entry.term}" (×${hit.count}): ${hit.entry.suggestion}`)
      rewritten = rewritten.replace(hit.entry.term, `【已替换:${hit.entry.suggestion}】`)
    } else if (hit.entry.tier === "1B") {
      suggestions.push(`轻提示 "${hit.entry.term}" (×${hit.count}): ${hit.entry.suggestion} (低权重, 非强制)`)
    } else {
      suggestions.push(`参考 "${hit.entry.term}" (×${hit.count}): ${hit.entry.suggestion} (弱提示, 仅参考)`)
    }
  }
  return { rewrittenText: rewritten, suggestions }
}

/**
 * runDeAiDualPass — 强制两遍检测 (detect → rewrite → re-detect)。
 *
 * 第一遍: 在原文中检测分级表 112 词命中。
 * 第二遍: 对改写后文本再次检测, 仍命中标 residual。
 *
 * 保持「信号非证据」立场: 1A 高权重仅提供强信号, 不阻断;
 * 1B 低权重仅轻提示, 不升级为 Anti-AI(P1) 硬门控。
 */
export function runDeAiDualPass(text: string): DualPassResult {
  // ── Pass 1: Detect ──
  const hits = detectTieredDeAi(text ?? "")
  const highHits = filterTieredDeAiHitsByTier(hits, "1A")
  const lowHits = filterTieredDeAiHitsByTier(hits, "1B")
  const weakHits = filterTieredDeAiHitsByTier(hits, "3")
  const highCount = highHits.reduce((s, h) => s + h.count, 0)
  const lowCount = lowHits.reduce((s, h) => s + h.count, 0)
  const weakCount = weakHits.reduce((s, h) => s + h.count, 0)
  // 加权: 1A×1.0 + 1B×0.4 + 3×0.1
  const weightedScore = Math.round((highCount * 1.0 + lowCount * 0.4 + weakCount * 0.1) * 10) / 10

  // ── Simulate rewrite ──
  const { rewrittenText, suggestions } = simulateRewrite(text ?? "", hits)

  // ── Pass 2: Re-detect ──
  const reHits = detectTieredDeAi(rewrittenText)
  const residual = reHits.filter((rh) => {
    // 只算 1A 和 1B 的残留, 3 弱提示不标残留
    return rh.entry.tier === "1A" || rh.entry.tier === "1B"
  })
  const residualCount = residual.reduce((s, h) => s + h.count, 0)
  const totalInitial = hits.reduce((s, h) => s + h.count, 0)
  const cleared = totalInitial - residualCount
  const residualRate = totalInitial > 0 ? Math.round((residualCount / totalInitial) * 100) / 100 : 0

  // ── 判断是否建议人工审查 ──
  const residualHigh = residual.filter((rh) => rh.entry.tier === "1A")
  const needsReview = residualRate > 0.3 || residualHigh.length > 0

  return {
    pass1: {
      hits,
      highCount,
      lowCount,
      weakCount,
      weightedScore,
    },
    dualPassRecheck: {
      residual,
      cleared,
      residualRate,
      rewriteSuggestions: suggestions,
    },
    needsReview,
  }
}

/** F-009 两遍检测单行摘要 (供 skill-hooks note / 审计)。 */
export function formatDualPassSummary(result: DualPassResult): string {
  return [
    `de-ai dual-pass: weighted=${result.pass1.weightedScore}`,
    `high=${result.pass1.highCount}`,
    `low=${result.pass1.lowCount}`,
    `weak=${result.pass1.weakCount}`,
    `residualRate=${result.dualPassRecheck.residualRate}`,
    result.needsReview ? "needs-review" : "ok",
    "Track B soft (F-009 分级两遍; not product hard gate)",
  ].join(" ")
}

/**
 * F-009 两遍检测 prompt 片段 (供 LLM 改写; 非产品硬门)。
 * 可选携带用户避用词 (Wave 4 additive; 未传/空则不输出)。
 */
export function formatDualPassPromptFragment(
  result: DualPassResult,
  avoidWordsHits?: readonly { word: string; count: number }[],
): string {
  const parts: string[] = []
  const suggestions = result.dualPassRecheck.rewriteSuggestions
  if (suggestions.length > 0) {
    parts.push(
      [
        `## De-AI dual-pass (F-009 分级两遍检测 · Track B soft)`,
        `加权分=${result.pass1.weightedScore} · 残留率=${result.dualPassRecheck.residualRate}`,
        ...suggestions.map((s) => `- ${s}`),
      ].join("\n"),
    )
  }
  if (avoidWordsHits && avoidWordsHits.length > 0) {
    parts.push(`用户避用词（改写时禁止使用）：${avoidWordsHits.map((h) => h.word).join("、")}`)
  }
  return parts.join("\n\n")
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

// ============================================================================
// P0-3: residual 三类分诊 (SOURCE-AI / REWRITER-CAVITY / AMBIGUOUS)
//
// 共识 R5 (v1-hy3) + V1-ds r-hcavity: dual-pass 残留不能只当「AI 味剩多少」,
// 要区分残留来源:
//   - SOURCE-AI:    源文本本身是 AI 生成的硬信号 (1A 高权重词频高, cavity 低)
//   - REWRITER-CAVITY: 改写器腔 — 改写后新出现的信号 (cavity 高, 源 slop 低)
//   - AMBIGUOUS:    无法归因 (两者指标均中等)
// 分诊驱动后续动作: SOURCE-AI → 继续去 AI; REWRITER-CAVITY → 停止改写并回退;
// AMBIGUOUS → 保留人工审查。
// ============================================================================

/** 残留来源分类 */
export type ResidualOrigin = "SOURCE-AI" | "REWRITER-CAVITY" | "AMBIGUOUS"

/** 分诊结果 */
export interface ResidualTriage {
  origin: ResidualOrigin
  /** 证据摘要 (供人工审查) */
  evidence: string[]
  /** 建议动作: continue|revert|manual */
  action: "continue" | "revert" | "manual"
  /** Track B soft — 永不产品硬门 */
  productHardGate: false
}

/**
 * residual 三类分诊。
 *
 * 输入: dual-pass residual 统计 + 可选改写痕迹 (overCorrectionReport) +
 * 可选源文本 slop (用于比较 cavity 相对源信号)。
 *
 * 规则:
 *   - residualRate 高 + 源文本自身 AI 信号强 (sourceSlopPenalty 高) → SOURCE-AI
 *   - residualRate 高 + cavity 高 + 源 slop 低 → REWRITER-CAVITY (改写器腔)
 *   - 其余 → AMBIGUOUS
 */
export function classifyResidualOrigin(input: {
  residualRate: number
  sourceSlopPenalty?: number
  cavityScore?: number
}): ResidualTriage {
  const evidence: string[] = []
  const { residualRate, sourceSlopPenalty = 0, cavityScore = 0 } = input
  evidence.push(`residualRate=${residualRate.toFixed(2)}`)
  evidence.push(`sourceSlopPenalty=${sourceSlopPenalty.toFixed(1)}`)
  evidence.push(`cavityScore=${cavityScore.toFixed(2)}`)

  if (residualRate <= 0.3) {
    // 低残留: 已基本清除; 但若 cavity 高, 说明清除动作本身引入了改写器腔
    if (cavityScore >= 0.5) {
      return {
        origin: "REWRITER-CAVITY",
        evidence,
        action: "revert",
        productHardGate: false,
      }
    }
    return {
      origin: "SOURCE-AI",
      evidence,
      action: "continue",
      productHardGate: false,
    }
  }

  if (sourceSlopPenalty >= 5 && cavityScore < 0.5) {
    // 源文本本身 AI 信号强, cavity 低 → 残留是源信号没去干净
    return { origin: "SOURCE-AI", evidence, action: "continue", productHardGate: false }
  }

  if (cavityScore >= 0.5 && sourceSlopPenalty < 5) {
    // 残留是改写器腔 — 改写过深产生的伪信号
    return {
      origin: "REWRITER-CAVITY",
      evidence,
      action: "revert",
      productHardGate: false,
    }
  }

  return {
    origin: "AMBIGUOUS",
    evidence,
    action: "manual",
    productHardGate: false,
  }
}

// ============================================================================
// P0-4: 信号分证 — 反过拟合护栏
//
// 共识 v1-ds r-antifit + v1-hy3 R10: 去 AI 目标不是把分数压到 0, 而是分布对齐
// 自然文本。机械指标 (slopPenalty / weightedScore) 只是信号, 不是证据;
// 永远不因「指标好看」而批准产品硬门。
//
// 分证原则:
//   1. 指标达标 ≠ 自然: 完全干净的文本可能是改写器过度打磨的结果
//   2. 指标不达标 ≠ 必改: 人类写作天然有重复、停顿、不完美
//   3. 机械指标只驱动 Track B soft 建议; 产品发布门 (Consistency P0) 永远
//      由语义层 (LLM 六维 / 一致性) 判定 — 防「为过反 AI 指标而毁一致性」
// ============================================================================

/** 信号分证声明 (供审计 / spec) */
export function signalDisclosure(input: {
  metricName: string
}): { metricName: string; productHardGate: false; track: "B" | "A"; note: string } {
  return {
    metricName: input.metricName,
    productHardGate: false,
    track: "B",
    note: "机械去 AI 指标为 Track B soft 信号; 产品硬门仅由 Consistency(P0) 语义层判定, 防止为过指标改写破坏一致性",
  }
}

// ============================================================================
// P0-1: 改写器腔 (humanizer-cavity) 防护 — 2026 检测对抗前沿共识
//
// aigc.md 核心反直觉: 乱加错字/假口语/机械断句对深度分类器 (Pangram4
// humanizer 头 / EditLens 介入度回溯) 适得其反 — 改写越深、越暴露改写痕迹。
// 三模型共识 (V1-ds r-hcavity / V1-hy3 R1/R3 / V2-ds+glm humanizer-tone-guard
// / V3-glm preserve-lock FPR 护栏): 目标不是把 slop 分数压到 0, 而是
// 「分布对齐自然文本」— 保留自然不均匀性, 禁止 converge 到统一改写风格。
// ============================================================================

/** 改写器腔 must-not-emit 指令 (注入 LLM 改写 prompt, 与 QM-QUAI 规则并列) */
export const HUMANIZER_CAVITY_GUARD = `## 改写器腔禁止 (2026 检测对抗前沿)

以下行为会制造「改写器腔」——深度检测器 (Pangram4 humanizer 头 / EditLens 介入度回溯) 专门抓这类信号, 越改写越暴露:

1. 假口语: 不要在每句加「呃/嗯/那个/额」，也不要刻意把对白改得结巴。真实口语密度远低于此。
2. 机械断句: 不要把所有长句切成等长短句。自然文本句长分布不均匀——允许长句存在。
3. 填充词泛滥: 不要在句首堆「其实/说白了/然而」。
4. 完美改写: 不要把每段都改到「无可挑剔」。人类写作有瑕疵: 松散段落、重复词、不完美转折。
5. 统一风格: 不要对全文施加同一种改写变换 (同批替换词/同句式)。检测器可聚类识别「单一改写者风格」。
6. 过度不规则: 不要刻意制造「不规则」来显得人工。CV 过高的句长分布本身就是改写信号。

**目标不是 slop 分数 0, 而是分布对齐自然文本**: 保留叙事节奏的自然不均匀性, 只消除真正的 AI 腔。`

/**
 * 构建 must-not-emit 指令片段, 供 adapter 拼接进 system prompt。
 * 与 HUMANIZER_CAVITY_GUARD 相同内容, 但可作为独立片段注入。
 */
export function buildHumanizerCavityGuard(): string {
  return HUMANIZER_CAVITY_GUARD
}
