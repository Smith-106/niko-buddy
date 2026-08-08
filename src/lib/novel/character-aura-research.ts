// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import { streamChat, combineAbortSignals, DEFAULT_LLM_REQUEST_TIMEOUT_MS, type ChatMessage } from "@/lib/llm-client"
import { resolveDefaultModel } from "@/lib/novel/model-resolver"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { useWikiStore } from "@/stores/wiki-store"
import type {
  AuraWorkflowStage,
  CustomCharacterAuraGenerationInput,
  CharacterAuraResearchFileName,
  CustomAuraGeneratedFields,
  AuraInjectedConfig,
} from "./character-aura-types"
import { clipText, markdownToPlainText, splitSourceLines } from "./character-aura-utils"

export const AURA_WORKFLOW_STAGES: AuraWorkflowStage[] = [
  {
    fileName: "01-writings.md",
    label: "01 公开资料",
    sections: ["核心结论", "证据线索", "可写入小说的细节", "未确认点"],
    goal: "整理角色的公开资料、基础经历、关键事件和可以安全借用到小说中的细节。",
  },
  {
    fileName: "02-conversations.md",
    label: "02 对话方式",
    sections: ["说话节奏", "常用表达策略", "冲突中的说话方式", "示例句式"],
    goal: "提炼角色在平静、压迫、博弈、亲密四种场景中的对话方式与口语节奏。",
  },
  {
    fileName: "03-expression-dna.md",
    label: "03 表达特征",
    sections: ["词汇偏好", "情绪显影", "叙事镜头感", "表达禁区"],
    goal: "归纳角色的表达 DNA，包括词汇偏好、情绪显影、画面感和表达禁区。",
  },
  {
    fileName: "04-external-views.md",
    label: "04 外部评价",
    sections: ["支持者视角", "对手视角", "旁观者视角", "争议点"],
    goal: "整理外部评价，区分支持者、对手和旁观者如何看待这个角色。",
  },
  {
    fileName: "05-decisions.md",
    label: "05 决策记录",
    sections: ["核心优先级", "高压下的选择", "典型取舍", "失败代价"],
    goal: "总结角色的决策逻辑、优先级排序、压力下的选择方式和失败代价。",
  },
  {
    fileName: "06-timeline.md",
    label: "06 时间线",
    sections: ["起点", "关键转折", "关系变化", "未来可延展线索"],
    goal: "构建角色的时间线，梳理成长阶段、关键转折、关系变化和未来可延展线索。",
  },
]

export async function buildAuraResearchStage(
  stage: AuraWorkflowStage,
  input: CustomCharacterAuraGenerationInput,
  previousResearchFiles: Partial<Record<CharacterAuraResearchFileName, string>>,
  injectedConfig: AuraInjectedConfig = {},
): Promise<string> {
  // ISS-20260709-023 (DC-7) 渐进式 DI: 注入优先, 缺省回退 store。
  const llmConfig = resolveDefaultModel(injectedConfig.llmConfig ?? useWikiStore.getState().llmConfig)
  if (hasUsableLlm(llmConfig)) {
    try {
      const raw = await runAuraModelPrompt(
        "你是一名小说角色灵魂研究工作流助手。必须只输出用户要求的 Markdown 正文，不要输出解释，不要输出代码围栏。",
        buildAuraResearchStagePrompt(stage, input, previousResearchFiles),
        injectedConfig,
      )
      if (raw.trim()) return ensureResearchMarkdownShape(raw, stage, input.name)
    } catch (error) {
      input.generationNotes.push(`${stage.label} 生成失败，已降级为模板生成：${error instanceof Error ? error.message : "未知错误"}`)
    }
  }
  return buildAuraResearchStageFallback(stage, input, previousResearchFiles)
}

export async function synthesizeCustomAuraFields(
  input: CustomCharacterAuraGenerationInput,
  researchFiles: Partial<Record<CharacterAuraResearchFileName, string>>,
  injectedConfig: AuraInjectedConfig = {},
): Promise<CustomAuraGeneratedFields> {
  // ISS-20260709-023 (DC-7) 渐进式 DI: 注入优先, 缺省回退 store。
  const llmConfig = resolveDefaultModel(injectedConfig.llmConfig ?? useWikiStore.getState().llmConfig)
  if (hasUsableLlm(llmConfig)) {
    try {
      const raw = await runAuraModelPrompt(
        "你是一名小说角色灵魂总结助手。只输出 JSON，不要解释，不要代码围栏。",
        buildAuraSynthesisPrompt(input, researchFiles),
        injectedConfig,
      )
      return parseCustomAuraSummaryResult(raw)
    } catch (error) {
      input.distillationFallbackNote = `灵魂汇总失败，已降级为结构化模板总结：${error instanceof Error ? error.message : "未知错误"}`
    }
  }
  return buildFallbackCustomAuraFields(input, researchFiles)
}

async function runAuraModelPrompt(
  systemPrompt: string,
  userPrompt: string,
  injectedConfig: AuraInjectedConfig = {},
  signal?: AbortSignal,
): Promise<string> {
  // ISS-20260709-023 (DC-7) 渐进式 DI: 注入优先, 缺省回退 store。
  const llmConfig = resolveDefaultModel(injectedConfig.llmConfig ?? useWikiStore.getState().llmConfig)
  let result = ""
  let streamError: Error | null = null
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]
  // ISS-20260724-004 (ROOT-C): merge caller signal with timeout signal to prevent
  // orphaned LLM requests when the caller aborts before the timeout fires.
  const combinedSignal = signal
    ? combineAbortSignals(signal, AbortSignal.timeout(DEFAULT_LLM_REQUEST_TIMEOUT_MS))
    : AbortSignal.timeout(DEFAULT_LLM_REQUEST_TIMEOUT_MS)
  await streamChat(llmConfig, messages, {
    onToken: (token) => { result += token },
    onDone: () => {},
    onError: (error) => { streamError = error },
  }, combinedSignal)
  if (streamError) throw streamError
  return result.trim()
}

function buildAuraResearchStagePrompt(
  stage: AuraWorkflowStage,
  input: CustomCharacterAuraGenerationInput,
  previousResearchFiles: Partial<Record<CharacterAuraResearchFileName, string>>,
): string {
  const title = stageDisplayTitle(stage)
  const sections = stage.sections.map((section) => `## ${section}`).join("\n")
  const material = buildAuraStageMaterial(stage, input, previousResearchFiles)
  return [
    `请为小说角色灵魂工作流生成第 ${stage.label} 份研究文件。`,
    "",
    "直接输出 Markdown，不要输出代码围栏，不要解释。",
    "",
    `标题必须是：# ${input.name} - ${title}`,
    sections,
    "",
    "硬性要求：",
    "1. 每个小节都要写实质内容，至少 2 到 4 句，或 3 到 5 条要点。",
    "2. 资料不足时，要明确写出「基于现有资料的推断」和「待补充信息」，不能只写一句空话。",
    "3. 不冒充真人，不把未经证实的信息写成确定事实。",
    "4. 这份研究文件是给小说创作服务的，所以要把资料转译成可写作、可表演、可决策的内容。",
    "5. 如果启用了 AI 搜索，可以吸收搜索结果，但要区分原始资料、外部线索和推断。",
    "",
    `角色名称：${input.name}`,
    `人物分类：${input.category?.trim() || "自定义灵魂"}`,
    `生成提示词：${input.generationPrompt?.trim() || "未提供"}`,
    `AI 搜索：${input.enableWebSearch ? "已开启" : "未开启"}`,
    `本阶段目标：${stage.goal}`,
    "",
    "资料：",
    material,
  ].join("\n")
}

function buildAuraStageMaterial(
  stage: AuraWorkflowStage,
  input: CustomCharacterAuraGenerationInput,
  previousResearchFiles: Partial<Record<CharacterAuraResearchFileName, string>>,
): string {
  const blocks = [
    input.corpus?.trim() ? `【用户资料文本】\n${clipText(input.corpus.trim(), 2800)}` : "",
    input.importedDocuments.length > 0
      ? `【本地文档摘录】\n${input.importedDocuments.map((document) => `- ${document.path}\n${clipText(document.content, 1000)}`).join("\n\n")}`
      : "",
    input.importedUrls.length > 0
      ? `【用户网页摘录】\n${input.importedUrls.map((document) => `- ${document.url}\n${clipText(document.content, 1000)}`).join("\n\n")}`
      : "",
    input.webSearchResults.length > 0
      ? `【AI 搜索结果摘要】\n${input.webSearchResults.map((result, index) => `${index + 1}. ${result.title} | ${result.source}\n链接：${result.url}\n摘要：${clipText(result.snippet, 240)}`).join("\n\n")}`
      : "",
    input.importedSearchDocuments.length > 0
      ? `【AI 搜索网页正文摘录】\n${input.importedSearchDocuments.map((document) => `- ${document.title}\n链接：${document.url}\n${clipText(document.content, 900)}`).join("\n\n")}`
      : "",
    Object.keys(previousResearchFiles).length > 0
      ? `【已生成的前序研究文件】\n${Object.entries(previousResearchFiles).map(([fileName, content]) => `### ${fileName}\n${clipText(content ?? "", 900)}`).join("\n\n")}`
      : "",
    input.generationNotes.length > 0
      ? `【生成备注】\n${input.generationNotes.map((note) => `- ${note}`).join("\n")}`
      : "",
    `【当前阶段】${stage.label}`,
  ]
  return blocks.filter(Boolean).join("\n\n").slice(0, 18000)
}

function ensureResearchMarkdownShape(markdown: string, stage: AuraWorkflowStage, name: string): string {
  const trimmed = markdown.trim()
  if (!trimmed) return buildAuraResearchStageFallback(stage, {
    name,
    category: "",
    corpus: "",
    sourceUrls: "",
    localDocumentPaths: "",
    generationPrompt: "",
    enableWebSearch: false,
    importedDocuments: [],
    failedDocuments: [],
    importedUrls: [],
    failedUrls: [],
    searchQueries: [],
    webSearchResults: [],
    importedSearchDocuments: [],
    failedSearchUrls: [],
    generationNotes: [],
  }, {})
  if (trimmed.startsWith("# ")) return trimmed
  return `# ${name} - ${stageDisplayTitle(stage)}\n\n${trimmed}`
}

export function buildAuraResearchStageFallback(
  stage: AuraWorkflowStage,
  input: CustomCharacterAuraGenerationInput,
  previousResearchFiles: Partial<Record<CharacterAuraResearchFileName, string>>,
): string {
  const title = stageDisplayTitle(stage)
  switch (stage.fileName) {
    case "01-writings.md":
      return [
        `# ${input.name} - ${title}`,
        "",
        "## 核心结论",
        `- 角色定位：${input.category?.trim() || "自定义灵魂"}。`,
        `- 提示词焦点：${input.generationPrompt?.trim() || "未提供，主要依靠用户资料归纳。"}。`,
        `- 资料来源：${input.enableWebSearch ? "用户资料 + AI 搜索补充" : "仅用户资料"}。`,
        "",
        "## 证据线索",
        buildSourceEvidenceList(input),
        "",
        "## 可写入小说的细节",
        `- 可优先借用的外在细节：${clipText(input.corpus?.trim() || "资料较少，建议补充公开经历、人物关系、代表事件和言行片段。", 260)}。`,
        input.importedSearchDocuments.length > 0
          ? `- 联网补充的外部线索显示：${clipText(input.importedSearchDocuments[0]?.content ?? "", 260)}。`
          : "- 若需要更像真人语感，建议补充公开讲话、采访、回忆录、旁人描述等材料。",
        "",
        "## 未确认点",
        `- 当前仍需补充：${buildMissingInputsHint(input)}。`,
        input.generationNotes.length > 0 ? input.generationNotes.map((note) => `- ${note}`).join("\n") : "- 若资料不足，后续小节会使用「基于现有资料的推断」进行扩写。",
        "",
        customSourceIndexMarkdown(input),
        "",
        urlDocumentContentMarkdown(input),
        "",
        localDocumentContentMarkdown(input),
        "",
        searchDocumentContentMarkdown(input),
      ].join("\n")
    case "02-conversations.md":
      return [
        `# ${input.name} - ${title}`,
        "",
        "## 说话节奏",
        `- 基于现有资料推断，这个角色的语言节奏应围绕「${input.generationPrompt?.trim() || input.name}」展开，优先保持稳定语气、明确立场和可辨识的节奏。`,
        `- 用户资料中的核心语料显示：${clipText(input.corpus?.trim() || "缺少直接对白素材，因此需要后续补充采访、对话摘录或公开讲话。", 240)}。`,
        "",
        "## 常用表达策略",
        "- 平静场景：先给判断，再给理由，避免空泛抒情。",
        "- 压迫场景：句子更短，语气更硬，优先表达底线与取舍。",
        "- 亲近场景：保留角色核心气质，但会露出更细的情绪纹理和关系判断。",
        "",
        "## 冲突中的说话方式",
        "- 不直接乱发火，而是先识别权力关系、利益位置和可承受代价。",
        previousResearchFiles["01-writings.md"]
          ? `- 结合公开资料可推断：${clipText(previousResearchFiles["01-writings.md"] ?? "", 220)}。`
          : "- 当前资料不足，建议后续补充冲突语境下的原始表达样本。",
        "",
        "## 示例句式",
        `- 「先把事情说清楚，再谈感情。」`,
        `- 「我不是没看见，只是还没到该翻牌的时候。」`,
        `- 「眼下最重要的，不是好不好听，而是能不能成。」`,
      ].join("\n")
    case "03-expression-dna.md":
      return [
        `# ${input.name} - ${title}`,
        "",
        "## 词汇偏好",
        `- 重点围绕提示词「${input.generationPrompt?.trim() || input.name}」构造词汇域，优先保留身份、权力、关系、代价、边界等高辨识度词汇。`,
        "",
        "## 情绪显影",
        "- 情绪不是直接喊出来，而是通过停顿、语序变化、措辞锋利度和信息选择显出来。",
        "- 资料不足时，可先把情绪线索写成「克制 / 迟疑 / 冷硬 / 温吞 / 试探」等层次，而不是只写「强势」或「温柔」。",
        "",
        "## 叙事镜头感",
        "- 适合抓取动作小细节、语气落点和他人反应来表现气场，而不是单靠概念形容词。",
        previousResearchFiles["02-conversations.md"]
          ? `- 对话方式可进一步支撑表达 DNA：${clipText(previousResearchFiles["02-conversations.md"] ?? "", 220)}。`
          : "- 若后续补充更多对白，可继续把常见句式、停顿习惯和回避话题补全进来。",
        "",
        "## 表达禁区",
        "- 不要把角色写成万能金句机器。",
        "- 不要让角色在不符合身份和情境时突然使用完全陌生的话语系统。",
      ].join("\n")
    case "04-external-views.md":
      return [
        `# ${input.name} - ${title}`,
        "",
        "## 支持者视角",
        "- 支持者通常更容易把角色的强势、克制、效率或承担解释成可靠与可托付。",
        previousResearchFiles["01-writings.md"]
          ? `- 可参考公开资料中的正面线索：${clipText(previousResearchFiles["01-writings.md"] ?? "", 220)}。`
          : "- 当前缺少正面旁观材料，建议补充采访、回忆、评价和传记型资料。",
        "",
        "## 对手视角",
        "- 对手更容易把同一套行为读成压迫、算计、冷酷、危险或难以预测。",
        "- 在小说中可通过对手的戒备、误判、恐惧和反制动作来呈现这个视角。",
        "",
        "## 旁观者视角",
        "- 旁观者评价往往最能体现「公共形象」，适合沉淀成角色出场时的第一印象。",
        input.importedSearchDocuments.length > 0
          ? `- AI 搜索补充的舆论线索：${clipText(input.importedSearchDocuments[0]?.snippet ?? "", 220)}。`
          : "- 当前没有足够的外部评价样本，可先用「传闻、印象、风评、名声」来构建出场氛围。",
        "",
        "## 争议点",
        "- 一个能支撑灵魂人物的角色，必须有可争议之处，而不是人人一致夸赞。",
        "- 争议点通常来自手段与目标的张力、亲密关系中的伤害、以及公众形象与私下动机的落差。",
      ].join("\n")
    case "05-decisions.md":
      return [
        `# ${input.name} - ${title}`,
        "",
        "## 核心优先级",
        "- 先判定当下要守住什么，再决定要牺牲什么。",
        `- 提示词强调的价值焦点：${input.generationPrompt?.trim() || "未提供，需要从资料中继续归纳"}。`,
        "",
        "## 高压下的选择",
        "- 压力越大，越会暴露真实优先级：保名声、保关系、保结果、保底线，还是保自己。",
        previousResearchFiles["04-external-views.md"]
          ? `- 外部评价能反推其决策代价：${clipText(previousResearchFiles["04-external-views.md"] ?? "", 220)}。`
          : "- 当前资料不足，建议补充角色在危机、冲突、背叛或资源紧缺时的真实选择案例。",
        "",
        "## 典型取舍",
        "- 在关系与结果冲突时，会先看长期后果还是眼前稳定。",
        "- 在规则与情感冲突时，会先守秩序还是先保具体的人。",
        "- 在信息不足时，更倾向试探、拖延、拍板，还是让别人先暴露。",
        "",
        "## 失败代价",
        "- 这个角色最怕的失败，往往正是他做选择时最先防御的东西。",
        "- 把失败代价写清楚，才能让灵魂人物在关键场景里做出有区分度的动作。",
      ].join("\n")
    case "06-timeline.md":
      return [
        `# ${input.name} - ${title}`,
        "",
        "## 起点",
        `- 当前可确认的起点线索：${clipText(input.corpus?.trim() || "资料较少，建议补充出身、初始处境、最早的关键关系与欲望。", 220)}。`,
        "",
        "## 关键转折",
        "- 把角色从旧状态推向新状态的事件，通常比外在履历更重要。",
        input.importedSearchDocuments.length > 0
          ? `- AI 搜索补充的关键事件线索：${clipText(input.importedSearchDocuments[0]?.content ?? "", 220)}。`
          : "- 当前仍缺关键事件链条，建议继续补充大事件、失去、获得、关系破裂与立场变化。",
        "",
        "## 关系变化",
        "- 时间线不只是事件顺序，更要写清楚每段关系什么时候发生方向性变化。",
        previousResearchFiles["05-decisions.md"]
          ? `- 决策记录可反推关系转折：${clipText(previousResearchFiles["05-decisions.md"] ?? "", 220)}。`
          : "- 若资料缺少关系信息，可先记录「谁塑造了他、谁限制了他、谁让他改变」。",
        "",
        "## 未来可延展线索",
        "- 为小说写作预留未完成的问题、未兑现的承诺、还没爆发的矛盾和可能回收的旧线索。",
        "- 这部分不是编造事实，而是从现有资料中找「仍然能继续长」的钩子。",
      ].join("\n")
    default:
      return `# ${input.name} - ${title}\n\n## 待补充\n- 当前阶段没有可用的默认模板。`
  }
}

function buildSourceEvidenceList(input: CustomCharacterAuraGenerationInput): string {
  const lines: string[] = []
  if (input.corpus?.trim()) lines.push(`- 用户资料文本：${clipText(input.corpus.trim(), 180)}`)
  for (const document of input.importedDocuments.slice(0, 3)) {
    lines.push(`- 本地文档 ${document.path}：${clipText(document.content, 180)}`)
  }
  for (const document of input.importedUrls.slice(0, 3)) {
    lines.push(`- 用户网页 ${document.url}：${clipText(document.content, 180)}`)
  }
  for (const result of input.webSearchResults.slice(0, 3)) {
    lines.push(`- AI 搜索 ${result.title}（${result.source}）：${clipText(result.snippet, 180)}`)
  }
  return lines.length > 0 ? lines.join("\n") : "- 当前没有可直接引用的资料，建议至少补充一段资料文本或几个可靠来源。"
}

function buildMissingInputsHint(input: CustomCharacterAuraGenerationInput): string {
  const missing: string[] = []
  if (!input.corpus?.trim()) missing.push("角色资料文本")
  if (input.importedDocuments.length === 0 && splitSourceLines(input.localDocumentPaths).length > 0) missing.push("可读取的本地文档正文")
  if (input.importedUrls.length === 0 && splitSourceLines(input.sourceUrls).length > 0) missing.push("可抓取的网页正文")
  if (input.enableWebSearch && input.webSearchResults.length === 0) missing.push("可用的 AI 搜索结果")
  return missing.length > 0 ? missing.join("、") : "更多可核实的公开经历、对话样本和时间线证据"
}

function buildAuraSynthesisPrompt(
  input: CustomCharacterAuraGenerationInput,
  researchFiles: Partial<Record<CharacterAuraResearchFileName, string>>,
): string {
  const titleBlocks = AURA_WORKFLOW_STAGES
    .map((stage) => `### ${stage.label}\n${clipText(researchFiles[stage.fileName] ?? "", 1800)}`)
    .join("\n\n")
  return [
    `请基于以下 6 份研究文件，为小说角色「${input.name}」总结出结构化角色灵魂。`,
    "",
    "只输出 JSON 对象，不要解释，不要代码围栏。",
    "字段必须包含：sourceNote、styleDescription、behaviorRules、boundaries、notes、expressionDna、mentalModel、decisionHeuristics、valueAntiPatterns、honestyBoundaries。",
    "每个字段都必须是内容饱满的中文字符串，不要只写一句泛话。",
    "behaviorRules、boundaries、notes、decisionHeuristics 等字段建议写成多行字符串，包含 3 到 6 条要点。",
    "如果资料不足，要明确说明哪些内容是基于现有资料的推断。",
    "",
    `人物分类：${input.category?.trim() || "自定义灵魂"}`,
    `生成提示词：${input.generationPrompt?.trim() || "未提供"}`,
    `AI 搜索：${input.enableWebSearch ? "已开启" : "未开启"}`,
    input.generationNotes.length > 0 ? `生成备注：\n${input.generationNotes.map((note) => `- ${note}`).join("\n")}` : "",
    "",
    titleBlocks,
  ].filter(Boolean).join("\n")
}

function parseCustomAuraSummaryResult(raw: string): CustomAuraGeneratedFields {
  const json = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw
  const objectText = json.match(/\{[\s\S]*\}/)?.[0]
  if (!objectText) throw new Error("模型未返回有效 JSON")
  const parsed = JSON.parse(objectText) as Partial<CustomAuraGeneratedFields>
  const required: Array<keyof CustomAuraGeneratedFields> = [
    "sourceNote",
    "styleDescription",
    "behaviorRules",
    "boundaries",
    "notes",
    "expressionDna",
    "mentalModel",
    "decisionHeuristics",
    "valueAntiPatterns",
    "honestyBoundaries",
  ]
  for (const key of required) {
    if (typeof parsed[key] !== "string" || !parsed[key]?.trim()) {
      throw new Error(`模型结果缺少 ${key}`)
    }
  }
  return {
    sourceNote: parsed.sourceNote!,
    styleDescription: parsed.styleDescription!,
    behaviorRules: parsed.behaviorRules!,
    boundaries: parsed.boundaries!,
    notes: parsed.notes!,
    expressionDna: parsed.expressionDna!,
    mentalModel: parsed.mentalModel!,
    decisionHeuristics: parsed.decisionHeuristics!,
    valueAntiPatterns: parsed.valueAntiPatterns!,
    honestyBoundaries: parsed.honestyBoundaries!,
  }
}

function buildFallbackCustomAuraFields(
  input: CustomCharacterAuraGenerationInput,
  researchFiles: Partial<Record<CharacterAuraResearchFileName, string>>,
): CustomAuraGeneratedFields {
  const writings = clipText(markdownToPlainText(researchFiles["01-writings.md"] ?? ""), 320)
  const conversations = clipText(markdownToPlainText(researchFiles["02-conversations.md"] ?? ""), 320)
  const expression = clipText(markdownToPlainText(researchFiles["03-expression-dna.md"] ?? ""), 320)
  const external = clipText(markdownToPlainText(researchFiles["04-external-views.md"] ?? ""), 320)
  const decisions = clipText(markdownToPlainText(researchFiles["05-decisions.md"] ?? ""), 320)
  const timeline = clipText(markdownToPlainText(researchFiles["06-timeline.md"] ?? ""), 320)
  const searchNote = input.enableWebSearch ? "本次生成同时参考了 AI 搜索补充资料。" : "本次生成仅依据你提供的资料。"
  const promptNote = input.generationPrompt?.trim() ? `提示词重点：${input.generationPrompt.trim()}` : "未提供额外提示词。"
  const fallbackNote = input.distillationFallbackNote ? `\n${input.distillationFallbackNote}` : ""
  return {
    sourceNote: `基于用户资料整理出的自定义人物灵魂。${searchNote}${promptNote}\n核心资料摘要：${writings || "当前可用资料仍然偏少，建议继续补充公开经历、对话样本与关系事件。"}${fallbackNote}`,
    styleDescription: `这个灵魂围绕「${input.name}」构建，强调其公开形象、说话方式、他人观感与决策习惯之间的连动。\n公开资料与外部评价显示：${writings || external || "当前仍以有限资料推断整体气质。"}\n写作时要优先保留其稳定气场、关系姿态与处事取向，而不是只抓一个标签。`,
    behaviorRules: [
      "写作行为规则：",
      `- 先服从人物小传、当前剧情目标和角色认知状态，再调用灵魂倾向。`,
      `- 决策执行时优先参考：${decisions || "资料不足时，先判断其要守住什么、愿意牺牲什么。"}。`,
      `- 对话执行时优先参考：${conversations || "先给判断，再给理由，保持稳定语气与身份感。"}。`,
      `- 叙述动作要让气质落在细节上，不要只写概念形容词。`,
    ].join("\n"),
    boundaries: [
      "安全与边界：",
      "- 不冒充真人，不把灵魂写成真人复刻。",
      "- 不照抄未授权文本，不把外部资料原句大段搬进小说。",
      "- 不覆盖小说既有人设、阵营、记忆、关系与情节因果。",
      `- 对不确定资料保持「可能 / 待核实 / 基于现有资料推断」的表述。`,
    ].join("\n"),
    notes: [
      "补充说明：",
      `- 当前外部评价与争议点：${external || "仍需继续补充外部视角样本。"}。`,
      `- 当前时间线线索：${timeline || "仍需继续补充成长阶段、关键事件与关系变化。"}。`,
      `- 若后续补料，优先增加公开讲话、评价、转折事件与决策案例。`,
      input.generationNotes.length > 0 ? `- 生成备注：${input.generationNotes.join("；")}` : "",
    ].filter(Boolean).join("\n"),
    expressionDna: `表达特征：${expression || conversations || "资料不足时，先把表达写成可辨识的节奏、停顿、锋利度和情绪显影，而不是空泛地写成强势或温柔。"}。`,
    mentalModel: `心智模型：${decisions || writings || "先判断角色真正害怕失去什么、想保住什么、长期想要成为什么，再让每次行动服从这条底层逻辑。"}。`,
    decisionHeuristics: `决策启发式：${decisions || "面对选择时，先判断优先级与失败代价，再决定保关系、保结果、保秩序还是保自己。"}。`,
    valueAntiPatterns: `价值观反模式：${external || "不要把角色写成全对、全强、全能的人物；争议、代价和误判同样会定义这个灵魂。"}。`,
    honestyBoundaries: "诚实边界：仅作为小说创作灵魂使用，不声明等同真人或原作人物；对缺失信息明确标注推断性质，不把猜测写成事实。",
  }
}

function stageDisplayTitle(stage: AuraWorkflowStage): string {
  return stage.label.replace(/^\d+\s*/, "")
}

// Import markdown helpers from character-aura-markdown module
import {
  customSourceIndexMarkdown,
  urlDocumentContentMarkdown,
  localDocumentContentMarkdown,
  searchDocumentContentMarkdown,
} from "./character-aura-markdown"
