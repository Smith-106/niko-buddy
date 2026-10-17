/**
 * 开书导演 B 范围（宽）：idea/character/outline/chapters 四阶段 LLM 生成器。
 *
 * 定位与 director-pipeline 的分工：
 * - `director-pipeline.ts` 是确定性阶段门（只判「能不能过」）；
 * - 本模块负责「产出物从哪来」：把每阶段的指令 + 项目上下文交给真实模型，
 *   产出具名结构，再做确定性结构校验；校验不过就抛错、**不落 journal**。
 *
 * 幂等（stage-output-journal）：`digest = hash(阶段 + 指令 + 上下文指纹)`，`stage = director-<阶段>`。
 * 同一 digest 复跑直接复用 journal 里的 payload，不重复调 LLM；产物结构校验失败时
 * producer 抛错，因此不会有非法工件进缓存（重试时会重新调 LLM）。
 *
 * Draft-first：本模块只生成 + 校验 + 回传结构，**不写正式正文**；落盘由调用方
 * （director-auto-advance / 编辑器）按各自草稿纪律处理。
 */

import {
  computeInstructionDigest,
  resolveStageOutput,
  type StageJournalRuntime,
} from "./stage-output-journal"
import { stripCodeFence } from "./main-control-quality"
import type { LlmConfig } from "@/stores/wiki-store"

export const DIRECTOR_STAGE_KEYS = ["idea", "character", "outline", "chapters"] as const

export type DirectorStageKey = (typeof DIRECTOR_STAGE_KEYS)[number]

/** journal stage 名（幂等键的一半）。 */
export function directorStageJournalKey(stage: DirectorStageKey): string {
  return `director-${stage}`
}

// ──────────────────────────────────────────────────────────────────────────
// 产物结构（每阶段一个具名结构，全部字段可确定性校验）
// ──────────────────────────────────────────────────────────────────────────

export interface DirectorIdeaOutput {
  title: string
  genre: string
  coreConflict: string
  logline: string
  hooks: string[]
}

export interface DirectorCharacterEntry {
  name: string
  role: "protagonist" | "antagonist" | "supporting"
  desire: string
  flaw: string
}

export interface DirectorCharacterOutput {
  characters: DirectorCharacterEntry[]
}

export interface DirectorVolumePlan {
  title: string
  arc: string
  chapterCount: number
}

export interface DirectorOutlineOutput {
  framework: string
  volumes: DirectorVolumePlan[]
}

export interface DirectorChapterPlan {
  title: string
  beats: string[]
  hook: string
}

export interface DirectorChaptersOutput {
  firstChapter: DirectorChapterPlan
}

export interface DirectorStageOutputMap {
  idea: DirectorIdeaOutput
  character: DirectorCharacterOutput
  outline: DirectorOutlineOutput
  chapters: DirectorChaptersOutput
}

// ──────────────────────────────────────────────────────────────────────────
// 指令（进度门的输入 + 上游产物；也是 digest 的一部分）
// ──────────────────────────────────────────────────────────────────────────

export interface DirectorStageInstruction {
  /** 书名/题材/核心冲突（idea 阶段为待补全的原始设定，其余阶段为已定稿设定）。 */
  idea: { title: string; genre: string; coreConflict: string }
  /** 附加要求（用户口味、篇幅、禁忌等），进 digest 参与幂等。 */
  brief?: string
  /** 上游阶段产物（character 收 idea，outline 收 idea+character，chapters 收前三阶段）。 */
  upstream?: Partial<DirectorStageOutputMap>
  /** 目标卷数/章数（outline/chapters 用，缺省 3 卷）。 */
  targetVolumes?: number
}

// ──────────────────────────────────────────────────────────────────────────
// 结构校验（确定性；错误不静默，返回可读缺口清单）
// ──────────────────────────────────────────────────────────────────────────

export interface StageValidationFinding {
  path: string
  message: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out = value.map((v) => nonEmptyString(v)).filter((v): v is string => v !== null)
  return out.length === value.length && out.length > 0 ? out : null
}

function validateIdea(raw: unknown, findings: StageValidationFinding[]): DirectorIdeaOutput | null {
  const rec = asRecord(raw)
  if (!rec) {
    findings.push({ path: "$", message: "产物不是 JSON 对象" })
    return null
  }
  const title = nonEmptyString(rec.title)
  const genre = nonEmptyString(rec.genre)
  const coreConflict = nonEmptyString(rec.coreConflict)
  const logline = nonEmptyString(rec.logline)
  const hooks = stringList(rec.hooks)
  if (!title) findings.push({ path: "title", message: "书名缺失" })
  if (!genre) findings.push({ path: "genre", message: "题材缺失" })
  if (!coreConflict) findings.push({ path: "coreConflict", message: "核心冲突缺失" })
  if (!logline) findings.push({ path: "logline", message: "一句话故事（logline）缺失" })
  if (!hooks) findings.push({ path: "hooks", message: "卖点/钩子需为非空字符串数组" })
  if (!title || !genre || !coreConflict || !logline || !hooks) return null
  return { title, genre, coreConflict, logline, hooks }
}

function validateCharacter(raw: unknown, findings: StageValidationFinding[]): DirectorCharacterOutput | null {
  const rec = asRecord(raw)
  const list = rec ? rec.characters : undefined
  if (!Array.isArray(list)) {
    findings.push({ path: "$.characters", message: "角色列表缺失" })
    return null
  }
  const characters: DirectorCharacterEntry[] = []
  list.forEach((item, index) => {
    const entry = asRecord(item)
    const name = entry ? nonEmptyString(entry.name) : null
    const role = entry && typeof entry.role === "string" ? entry.role : ""
    const desire = entry ? nonEmptyString(entry.desire) : null
    const flaw = entry ? nonEmptyString(entry.flaw) : null
    if (!name) findings.push({ path: `characters[${index}].name`, message: "角色名缺失" })
    if (role !== "protagonist" && role !== "antagonist" && role !== "supporting") {
      findings.push({ path: `characters[${index}].role`, message: "role 必须是 protagonist/antagonist/supporting" })
    }
    if (!desire) findings.push({ path: `characters[${index}].desire`, message: "角色动机缺失" })
    if (!flaw) findings.push({ path: `characters[${index}].flaw`, message: "角色缺陷缺失" })
    if (name && desire && flaw && (role === "protagonist" || role === "antagonist" || role === "supporting")) {
      characters.push({ name, role, desire, flaw })
    }
  })
  const hasProtagonist = characters.some((c) => c.role === "protagonist")
  const hasAntagonist = characters.some((c) => c.role === "antagonist")
  if (!hasProtagonist) findings.push({ path: "characters", message: "缺主角（protagonist）" })
  if (!hasAntagonist) findings.push({ path: "characters", message: "缺对手（antagonist）" })
  if (findings.length > 0) return null
  return { characters }
}

function validateOutline(raw: unknown, findings: StageValidationFinding[]): DirectorOutlineOutput | null {
  const rec = asRecord(raw)
  const framework = rec ? nonEmptyString(rec.framework) : null
  const volumesRaw = rec ? rec.volumes : undefined
  if (!framework) findings.push({ path: "framework", message: "情节框架未选型" })
  if (!Array.isArray(volumesRaw) || volumesRaw.length < 2) {
    findings.push({ path: "volumes", message: "分卷需至少 2 卷（只计划 1 卷视为未分卷）" })
  }
  const volumes: DirectorVolumePlan[] = []
  if (Array.isArray(volumesRaw)) {
    volumesRaw.forEach((item, index) => {
      const entry = asRecord(item)
      const title = entry ? nonEmptyString(entry.title) : null
      const arc = entry ? nonEmptyString(entry.arc) : null
      const chapterCount = entry && typeof entry.chapterCount === "number" ? entry.chapterCount : NaN
      if (!title) findings.push({ path: `volumes[${index}].title`, message: "卷名缺失" })
      if (!arc) findings.push({ path: `volumes[${index}].arc`, message: "卷弧线缺失" })
      if (!Number.isFinite(chapterCount) || chapterCount <= 0) {
        findings.push({ path: `volumes[${index}].chapterCount`, message: "每卷章数需为正整数" })
      }
      if (title && arc && Number.isFinite(chapterCount) && chapterCount > 0) {
        volumes.push({ title, arc, chapterCount: Math.round(chapterCount) })
      }
    })
  }
  if (findings.length > 0 || !framework) return null
  return { framework, volumes }
}

function validateChapters(raw: unknown, findings: StageValidationFinding[]): DirectorChaptersOutput | null {
  const rec = asRecord(raw)
  const chapter = rec ? asRecord(rec.firstChapter) : null
  const title = chapter ? nonEmptyString(chapter.title) : null
  const beats = chapter ? stringList(chapter.beats) : null
  const hook = chapter ? nonEmptyString(chapter.hook) : null
  if (!chapter) findings.push({ path: "$.firstChapter", message: "首章计划缺失" })
  if (!title) findings.push({ path: "firstChapter.title", message: "首章标题缺失" })
  if (!beats) findings.push({ path: "firstChapter.beats", message: "首章节拍需为非空字符串数组" })
  if (!hook) findings.push({ path: "firstChapter.hook", message: "首章结尾钩子缺失" })
  if (!title || !beats || !hook) return null
  return { firstChapter: { title, beats, hook } }
}

/**
 * 阶段产物结构校验：返回 findings + 规范化产物（有 finding 时产物为 null）。
 * 校验器按阶段单源登记，生成与调用方落盘前共用同一套规则。
 */
export function validateStageOutput<K extends DirectorStageKey>(
  stage: K,
  raw: unknown,
): { ok: true; value: DirectorStageOutputMap[K] } | { ok: false; findings: StageValidationFinding[] } {
  const findings: StageValidationFinding[] = []
  const value =
    stage === "idea"
      ? validateIdea(raw, findings)
      : stage === "character"
        ? validateCharacter(raw, findings)
        : stage === "outline"
          ? validateOutline(raw, findings)
          : validateChapters(raw, findings)
  if (value === null || findings.length > 0) return { ok: false, findings }
  return { ok: true, value: value as DirectorStageOutputMap[K] }
}

// ──────────────────────────────────────────────────────────────────────────
// prompt（确定性渲染；同一指令 → 同一 prompt）
// ──────────────────────────────────────────────────────────────────────────

function ideaBlock(idea: DirectorStageInstruction["idea"]): string {
  return [
    `书名：${idea.title || "（待定）"}`,
    `题材：${idea.genre || "（待定）"}`,
    `核心冲突：${idea.coreConflict || "（待定）"}`,
  ].join("\n")
}

function upstreamBlock(instruction: DirectorStageInstruction, stages: DirectorStageKey[]): string {
  const parts: string[] = []
  for (const stage of stages) {
    const payload = instruction.upstream?.[stage]
    if (payload) parts.push(`## ${stage}\n${JSON.stringify(payload, null, 2)}`)
  }
  return parts.join("\n\n")
}

/** 每阶段的 JSON 契约文本（写进 prompt，模型照此产出）。 */
const STAGE_CONTRACTS: Record<DirectorStageKey, string> = {
  idea: `{"title": "书名", "genre": "题材", "coreConflict": "核心冲突（一句话）", "logline": "一句话故事", "hooks": ["卖点1", "卖点2", "卖点3"]}`,
  character: `{"characters": [{"name": "姓名", "role": "protagonist|antagonist|supporting", "desire": "他想要什么", "flaw": "他的致命缺陷"}]}`,
  outline: `{"framework": "三幕/起承转合/英雄之旅 等框架名", "volumes": [{"title": "卷名", "arc": "本卷弧线（起→转→合）", "chapterCount": 30}]}`,
  chapters: `{"firstChapter": {"title": "首章标题", "beats": ["节拍1", "节拍2", "节拍3"], "hook": "章末钩子"}}`,
}

const STAGE_MISSIONS: Record<DirectorStageKey, string> = {
  idea: "把模糊的开书念头收敛成能开写的立意卡：书名要可检索且有辨识度，核心冲突必须是「谁要什么 vs 谁阻止」的具体对立。",
  character: "建立角色账本：至少一名主角（protagonist）和一名对手（antagonist），每人有明确欲望与致命缺陷；配角按剧情需要补。",
  outline: "选型情节框架并分卷：每卷给出可执行的弧线与章数，卷间要有递进压力，不许只给一卷。",
  chapters: "设计首章开篇：给出标题、3-6 个节拍（场景级动作，不是剧情梗概）和章末钩子。",
}

export function buildStagePrompt(stage: DirectorStageKey, instruction: DirectorStageInstruction): string {
  const upstreamStages: Record<DirectorStageKey, DirectorStageKey[]> = {
    idea: [],
    character: ["idea"],
    outline: ["idea", "character"],
    chapters: ["idea", "character", "outline"],
  }
  const sections = [
    `# 任务：开书导演 · ${stage} 阶段`,
    STAGE_MISSIONS[stage],
    `## 已知开书设定\n${ideaBlock(instruction.idea)}`,
  ]
  const upstream = upstreamBlock(instruction, upstreamStages[stage])
  if (upstream) sections.push(`## 上游阶段产物\n${upstream}`)
  if (instruction.brief?.trim()) sections.push(`## 附加要求\n${instruction.brief.trim()}`)
  if (stage === "outline") {
    sections.push(`## 目标卷数\n${instruction.targetVolumes ?? 3} 卷`)
  }
  sections.push(`## 输出格式\n只输出一个 JSON 对象，不要解释、不要 Markdown 代码围栏之外的文字：\n${STAGE_CONTRACTS[stage]}`)
  return sections.join("\n\n")
}

export const DIRECTOR_STAGE_SYSTEM_PROMPT =
  "你是中文长篇小说的开书策划。你只输出严格 JSON，字段与要求完全对应；不确定的字段也给出具体可执行的内容，不要留空、不要写占位符。"

// ──────────────────────────────────────────────────────────────────────────
// 生成（LLM 调用经 deps 注入，默认走 streamChat）
// ──────────────────────────────────────────────────────────────────────────

export interface DirectorStageGenerationDeps {
  llmConfig: LlmConfig
  /** journal 运行时（缺省 = 不缓存：每次都调 LLM）。 */
  journal?: StageJournalRuntime
  signal?: AbortSignal
  /** LLM 文本生成注入（测试用；缺省走真实 streamChat）。 */
  complete?: (messages: Array<{ role: "system" | "user"; content: string }>, signal?: AbortSignal) => Promise<string>
}

async function defaultComplete(
  llmConfig: LlmConfig,
  messages: Array<{ role: "system" | "user"; content: string }>,
  signal?: AbortSignal,
): Promise<string> {
  const { streamChat } = await import("@/lib/llm-client")
  let text = ""
  let failure: Error | null = null
  await streamChat(
    llmConfig,
    messages,
    {
      onToken: (token) => {
        text += token
      },
      onDone: () => {},
      onError: (error) => {
        failure = error
      },
    },
    signal,
  )
  if (failure) throw failure
  return text
}

/** 结构校验失败的生成错误（携带缺口清单；不会写 journal）。 */
export class DirectorStageGenerationError extends Error {
  readonly stage: DirectorStageKey
  readonly findings: StageValidationFinding[]

  constructor(stage: DirectorStageKey, findings: StageValidationFinding[]) {
    super(`${stage} 阶段产物结构不合格：${findings.map((f) => `${f.path} ${f.message}`).join("；")}`)
    this.name = "DirectorStageGenerationError"
    this.stage = stage
    this.findings = findings
  }
}

/** 解析模型输出为 JSON（剥代码围栏；解析失败抛错，不落缓存）。 */
export function parseStageJson(stage: DirectorStageKey, raw: string): unknown {
  const body = stripCodeFence(raw)
  if (!body.trim()) {
    throw new DirectorStageGenerationError(stage, [{ path: "$", message: "模型未输出内容" }])
  }
  try {
    return JSON.parse(body)
  } catch {
    throw new DirectorStageGenerationError(stage, [{ path: "$", message: "输出不是合法 JSON" }])
  }
}

export interface StageGenerationResult<K extends DirectorStageKey> {
  output: DirectorStageOutputMap[K]
  /** true = 命中 journal（未调 LLM）。 */
  cached: boolean
  digest: string
}

/**
 * 生成单个阶段产物：指令 → digest → journal 命中即复用；未命中调 LLM、
 * 解析、结构校验（不合格抛错且不落盘），合格才写 journal。
 */
export async function generateDirectorStage<K extends DirectorStageKey>(
  stage: K,
  instruction: DirectorStageInstruction,
  deps: DirectorStageGenerationDeps,
): Promise<StageGenerationResult<K>> {
  const prompt = buildStagePrompt(stage, instruction)
  const journalKey = directorStageJournalKey(stage)
  const now = deps.journal?.now ?? Date.now

  const produce = async (): Promise<unknown> => {
    const messages = [
      { role: "system" as const, content: DIRECTOR_STAGE_SYSTEM_PROMPT },
      { role: "user" as const, content: prompt },
    ]
    const raw = deps.complete
      ? await deps.complete(messages, deps.signal)
      : await defaultComplete(deps.llmConfig, messages, deps.signal)
    const parsed = parseStageJson(stage, raw)
    const validated = validateStageOutput(stage, parsed)
    if (!validated.ok) throw new DirectorStageGenerationError(stage, validated.findings)
    return validated.value
  }

  if (!deps.journal) {
    const value = await produce()
    return { output: value as DirectorStageOutputMap[K], cached: false, digest: "" }
  }

  const digest = await computeInstructionDigest({ stage, prompt, instruction })
  const lookup = await resolveStageOutput(
    deps.journal.deps,
    deps.journal.projectId,
    digest,
    journalKey,
    produce,
    now(),
    deps.journal.ttlMs,
  )
  const payload = lookup.record?.payload
  // 缓存行可能来自旧 schema：仍按当前校验器复核，不合格视为未命中（并已在上方 producer 侧拦新写入）。
  const validated = validateStageOutput(stage, payload)
  if (!validated.ok) {
    const value = await produce()
    const refreshed = await resolveStageOutput(
      deps.journal.deps,
      deps.journal.projectId,
      digest,
      journalKey,
      async () => value,
      now(),
      deps.journal.ttlMs,
    )
    return { output: refreshed.record?.payload as DirectorStageOutputMap[K], cached: false, digest }
  }
  return { output: validated.value, cached: lookup.hit, digest }
}

/**
 * 顺序生成多个阶段（chapters 依赖前三阶段产物时用）。
 * `upstream` 自动串联：后面阶段的 instruction.upstream 由本函数填入。
 */
export async function generateDirectorStages<K extends DirectorStageKey>(
  stages: readonly K[],
  instruction: DirectorStageInstruction,
  deps: DirectorStageGenerationDeps,
): Promise<{ [P in K]: StageGenerationResult<P> }> {
  const out = {} as { [P in K]: StageGenerationResult<P> }
  const upstream: Partial<DirectorStageOutputMap> = { ...instruction.upstream }
  for (const stage of stages) {
    const result = await generateDirectorStage(stage, { ...instruction, upstream: { ...upstream } }, deps)
    out[stage] = result
    upstream[stage] = result.output as DirectorStageOutputMap[K]
  }
  return out
}
