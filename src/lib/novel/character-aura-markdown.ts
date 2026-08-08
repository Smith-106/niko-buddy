// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import type {
  CharacterAura,
  CharacterAuraResearchFileName,
  CustomCharacterAuraGenerationInput,
  CustomSourceIndexInput,
} from "./character-aura-types"
import { CHARACTER_AURA_RESEARCH_FILES } from "./character-aura-types"
import { AURA_WORKFLOW_STAGES, buildAuraResearchStageFallback } from "./character-aura-research"
import { splitSourceLines, clipText, markdownToPlainText } from "./character-aura-utils"

export function customSkillMarkdown(
  aura: CharacterAura,
  input: CustomCharacterAuraGenerationInput,
  researchFiles: Partial<Record<CharacterAuraResearchFileName, string>> = {},
): string {
  const sourceIndex = customSourceIndexMarkdown(input)
  const workflowSummary = researchFilesSummaryMarkdown(researchFiles)
  const generationNotes = generationNotesMarkdown(input.generationNotes, input.distillationFallbackNote)
  return `---
name: ${aura.name}
description: 自定义角色灵魂，基于用户提供的公开或已授权资料生成。
---

# ${aura.name} · 自定义人物灵魂操作系统

## 角色扮演规则

只能作为小说角色灵魂使用，不冒充真人，不覆盖人物小传，不替代大纲、正史规则和情节因果。

## 回答工作流

1. 先读取小说大纲、人物小传和当前章节目标。
2. 再参考本灵魂的表达方式、心智模型和边界。
3. 最后让角色行为服从当前剧情、认知状态和人物关系。

## 身份卡

- 名称：${aura.name}
- 分类：${aura.category ?? "自定义灵魂"}
- 来源说明：${aura.sourceNote}

## 资料导入设置

${sourceIndex}

## 生成工作流

${workflowStageIndexMarkdown()}

${generationNotes ? `${generationNotes}\n\n` : ""}## 核心心智模型

${aura.mentalModel}

## 决策启发式

${aura.decisionHeuristics}

## 表达特征

${aura.expressionDna}

## 人物时间线

请重点参考 \`06-timeline.md\` 中的阶段梳理，再结合当前小说人物小传落地到具体剧情。

## 价值观与反模式

${aura.valueAntiPatterns}

## 诚实边界

${aura.honestyBoundaries}

## 研究文件索引

${CHARACTER_AURA_RESEARCH_FILES.map((file) => `- 研究资料/${file.fileName}：${file.label}`).join("\n")}

${workflowSummary}

## 绑定到小说角色时的使用方式

绑定后只增强角色气质、语言倾向和判断方式，不得改写角色既有人设、阵营、记忆和剧情任务。

## 质量校验清单

- 不冒充真人或原作角色。
- 不照搬未授权文本。
- 不覆盖小说大纲和人物小传。
- 不把灵魂当作万能行为解释。
`
}

export function customSourceIndexMarkdown(input: CustomSourceIndexInput): string {
  const urls = splitSourceLines(input.sourceUrls)
  const paths = splitSourceLines(input.localDocumentPaths)
  const searchEnabled = isSourceSearchEnabled(input)
  const prompt = input.generationPrompt?.trim()
  const searchQueries = input.searchQueries ?? []
  const searchResults = input.webSearchResults ?? []
  const failedSearchUrls = input.failedSearchUrls ?? []
  const noteLines = input.generationNotes ?? []
  return [
    "## 资料索引",
    "",
    "### 生成提示词",
    "",
    prompt || "- 未填写",
    "",
    "### AI 搜索",
    "",
    `- 状态：${searchEnabled ? "已开启" : "未开启"}`,
    searchQueries.length > 0 ? `- 检索词：${searchQueries.join("；")}` : "- 检索词：未生成",
    "",
    "### 网页资料地址",
    "",
    urls.length > 0 ? urls.map((url) => `- ${url}`).join("\n") : "- 未填写",
    "",
    "### 本地文档路径",
    "",
    paths.length > 0 ? paths.map((path) => `- ${path}`).join("\n") : "- 未填写",
    "",
    "### 联网补充来源",
    "",
    searchResults.length > 0
      ? searchResults
        .slice(0, 5)
        .map((result) => `- ${result.title}｜${result.source}\n  ${result.url}`)
        .join("\n")
      : searchEnabled
        ? "- 本次未拿到可用的 AI 搜索结果"
        : "- 未开启 AI 搜索",
    failedSearchUrls.length > 0
      ? `\n### 联网抓取失败\n\n${failedSearchUrls.map((url) => `- ${url}`).join("\n")}`
      : "",
    noteLines.length > 0
      ? `\n### 生成备注\n\n${noteLines.map((note) => `- ${note}`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n")
}

function isSourceSearchEnabled(input: CustomSourceIndexInput): boolean {
  return Boolean(input.enableWebSearch ?? input.webSearchEnabled)
}

export function generationNotesMarkdown(notes: string[] = [], fallbackNote?: string): string {
  const items = [...notes]
  if (fallbackNote?.trim()) items.push(fallbackNote.trim())
  if (items.length === 0) return ""
  return ["## 生成备注", "", ...items.map((note) => `- ${note}`)].join("\n")
}

export function workflowStageIndexMarkdown(): string {
  return AURA_WORKFLOW_STAGES
    .map((stage, index) => `${index + 1}. ${stage.label}：${stage.goal}`)
    .join("\n")
}

export function researchFilesSummaryMarkdown(
  researchFiles: Partial<Record<CharacterAuraResearchFileName, string>>,
): string {
  return [
    "## 工作流产出摘要",
    "",
    ...AURA_WORKFLOW_STAGES.flatMap((stage) => {
      const content = researchFiles[stage.fileName]?.trim()
      return [
        `### ${stage.label}`,
        "",
        content ? clipText(markdownToPlainText(content), 260) : "当前还没有该阶段的研究摘要。",
        "",
      ]
    }),
  ].join("\n")
}

export function localDocumentContentMarkdown(input: CustomCharacterAuraGenerationInput): string {
  const imported = input.importedDocuments.length > 0
    ? `## 本地文档正文\n\n${input.importedDocuments.map((document) => `### ${document.path}\n\n${document.content}`).join("\n\n")}`
    : "## 本地文档正文\n\n未读取到本地文档正文。"
  const failed = input.failedDocuments.length > 0
    ? `\n\n## 本地文档读取失败\n\n${input.failedDocuments.map((path) => `- ${path}：读取失败`).join("\n")}`
    : ""
  return `${imported}${failed}`
}

export function urlDocumentContentMarkdown(input: CustomCharacterAuraGenerationInput): string {
  const imported = input.importedUrls.length > 0
    ? `## 网页资料正文\n\n${input.importedUrls.map((document) => `### ${document.url}\n\n${document.content}`).join("\n\n")}`
    : "## 网页资料正文\n\n未读取到网页资料正文。"
  const failed = input.failedUrls.length > 0
    ? `\n\n## 网页资料读取失败\n\n${input.failedUrls.map((url) => `- ${url}：读取失败`).join("\n")}`
    : ""
  return `${imported}${failed}`
}

export function searchDocumentContentMarkdown(input: CustomCharacterAuraGenerationInput): string {
  const imported = input.importedSearchDocuments.length > 0
    ? `## AI 搜索网页正文\n\n${input.importedSearchDocuments.map((document) => `### ${document.title}\n\n- 来源：${document.source}\n- 链接：${document.url}\n- 检索词：${document.query || "未记录"}\n- 摘要：${document.snippet || "无"}\n\n${document.content}`).join("\n\n")}`
    : `## AI 搜索网页正文\n\n${input.enableWebSearch ? "未读取到可用的 AI 搜索网页正文。" : "未开启 AI 搜索。"}`
  const failed = input.failedSearchUrls.length > 0
    ? `\n\n## AI 搜索网页读取失败\n\n${input.failedSearchUrls.map((url) => `- ${url}：读取失败`).join("\n")}`
    : ""
  return `${imported}${failed}`
}

export function buildStoredCorpus(input: CustomCharacterAuraGenerationInput): string {
  if (input.corpus?.trim()) return input.corpus.trim()
  const lines: string[] = []
  if (input.generationPrompt?.trim()) lines.push(`提示词：${input.generationPrompt.trim()}`)
  if (input.webSearchResults.length > 0) {
    lines.push("AI 搜索摘要：")
    lines.push(...input.webSearchResults.slice(0, 3).map((result) => `- ${result.title}：${clipText(result.snippet, 120)}`))
  }
  if (input.importedDocuments.length > 0) {
    lines.push(...input.importedDocuments.slice(0, 2).map((document) => `- ${document.path}：${clipText(document.content, 120)}`))
  }
  if (input.importedUrls.length > 0) {
    lines.push(...input.importedUrls.slice(0, 2).map((document) => `- ${document.url}：${clipText(document.content, 120)}`))
  }
  return lines.join("\n") || "用户未填写资料文本，仅提供资料索引。"
}

function stageForResearchFile(fileName: CharacterAuraResearchFileName): typeof AURA_WORKFLOW_STAGES[0] {
  return AURA_WORKFLOW_STAGES.find((stage) => stage.fileName === fileName) ?? AURA_WORKFLOW_STAGES[0]
}

export function customResearchMarkdown(
  aura: CharacterAura,
  input: CustomCharacterAuraGenerationInput,
  fileName: CharacterAuraResearchFileName,
): string {
  const base = buildAuraResearchStageFallback(stageForResearchFile(fileName), input, {})
  const localDocumentContent = localDocumentContentMarkdown(input)
  const urlDocumentContent = urlDocumentContentMarkdown(input)
  const searchDocumentContent = searchDocumentContentMarkdown(input)
  const generationNotes = generationNotesMarkdown(input.generationNotes, input.distillationFallbackNote)
  const content: Record<CharacterAuraResearchFileName, string> = {
    "01-writings.md": [
      base,
      customSourceIndexMarkdown(input),
      urlDocumentContent,
      localDocumentContent,
      searchDocumentContent,
      generationNotes,
    ].filter(Boolean).join("\n\n"),
    "02-conversations.md": [
      base,
      "## 已沉淀的灵魂摘要",
      "",
      aura.styleDescription,
      "",
      "## 表达特征补充",
      "",
      aura.expressionDna || aura.styleDescription,
      "",
      "## 资料证据线索",
      "",
      buildSourceEvidenceList(input),
    ].join("\n"),
    "03-expression-dna.md": [
      base,
      "",
      "## 当前灵魂字段映射",
      "",
      `- 表达特征：${aura.expressionDna || aura.styleDescription}`,
      `- 心智模型：${aura.mentalModel || aura.corpus}`,
      `- 诚实边界：${aura.honestyBoundaries || aura.boundaries}`,
    ].join("\n"),
    "04-external-views.md": [
      base,
      "",
      "## 当前外部视角摘要",
      "",
      aura.sourceNote,
      "",
      "## 反模式提醒",
      "",
      aura.valueAntiPatterns || aura.notes,
    ].join("\n"),
    "05-decisions.md": [
      base,
      "",
      "## 当前决策启发式",
      "",
      aura.decisionHeuristics || aura.behaviorRules,
      "",
      "## 当前心智模型",
      "",
      aura.mentalModel || aura.corpus,
    ].join("\n"),
    "06-timeline.md": [
      base,
      "",
      "## 当前资料摘要",
      "",
      aura.corpus || "待用户继续补充资料文本。",
      "",
      searchDocumentContent,
    ].filter(Boolean).join("\n"),
  }
  return content[fileName]
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

export function storedCustomSkillMarkdown(
  aura: CharacterAura,
  researchFiles: Partial<Record<CharacterAuraResearchFileName, string>> = {},
): string {
  const sourceIndex = customSourceIndexMarkdown(aura)
  const workflowSummary = researchFilesSummaryMarkdown(researchFiles)
  return `---
name: ${aura.name}
description: 自定义角色灵魂，基于用户维护的公开或已授权资料生成。
---

# ${aura.name} · 自定义人物灵魂操作系统

## 角色扮演规则

只能作为小说角色灵魂使用，不冒充真人，不覆盖人物小传，不替代大纲、正史规则和情节因果。

## 回答工作流

1. 先读取小说大纲、人物小传和当前章节目标。
2. 再参考本灵魂的表达方式、心智模型和边界。
3. 最后让角色行为服从当前剧情、认知状态和人物关系。

## 身份卡

- 名称：${aura.name}
- 分类：${aura.category ?? "自定义灵魂"}
- 来源说明：${aura.sourceNote}

## 资料导入设置

${sourceIndex}

## 生成工作流

${workflowStageIndexMarkdown()}

## 核心心智模型

${aura.mentalModel ?? aura.corpus}

## 决策启发式

${aura.decisionHeuristics ?? aura.behaviorRules}

## 表达特征

${aura.expressionDna ?? aura.styleDescription}

## 人物时间线

请重点参考 \`06-timeline.md\` 的时间线整理，再结合当前人物小传安排成长弧线。

## 价值观与反模式

${aura.valueAntiPatterns ?? aura.notes}

## 诚实边界

${aura.honestyBoundaries ?? aura.boundaries}

## 研究文件索引

${CHARACTER_AURA_RESEARCH_FILES.map((file) => `- 研究资料/${file.fileName}：${file.label}`).join("\n")}

${workflowSummary}

## 绑定到小说角色时的使用方式

绑定后只增强角色气质、语言倾向和判断方式，不得改写角色既有人设、阵营、记忆和剧情任务。

## 质量校验清单

- 不冒充真人或原作角色。
- 不照抄未授权文本。
- 不覆盖小说大纲和人物小传。
- 不把灵魂当作万能行为解释。
`
}

export function storedCustomResearchMarkdown(aura: CharacterAura, fileName: CharacterAuraResearchFileName): string {
  const sourceIndex = customSourceIndexMarkdown(aura)
  const content: Record<CharacterAuraResearchFileName, string> = {
    "01-writings.md": [
      `# ${aura.name} - 公开资料`,
      "",
      "## 核心结论",
      `- 角色定位：${aura.category ?? "自定义灵魂"}。`,
      `- 气质说明：${aura.sourceNote || "待补充"}。`,
      `- 生成提示词：${aura.generationPrompt?.trim() || "未填写"}。`,
      "",
      "## 证据线索",
      aura.corpus || "待用户继续补充资料文本。",
      "",
      sourceIndex,
      "",
      "## 可写入小说的细节",
      `- 表达特征：${aura.expressionDna ?? aura.styleDescription}`,
      `- 心智模型：${aura.mentalModel ?? aura.corpus}`,
      "",
      "## 未确认点",
      "- 若要继续增强灵魂稳定度，建议补充更完整的公开经历、对话样本、评价和时间线资料。",
    ].join("\n"),
    "02-conversations.md": [
      `# ${aura.name} - 对话方式`,
      "",
      "## 说话节奏",
      aura.styleDescription || "待补充",
      "",
      "## 常用表达策略",
      aura.expressionDna ?? aura.styleDescription,
      "",
      "## 冲突中的说话方式",
      aura.decisionHeuristics ?? aura.behaviorRules,
      "",
      "## 示例句式",
      "- 写作时先给立场，再给理由，再根据关系强弱控制锋利度与停顿。",
    ].join("\n"),
    "03-expression-dna.md": [
      `# ${aura.name} - 表达特征`,
      "",
      "## 词汇偏好",
      aura.expressionDna ?? aura.styleDescription,
      "",
      "## 情绪显影",
      aura.styleDescription || "待补充",
      "",
      "## 叙事镜头感",
      aura.sourceNote || "待补充",
      "",
      "## 表达禁区",
      aura.honestyBoundaries ?? aura.boundaries,
    ].join("\n"),
    "04-external-views.md": [
      `# ${aura.name} - 外部评价`,
      "",
      "## 支持者视角",
      aura.sourceNote || "待补充",
      "",
      "## 对手视角",
      aura.valueAntiPatterns ?? aura.notes,
      "",
      "## 旁观者视角",
      aura.styleDescription || "待补充",
      "",
      "## 争议点",
      aura.valueAntiPatterns ?? aura.notes,
    ].join("\n"),
    "05-decisions.md": [
      `# ${aura.name} - 决策记录`,
      "",
      "## 核心优先级",
      aura.mentalModel ?? aura.corpus,
      "",
      "## 高压下的选择",
      aura.decisionHeuristics ?? aura.behaviorRules,
      "",
      "## 典型取舍",
      aura.valueAntiPatterns ?? aura.notes,
      "",
      "## 失败代价",
      aura.honestyBoundaries ?? aura.boundaries,
    ].join("\n"),
    "06-timeline.md": [
      `# ${aura.name} - 时间线`,
      "",
      "## 起点",
      aura.corpus || "待用户补充出身、早期处境和最初欲望。",
      "",
      "## 关键转折",
      aura.sourceNote || "待补充",
      "",
      "## 关系变化",
      aura.notes || aura.valueAntiPatterns || "待补充",
      "",
      "## 未来可延展线索",
      "- 后续可围绕未完成承诺、旧关系回收、立场变化和代价兑现继续补料。",
    ].join("\n"),
  }
  return content[fileName]
}
