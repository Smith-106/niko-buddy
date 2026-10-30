import type { ChatMessage } from "@/lib/llm-providers"
import { readFileSync } from "node:fs"
import { readFile } from "@/commands/fs"
import { join, resourceDir } from "@tauri-apps/api/path"
import { parseFrontmatter } from "@/lib/frontmatter"
import { splitChapterHeading } from "@/lib/chapter-selection"
import { HUMANIZER_CAVITY_GUARD } from "./de-ai-rules"
import { detectTieredDeAi } from "./de-ai-tiered-table"
import { slopScore, classifySlop } from "./mechanical-slop-detector"
import {
  parseReviewRewritePlan,
  applyReviewRewriteEditsToMarkdown,
  extractReviewRewriteJsonArray,
  type ReviewRewriteEdit,
  type ReviewRewriteApplyResult,
} from "@/lib/review-rewrite-plan"

function loadBundledDeAiSkill(): string {
  // NOTE: `import.meta.glob` must be called unconditionally (no typeof guard).
  // Vite inlines eager globs at build time, but the guard itself evaluates to
  // false in the built bundle and falls through to the Node-only fs path,
  // crashing module evaluation (white screen). In Node script runtimes (tsx)
  // the glob call throws -> caught -> fs fallback below.
  try {
    const modules = import.meta.glob("../../../skills/de-ai-writing/SKILL.md", {
      eager: true,
      query: "?raw",
      import: "default",
    }) as Record<string, string>
    const bundled = Object.values(modules)[0]
    if (bundled) return bundled
  } catch {
    // No glob transform (Node runtime): try fs below.
  }
  try {
    return readFileSync(new URL("../../../skills/de-ai-writing/SKILL.md", import.meta.url), "utf8")
  } catch {
    // webview: node:fs is a throwing shim — fail open with empty skill text
    // rather than crashing module evaluation (white screen).
    console.warn("[de-ai-adapter] bundled SKILL.md unavailable, using empty skill text")
    return ""
  }
}

const deAiSkillMarkdown = loadBundledDeAiSkill()
import type { ContextPack } from "./context-engine"

const QM_QUAI_SYSTEM_PROMPT = deAiSkillMarkdown.trim()

/**
 * 提取文档顶部 YAML frontmatter 块（开 --- 行起到下一个独占一行的 --- 止）。
 * 无 frontmatter 或未闭合 → null（严格边界，宁缺勿误配）。
 * BOM 兼容；CRLF 兼容；非贪婪停在首个闭合 ---，正文横线不干扰。
 */
function extractFrontmatter(markdown: string): string | null {
  if (!markdown) return null
  const start = markdown.match(/^\uFEFF?---[ \t]*\r?\n/)
  if (!start) return null
  const body = markdown.slice(start[0].length)
  const close = body.match(/\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!close || close.index === undefined) return null
  return body.slice(0, close.index)
}

/**
 * 解析 SKILL.md frontmatter 中的 metadata.version（P2-1 skill-versioning，35 号 frontmatter 边界化）。
 * 供审计/追踪：内置 skill 版本随产品发版（2.7.4），自定义 skill 无版本时返回 null。
 * 仅匹配文档顶部 --- frontmatter 块内的 version 键：正文孤立 version: 行不误配（理论边角修复）；
 * 字段名边界避免误匹配 contentVersion/schemaVersion；^[ \t]* 兼容 metadata 嵌套缩进。
 */
export function extractSkillVersion(markdown: string): string | null {
  const fm = extractFrontmatter(markdown)
  if (!fm) return null
  const match = fm.match(/^[ \t]*version:[ \t]*["']?([^\s"']+)/m)
  return match?.[1] ?? null
}

/** 内置 QM-QUAI skill 版本（发版同步 package.json 版本）。 */
export const BUILTIN_DE_AI_SKILL_VERSION: string =
  extractSkillVersion(deAiSkillMarkdown) ?? "unknown"

export async function loadCustomDeAiSkill(projectPath?: string | null): Promise<string | null> {
  if (!projectPath) return null
  try {
    const skillPath = await join(projectPath, "de-ai-skill.txt")
    const content = await readFile(skillPath)
    const trimmed = content.trim()
    return trimmed || null
  } catch {
    return null
  }
}

export function buildQmQuaiSystemPrompt(customSkill?: string): string {
  if (customSkill && customSkill.trim()) {
    return customSkill.trim()
  }
  return QM_QUAI_SYSTEM_PROMPT
}

export function buildDeAiSystemPrompt(customSkill?: string): string {
  return buildQmQuaiSystemPrompt(customSkill)
}

export function buildQmQuaiRewriteMessages(
  content: string,
  customSkill?: string,
  extra?: { userPrompt?: string; dualPassFragment?: string; cavityGuard?: boolean; preserveDirective?: string },
): ChatMessage[] {
  if (!content.trim()) throw new Error("去AI味内容为空，无法处理")
  const guardFragment = extra?.cavityGuard
    ? `\n\n${HUMANIZER_CAVITY_GUARD}`
    : ""
  const preserveFragment = extra?.preserveDirective?.trim()
    ? `\n\n${extra.preserveDirective.trim()}`
    : ""
  const systemContent = extra?.userPrompt?.trim()
    ? `${buildQmQuaiSystemPrompt(customSkill)}${guardFragment}${preserveFragment}\n\n${extra.userPrompt.trim()}`
    : `${buildQmQuaiSystemPrompt(customSkill)}${guardFragment}${preserveFragment}`
  const userContent = extra?.dualPassFragment?.trim()
    ? `请严格按照 QM-QUAI skill 规则处理下面正文。\n\n${extra.dualPassFragment.trim()}\n\n输出仅返回改写后的正文，不要解释。\n\n正文如下：\n\n${content}`
    : `请严格按照 QM-QUAI skill 规则处理下面正文。\n\n输出仅返回改写后的正文，不要解释。\n\n正文如下：\n\n${content}`
  return [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ]
}

export function buildDeAiRewriteMessages(
  content: string,
  customSkill?: string,
  extra?: { userPrompt?: string; dualPassFragment?: string; cavityGuard?: boolean; preserveDirective?: string },
): ChatMessage[] {
  return buildQmQuaiRewriteMessages(content, customSkill, extra)
}

/** 去 AI 味工作模式 */
export type DeAiMode = "detect" | "rewrite" | "edit"

export const DEFAULT_DE_AI_MODE: DeAiMode = "rewrite"

/** 单个 AI 味检测命中项 */
export interface DeAiDetectionHit {
  readonly id: string
  readonly term: string
  readonly category: string
  readonly tier: "1A" | "1B" | "3" | "slop"
  readonly startIndex: number
  readonly endIndex: number
  readonly suggestion: string
}

/** 静态检测汇总报告 (zero LLM) */
export interface DeAiDetectResult {
  readonly hits: readonly DeAiDetectionHit[]
  readonly slopPenalty: number
  readonly slopClass: "clean" | "warn" | "block"
  readonly markedText: string
}

/** 原位定点替换单项 */
export type DeAiSpanEdit = ReviewRewriteEdit

/** 原位替换校验与执行结果 */
export type DeAiSpanApplyResult = ReviewRewriteApplyResult

/** 机械层（tier1/tier2 词库 + tier3 正则）命中项在 UI 上的通用分类/建议 id（ASCII）。 */
export const DE_AI_SLOP_CATEGORY = "机械词"
export const DE_AI_SLOP_SUGGESTION = "建议删除或替换为具体生动的描写"

/** 单个正则命中区间（tier3 用正则自身定位，索引指向被展示的原文）。 */
interface RegexSpan {
  readonly term: string
  readonly startIndex: number
  readonly endIndex: number
}

/**
 * 取出章节**正文**（去 YAML frontmatter + 去一级标题），供 detect / edit 模式使用。
 *
 * 原因（RV-006）：整篇 fileContent 含 frontmatter 与 `# 章标题`：
 *  - detect 会把 frontmatter 字段值当成 AI 痕迹列出来（噪声）；
 *  - edit 模式下 LLM 返回的 `original_text` 若指向 frontmatter，
 *    `findUniqueExactReviewRewriteAnchor` 只在正文里找，永远定位不到 → 整批 ok:false。
 *
 * 复用既有正文切分链：`parseFrontmatter` → `splitChapterHeading`（与
 * replaceWholeChapterBody / review-rewrite-plan 完全一致）。回写仍走
 * `replaceWholeChapterBody`，因此 frontmatter 与标题原样保留。
 */
export function extractDeAiChapterBody(markdown: string): string {
  if (!markdown) return ""
  const { body } = parseFrontmatter(markdown)
  return splitChapterHeading(body).body
}

/**
 * 用正则自身在文本中定位全部非空命中。
 *
 * 必要性：`SlopHit.kw` 对 tier3 是**正则 source**（如 `既[^，。]{1,8}又[^，。]{1,8}`），
 * 用 `text.indexOf(kw)` 永远找不到（实测 65 条 tier3 模式中 33 条含元字符）。
 * 这里用 `matchAll` + `g` 旗标取回真实匹配文本与偏移。
 */
function matchRegexSpans(text: string, source: string): RegexSpan[] {
  const spans: RegexSpan[] = []
  if (!source) return spans
  let re: RegExp
  try {
    re = new RegExp(source, "g")
  } catch {
    // 词库正则均为模块级常量（构造期已验证）；单条非法 source 跳过，不让整个检测失败。
    return spans
  }
  for (const match of text.matchAll(re)) {
    const term = match[0]
    const startIndex = match.index
    if (!term || startIndex === undefined) continue
    spans.push({ term, startIndex, endIndex: startIndex + term.length })
  }
  return spans
}

/**
 * 纯静态检测正文中 AI 味与机械腔（零 LLM，零写盘）
 *
 * 偏移语义（RV-003）：所有 `startIndex/endIndex` 都相对**传入的原文**（= 对话框实际
 * 展示的文本）计算，不经过归一化副本。机械层分数 `slopScore` 内部会做 NFKC + 零宽
 * 剥离 + 同形字还原后再统计，因此「只在归一化后才命中」的样本（如 `显\u200b而易见`）
 * 会进入分数但不会产出可定位命中项——这是有意取舍：宁可少标注，也不把偏移指向
 * 错位的字符。不在此处重建 normalizer（避免两套归一化漂移）。
 */
export function runDeAiDetection(text: string): DeAiDetectResult {
  if (!text || !text.trim()) {
    return {
      hits: [],
      slopPenalty: 0,
      slopClass: "clean",
      markedText: text || "",
    }
  }

  const report = slopScore(text)
  const slopClass = classifySlop(report)
  const slopPenalty = report.slopPenalty

  const rawHits: Array<{
    term: string
    category: string
    tier: "1A" | "1B" | "3" | "slop"
    startIndex: number
    endIndex: number
    suggestion: string
  }> = []

  // 1. Tiered table hits (112 词分级表，字面词条 → indexOf 定位)
  const tiered = detectTieredDeAi(text)
  for (const item of tiered) {
    const { entry } = item
    // 空词条守卫：indexOf("") 恒为 0 且 pos 不前进 → 无限 push（RV-007）
    if (!entry.term) continue
    let pos = text.indexOf(entry.term)
    while (pos !== -1) {
      rawHits.push({
        term: entry.term,
        category: entry.category,
        tier: entry.tier,
        startIndex: pos,
        endIndex: pos + entry.term.length,
        suggestion: entry.suggestion,
      })
      pos = text.indexOf(entry.term, pos + entry.term.length)
    }
  }

  const seenSpans = new Set(rawHits.map((h) => `${h.startIndex}:${h.endIndex}`))

  // 2. 机械层字面词库命中（tier1/tier2：kw 是字面词，indexOf 可定位）
  for (const slop of [...report.tier1Hits, ...report.tier2Hits]) {
    if (!slop.kw) continue
    let pos = text.indexOf(slop.kw)
    while (pos !== -1) {
      const spanKey = `${pos}:${pos + slop.kw.length}`
      if (!seenSpans.has(spanKey)) {
        seenSpans.add(spanKey)
        rawHits.push({
          term: slop.kw,
          category: DE_AI_SLOP_CATEGORY,
          tier: "slop",
          startIndex: pos,
          endIndex: pos + slop.kw.length,
          suggestion: DE_AI_SLOP_SUGGESTION,
        })
      }
      pos = text.indexOf(slop.kw, pos + slop.kw.length)
    }
  }

  // 3. 机械层正则命中（tier3：kw 是正则 source → 必须用正则自身定位，见 matchRegexSpans）
  for (const slop of report.tier3Hits) {
    for (const span of matchRegexSpans(text, slop.kw)) {
      const spanKey = `${span.startIndex}:${span.endIndex}`
      if (seenSpans.has(spanKey)) continue
      seenSpans.add(spanKey)
      rawHits.push({
        term: span.term,
        category: DE_AI_SLOP_CATEGORY,
        tier: "slop",
        startIndex: span.startIndex,
        endIndex: span.endIndex,
        suggestion: DE_AI_SLOP_SUGGESTION,
      })
    }
  }

  // 按起始位置递增排序，同一起始按长度降序
  rawHits.sort((a, b) => a.startIndex - b.startIndex || b.term.length - a.term.length)

  const hits: DeAiDetectionHit[] = rawHits.map((h, i) => ({
    id: `hit-${i + 1}`,
    ...h,
  }))

  // 生成展示标记文本（非重叠区间插入【...】）
  let markedText = ""
  let lastIndex = 0
  for (const h of rawHits) {
    if (h.startIndex >= lastIndex) {
      markedText += text.slice(lastIndex, h.startIndex) + `【${h.term}】`
      lastIndex = h.endIndex
    }
  }
  if (lastIndex < text.length) {
    markedText += text.slice(lastIndex)
  }

  return {
    hits,
    slopPenalty,
    slopClass,
    markedText,
  }
}

/**
 * 构造原位编辑（edit 模式）LLM Prompt 消息
 * 强约束返回 JSON 数组，复用 review-rewrite-plan 的 [{"original_text", "replacement_text", "note"}] 契约
 */
export function buildDeAiEditMessages(
  content: string,
  customSkill?: string,
): ChatMessage[] {
  if (!content.trim()) throw new Error("去AI味内容为空，无法处理")
  return [
    {
      role: "system",
      content: [
        buildQmQuaiSystemPrompt(customSkill),
        "【执行模式：原位定点修改（edit）】",
        "你必须找出正文中需要消除 AI 味的具体片段，为每个片段给出替换后的文本。",
        "严禁整篇重写！严禁改动没有 AI 味的正常文字！未标记修改的句子必须保持一个字都不变。",
        "只返回 JSON 数组，严禁附带 Markdown 代码块标记（```json），严禁输出任何分析解释。",
        '数组格式：[{"original_text":"必须在正文中严格存在的唯一原文片段","replacement_text":"替换后的自然正文","note":"修改理由"}]',
      ].join("\n"),
    },
    {
      role: "user",
      content: `正文如下：\n\n${content}`,
    },
  ]
}

/**
 * 解析原位编辑 LLM 输出的 JSON 片段改写数组
 * 复用 review-rewrite-plan 中的 parseReviewRewritePlan
 *
 * 注意：契约保持「解析不出 → []」（其它调用方依赖）。需要区分「输出不可解析」与
 * 「解析成功但 0 条修改」的调用方用 `parseDeAiEditPlanChecked`。
 */
export function parseDeAiEditPlan(raw: string): DeAiSpanEdit[] {
  return parseReviewRewritePlan(raw)
}

/** edit 模式解析结果：区分「输出不可解析」与「可解析但 0 条修改」 */
export type DeAiEditPlanParseResult =
  | { readonly ok: true; readonly edits: readonly DeAiSpanEdit[] }
  | { readonly ok: false; readonly reason: "unparseable" }

/** edit 模式失败态（供 UI 展示 / 禁用写回）：模型输出不可解析 */
export type DeAiEditError = "unparseable"

/**
 * 严格版解析：LLM 输出里根本没有可解析的 JSON 数组 → ok:false。
 *
 * 不改 `parseReviewRewritePlan` 契约（它把「无 JSON / 截断 / 非数组」统一压成 []），
 * 本包装先跑它，再在结果为 0 条时用 `extractReviewRewriteJsonArray` 判断
 * 「输出里是否存在合法 JSON 数组」：
 *  - 有数组（含 `[]`、或元素缺 original/replacement 被过滤）→ ok:true, edits=[]（= 无可应用修改）
 *  - 无数组 / JSON 语法错误 / 非数组 → ok:false（= 模型输出不可解析，必须报错且禁止写回）
 */
export function parseDeAiEditPlanChecked(raw: string): DeAiEditPlanParseResult {
  const edits = parseReviewRewritePlan(raw)
  if (edits.length > 0) return { ok: true, edits }

  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim()
  const jsonText = extractReviewRewriteJsonArray(cleaned)
  if (!jsonText) return { ok: false, reason: "unparseable" }
  try {
    const parsed: unknown = JSON.parse(jsonText)
    if (!Array.isArray(parsed)) return { ok: false, reason: "unparseable" }
    return { ok: true, edits: [] }
  } catch {
    return { ok: false, reason: "unparseable" }
  }
}

/**
 * 执行原位定点片段替换
 * 严格复用 review-rewrite-plan 的 applyReviewRewriteEditsToMarkdown（含唯一锚点校验）
 */
export function applyDeAiSpanEdits(
  content: string,
  edits: DeAiSpanEdit[],
): DeAiSpanApplyResult {
  return applyReviewRewriteEditsToMarkdown(content, edits)
}

const DIRECTIVE_PREFIX = [
  "请保持剧情一致，并用更自然、更像真人网文作者的方式输出。",
  "减少套话、总结腔和机械解释。",
  "注意中文小说适配：保留角色声线、对白毛边、叙事节奏和必要停顿，不要按非虚构文章规则硬删副词或压缩到固定字数。",
  "",
  "任务内容：",
  "",
].join("\n")

export function injectDeAiDirective(content: string, enabled: boolean): string {
  if (!enabled) return content
  return DIRECTIVE_PREFIX + content
}

// ============ 智能场景选择功能 ============

/**
 * 场景类型
 */
type ContentGenre = 'web-novel' | 'popular-science' | 'commentary' | 'translation' | 'default'

/**
 * 检测内容场景类型
 * @param task 用户请求文本
 * @param contextPack 上下文包（可选）
 * @returns 场景类型
 */
function detectContentGenre(
  task: string,
  contextPack?: ContextPack
): ContentGenre {
  // 1. 翻译任务优先级最高
  if (/翻译|translate|译文|英译中|中译英/.test(task)) {
    return 'translation'
  }

  // 2. 科普文章
  if (/科普|科学普及|知识分享|科技解读/.test(task)) {
    return 'popular-science'
  }

  // 3. 观点评论（触发good-writing）
  if (/评论|书评|影评|观点|散文|随笔/.test(task)) {
    return 'commentary'
  }

  // 4. 检查大纲中的genre标记
  if (contextPack?.outline) {
    const genreMatch = contextPack.outline.match(/genre:\s*(\w+)/i)
    if (genreMatch) {
      const genre = genreMatch[1].toLowerCase()
      if (['xuanhuan', 'wuxia', 'xianxia', 'dushi'].includes(genre)) {
        return 'web-novel'
      }
    }
  }

  // 5. 默认：网络小说（项目主要使用场景）
  return 'web-novel'
}

/**
 * 场景类型映射到skill文件路径
 * @param genre 场景类型
 * @returns skill文件路径
 */
function genreToSkillPath(genre: ContentGenre): string {
  switch (genre) {
    case 'commentary':
    case 'popular-science':
      return 'skills/good-writing/SKILL.md'
    case 'web-novel':
    case 'translation':
    case 'default':
    default:
      return 'skills/de-ai-writing/SKILL.md'
  }
}

/**
 * 从打包的资源目录读取skill文件
 * @param skillPath 相对于资源目录的skill路径
 * @returns skill内容，失败返回null
 */
async function tryLoadSkillFromBundle(skillPath: string): Promise<string | null> {
  try {
    const resDir = await resourceDir()
    const fullPath = await join(resDir, skillPath)
    const content = await readFile(fullPath)
    return content.trim() || null
  } catch {
    return null
  }
}

/**
 * 智能加载去AI味skill（根据场景自动选择）
 * @param projectPath 项目路径
 * @param userRequest 用户请求文本
 * @param contextPack 上下文包（可选）
 * @returns skill内容，失败返回null（将使用内置规则兜底）
 */
export async function loadSmartDeAiSkill(
  projectPath: string | null,
  userRequest: string,
  contextPack?: ContextPack
): Promise<string | null> {
  if (!projectPath) return null

  // 1. 最高优先：用户自定义 de-ai-skill.txt
  try {
    const customPath = await join(projectPath, "de-ai-skill.txt")
    const customSkill = await readFile(customPath)
    const trimmed = customSkill.trim()
    if (trimmed) return trimmed
  } catch {
    // 用户未自定义，继续自动选择
  }

  // 2. 场景检测
  const genre = detectContentGenre(userRequest, contextPack)

  // 3. 根据场景选择skill
  const skillPath = genreToSkillPath(genre)
  const sceneSkill = await tryLoadSkillFromBundle(skillPath)
  if (sceneSkill) return sceneSkill

  // 4. 保底：返回null，使用内置规则
  return null
}
