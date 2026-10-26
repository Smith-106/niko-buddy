/**
 * chapter-typography.ts — 章节标题解析与文档排版归一（纯函数，零 LLM）。
 *
 * 背景：`autonomous-campaign` 产出的章节 frontmatter 只写裸标签 `title: "第N章"`，
 * 真实章节名留在正文 H1（如 `# 第5章 律师说没漏洞`），部分章节甚至同时存在
 * `# 第N章` 与 `# 第N章 章名` 两个 H1。结果是目录(TOC)只显示「第3章」，作者无法
 * 分辨章节内容。本模块把「标题解析」和「排版归一」收敛为单一真源：
 *
 *   1. resolveChapterTitle —— 目录/预览统一用同一优先级取标题
 *      （富 frontmatter > 富 H1 > 裸标签 > 回退；只升级不降级）。
 *   2. normalizeChapterDocument —— 写入边界把文档整理成规范形态：
 *      frontmatter title 同步为富标题、正文重复裸 H1 去重为单一 canonical H1、
 *      body 过既有 normalizeMarkdownBody（引号/省略号/间隔等排版规则）。
 *
 * 纪律：
 *   - 幂等：对已规范文档再跑一次必须 changed=false（spec 守卫）。
 *   - frontmatter 除 `title` 外逐字节保留。
 *   - 不新增真源、不改门控语义；Draft-first 不变（本模块只整理文本）。
 */

import { normalizeMarkdownBody } from "./normalize-markdown-body"

/** 裸章节标签：`第N章` / `第N节` / `第N卷` / `第N回`，N 为中文或阿拉伯数字，无章节名。 */
const BARE_CHAPTER_LABEL_RE =
  /^第\s*[0-9零〇一二两三四五六七八九十百千]+\s*[章节卷回](?:\s*[：:、.\-—]?\s*)?$/

/** 富章节标题：`第N章 章名`（章名部分非空）。 */
const RICH_CHAPTER_TITLE_RE =
  /^第\s*[0-9零〇一二两三四五六七八九十百千]+\s*[章节卷回](?:\s*[：:、.\-—]\s*|\s+)\S.*$/

/** `^# 标题` 一级标题行。 */
const H1_LINE_RE = /^#[ \t]+(.+?)[ \t]*$/gm

/** 文档开头 frontmatter 块。 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/

/** frontmatter 内的 title 行。 */
const FRONTMATTER_TITLE_RE = /^title:[ \t]*["']?(.*?)["']?[ \t]*$/m

/**
 * 是否为「无章节名」的裸章节标签。
 * 例：`第3章` → true；`第3章 律师说没漏洞` → false；`第三章` → true。
 */
export function isBareChapterLabel(text: string): boolean {
  return BARE_CHAPTER_LABEL_RE.test(text.trim())
}

/** 是否为「带章节名」的富章节标题。 */
export function isRichChapterTitle(text: string): boolean {
  return RICH_CHAPTER_TITLE_RE.test(text.trim()) && !isBareChapterLabel(text)
}

const CNY_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

/** 解析章节序号（`第12章` / `第十二章` / `第一百零三章` → 数字；无法解析 → null）。 */
export function parseChapterOrdinal(text: string): number | null {
  const match = text.match(/第\s*([0-9零〇一二两三四五六七八九十百千]+)\s*[章节卷回]/)
  const raw = match?.[1]
  if (!raw) return null
  if (/^[0-9]+$/.test(raw)) return Number.parseInt(raw, 10)

  let total = 0
  let section = 0
  let digit = 0
  for (const char of raw) {
    if (char === "百") {
      section += (digit === 0 ? 1 : digit) * 100
      digit = 0
    } else if (char === "十") {
      section += (digit === 0 ? 1 : digit) * 10
      digit = 0
    } else if (char === "千") {
      section += (digit === 0 ? 1 : digit) * 1000
      digit = 0
    } else {
      const value = CNY_DIGITS[char]
      if (value === undefined) return null
      digit = value
    }
  }
  total = section + digit
  return total > 0 ? total : null
}

function stripFrontmatter(content: string): string {
  const fm = content.match(FRONTMATTER_RE)
  return fm ? content.slice(fm[0].length) : content
}

/** 提取 frontmatter title 原值（无则 undefined）。 */
export function readFrontmatterTitle(content: string): string | undefined {
  const fm = content.match(FRONTMATTER_RE)
  if (!fm) return undefined
  const match = fm[1].match(FRONTMATTER_TITLE_RE)
  return match?.[1]?.trim() || undefined
}

/** 提取正文全部 H1 文本（按出现顺序）。 */
export function extractH1Headings(content: string): string[] {
  const body = stripFrontmatter(content)
  const headings: string[] = []
  for (const match of body.matchAll(H1_LINE_RE)) {
    const text = match[1]?.trim()
    if (text) headings.push(text)
  }
  return headings
}

/**
 * 解析章节显示标题（目录 / 预览 / 重命名共用）。
 *
 * 优先级（只升级不降级）：
 *   1. frontmatter title 已是富标题 → 直接用；
 *   2. 正文存在富 H1（`# 第N章 章名`）→ 用第一个富 H1；
 *   3. frontmatter title 为裸标签 → 用 frontmatter（保持旧行为）；
 *   4. 正文首个非裸 H1 → 用之（如无 frontmatter 的导入章节）；
 *   5. fallback（通常为文件名派生标题）。
 */
/**
 * 去掉模型偶尔包在正文外的 ``` 代码围栏（格式回声）。
 *
 * 提示词已要求「不要包裹代码块」，但模型并非强制遵守；围栏字面量一旦落进
 * 正式章节文件会污染正文与目录。此函数是纯字符串处理，零依赖，供写入边界复用。
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fence = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/)
  return fence ? fence[1] : trimmed
}

export function resolveChapterTitle(content: string, fallback?: string): string {
  const fmTitle = readFrontmatterTitle(content)
  const headings = extractH1Headings(content)
  const richHeading = headings.find((h) => isRichChapterTitle(h))
  const nonBareHeading = headings.find((h) => !isBareChapterLabel(h))

  if (fmTitle && isRichChapterTitle(fmTitle)) return fmTitle
  if (richHeading) return richHeading
  if (fmTitle) return fmTitle
  if (nonBareHeading) return nonBareHeading
  const firstHeading = headings[0]
  if (firstHeading) return firstHeading
  return (fallback ?? "").trim()
}

export interface NormalizeChapterOptions {
  /** 标题已由调用方解析（如 campaign 的任务标题），优先于文档内解析结果。 */
  preferredTitle?: string
  /** 正文是否走 format-normalizer（引号/省略号/间隔等排版规则）。默认 true。 */
  normalizeBody?: boolean
}

export interface NormalizeChapterResult {
  content: string
  title: string
  changed: boolean
  /** 变更类别，便于脚本打印与测试断言。 */
  changes: {
    titleSynced: boolean
    headingsDeduped: number
    bodyNormalized: boolean
  }
}

/**
 * 章节文档归一（写入边界用；幂等）。
 *
 * 规则：
 *   - 解析出富标题后同步 frontmatter `title`（无 frontmatter 时不新增，仅整理正文）；
 *   - 正文开头连续的标题行里若存在裸 H1 / 与 canonical 等价的重复 H1，收敛为单一
 *     `# <富标题>`，避免「# 第1章」+「# 第1章 章名」并存；
 *   - body 过 normalizeMarkdownBody（frontmatter 原样保留）。
 */
export function normalizeChapterDocument(
  content: string,
  options: NormalizeChapterOptions = {},
): NormalizeChapterResult {
  const { preferredTitle, normalizeBody = true } = options
  const fm = content.match(FRONTMATTER_RE)
  const frontmatter = fm ? fm[0] : ""
  let body = fm ? content.slice(fm[0].length) : content

  const resolved = (preferredTitle ?? "").trim() || resolveChapterTitle(content, "")
  const title = resolved.length > 0 ? resolved : readFrontmatterTitle(content) ?? ""
  let titleSynced = false
  let headingsDeduped = 0

  // 1) frontmatter title 同步（仅当存在 frontmatter 且与解析结果不一致）
  let nextFrontmatter = frontmatter
  if (fm && title) {
    const currentTitle = readFrontmatterTitle(content)
    if (currentTitle !== title) {
      const escaped = title.replace(/"/g, '\\"')
      if (FRONTMATTER_TITLE_RE.test(fm[1])) {
        nextFrontmatter = fm[0].replace(FRONTMATTER_TITLE_RE, `title: "${escaped}"`)
      } else {
        nextFrontmatter = fm[0].replace(/^---(\r?\n)/, `---$1title: "${escaped}"$1`)
      }
      titleSynced = nextFrontmatter !== fm[0]
    }
  }

  // 2) 开头标题行去重：把正文起始处连续的 H1 行收敛为一条 canonical 标题
  if (title) {
    const eol = body.includes("\r\n") ? "\r\n" : "\n"
    const lines = body.split(/\r?\n/)
    let index = 0
    while (index < lines.length && lines[index].trim() === "") index += 1
    const leadingH1: number[] = []
    let cursor = index
    while (cursor < lines.length) {
      const line = lines[cursor]
      if (line.trim() === "") {
        cursor += 1
        continue
      }
      if (/^#[ \t]+/.test(line)) {
        leadingH1.push(cursor)
        cursor += 1
        continue
      }
      break
    }
    if (leadingH1.length > 0) {
      const canonicalOrdinal = parseChapterOrdinal(title)
      const redundant = leadingH1.filter((lineIndex) => {
        const text = lines[lineIndex].replace(/^#[ \t]+/, "").trim()
        if (isBareChapterLabel(text) || text === title) return true
        // 同一章号的旧标题（如调用方 preferredTitle 更准确时）一并收敛，避免双标题并存
        const ordinal = parseChapterOrdinal(text)
        return canonicalOrdinal !== null && ordinal === canonicalOrdinal
      })
      // 只有真正删行或标题行需重写时才重建，避免无意义的行尾风格改写（changed 判据保持纯净）
      const needsRewrite =
        redundant.length > 1 ||
        (redundant.length === 1 && lines[redundant[0]].trim() !== `# ${title}`)
      if (needsRewrite) {
        const keep = redundant[redundant.length - 1]
        const keptLine = `# ${title}`
        const nextLines: string[] = []
        for (let i = 0; i < lines.length; i += 1) {
          if (redundant.includes(i) && i !== keep) {
            headingsDeduped += 1
            continue
          }
          nextLines.push(i === keep ? keptLine : lines[i])
        }
        body = nextLines.join(eol)
        // 去重后可能多出前导空行：头块已以换行结尾时只保留一个空行
        if (frontmatter) body = body.replace(/^[ \t]*(?:\r?\n)+/, eol)
      }
    }
  }

  // 3) 正文排版规范化（frontmatter 已剥离，不会被改写）
  let bodyNormalized = false
  if (normalizeBody) {
    const normalized = normalizeMarkdownBody(body)
    if (normalized !== body) {
      body = normalized
      bodyNormalized = true
    }
  }

  const nextContent = nextFrontmatter + body
  return {
    content: nextContent,
    title,
    changed: nextContent !== content,
    changes: { titleSynced, headingsDeduped, bodyNormalized },
  }
}
