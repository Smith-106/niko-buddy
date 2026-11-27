// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * 全自动小说冷启动孵化器 (Autonomous Novel Incubator)
 *
 * 核心设计目标：
 * 将冷启动到分章起草的自动化等级推向 100%（全自动无人值守闭环）：
 * 仅需单句核心构思/灵感，全自动链式自主推演：
 * 1. 灵魂文档孵化 (SoulDoc)：确立全书主旨、调性、价值观困境与防失真禁区
 * 2. 世界观蓝图派生 (WorldBlueprint)：调用 LLM 生成并通过完备性校验的五大分层骨架
 * 3. 核心角色小传建立 (Character Workstation)：调用 LLM 生成主角、对手与盟友档案
 * 4. 宏观总纲推演 (Outline Orchestration)：基于灵魂文档、世界观与真实角色生成分章框架
 * 5. 章节骨架自动铺排 (Auto Unpack)：零人工点击，原子解构并铺排 chapters/chapter-*.md
 * 6. 故事模拟起承转合提取与绑定 (Auto Framework Derive & Bind)：基于真实角色与大纲提取 4 阶段节拍并落盘 active-binding.json
 *
 * 纪律（P0-01 fail-closed）：
 * - 禁止任何硬编码假人名/假世界观/静态兜底模板；
 * - 无可用 LLM 配置、调用失败、空输出或非法结构一律 fail-loud 抛出带阶段名的 Error。
 */

import { createDirectory, writeFileAtomic } from "@/commands/fs"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { combineAbortSignals, DEFAULT_LLM_REQUEST_TIMEOUT_MS, streamChat } from "@/lib/llm-client"
import { normalizePath } from "@/lib/path-utils"
import { logger, toErrorMessage } from "@/lib/utils"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import { DEFAULT_NOVEL_CONFIG } from "@/stores/wiki-store"
import {
  runAutonomousDraftCampaign,
  type CampaignReport,
} from "./campaign-runner"
import { recordModuleHit } from "./module-heat"
import { appendStageMetric } from "./novel-session-status"
import {
  unpackOutlineToChapterFiles,
  type UnpackOutlineResult,
} from "./outline-chapter-unpack"
import { writeSoulDoc } from "./soul-doc"
import {
  saveBinding,
} from "./story-simulation/framework-binding"
import type {
  FrameworkBinding,
  StoryFramework,
  StoryNode,
} from "./story-simulation/types"
import {
  WORLD_LAYERS,
  saveWorldBlueprint,
  validateWorldBlueprint,
  type WorldBlueprint,
  type WorldLayer,
} from "./world-blueprint"
import {
  advanceDirectorPhase,
  createDirectorPipeline,
  type DirectorPipelineState,
  type PhaseGateInput,
} from "./director-pipeline"
import {
  saveDirectorPersisted,
  type DirectorIdeaInput,
} from "./director-pipeline-store"

export interface NovelIncubatorOptions {
  projectPath: string
  /** 核心灵感或构思点子 */
  idea: string
  /** 书名（可选，未提供则基于灵感智能提取） */
  title?: string
  /** 流派（可选，如科幻、修真、悬疑、都市等） */
  genre?: string
  /** 目标章节数（默认 10 章） */
  targetChapters?: number
  llmConfig: LlmConfig
  novelConfig?: NovelConfig
  /** 进度回调 */
  onProgress?: (info: { stage: string; current: number; total: number; message: string }) => void
  signal?: AbortSignal
}

export interface IncubatedCharacter {
  name: string
  role: string
  profile: string
  filePath: string
}

export interface NovelIncubatorResult {
  projectPath: string
  title: string
  genre: string
  soulDoc: string
  worldBlueprint: WorldBlueprint
  characters: IncubatedCharacter[]
  outlineContent: string
  unpackedSkeletons: UnpackOutlineResult
  activeBinding: FrameworkBinding
}

const REQUIRED_STORY_PHASES: readonly StoryNode["phase"][] = ["起", "承", "转", "合"]
const WORLD_LAYER_SET: ReadonlySet<string> = new Set<string>(WORLD_LAYERS)

/**
 * Fail-loud LLM 调用入口：无可用配置、用户取消、流式错误、异常或空输出一律抛出带阶段名的 Error，
 * 绝不静默降级为静态假模板。
 */
async function callIncubatorLlm(
  stageLabel: string,
  llmConfig: LlmConfig,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    throw new Error(`[${stageLabel}] 孵化已被取消`)
  }
  if (!hasUsableLlm(llmConfig)) {
    throw new Error(
      `[${stageLabel}] 缺少可用的 LLM 配置（provider=${llmConfig.provider}，请配置有效的 API Key / 端点与模型）`,
    )
  }

  let output = ""
  let streamError: Error | null = null
  const timeoutSignal = AbortSignal.timeout(DEFAULT_LLM_REQUEST_TIMEOUT_MS)
  const combinedSignal = combineAbortSignals(signal, timeoutSignal)

  try {
    await streamChat(
      llmConfig,
      [{ role: "user", content: prompt }],
      {
        onToken: (tok) => {
          output += tok
        },
        onDone: () => {},
        onError: (err) => {
          streamError = err
        },
      },
      combinedSignal,
    )
  } catch (err) {
    throw new Error(`[${stageLabel}] LLM 调用失败：${toErrorMessage(err)}`)
  }

  if (signal?.aborted) {
    throw new Error(`[${stageLabel}] 孵化已被取消`)
  }
  const readStreamError = (): Error | null => streamError
  const errNow = readStreamError()
  if (errNow) {
    throw new Error(`[${stageLabel}] LLM 流式返回错误：${toErrorMessage(errNow)}`)
  }

  const trimmed = output.trim()
  if (!trimmed) {
    throw new Error(`[${stageLabel}] LLM 返回空内容`)
  }
  return trimmed
}

/**
 * 提取平衡 JSON 对象或数组文本片段（支持 markdown code fence）。
 */
function extractBalancedJsonSpan(text: string, openChar: "{" | "[", closeChar: "}" | "]"): string | null {
  const fenceMatch = text.trim().match(/```(?:json)?\s*([\s\S]*?)```/i)
  const cleaned = fenceMatch ? fenceMatch[1].trim() : text.trim()
  if (cleaned.startsWith(openChar) && cleaned.endsWith(closeChar)) {
    return cleaned
  }
  const start = cleaned.indexOf(openChar)
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < cleaned.length; i += 1) {
    const ch = cleaned[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === openChar) {
      depth += 1
    } else if (ch === closeChar) {
      depth -= 1
      if (depth === 0) return cleaned.slice(start, i + 1)
    }
  }
  return null
}

/**
 * 严格解析 LLM 返回的结构化 JSON，非法文本或容器类型不符时抛出带阶段名的 Error。
 */
function parseIncubatorJson(stageLabel: string, raw: string, expectedKind: "object" | "array"): unknown {
  const openChar = expectedKind === "object" ? "{" : "["
  const closeChar = expectedKind === "object" ? "}" : "]"
  const span = extractBalancedJsonSpan(raw, openChar, closeChar)
  if (!span) {
    throw new Error(`[${stageLabel}] LLM 输出缺少合法 JSON ${expectedKind === "object" ? "对象" : "数组"}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(span)
  } catch (err) {
    throw new Error(`[${stageLabel}] LLM 输出非法 JSON：${toErrorMessage(err)}`)
  }
  if (expectedKind === "array" && !Array.isArray(parsed)) {
    throw new Error(`[${stageLabel}] LLM 输出必须为 JSON 数组`)
  }
  if (expectedKind === "object" && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new Error(`[${stageLabel}] LLM 输出必须为 JSON 对象`)
  }
  return parsed
}

const WINDOWS_RESERVED_DEVICE_NAME_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i

/**
 * 清洗角色文件名以防止路径穿越（移除 `..`、路径分隔符、非法文件名字符与 Windows 保留设备名），并去重。
 */
function sanitizeCharacterFileName(name: string, index: number, usedFileNames: Set<string>): string {
  const cleaned = name
    .replace(/\.\./g, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^[_.\s]+/, "")
    .slice(0, 64)
    .replace(/[_.\s]+$/g, "")
  let base = cleaned || `character-${index + 1}`
  if (WINDOWS_RESERVED_DEVICE_NAME_RE.test(base)) {
    base = `char-${base}`
  }
  let candidate = base
  let suffix = 2
  while (usedFileNames.has(candidate.toLowerCase())) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  usedFileNames.add(candidate.toLowerCase())
  return candidate
}

function asNonEmptyStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * 推导题材与规范书名
 */
function deriveTitleAndGenre(idea: string, userTitle?: string, userGenre?: string): { title: string; genre: string } {
  let genre = userGenre?.trim()
  if (!genre) {
    if (/修仙|宗门|道|灵气|玄幻|飞升|长生/.test(idea)) genre = "玄幻修真"
    else if (/赛博|AI|机械|星际|未来|飞船|赛博朋克/.test(idea)) genre = "科幻未来"
    else if (/悬疑|凶手|侦探|案件|诡异|谜案/.test(idea)) genre = "悬疑推理"
    else if (/商海|都市|神豪|重生|逆袭|职场/.test(idea)) genre = "都市逆袭"
    else genre = "奇幻冒险"
  }

  let title = userTitle?.trim()
  if (!title) {
    const cleaned = idea.replace(/[，。！？,.!?:：\n\r]/g, " ").trim()
    const words = cleaned.split(/\s+/).filter(Boolean)
    const firstPhrase = words[0] || "未命名神作"
    title = firstPhrase.slice(0, 10)
    if (title.length < 2) title = `${genre}传奇`
  }

  return { title, genre }
}

/**
 * 阶段 1：生成灵魂文档
 */
async function generateSoulDocContent(
  title: string,
  genre: string,
  idea: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<string> {
  const prompt = `你是一位顶级小说总编。请根据以下构思，为作品《${title}》（流派：${genre}）撰写一份完整的【灵魂文档】（Soul Document）。
构思：${idea}

要求：
1. 包含核心主旨（全书要探讨的终极命题）
2. 包含情绪基调与审美风格
3. 包含主人公核心愿望与道德冲突
4. 包含创作红线与禁忌事项
5. 输出纯 Markdown 格式。`

  return callIncubatorLlm("阶段1:soul-doc", llmConfig, prompt, signal)
}

/**
 * 阶段 2：调用 LLM 生成世界观蓝图并严格校验完备性
 */
async function generateWorldBlueprintData(
  title: string,
  genre: string,
  idea: string,
  soulDoc: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<WorldBlueprint> {
  const stageLabel = "阶段2:world-blueprint"
  const prompt = `你是一位专业世界观架构师。请为长篇小说《${title}》（流派：${genre}）构建一份严格结构化的【世界观蓝图】JSON。
核心构思：${idea}
灵魂文档参考：
${soulDoc.slice(0, 1500)}

要求：
1. 只输出一个合法 JSON 对象，不要输出额外解释。
2. 必须包含字段 "worldType"（字符串）与 "layers"（对象）。
3. "layers" 必须包含且非空以下五大必填分层（每层为字符串数组，至少 1 条贴合本题材的具体设定）：
   - "axioms"（底层公理/运行法则）
   - "background"（时代背景与格局）
   - "geography"（核心地理空间）
   - "cultures"（文化、秩序与社会规则）
   - "conflicts"（核心结构性冲突）
4. 可按需补充可选分层："races"、"magicSystem"、"politics"、"technology"、"economy"、"religions"、"history"、"factions"。
5. 可选字段 "crossRefs"：数组，元素形如 { "from": "层名", "to": "层名", "term": "被引用条目原文" }。`

  const raw = await callIncubatorLlm(stageLabel, llmConfig, prompt, signal)
  const parsed = parseIncubatorJson(stageLabel, raw, "object") as Record<string, unknown>

  const rawLayers = parsed.layers
  if (rawLayers === null || typeof rawLayers !== "object" || Array.isArray(rawLayers)) {
    throw new Error(`[${stageLabel}] LLM 输出的世界观蓝图缺少 layers 对象`)
  }
  const layerRecord = rawLayers as Record<string, unknown>
  const layers: Partial<Record<WorldLayer, string[]>> = {}
  for (const layer of WORLD_LAYERS) {
    const entries = asNonEmptyStringArray(layerRecord[layer])
    if (entries.length > 0) {
      layers[layer] = entries
    }
  }

  const crossRefs: NonNullable<WorldBlueprint["crossRefs"]> = []
  if (Array.isArray(parsed.crossRefs)) {
    for (const item of parsed.crossRefs) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue
      const rec = item as Record<string, unknown>
      const from = asNonEmptyString(rec.from)
      const to = asNonEmptyString(rec.to)
      const term = asNonEmptyString(rec.term)
      if (WORLD_LAYER_SET.has(from) && WORLD_LAYER_SET.has(to) && term) {
        crossRefs.push({ from: from as WorldLayer, to: to as WorldLayer, term })
      }
    }
  }

  const bp: WorldBlueprint = {
    version: "1.0",
    worldType: asNonEmptyString(parsed.worldType) || genre,
    layers,
    crossRefs,
  }

  const validation = validateWorldBlueprint(bp)
  if (validation.verdict !== "complete") {
    const missing = validation.findings
      .filter((f) => f.severity === "error")
      .map((f) => f.layer ?? f.message)
      .join(", ")
    throw new Error(`[${stageLabel}] 世界观蓝图完备性校验失败：${missing || "缺少必填层"}`)
  }

  return bp
}

/**
 * 阶段 3：调用 LLM 生成核心角色小传并清洗文件名落盘
 */
async function generateCoreCharacters(
  projectPath: string,
  title: string,
  genre: string,
  idea: string,
  soulDoc: string,
  worldBlueprint: WorldBlueprint,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<IncubatedCharacter[]> {
  const stageLabel = "阶段3:characters"
  const worldSummary = [
    `世界类型：${worldBlueprint.worldType}`,
    `底层法则：${(worldBlueprint.layers.axioms ?? []).join("；")}`,
    `时代背景：${(worldBlueprint.layers.background ?? []).join("；")}`,
    `核心冲突：${(worldBlueprint.layers.conflicts ?? []).join("；")}`,
  ].join("\n")

  const prompt = `你是一位资深小说人物设定师。请根据作品《${title}》（流派：${genre}）的核心构思与世界观，塑造 3 位核心人物（主角、主要对抗者、重要盟友），输出【核心角色档案】JSON 数组。
核心构思：${idea}
灵魂文档参考：
${soulDoc.slice(0, 1200)}
世界观参考：
${worldSummary}

要求：
1. 只输出一个合法 JSON 数组，至少包含 3 个角色对象，不要输出额外解释。
2. 每个角色对象必须包含以下非空字符串字段：
   - "name"：贴合本作品题材的真实角色姓名（不得使用占位词或组织泛称）
   - "role"：角色定位（如主角、主要对抗者、重要盟友）
   - "profile"：完整的 Markdown 角色档案（含身份、性格、核心动机、能力/资源与关键弱点）`

  const raw = await callIncubatorLlm(stageLabel, llmConfig, prompt, signal)
  const parsed = parseIncubatorJson(stageLabel, raw, "array") as unknown[]

  if (parsed.length === 0) {
    throw new Error(`[${stageLabel}] LLM 返回的角色列表为空`)
  }

  const pp = normalizePath(projectPath)
  const charDir = `${pp}/wiki/entities/characters`
  const usedFileNames = new Set<string>()
  const characters: IncubatedCharacter[] = []

  for (let idx = 0; idx < parsed.length; idx += 1) {
    const item = parsed[idx]
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`[${stageLabel}] 第 ${idx + 1} 个角色项不是合法对象`)
    }
    const rec = item as Record<string, unknown>
    const name = asNonEmptyString(rec.name)
    const role = asNonEmptyString(rec.role)
    const profile = asNonEmptyString(rec.profile)
    if (!name || !role || !profile) {
      throw new Error(`[${stageLabel}] 第 ${idx + 1} 个角色缺少必填字段（name / role / profile）`)
    }
    const safeFileName = sanitizeCharacterFileName(name, idx, usedFileNames)
    characters.push({
      name,
      role,
      profile,
      filePath: `${charDir}/${safeFileName}.md`,
    })
  }

  await createDirectory(charDir)
  for (const c of characters) {
    await writeFileAtomic(c.filePath, c.profile)
  }

  return characters
}

/**
 * 阶段 4：串联灵魂文档、世界观与阶段 3 真实角色，调用 LLM 生成宏观大纲与分章概要
 */
async function generateMacroOutline(
  title: string,
  genre: string,
  idea: string,
  targetChapters: number,
  soulDoc: string,
  worldBlueprint: WorldBlueprint,
  characters: IncubatedCharacter[],
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<string> {
  const stageLabel = "阶段4:outline"
  const characterRoster = characters
    .map((c) => `- ${c.name}（${c.role}）`)
    .join("\n")

  const prompt = `你是一位长篇小说总策划。请为作品《${title}》（流派：${genre}，目标 ${targetChapters} 章）撰写【宏观总纲与分章规划】。
核心灵感：${idea}
核心角色清单（必须直接使用下列真实角色姓名推进剧情，严禁替换为无关角色名）：
${characterRoster}
世界观核心冲突：${(worldBlueprint.layers.conflicts ?? []).join("；")}
灵魂文档参考：
${soulDoc.slice(0, 1200)}

要求：
1. 输出结构清晰的 Markdown 总纲，包含全书主线与第 1 章到第 ${targetChapters} 章的分章纲要。
2. 每一章必须严格使用如下标题格式：
### 第X章 章节标题
本章剧情概要与核心冲突...`

  const outline = await callIncubatorLlm(stageLabel, llmConfig, prompt, signal)
  const hasChapterHeading = /^(?:#{1,6}\s+|\*{2}|[-*+]\s+|\d+\.\s+)?(?:第\s*[0-9零〇一二两三四五六七八九十百千万]+\s*[章节回]|Chapter\s*[0-9]+)/im.test(
    outline,
  )
  if (!hasChapterHeading) {
    throw new Error(`[${stageLabel}] LLM 生成的大纲缺少可解析的分章标题（如 ### 第1章 ...）`)
  }
  return outline
}

/**
 * 阶段 6：串联阶段 3 真实角色与阶段 4 大纲，调用 LLM 提取起承转合 4 节点 StoryFramework 并绑定
 */
async function deriveAndBindFramework(
  projectPath: string,
  title: string,
  genre: string,
  idea: string,
  targetChapters: number,
  characters: IncubatedCharacter[],
  outlineContent: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<FrameworkBinding> {
  const stageLabel = "阶段6:framework-binding"
  const characterNames = characters.map((c) => c.name)
  const prompt = `你是一位叙事结构专家。请根据作品《${title}》（流派：${genre}，共 ${targetChapters} 章）的真实角色与宏观大纲，提取【起承转合故事模拟框架】JSON 对象。
核心灵感：${idea}
真实角色名单（involvedCharacters 必须从真实角色中选取，禁止杜撰无关占位名）：${characterNames.join("、")}
宏观大纲：
${outlineContent.slice(0, 4000)}

要求：
1. 只输出一个合法 JSON 对象，格式为 { "nodes": [ ... ] }，不要输出额外解释。
2. "nodes" 必须严格包含 4 个节点，依次覆盖阶段 "起"、"承"、"转"、"合"。
3. 每个节点必须包含以下非空字段：
   - "phase": "起" | "承" | "转" | "合"
   - "title": 节点标题（非空字符串）
   - "coreConflict": 核心冲突（非空字符串）
   - "involvedCharacters": 参与角色名数组（至少 1 个非空字符串）
   - "goal": 本阶段目标（非空字符串）
   - "causeFromPrev": 承接上一阶段的因果（非空字符串）
   - "expectedOutcome": 本阶段预期结果（非空字符串）`

  const raw = await callIncubatorLlm(stageLabel, llmConfig, prompt, signal)
  const parsed = parseIncubatorJson(stageLabel, raw, "object") as Record<string, unknown>

  if (!Array.isArray(parsed.nodes) || parsed.nodes.length !== REQUIRED_STORY_PHASES.length) {
    throw new Error(`[${stageLabel}] LLM 输出的框架必须包含恰好 4 个起承转合节点`)
  }

  const seenPhases = new Set<StoryNode["phase"]>()
  const nodes: StoryNode[] = parsed.nodes.map((item, idx) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`[${stageLabel}] 第 ${idx + 1} 个框架节点不是合法对象`)
    }
    const rec = item as Record<string, unknown>
    const phase = asNonEmptyString(rec.phase) as StoryNode["phase"]
    if (!REQUIRED_STORY_PHASES.includes(phase)) {
      throw new Error(`[${stageLabel}] 第 ${idx + 1} 个框架节点 phase 非法：${String(rec.phase)}`)
    }
    seenPhases.add(phase)
    const nodeTitle = asNonEmptyString(rec.title)
    const coreConflict = asNonEmptyString(rec.coreConflict)
    const involvedCharacters = asNonEmptyStringArray(rec.involvedCharacters)
    const goal = asNonEmptyString(rec.goal)
    const causeFromPrev = asNonEmptyString(rec.causeFromPrev)
    const expectedOutcome = asNonEmptyString(rec.expectedOutcome)

    if (!nodeTitle || !coreConflict || involvedCharacters.length === 0 || !goal || !causeFromPrev || !expectedOutcome) {
      throw new Error(`[${stageLabel}] 第 ${idx + 1} 个框架节点（${phase}）缺少必填字段`)
    }

    return {
      index: idx + 1,
      phase,
      title: nodeTitle,
      coreConflict,
      involvedCharacters,
      goal,
      causeFromPrev,
      expectedOutcome,
    }
  })

  for (const requiredPhase of REQUIRED_STORY_PHASES) {
    if (!seenPhases.has(requiredPhase)) {
      throw new Error(`[${stageLabel}] 框架缺少必需阶段：${requiredPhase}`)
    }
  }

  const framework: StoryFramework = {
    id: `fw-${Date.now()}`,
    title: `${title}·四幕推演框架`,
    shortTitle: title.slice(0, 8),
    premise: idea,
    targetWords: targetChapters * 3000,
    simulationMode: "event-driven",
    userIdea: idea,
    sourceChapters: targetChapters,
    nodes,
    createdAt: new Date().toISOString(),
  }

  // 保存绑定并生成各章节起承转合节拍分配
  return await saveBinding(projectPath, framework, targetChapters)
}

/**
 * R3 无头遥测私有纯函数（不导出）：孵化产物 token 近似（诊断用，非计费）。
 * - string → 去空白后字符数；array → 逐项累加（Character 取 profile 累加）；
 * - object → JSON 序列化去空白后字符数；其余 → 0。
 */
function incubatorTokenCost(value: unknown): number {
  if (typeof value === "string") return value.replace(/\s/g, "").length
  if (Array.isArray(value)) {
    let sum = 0
    for (const item of value) {
      if (
        item !== null &&
        typeof item === "object" &&
        "profile" in item &&
        typeof (item as { profile: unknown }).profile === "string"
      ) {
        sum += ((item as { profile: string }).profile).replace(/\s/g, "").length
      } else {
        sum += incubatorTokenCost(item)
      }
    }
    return sum
  }
  if (value !== null && typeof value === "object") {
    try {
      return JSON.stringify(value).replace(/\s/g, "").length
    } catch (err) {
      logger.warn("autonomous-incubator", "tokenCost stringify skipped (non-serializable)", {
        error: toErrorMessage(err),
      })
      return 0
    }
  }
  return 0
}

/**
 * R3 无头遥测私有纯函数（不导出）：墙钟差，负值钳 0。
 */
function stageLatencyMs(t0: number): number {
  const d = Date.now() - t0
  return d < 0 ? 0 : d
}

/**
 * 确定性分卷规划生成（零 LLM）：从书名、流派、目标章数与宏观大纲派生 `wiki/outlines/volume-plan.md`，
 * 确保 `wiki/outlines/` 至少有 2 个 `.md` 文件以对齐 `director-orchestrator.ts` 的
 * `frameworkChosen` 与 `volumesPlanned` 门控判据。
 */
function buildDeterministicVolumePlanMarkdown(
  title: string,
  genre: string,
  targetChapters: number,
  outlineContent: string,
): string {
  const headingMatches: string[] = []
  const headingRe =
    /^(?:#{1,6}\s+|\*{2}|[-*+]\s+|\d+\.\s+)?((?:第\s*[0-9零〇一二两三四五六七八九十百千万]+\s*[章节回]|Chapter\s*[0-9]+)[^\r\n]*)/gim
  let match: RegExpExecArray | null
  while ((match = headingRe.exec(outlineContent)) !== null) {
    const cleaned = match[1].replace(/\*{2}\s*$/, "").trim()
    if (cleaned) headingMatches.push(cleaned)
  }

  const totalChapters = Math.max(1, Number.isFinite(targetChapters) && targetChapters > 0
    ? Math.floor(targetChapters)
    : headingMatches.length || 10)
  const volumeSpan = totalChapters <= 20 ? totalChapters : 20
  const volumeCount = Math.max(1, Math.ceil(totalChapters / volumeSpan))

  const lines: string[] = [
    "---",
    "type: 卷纲",
    `title: ${title}`,
    `genre: ${genre}`,
    `targetChapters: ${totalChapters}`,
    `volumeCount: ${volumeCount}`,
    "---",
    "",
    `# 《${title}》分卷规划`,
    "",
    `- 流派：${genre}`,
    `- 规划总章数：${totalChapters} 章`,
    `- 分卷总数：${volumeCount} 卷`,
    "",
  ]

  for (let v = 0; v < volumeCount; v += 1) {
    const startCh = v * volumeSpan + 1
    const endCh = Math.min(totalChapters, (v + 1) * volumeSpan)
    lines.push(`## 第 ${v + 1} 卷（第 ${startCh}-${endCh} 章）`)
    const slice = headingMatches.slice(startCh - 1, endCh)
    if (slice.length > 0) {
      for (const heading of slice) {
        lines.push(`- ${heading}`)
      }
    } else {
      lines.push(`- 覆盖章节：第 ${startCh} 章 至 第 ${endCh} 章`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

/**
 * 确定性导演管线推进：孵化阶段 1–6 完成后，沿 `idea → world → character → outline`
 * 逐门推进，使最终持久化状态处于 `currentPhase: "chapters"` 且前四阶段为 `"done"`、
 * `"chapters"` 为 `"running"`。
 */
function buildIncubatedDirectorState(
  ideaInput: DirectorIdeaInput,
  worldBlueprint: WorldBlueprint,
  characters: readonly IncubatedCharacter[],
): DirectorPipelineState {
  const gateInput: PhaseGateInput = {
    idea: ideaInput,
    worldComplete: validateWorldBlueprint(worldBlueprint).verdict === "complete",
    protagonistNamed: characters.length >= 1,
    antagonistNamed: characters.length >= 2,
    frameworkChosen: true,
    volumesPlanned: true,
    firstChapterReady: false,
  }
  let state = createDirectorPipeline()
  for (const expectedPhase of ["idea", "world", "character", "outline"] as const) {
    if (state.currentPhase !== expectedPhase) break
    const step = advanceDirectorPhase(state, gateInput)
    state = step.state
    if (!step.advanced) break
  }
  return state
}

/**
 * 启动全自动小说冷启动孵化流水线 (Autonomous Novel Incubator)
 */
export async function runAutonomousNovelIncubator(
  options: NovelIncubatorOptions,
): Promise<NovelIncubatorResult> {
  const {
    projectPath,
    idea,
    title: rawTitle,
    genre: rawGenre,
    targetChapters = 10,
    llmConfig,
    onProgress,
    signal,
  } = options

  const pp = normalizePath(projectPath)
  const { title, genre } = deriveTitleAndGenre(idea, rawTitle, rawGenre)

  // 1/6 灵魂文档
  onProgress?.({
    stage: "soul-doc",
    current: 1,
    total: 6,
    message: `[1/6] 正在自主孵化《${title}》灵魂文档 (SoulDoc)...`,
  })
  const t0SoulDoc = Date.now()
  const soulDoc = await generateSoulDocContent(title, genre, idea, llmConfig, signal)
  await writeSoulDoc(pp, soulDoc)
  // R3：孵化 1/6 遥测（诊断近似，非计费；appendStageMetric 非致命，失败不阻断主链）
  await appendStageMetric(pp, { stage: "incubator:soul-doc", tokenCost: incubatorTokenCost(soulDoc), latencyMs: stageLatencyMs(t0SoulDoc), partial: false, timestamp: new Date().toISOString() })
  recordModuleHit({ path: "src/lib/novel/soul-doc.ts", at: Date.now(), ok: true, detail: `孵化 1/6 灵魂文档 ${title}` })

  // 2/6 世界观蓝图
  onProgress?.({
    stage: "world-blueprint",
    current: 2,
    total: 6,
    message: `[2/6] 正在构建《${title}》世界观五大分层骨架蓝图...`,
  })
  const t0WorldBlueprint = Date.now()
  const worldBlueprint = await generateWorldBlueprintData(title, genre, idea, soulDoc, llmConfig, signal)
  await saveWorldBlueprint(pp, worldBlueprint)
  // R3：孵化 2/6 遥测（诊断近似，非计费）
  await appendStageMetric(pp, { stage: "incubator:world-blueprint", tokenCost: incubatorTokenCost(worldBlueprint), latencyMs: stageLatencyMs(t0WorldBlueprint), partial: false, timestamp: new Date().toISOString() })
  recordModuleHit({ path: "src/lib/novel/world-blueprint.ts", at: Date.now(), ok: true, detail: `孵化 2/6 世界观蓝图 ${title}` })

  // 3/6 核心人物卡
  onProgress?.({
    stage: "characters",
    current: 3,
    total: 6,
    message: `[3/6] 正在塑造《${title}》主角、主要对抗者与核心盟友档案...`,
  })
  const t0Characters = Date.now()
  const characters = await generateCoreCharacters(pp, title, genre, idea, soulDoc, worldBlueprint, llmConfig, signal)
  // R3：孵化 3/6 遥测（characters 取各 profile 累加）
  await appendStageMetric(pp, { stage: "incubator:characters", tokenCost: incubatorTokenCost(characters), latencyMs: stageLatencyMs(t0Characters), partial: false, timestamp: new Date().toISOString() })
  recordModuleHit({ path: "src/lib/novel/autonomous-incubator.ts", at: Date.now(), ok: true, detail: `孵化 3/6 核心角色 ${title}` })

  // 4/6 宏观总纲推演
  // M2 接线位 TODO：outline-multi-agent-orchestrator（主线/话题/人物/世界观/伏笔五子智能体并发）
  // 可在此替代 generateMacroOutline；重型一次性任务，暂不自动触发，待人工确认后接线。
  // B2 特性开关（P1-11）：`novelConfig.enableMultiAgentOutline === true` 时才走多智能体
  // 编排（`runOutlineMultiAgentWorkflow`）；缺省/显式 false 恒走单智能体 generateMacroOutline。
  // 默认行为不变。本轮只留开关读取位，执行分支待 orchestrator 就绪后接线。
  // TODO(B2-outline)：enableMultiAgentOutline 执行分支接线。
  onProgress?.({
    stage: "outline",
    current: 4,
    total: 6,
    message: `[4/6] 正在进行大纲多智能体全局推演与分章规划...`,
  })
  const t0Outline = Date.now()
  const outlineContent = await generateMacroOutline(
    title,
    genre,
    idea,
    targetChapters,
    soulDoc,
    worldBlueprint,
    characters,
    llmConfig,
    signal,
  )
  const outlineDir = `${pp}/wiki/outlines`
  await createDirectory(outlineDir)
  await writeFileAtomic(`${outlineDir}/story-outline.md`, outlineContent)
  const volumePlanContent = buildDeterministicVolumePlanMarkdown(
    title,
    genre,
    targetChapters,
    outlineContent,
  )
  await writeFileAtomic(`${outlineDir}/volume-plan.md`, volumePlanContent)
  // R3：孵化 4/6 遥测
  await appendStageMetric(pp, { stage: "incubator:outline", tokenCost: incubatorTokenCost(outlineContent), latencyMs: stageLatencyMs(t0Outline), partial: false, timestamp: new Date().toISOString() })
  recordModuleHit({ path: "src/lib/novel/autonomous-incubator.ts", at: Date.now(), ok: true, detail: `孵化 4/6 大纲推演 ${title}` })

  // 5/6 章节骨架零人工自动铺排
  onProgress?.({
    stage: "unpack-chapters",
    current: 5,
    total: 6,
    message: `[5/6] 正在自动解构并铺排章节骨架文件树...`,
  })
  const t0Unpack = Date.now()
  const unpackedSkeletons = await unpackOutlineToChapterFiles({
    projectPath: pp,
    outlineContent,
    overwriteExisting: false,
  })
  // R3：孵化 5/6 遥测
  await appendStageMetric(pp, { stage: "incubator:unpack-chapters", tokenCost: incubatorTokenCost(unpackedSkeletons), latencyMs: stageLatencyMs(t0Unpack), partial: false, timestamp: new Date().toISOString() })
  recordModuleHit({ path: "src/lib/novel/outline-chapter-unpack.ts", at: Date.now(), ok: true, detail: `孵化 5/6 章节骨架铺排 ${title}` })

  // 6/6 起承转合故事模拟框架提取与绑定
  onProgress?.({
    stage: "framework-binding",
    current: 6,
    total: 6,
    message: `[6/6] 正在提取起承转合 4 节点故事模拟框架并写入全局激活绑定...`,
  })
  const t0Binding = Date.now()
  const activeBinding = await deriveAndBindFramework(
    pp,
    title,
    genre,
    idea,
    targetChapters,
    characters,
    outlineContent,
    llmConfig,
    signal,
  )
  // R3：孵化 6/6 遥测
  await appendStageMetric(pp, { stage: "incubator:framework-binding", tokenCost: incubatorTokenCost(activeBinding), latencyMs: stageLatencyMs(t0Binding), partial: false, timestamp: new Date().toISOString() })
  recordModuleHit({ path: "src/lib/novel/story-simulation/framework-binding.ts", at: Date.now(), ok: true, detail: `孵化 6/6 框架绑定 ${title}` })

  // 导演管线持久化兼容：确定性推进 idea → world → character → outline 并落盘 .novel/director-pipeline.json（非致命）
  const directorIdeaInput: DirectorIdeaInput = {
    title,
    genre,
    coreConflict:
      worldBlueprint.layers.conflicts?.find((item) => item.trim().length > 0)?.trim()
      || idea.trim()
      || `${title}核心冲突`,
  }
  const directorState = buildIncubatedDirectorState(directorIdeaInput, worldBlueprint, characters)
  try {
    await saveDirectorPersisted(pp, {
      fileVersion: 1,
      state: directorState,
      ideaInput: directorIdeaInput,
    })
  } catch (err) {
    logger.warn("autonomous-incubator", "persist director-pipeline.json failed (non-fatal)", {
      error: toErrorMessage(err),
    })
  }

  onProgress?.({
    stage: "complete",
    current: 6,
    total: 6,
    message: `全自动孵化完成！《${title}》基础架构、骨架树与故事模拟已全面就绪。`,
  })

  return {
    projectPath: pp,
    title,
    genre,
    soulDoc,
    worldBlueprint,
    characters,
    outlineContent,
    unpackedSkeletons,
    activeBinding,
  }
}

/**
 * 端到端全自动生产流水线 (End-to-End Autonomous Novel Production)
 * 从单个灵感出发，一键完成孵化 + 自动开启战役全自动巡航推进！
 */
export async function runEndToEndAutonomousNovelProduction(
  options: NovelIncubatorOptions & {
    /** 孵化后是否立即自动巡航前 N 章正文起草 */
    autoStartCruise?: boolean
    /** 巡航章数，默认 3 章 */
    cruiseChapterCount?: number
  },
): Promise<{
  incubation: NovelIncubatorResult
  campaign?: CampaignReport
}> {
  const { autoStartCruise = false, cruiseChapterCount = 3, ...incubatorOptions } = options

  // 步骤 1：全自动孵化冷启动
  const incubation = await runAutonomousNovelIncubator(incubatorOptions)

  let campaign: CampaignReport | undefined
  // 步骤 2：若开启了巡航推进，立即衔接长程战役全自动起草
  if (autoStartCruise) {
    campaign = await runAutonomousDraftCampaign({
      projectPath: options.projectPath,
      startChapter: 1,
      chapterCount: Math.min(cruiseChapterCount, options.targetChapters || 10),
      llmConfig: options.llmConfig,
      novelConfig: options.novelConfig || DEFAULT_NOVEL_CONFIG,
      cruiseMode: false,
      incubationSkeletons: incubation.unpackedSkeletons.createdSkeletons,
      onProgress: options.onProgress,
      signal: options.signal,
    })
  }

  return {
    incubation,
    campaign,
  }
}
