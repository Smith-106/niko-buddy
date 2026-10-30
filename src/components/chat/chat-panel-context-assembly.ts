// Copyright (c) 2024 Niko-hub contributors. MIT License.
import {
  buildGoldenThreeChapterDirective,
  buildQmQuaiSystemPrompt,
  buildTaskDirective,
  type GoldenThreeChapterRequest,
  type TaskRouteResult,
} from "@/lib/novel"
import { readFile } from "@/commands/fs"
import { searchWiki, tokenizeQuery } from "@/lib/search"
import { normalizePath, getFileName, getRelativePath } from "@/lib/path-utils"
import { getOutputLanguage, buildLanguageReminder } from "@/lib/output-language"
import { isGreeting } from "@/lib/greeting-detector"
import { computeContextBudget } from "@/lib/context-budget"
import { logger, toErrorMessage } from "@/lib/utils"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage as LLMMessage } from "@/lib/llm-client"
import { setLastQueryPages } from "./chat-shared"
import type { WikiProject } from "@/types/wiki"
import type { ContextPackReplayPanel } from "@/components/novel/context-pack-replay-panel"

export type AssembleChatContextResult =
  | {
      cancelled: true
      message: string
    }
  | {
      cancelled?: false
      systemMessages: LLMMessage[]
      queryRefs: { title: string; path: string }[]
      langReminder: string | undefined
    }

export interface AssembleChatContextParams {
  text: string
  project: WikiProject | null
  novelMode: boolean
  effectiveTaskRoute: TaskRouteResult | null
  goldenThreeChapter: GoldenThreeChapterRequest | undefined
  dismantlingDirective: string
  llmConfig: LlmConfig
  requestSoulDialog: (summary: string) => Promise<boolean>
  setReplayContextPack: (pack: React.ComponentProps<typeof ContextPackReplayPanel>["pack"]) => void
}

/**
 * 装配聊天系统上下文（chat-panel 拆分 T6）。
 *
 * 包含：打招呼短路、资料库检索与预算裁剪（indexBudget / pageBudget / tryAddPage）、
 * 知识图谱 1-level 扩展、小说上下文包装配（buildContextPack、Soul 对话框确认、
 * contextPackToPrompt）、Prompt 缓存控制断点（stablePrefixParts cacheControl + dynamicParts）、
 * 语言强制提醒（buildLanguageReminder）、Agent 章节修改定位增强（detectEditIntent）。
 *
 * 返回 `{ cancelled: true, message }` 时，由调用方在会话守卫内执行
 * finish + finalizeStream + delete abortControllersRef 并在 await 后直接 return。
 * 正常返回 `{ systemMessages, queryRefs, langReminder }`。
 */
export async function assembleChatContext(
  params: AssembleChatContextParams,
): Promise<AssembleChatContextResult> {
  const {
    text,
    project,
    novelMode,
    effectiveTaskRoute,
    goldenThreeChapter,
    dismantlingDirective,
    llmConfig,
    requestSoulDialog,
    setReplayContextPack,
  } = params

  const systemMessages: LLMMessage[] = []
  let queryRefs: { title: string; path: string }[] = []
  let langReminder: string | undefined

const shouldUseQmQuaiSkill = effectiveTaskRoute != null && (
  effectiveTaskRoute.intent === "write_chapter" ||
  effectiveTaskRoute.intent === "continue_chapter" ||
  effectiveTaskRoute.intent === "rewrite_chapter"
)
const qmQuaiSystemPrompt = shouldUseQmQuaiSkill ? buildQmQuaiSystemPrompt() : ""
// Pure greetings ("hi", "你好", "嗨") don't warrant running the whole
// retrieval pipeline — it's slow, costs context, and drags in random
// wiki pages the user clearly didn't ask about. Short-circuit with a
// minimal system prompt and let the model reply conversationally.
const greetingOnly = isGreeting(text)
if (project && greetingOnly) {
  const outLang = getOutputLanguage(text)
  systemMessages.push({
    role: "system",
    content: [
      `你是项目「${project.name}」的资料库问答助手。`,
      "用户只是打了一个招呼，请用一两句话自然简短地回应。",
      "不要编造资料库内容，也不要假装已经检索过页面。如果用户想查询资料，请引导用户提出一个具体问题。",
      "",
      `请使用 ${outLang} 回复。`,
    ].join("\n"),
  })
  // Skip retrieval; queryRefs stays empty so no "Sources" chip is shown.
} else if (project) {
  const pp = normalizePath(project.path)
  const dataVersion = useWikiStore.getState().dataVersion

  // ── Budget allocation (see context-budget.ts) ─────────
  // Page budget scales with the LLM's context window; we now
  // also reserve ~15% as headroom for the response so the
  // model isn't truncated mid-sentence on a packed prompt.
  const {
    indexBudget: INDEX_BUDGET,
    pageBudget: PAGE_BUDGET,
    maxPageSize: MAX_PAGE_SIZE,
  } = computeContextBudget(llmConfig.maxContextSize)

  const [rawIndex, purpose] = await Promise.all([
    readFile(`${pp}/wiki/index.md`).catch(() => ""),
    readFile(`${pp}/purpose.md`).catch(() => ""),
  ])

  // ── Phase 1: Tokenized search → top 10 ────────────────
  const searchResults = await searchWiki(pp, text, {
    rerank: true,
    topK: 10,
    rerankPurpose: "用于聊天问答时挑选最值得注入上下文的知识页面。",
  })
  const topSearchResults = searchResults.slice(0, 10)

  // ── Trim index by relevance if over budget ─────────────
  let index = rawIndex
  if (rawIndex.length > INDEX_BUDGET) {
    const tokens = tokenizeQuery(text)
    const lines = rawIndex.split("\n")
    const keptLines: string[] = []
    let keptSize = 0

    for (const line of lines) {
      const isHeader = line.startsWith("##")
      const lower = line.toLowerCase()
      const isRelevant = tokens.some((t) => lower.includes(t))

      if (isHeader || isRelevant) {
        if (keptSize + line.length + 1 <= INDEX_BUDGET) {
          keptLines.push(line)
          keptSize += line.length + 1
        }
      }
    }
    index = keptLines.join("\n")
    /* v8 ignore next */
    if (index.length < rawIndex.length) {
      index += "\n\n[...index trimmed to relevant entries...]"
    }
  }

  // ── Phase 2: Graph 1-level expansion ───────────────────
  // Note: Vector search (if enabled) is already merged into searchResults
  // by searchWiki() in search.ts — no duplicate code needed here.
  const { buildRetrievalGraph, getRelatedNodes } = await import("@/lib/graph-relevance")
  const graph = await buildRetrievalGraph(pp, dataVersion)
  const expandedIds = new Set<string>()
  const searchHitPaths = new Set(topSearchResults.map((r) => r.path))
  const graphExpansions: { title: string; path: string; relevance: number }[] = []

  for (const result of topSearchResults) {
    const fileName = getFileName(result.path)
    const nodeId = fileName.replace(/\.md$/, "")
    const related = getRelatedNodes(nodeId, graph, 3)
    for (const { node, relevance } of related) {
      if (relevance < 2.0) continue
      if (searchHitPaths.has(node.path)) continue
      if (expandedIds.has(node.id)) continue
      expandedIds.add(node.id)
      graphExpansions.push({ title: node.title, path: node.path, relevance })
    }
  }
  graphExpansions.sort((a, b) => b.relevance - a.relevance)

  // ── Phase 3 & 4: Page budget control ───────────────────
  let usedChars = 0
  type PageEntry = { title: string; path: string; content: string; priority: number }
  const relevantPages: PageEntry[] = []

  const tryAddPage = async (title: string, filePath: string, priority: number): Promise<boolean> => {
    if (usedChars >= PAGE_BUDGET) return false
    try {
      const raw = await readFile(filePath)
      const relativePath = getRelativePath(filePath, pp)
      const truncated = raw.length > MAX_PAGE_SIZE
        ? raw.slice(0, MAX_PAGE_SIZE) + "\n\n[...truncated...]"
        : raw
      if (usedChars + truncated.length > PAGE_BUDGET) return false
      usedChars += truncated.length
      relevantPages.push({ title, path: relativePath, content: truncated, priority })
      return true
    } catch { return false }
  }

  // P0: Title matches
  for (const r of topSearchResults.filter((r) => r.titleMatch)) {
    await tryAddPage(r.title, r.path, 0)
  }
  // P1: Content matches
  for (const r of topSearchResults.filter((r) => !r.titleMatch)) {
    await tryAddPage(r.title, r.path, 1)
  }
  // P2: Graph expansions
  for (const exp of graphExpansions) {
    await tryAddPage(exp.title, exp.path, 2)
  }
  // P3: Overview fallback
  if (relevantPages.length === 0) {
    await tryAddPage("Overview", `${pp}/wiki/overview.md`, 3)
  }

  const pagesContext = relevantPages.length > 0
    ? relevantPages.map((p, i) =>
        `### [${i + 1}] ${p.title}\nPath: ${p.path}\n\n${p.content}`
      ).join("\n\n---\n\n")
    : "(No wiki pages found)"

  const pageList = relevantPages.map((p, i) =>
    `[${i + 1}] ${p.title} (${p.path})`
  ).join("\n")

  const outLang = getOutputLanguage(text)

  let novelContextPreamble = ""
  if (novelMode && project && effectiveTaskRoute) {
    try {
      const taskDirective = buildTaskDirective(effectiveTaskRoute)
      const goldenDirective = buildGoldenThreeChapterDirective(goldenThreeChapter)
      const { buildContextPack, contextPackToPrompt } = await import("@/lib/novel/context-engine")
      const contextPack = await buildContextPack(pp, text, effectiveTaskRoute.chapterNumber).catch(() => ({
        task: text,
        chapterGoal: "",
        outline: "",
        recentSummaries: [],
        previousChapterEnding: "",
        characterStates: "",
        soulDoc: "",
        characterAuras: "",
        cognitionStates: "",
        foreshadowingStates: "",
        timeline: "",
        relatedSettings: "",
        canonRules: "",
        writingStyle: "",
        searchResults: "",
        graphSearchResults: "",
        mustDo: "",
        mustAvoid: "",
        nextChapterAdvice: "",
        revisionDirectives: "",
      }))
      // Wave C6: 接入 ContextPackReplayPanel —— 捕获本次装配结果供回放面板只读展示。
      setReplayContextPack(contextPack)
      if (contextPack.characterAuras.trim()) {
        const confirmed = await requestSoulDialog(contextPack.characterAuras)
        if (!confirmed) {
          return {
            cancelled: true,
            message: "已取消本次生成，角色灵魂上下文未发送给模型。",
          }
        }
      }
      const novelConfig = useWikiStore.getState().novelConfig
      const budget = novelConfig.contextTokenBudget > 0 ? novelConfig.contextTokenBudget : undefined
      novelContextPreamble = contextPackToPrompt(contextPack, budget, {
        layeredRecall: "default",
        sectionCharBudget: 4000,
        hardInjectEnabled: novelConfig.hardInjectEnabled,
      })
      if (goldenDirective) {
        novelContextPreamble = goldenDirective + "\n" + novelContextPreamble
      }
      if (taskDirective) {
        novelContextPreamble = taskDirective + "\n" + novelContextPreamble
      }
    } catch (err) {
      // R4 共识（deepseek+glm）: 原先空 catch —— 小说上下文装配完全失败时零诊断。
      // 行为不变（仍继续生成），但降级必须留痕。
      logger.warn("ChatPanel", "novel context preamble build failed, continuing without it", {
        error: toErrorMessage(err),
      })
    }
  }

  // 固定前缀：技能、角色定位、章节输出规则、规则、Markdown 格式要求。
  // 这部分在一次会话/配置下稳定，打 cacheControl 让 Anthropic 跨会话命中
  // prompt cache；OpenAI/Google 等其他 provider 会自动折叠成字符串，不受影响。
  const stablePrefixParts = [
    qmQuaiSystemPrompt ? `## QM-QUAI 技能\n${qmQuaiSystemPrompt}` : "",
    novelMode
      ? "你是一个专业的小说写作助手。请根据提供的小说上下文包和章节内容，协助用户进行小说创作。"
      : "你是一个专业的资料库问答助手。请基于下方提供的资料内容回答问题。",
    "",
    novelMode
      ? [
          "## 小说章节输出规则",
          "- 如果用户要求生成、续写或改写章节，只输出可直接放入章节库的小说正文。",
          "- 正文第一行必须是章节标题，格式为：# 第X章 标题名（标题4-12字，概括本章核心内容）。",
          "- 不要输出资料说明、创作说明、免责声明、后续建议、引用列表或隐藏 cited 注释。",
          "- 不要在小说正文里写 [[资料名]]、[1]、[2] 这类资料引用标记。",
          "- 资料只作为内部参考，不能把资料库缺失、基于现有资料等元信息写进章节。",
        ].filter(Boolean).join("\n")
      : "",
    "",
    novelMode
      ? [
          "## 规则",
          "- 只能基于下方小说资料、上下文包和用户要求创作，不要编写解释性回答。",
          "- 如果资料不足，也要根据已有小说上下文自然续写，不要把“资料不足”写进正文。",
        ].join("\n")
      : [
          "## 规则",
          "- 只能基于下方编号资料页面回答。",
          "- 如果资料不足，请直接说明资料不足。",
          "- 引用资料页面时使用 [[页面名]] 格式。",
          "- 引用具体信息时使用页码标记，例如 [1]、[2]。",
          "- 回复末尾必须添加隐藏注释，列出你使用过的资料页码：",
          "  <!-- cited: 1, 3, 5 -->",
        ].join("\n"),
    "",
    "请使用清晰的 Markdown 格式。",
  ].filter(Boolean)

  // 动态部分：资料库目标、索引、页面、上下文包、语言规则。
  // 每次检索结果不同，不缓存。
  const dynamicParts = [
    purpose ? `## 资料库目标\n${purpose}` : "",
    index ? `## 资料库索引\n${index}` : "",
    relevantPages.length > 0 ? `## 页面列表\n${pageList}` : "",
    `## 资料页面\n\n${pagesContext}`,
    novelContextPreamble ? `\n${novelContextPreamble}` : "",
    dismantlingDirective ? `\n${dismantlingDirective}` : "",
    "",
    "---",
    "",
    `## ⚠️ 强制输出语言：${outLang}`,
    "",
    `你的整段回复必须使用 **${outLang}**。`,
    "即使上方资料内容使用其他语言，也不能影响你的回复语言。",
    `请忽略资料原文语言，只使用 ${outLang} 回复。`,
    `必要时，专有名词也应使用 ${outLang} 的常见译法或音译。`,
    "不要使用任何其他语言。本规则优先于其他所有指令。",
  ].filter(Boolean)

  const systemBlocks: { type: "text"; text: string; cacheControl?: boolean }[] = []
  if (stablePrefixParts.length > 0) {
    systemBlocks.push({ type: "text", text: stablePrefixParts.join("\n"), cacheControl: true })
  }
  /* v8 ignore next */
  if (dynamicParts.length > 0) {
    systemBlocks.push({ type: "text", text: dynamicParts.join("\n") })
  }

  systemMessages.push({
    role: "system",
    content: systemBlocks,
  })

  // Reminder injected later, right before the user's current message
  // (after history so it's the last system instruction the LLM sees).
  langReminder = buildLanguageReminder(text)

  // ── Agent mode: append file edit instructions if user has edit intent ──
  if (novelMode && systemMessages.length > 0) {
    const { detectEditIntent, buildAgentSystemSuffix } = await import("@/lib/novel/agent-parser")
    if (detectEditIntent(text)) {
      const lastSys = systemMessages[systemMessages.length - 1]
      /* v8 ignore next */
      if (lastSys) {
        const { readScopeFileContents } = await import("@/lib/novel/agent-tools")
        const filesWithContent = await readScopeFileContents(pp, "chapters")
        const fileContentStr = filesWithContent.length > 0
          ? `\n\n## 当前章节文件内容（供修改定位）\n${filesWithContent.map(f => `### ${f.name}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")}`
          : "\n\n## 当前章节文件列表\n(暂无章节文件)"
        const suffix = buildAgentSystemSuffix("chapters") + fileContentStr
        if (typeof lastSys.content === "string") {
          lastSys.content += suffix
        /* v8 ignore next */
        } else if (Array.isArray(lastSys.content)) {
          // content 为 ContentBlock[] 时，追加为新的 text block（不缓存，
          // 因为文件内容动态），避免破坏前面的 cacheControl 断点。
          lastSys.content.push({ type: "text", text: suffix })
        }
      }
    }
  }

  const nextQueryPages = relevantPages.map((p) => ({ title: p.title, path: p.path }))
  setLastQueryPages(nextQueryPages)
  queryRefs = [...nextQueryPages]
}

  return {
    cancelled: false,
    systemMessages,
    queryRefs,
    langReminder,
  }
}
