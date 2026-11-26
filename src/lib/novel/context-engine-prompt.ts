/**
 * context-engine-prompt.ts — ContextPack → prompt 文本渲染族（纯搬迁，零逻辑变更）
 *
 * 从 context-engine.ts 抽出（P1 巨文件拆分，swarm ts-bloat-20261017 裁决）。
 * 承载 LayeredRecallMode / ContextPackToPromptOptions / FieldConfig /
 * FIELD_CONFIGS / FORMER_FACTS_CAP / contextPackToPrompt。
 */
import i18n from "@/i18n"
import type { ContextPack, ContextEntity } from "./context-engine"
import type { HardInjectItem } from "./search-adapter"
import type { TemporalFact } from "./temporal-memory"
import { applySectionCharBudget } from "./context-pack-format-helpers"
import { PROTECTED_TRIM_FIELDS, SECTION_PRIORITY_BY_FIELD } from "./context-engine-gaps"

/** Layered recall mode (Tencent L0–L3 inspired; default = scenario+persona). */
export type LayeredRecallMode = "default" | "full" | "scenario_persona"

export interface ContextPackToPromptOptions {
  excludeOutline?: boolean
  /**
   * G6：canonRules 段只渲染 **temporal 增量**（base 已进稳定缓存段）。
   *
   * 置 true 时 canonRules 段输出 `full` 去掉 `base` 前缀后的后缀；若 base 不是
   * full 的前缀（上游 join 语义变化等异常），退化为完整 canonRules —— 宁可失去
   * 缓存收益，也不丢规则。与 `renderCanonRulesBaseForStablePrefix` 成对使用。
   */
  excludeCanonRulesBase?: boolean
  temporalFactsEnabled?: boolean
  /**
   * E-02 (C-10): 硬注入段渲染开关（默认 false）。false 时完全跳过该段，
   * 保 prompt 字节级不变（可逆上线）。
   */
  hardInjectEnabled?: boolean
  /**
   * default / scenario_persona: L2+L3 first; L1-heavy blocks only when temporalFactsEnabled or full.
   * full: include all present sections (still subject to tokenBudget).
   */
  layeredRecall?: LayeredRecallMode
  /** Soft per-section character budget (after join of array items). */
  sectionCharBudget?: number
}

interface FieldConfig {
  titleKey: string
  /** R2-W06：i18n 缺键时兜底标题，绝不把裸 key 泄漏进 Prompt。 */
  fallbackTitle?: string
  fieldKey: keyof ContextPack
  /**
   * F-06: 条件渲染谓词 — 仅当返回 true 才把该段渲染进 prompt.
   * flag=false 时完全跳过该段, 保 prompt 字节级不变 (R1).
   */
  renderIf?: (
    pack: ContextPack,
    flags: { temporalFactsEnabled: boolean; layeredRecall: LayeredRecallMode; hardInjectEnabled: boolean },
  ) => boolean
  /**
   * 对象数组序列化 — 把 ContextEntity[] 格式化为 string[], 避免 [object Object].
   */
  serialize?: (
    content: unknown,
    pack: ContextPack,
    flags: { temporalFactsEnabled: boolean; layeredRecall: LayeredRecallMode; hardInjectEnabled: boolean },
  ) => string | string[]
  /** Soft layer tag for docs / budget policy (not a hard gate). */
  layer?: "L0" | "L1" | "L2" | "L3" | "aux"
}

function resolveFieldTitle(config: FieldConfig): string {
  if (config.fallbackTitle && !i18n.exists(config.titleKey)) {
    return config.fallbackTitle
  }
  return i18n.t(config.titleKey)
}

/**
 * C（方案 X 全做 M+）P0 护栏：former 事实独立分块渲染条数上限。
 * 压缩误导空间（失效事实不应喧宾夺主），与有效 temporal 块解耦。
 */
const FORMER_FACTS_CAP = 8

const FIELD_CONFIGS: FieldConfig[] = [
  { titleKey: "novel.contextPack.currentChapterGoal", fieldKey: "chapterGoal", layer: "L2" },
  { titleKey: "novel.contextPack.mustDo.title", fieldKey: "mustDo", layer: "L2" },
  { titleKey: "novel.contextPack.mustAvoid.title", fieldKey: "mustAvoid", layer: "L2" },
  { titleKey: "novel.contextPack.nextChapterAdvice.title", fieldKey: "nextChapterAdvice", layer: "L2" },
  { titleKey: "novel.contextPack.soulDoc", fieldKey: "soulDoc", layer: "L3" },
  { titleKey: "novel.contextPack.recentRevisionDirectives", fieldKey: "revisionDirectives", layer: "L2" },
  { titleKey: "novel.contextPack.requiredOutline", fieldKey: "outline", layer: "L2" },
  {
    titleKey: "novel.contextPack.recentChapterContents",
    fieldKey: "recentChapterContents",
    layer: "L0",
    // L0-ish raw chapter bodies: only in full recall to avoid context blow-up
    renderIf: (_pack, flags) => flags.layeredRecall === "full",
  },
  { titleKey: "novel.contextPack.recentPlotSummaries", fieldKey: "recentSummaries", layer: "L2" },
  {
    // P2-IMP-10 (M2): stateDelta 键控子表段 — additive 独立分块，renderIf 非空才渲染
    // （空 store / 无快照时不渲染，recentSummaries 现路径字节级不动）。
    titleKey: "novel.contextPack.recentStateDeltas",
    fieldKey: "recentStateDeltas",
    layer: "L2",
    renderIf: (pack) => Boolean(pack.recentStateDeltas),
  },
  { titleKey: "novel.contextPack.previousChapterEnding", fieldKey: "previousChapterEnding", layer: "L2" },
  { titleKey: "novel.contextPack.characterStates", fieldKey: "characterStates", layer: "L3" },
  { titleKey: "novel.contextPack.characterAuras", fieldKey: "characterAuras", layer: "L3" },
  { titleKey: "novel.contextPack.cognitionStates", fieldKey: "cognitionStates", layer: "L3" },
  { titleKey: "novel.contextPack.foreshadowingStates", fieldKey: "foreshadowingStates", layer: "L2" },
  { titleKey: "novel.contextPack.timeline", fieldKey: "timeline", layer: "L2" },
  { titleKey: "novel.contextPack.relatedSettings", fieldKey: "relatedSettings", layer: "L3" },
  {
    titleKey: "novel.contextPack.canonRules",
    fieldKey: "canonRules",
    layer: "L1",
    // L1-heavy: default path keeps when present; full always; scenario_persona skips unless temporal on
    renderIf: (pack, flags) => {
      if (flags.layeredRecall === "full") return true
      if (flags.layeredRecall === "scenario_persona" && !flags.temporalFactsEnabled) return false
      return Boolean(pack.canonRules && (Array.isArray(pack.canonRules) ? pack.canonRules.length : pack.canonRules))
    },
  },
  { titleKey: "novel.contextPack.writingStyle", fieldKey: "writingStyle", layer: "L3" },
  {
    titleKey: "novel.contextPack.voiceStyleGuide",
    fallbackTitle: "## 声音与风格指南",
    fieldKey: "voiceStyleGuide",
    layer: "L3",
    renderIf: (pack) => Boolean(pack.voiceStyleGuide?.trim()),
  },
  { titleKey: "novel.contextPack.searchResults", fieldKey: "searchResults", layer: "aux" },
  { titleKey: "novel.contextPack.graphSearchResults", fieldKey: "graphSearchResults", layer: "aux" },
  { titleKey: "novel.contextPack.communitySummaries", fieldKey: "communitySummaries", layer: "L2" },
  {
    // MIG-002: 世界骨架段 — additive 独立分块；renderIf 非空才渲染
    // （空/无 blueprint → undefined → 不渲染，字节级不变）。
    titleKey: "novel.contextPack.worldBlueprint",
    fieldKey: "worldBlueprint",
    layer: "L2",
    renderIf: (pack) => Boolean(pack.worldBlueprint),
  },
  {
    // MIG-003: 叙事信息差可见性段 — additive 独立分块；renderIf 非空才渲染
    // （空 store/无可见声明 → undefined → 不渲染，字节级不变）。
    titleKey: "novel.contextPack.narrativeVisibility",
    fieldKey: "narrativeVisibility",
    layer: "L2",
    renderIf: (pack) => Boolean(pack.narrativeVisibility),
  },
  { titleKey: "novel.contextPack.relatedChapters", fieldKey: "relatedChapters", layer: "L2" },
  // Wave 2 (v2.5.0): @引用段渲染条目（additive，与 relatedChapters 同款）
  { titleKey: "novel.contextPack.references", fieldKey: "references", layer: "aux" },
  {
    // P1-IMP-13 (A1a): 素材引用绑定段 — additive 独立字段；renderIf 非空才渲染
    // （零绑定 / 加载失败 → undefined → 不渲染，字节级不变）。
    titleKey: "novel.contextPack.referenceBindings",
    fieldKey: "referenceBindings",
    layer: "aux",
    renderIf: (pack) => Boolean(pack.referenceBindings),
  },
  {
    // E-02 (C-9/D6): 硬注入段 — 独立 additive 分块（绝不并入 canonRules / searchResults）。
    // renderIf 双门控：hardInjectEnabled flag（可逆上线）+ 条目非空（空数据不渲染，字节级不变）。
    titleKey: "novel.contextPack.hardInject",
    fieldKey: "hardInject",
    layer: "L1",
    renderIf: (pack, flags) => flags.hardInjectEnabled === true && (pack.hardInject?.length ?? 0) > 0,
    serialize: (content) => {
      const items = content as HardInjectItem[]
      return items.map((item) => `- ${item.text}`)
    },
  },
  {
    titleKey: "novel.contextPack.activeEntities",
    fieldKey: "activeEntities",
    layer: "L1",
    renderIf: (pack, flags) =>
      (flags.temporalFactsEnabled === true || flags.layeredRecall === "full") &&
      (pack.activeEntities?.length ?? 0) > 0,
    serialize: (content) => {
      const entities = content as ContextEntity[]
      return entities.map((e) => "- " + e.name + (e.tags && e.tags.length ? " (tags: " + e.tags.join(", ") + ")" : ""))
    },
  },
  {
    // C：已失效（曾成立）事实独立分块 —— 禁并入 canonRules / 有效 temporal 块（P0 护栏）。
    titleKey: "novel.contextPack.formerFacts",
    fieldKey: "formerFacts",
    layer: "L2",
    // 仅当存在 former 事实才渲染；former 为空 → 不渲染（字节级不变，由数据空保证，无独立 flag 门控）。
    renderIf: (pack) => (pack.formerFacts?.length ?? 0) > 0,
    serialize: (content, pack) => {
      const former = content as TemporalFact[]
      // P0 护栏：条数上限 cap，压缩误导空间。
      const capped = former.slice(0, FORMER_FACTS_CAP)
      // 最佳努力配对：同 (subject,predicate) 的当前有效事实作为替代事实（曾以为X→现Y）。
      const currentByKey = new Map<string, TemporalFact>()
      for (const f of pack.temporalFacts ?? []) {
        currentByKey.set(`${f.subject}::${f.predicate}`, f)
      }
      return capped.map((f) => {
        const window = `[第${f.validFrom}章起→第${f.validUntil}章失效]`
        const formerPhrase = f.object ? `${f.subject}${f.predicate ? f.predicate + " " : ""}${f.object}` : f.subject
        const replacement = currentByKey.get(`${f.subject}::${f.predicate}`)
        const replPhrase = replacement?.object
          ? `${replacement.subject}${replacement.predicate ? replacement.predicate + " " : ""}${replacement.object}`
          : ""
        if (replacement && replPhrase) {
          return `- ${window} 曾以为「${formerPhrase}」→ 现「${replPhrase}」`
        }
        return `- ${window} 曾以为「${formerPhrase}」（当前已失效，禁止作为当前叙述事实）`
      })
    },
  },
]



/**
 * G6：把 `canonRules` 拆成「稳定段（base）」与「动态段（temporal 增量）」。
 *
 * **单一真源**：稳定段与动态段必须从同一个函数取值，否则两侧归一化不一致时
 * 会出现「base 既在稳定段又在动态段」的重复渲染。
 *
 * 归一化：上游 `joinNonEmpty` 对每个 part 做 `.trim()`，所以 base 实际以
 * `base.trim()` 的形式出现在 `canonRules` 头部；两侧都用 trim 后的 base。
 *
 * 退化：base 为空、或 `full` 不以 base 开头（上游语义变化、CRLF、行尾空格等
 * 导致 startsWith 不成立）时，**清空稳定段**并让完整 canonRules 走动态段。
 * 宁可零缓存收益，也绝不重复渲染规则（重复会把「降费」变成「增费」）。
 */
export function splitCanonRules(pack: ContextPack): { stable: string; delta: string } {
  const base = (pack.canonRulesBase ?? "").replace(/\r\n/g, "\n").trim()
  const full = (pack.canonRules ?? "").replace(/\r\n/g, "\n")
  if (!base) return { stable: "", delta: full }
  if (full === base) return { stable: base, delta: "" }
  if (full.startsWith(`${base}\n`)) {
    return { stable: base, delta: full.slice(base.length).replace(/^\n+/, "") }
  }
  return { stable: "", delta: full }
}

/**
 * G6：canonRules 去掉项目级 base 前缀后的 **temporal 增量**（内容级等价）。
 *
 * 退化时返回完整 canonRules。调用方若要**同时**渲染稳定段，必须用
 * [`splitCanonRules`]（它在退化时同时清空稳定段），否则会重复渲染 base。
 */
export function canonRulesDelta(full: string, base: string): string {
  return splitCanonRules({ canonRules: full, canonRulesBase: base } as ContextPack).delta
}

/**
 * G6：把 `canonRulesBase` 渲染成**稳定缓存段**用的文本（标题 + 基线内容）。
 *
 * 与 `contextPackToPrompt` 的 canonRules 段同源渲染，保证两段拼起来恰好等于
 * 原 canonRules，不重复、不丢失。空串不进稳定段（避免无意义的前缀抖动）。
 */
export function renderCanonRulesBaseForStablePrefix(pack: ContextPack): string {
  const config = FIELD_CONFIGS.find((c) => c.fieldKey === "canonRules")
  /* v8 ignore next -- 台账 context-engine-prompt.ts L245：canonRules 是 FIELD_CONFIGS 的静态成员（同文件 L105），find 恒命中 */
  if (!config) return ""
  // 单一真源：与动态段同源切分，退化时稳定段为空（绝不重复渲染）。
  const { stable } = splitCanonRules(pack)
  if (!stable) return ""
  return [resolveFieldTitle(config), stable].join("\n")
}

interface RenderedFieldSection {
  fieldKey: keyof ContextPack
  title: string
  content: string | string[]
}

function estimatePromptTokens(text: string): number {
  const cjkCount = (text.match(/[㐀-鿿]/g) ?? []).length
  const nonCjk = text.length - cjkCount
  return Math.ceil(nonCjk / 4 + cjkCount / 1.5)
}

function charsForTokenBudget(text: string, tokenBudget: number): number {
  const cjkCount = (text.match(/[㐀-鿿]/g) ?? []).length
  const cjkRatio = text.length > 0 ? cjkCount / text.length : 0
  const charsPerToken = 1 / (cjkRatio / 1.5 + (1 - cjkRatio) / 4)
  return Math.max(1, Math.floor(tokenBudget * charsPerToken))
}

function renderSectionsPrompt(
  headerLines: readonly string[],
  fieldSections: readonly RenderedFieldSection[],
  droppedLabels: readonly string[],
): string {
  const lines: string[] = [...headerLines]
  for (const { title, content } of fieldSections) {
    lines.push(title)
    if (Array.isArray(content)) {
      for (const item of content) lines.push(item)
    } else {
      lines.push(content)
    }
    lines.push("")
  }
  if (droppedLabels.length > 0) {
    lines.push(`[...上下文已按优先级裁剪低优分段: ${droppedLabels.join("、")}...]`)
  }
  return lines.join("\n")
}

export function contextPackToPrompt(
  pack: ContextPack,
  tokenBudget?: number,
  options?: ContextPackToPromptOptions,
): string {
  const headerLines: string[] = [
    i18n.t("novel.contextPack.title"),
    "",
    i18n.t("novel.contextPack.currentTask"),
    pack.task,
    "",
  ]

  const layeredRecall: LayeredRecallMode = options?.layeredRecall ?? "default"
  const fieldSections: RenderedFieldSection[] = []
  for (const config of FIELD_CONFIGS) {
    // 如果设置了 excludeOutline，跳过大纲字段
    if (options?.excludeOutline && config.fieldKey === "outline") {
      continue
    }

    // F-06: 条件渲染守卫 — renderIf 返回 false (如 temporalFactsEnabled=false) 时完全跳过该段, 保 prompt 字节级不变
    const flags = {
      temporalFactsEnabled: options?.temporalFactsEnabled === true,
      layeredRecall,
      hardInjectEnabled: options?.hardInjectEnabled === true,
    }
    if (config.renderIf && !config.renderIf(pack, flags)) continue

    let raw = pack[config.fieldKey] as string | string[]
    // G6：动态段只放 temporal 增量。退化（base 不是前缀）时 splitCanonRules
    // 返回完整 canonRules 且稳定段为空，不会出现两段都含 base 的重复渲染。
    let titleSuffix = ""
    if (options?.excludeCanonRulesBase && config.fieldKey === "canonRules") {
      const split = splitCanonRules(pack)
      raw = split.delta
      // 稳定段已占用了同名标题；增量段加后缀区分，避免 prompt 里出现两个
      // 完全相同的「## 禁止违背」，同时保留该段的可识别性。
      // 注意口径变化（MINOR-2）：sectionCharBudget 现在只作用在 delta 上，
      // 所以该段上限 = base(≤2000，走稳定段) + sectionCharBudget。
      if (split.stable) titleSuffix = i18n.t("novel.contextPack.canonRulesTemporalSuffix")
    }
    let content = config.serialize ? config.serialize(raw, pack, flags) : raw
    content = applySectionCharBudget(content, options?.sectionCharBudget)
    const hasContent = Array.isArray(content) ? content.length > 0 : Boolean(content)
    if (!hasContent) continue
    fieldSections.push({ fieldKey: config.fieldKey, title: resolveFieldTitle(config) + titleSuffix, content })
  }

  // R2-W06：按语言无关 fieldKey 排序（免疫英文 locale 与 G6 titleSuffix）
  fieldSections.sort((a, b) => {
    const priorityA = SECTION_PRIORITY_BY_FIELD[a.fieldKey] ?? 999
    const priorityB = SECTION_PRIORITY_BY_FIELD[b.fieldKey] ?? 999
    return priorityA - priorityB
  })

  const fullPrompt = renderSectionsPrompt(headerLines, fieldSections, [])

  if (tokenBudget && tokenBudget > 0 && fullPrompt.length > tokenBudget) {
    // COR (odyssey-review): CJK chars tokenize ~1 token/1.5char, not 1/4.
    if (estimatePromptTokens(fullPrompt) <= tokenBudget) return fullPrompt

    // R2-W06：优先级整段降级裁剪替代 40/60 盲切——先整段剔除非保护低优分段，
    // 保护 P0/P1 核心段（canonRules/outline/chapterGoal/soulDoc/hardInject/mustDo/mustAvoid 等）。
    const keptSections: RenderedFieldSection[] = fieldSections.map((s) => ({ ...s }))
    const droppedLabels: string[] = []
    let currentPrompt = fullPrompt

    // 当且仅当剩余分段数 > 1 时整段剔除最低优非保护段；仅剩最后 1 段时留给下方 CJK 加权尾截断，避免整包清空
    while (keptSections.length > 1 && estimatePromptTokens(currentPrompt) > tokenBudget) {
      let dropIdx = -1
      let maxPriority = -Infinity
      for (let i = 0; i < keptSections.length; i += 1) {
        const s = keptSections[i]!
        if (PROTECTED_TRIM_FIELDS.has(s.fieldKey)) continue
        const p = SECTION_PRIORITY_BY_FIELD[s.fieldKey] ?? 999
        if (p > maxPriority) {
          maxPriority = p
          dropIdx = i
        }
      }
      if (dropIdx < 0) break
      const [removed] = keptSections.splice(dropIdx, 1)
      droppedLabels.push(removed.title.replace(/^##\s*/, ""))
      currentPrompt = renderSectionsPrompt(headerLines, keptSections, droppedLabels)
    }

    // 极端保底：全部非保护段已剔除（或仅剩最后 1 段）仍超预算时，对最长分段做 CJK 加权尾段截断（保 P0 前缀不断）
    const tailNotice = "\n[...该分段尾部已按Token预算截断...]"
    const trimmedProtected = new Set<keyof ContextPack>()
    while (estimatePromptTokens(currentPrompt) > tokenBudget) {
      let longestIdx = -1
      let longestLen = 0
      for (let i = 0; i < keptSections.length; i += 1) {
        const s = keptSections[i]!
        if (trimmedProtected.has(s.fieldKey)) continue
        const body = Array.isArray(s.content) ? s.content.join("\n") : s.content
        if (body.length > longestLen) {
          longestLen = body.length
          longestIdx = i
        }
      }
      if (longestIdx < 0) {
        return currentPrompt.slice(0, charsForTokenBudget(currentPrompt, tokenBudget))
      }
      const target = keptSections[longestIdx]!
      const body = Array.isArray(target.content) ? target.content.join("\n") : target.content
      const targetChars = charsForTokenBudget(currentPrompt, tokenBudget)
      const excess = Math.max(1, currentPrompt.length - targetChars)
      // 从估算上限起步；若截断提示引入更高 CJK 密度导致 token 仍超预算，则二分收缩 keepLen 保住完整截断提示与最长 P0 前缀
      const initialKeep = Math.max(0, body.length - excess - tailNotice.length)
      const renderWithKeep = (len: number) => {
        target.content = len > 0 ? body.slice(0, len) + tailNotice : tailNotice.trim()
        return renderSectionsPrompt(headerLines, keptSections, droppedLabels)
      }
      currentPrompt = renderWithKeep(initialKeep)
      if (initialKeep > 0 && estimatePromptTokens(currentPrompt) > tokenBudget) {
        let lo = 0
        let hi = initialKeep
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2)
          if (estimatePromptTokens(renderWithKeep(mid)) <= tokenBudget) {
            lo = mid
          } else {
            hi = mid - 1
          }
        }
        currentPrompt = renderWithKeep(lo)
      }
      trimmedProtected.add(target.fieldKey)
    }

    return currentPrompt
  }

  return fullPrompt
}
