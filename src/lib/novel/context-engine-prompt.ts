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
import { SECTION_PRIORITY } from "./context-engine-gaps"

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
  { titleKey: "novel.contextPack.voiceStyleGuide", fieldKey: "voiceStyleGuide", layer: "L3" },
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
  const base = (pack.canonRulesBase ?? "").trim()
  const full = pack.canonRules ?? ""
  if (!base || !full.startsWith(base)) return { stable: "", delta: full }
  return { stable: base, delta: full.slice(base.length).replace(/^\n+/, "") }
}

/**
 * G6：canonRules 去掉项目级 base 前缀后的 **temporal 增量**（内容级等价）。
 *
 * 退化时返回完整 canonRules。调用方若要**同时**渲染稳定段，必须用
 * [`splitCanonRules`]（它在退化时同时清空稳定段），否则会重复渲染 base。
 */
export function canonRulesDelta(full: string, base: string): string {
  const normalized = (base ?? "").trim()
  if (!normalized) return full
  if (!full.startsWith(normalized)) return full
  return full.slice(normalized.length).replace(/^\n+/, "")
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
  return [i18n.t(config.titleKey), stable].join("\n")
}

export function contextPackToPrompt(
  pack: ContextPack,
  tokenBudget?: number,
  options?: ContextPackToPromptOptions,
): string {
  const sections: string[] = []

  sections.push(i18n.t("novel.contextPack.title"))
  sections.push("")
  sections.push(i18n.t("novel.contextPack.currentTask"))
  sections.push(pack.task)
  sections.push("")

  const layeredRecall: LayeredRecallMode = options?.layeredRecall ?? "default"
  const fieldSections: { title: string; content: string | string[] }[] = []
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
    fieldSections.push({ title: i18n.t(config.titleKey) + titleSuffix, content })
  }

  fieldSections.sort((a, b) => {
    const keyA = a.title.replace(/^##\s*/, "")
    const keyB = b.title.replace(/^##\s*/, "")
    const priorityA = SECTION_PRIORITY[keyA] ?? 999
    const priorityB = SECTION_PRIORITY[keyB] ?? 999
    return priorityA - priorityB
  })

  for (const { title, content } of fieldSections) {
    sections.push(title)
    if (Array.isArray(content)) {
      content.forEach(item => sections.push(item))
    } else {
      sections.push(content)
    }
    sections.push("")
  }

  const fullPrompt = sections.join("\n")

  if (tokenBudget && tokenBudget > 0 && fullPrompt.length > tokenBudget) {
    // COR (odyssey-review): CJK chars tokenize ~1 token/1.5char, not 1/4.
    // Niko Buddy novel prompts are predominantly Chinese, so a naive length/4
    // underestimates real token count → budget gate misjudges and returns
    // an over-budget prompt untrimmed. Weight CJK at ~1.5 char/token.
    const cjkCount = (fullPrompt.match(/[㐀-鿿]/g) ?? []).length
    const nonCjk = fullPrompt.length - cjkCount
    const estimatedTokens = Math.ceil(nonCjk / 4 + cjkCount / 1.5)
    if (estimatedTokens <= tokenBudget) return fullPrompt
    const targetChars = (() => {
      // R4 共识（deepseek+glm）: 裁剪目标原先固定按 4 字符/token 换算，与上面刚用过的
      // CJK 加权估算（≈1.5 字符/token）自相矛盾——中文正文裁完仍然远超预算。
      // 改为用与估算器同源的混合比换算：纯 ASCII 仍为 4 字符/token（行为不变），
      // 纯中文为 1.5 字符/token。
      const cjkRatio = cjkCount / fullPrompt.length
      const charsPerToken = 1 / (cjkRatio / 1.5 + (1 - cjkRatio) / 4)
      return Math.max(1, Math.floor(tokenBudget * charsPerToken))
    })()
    const headChars = Math.floor(targetChars * 0.4)
    const tailChars = targetChars - headChars
    return fullPrompt.slice(0, headChars) + "\n\n[...上下文已按Token预算裁剪...]\n\n" + fullPrompt.slice(-tailChars)
  }

  return fullPrompt
}
