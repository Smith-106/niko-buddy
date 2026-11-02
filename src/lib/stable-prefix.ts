// Copyright (c) 2024 Niko-hub contributors. MIT License.
import { sha256Text } from "@/lib/context-hub/fingerprint"
import { estimateTokens } from "@/lib/token-estimator"

/**
 * 稳定前缀（stable prefix）的版本号 —— prompt 缓存段的唯一版本真源。
 *
 * ## 什么时候必须 +1
 *
 * - 任一 stable 字段的**文本**改动（哪怕只改一个标点）；
 * - 字段白名单增删（STABLE_PREFIX_FIELD_ORDER）；
 * - 字段顺序调整（顺序进了哈希，也进了渲染结果）；
 * - 渲染分隔符改动（当前是 `\n`）。
 *
 * 由 `stable-prefix.spec.ts` 的「字段抖动即版本变」用例强制：字段文本变了却没 bump，
 * 基线摘要对不上 → 用例红 → 必须 bump 并补基线（缓解 R4：旧版本已被上游缓存的
 * 错误前缀被静默复用，缓存命中率看起来正常，实际喂给模型的是过期规则）。
 *
 * ## 为什么这些字段「稳定」（E4：字段为何稳定，理由行）
 *
 * - `skillPrompt`：只由任务路由（write/continue/rewrite）决定，同一会话内不变；
 * - `roleDirective`：角色定位是产品文案，随 novelMode 二值切换，不随检索结果变化；
 * - `chapterOutputRules`：章节输出格式契约（标题行、无引用标记），是常量；
 * - `answerRules`：回答/引用规则，同样是常量；
 * - `formatHint`：Markdown 格式要求，常量。
 *
 * 与之相对，资料库索引、页面正文、上下文包、拆解指令、输出语言提醒都**随每次请求变化**，
 * 一律进 dynamic 段（见 chat-panel-context-assembly / chat-panel-continue-unfinished），
 * 永不进 cacheControl 段 —— 否则每次请求前缀都不同，缓存命中率归零。
 *
 * ## 跨 provider 缓存策略（同一个前缀，三种投递方式）
 *
 * - **Anthropic / MiniMax / custom+anthropic_messages（显式）**：cacheControl 块在
 *   llm-providers 的 toAnthropicContent 里落成 `cache_control: { type: "ephemeral" }`；
 *   system 段在存在断点时也按块下发（此前被压平成字符串，断点实际没送到上游）。
 * - **OpenAI / Azure / Google / 兼容端点（隐式）**：没有 cache_control 概念，靠上游自动
 *   前缀缓存命中。命中前提是**前缀字节完全一致**，因此本模块把字段顺序锁进
 *   STABLE_PREFIX_FIELD_ORDER，渲染顺序只由这个数组决定，不受调用方对象字面量顺序影响。
 * - **Ollama / 本地端点（无）**：本地推理没有跨请求前缀缓存，cacheControl 无副作用。
 *
 * 版本与哈希以**既有 trace 字段**落盘（`prefixFingerprint` / `prefixEstimatedTokens`，
 * 见 llm-request-trace.ts 的 LlmRequestCacheTrace）：版本折进哈希，所以同一段文本在不同
 * 版本下哈希必然不同 —— 不需要给 trace 加字段（trace 结构归 TASK-006）。
 */
export const STABLE_PREFIX_VERSION = 2

/**
 * 稳定字段白名单 + 渲染顺序（唯一真源）。
 *
 * 只有出现在这里的字段才可能进入 cacheControl 段；调用方多传的键会被
 * buildStablePrefix 直接丢弃 —— 「dynamic 段永不进缓存」这条约束由白名单兜住，
 * 而不是靠调用方自觉。
 */
export const STABLE_PREFIX_FIELD_ORDER = [
  "skillPrompt",
  "roleDirective",
  // G6：世界规则的**项目级不变基线**（不含随章节变化的 temporal 块）。
  // 只有跨章字节一致的内容才能进缓存段——canonRules 含 temporal 增量，
  // 放进来永远不命中；这里放的是去掉增量后的 base。
  "canonRulesBase",
  "chapterOutputRules",
  "answerRules",
  "formatHint",
] as const

export type StablePrefixFieldName = (typeof STABLE_PREFIX_FIELD_ORDER)[number]

/** 稳定字段的完整形态（缺省一律归一成空串，空串不参与渲染）。 */
export type StablePrefixFields = Record<StablePrefixFieldName, string>

/** 调用方入参：允许缺字段、允许传多余键（多余键被丢弃）。 */
export type StablePrefixFieldInput = Partial<Record<StablePrefixFieldName, string>> & {
  [key: string]: unknown
}

/**
 * 「继续未完成」组装点的字段顺序：**角色定位在技能段之前**。
 *
 * 这是该组装点拆分前既有的文本顺序（断点续写语义不得改变），所以单独锁定一条顺序
 * 常量而不是就地拼数组 —— 顺序仍然只有 stable-prefix.ts 一个真源，并且参与哈希。
 */
export const CONTINUE_UNFINISHED_FIELD_ORDER = [
  "roleDirective",
  "skillPrompt",
  "chapterOutputRules",
  "answerRules",
  "formatHint",
] as const satisfies readonly StablePrefixFieldName[]

export interface StablePrefix {
  version: number
  /** 本次渲染实际使用的字段顺序（进哈希）。 */
  order: readonly StablePrefixFieldName[]
  fields: StablePrefixFields
  /** 按 order 渲染的非空片段。 */
  parts: string[]
  /** 片段以 `\n` 连接 —— 与拆分前的 `parts.join("\n")` 逐字节等价。 */
  text: string
}

/** 小说 / 资料库两种角色定位。 */
export function buildStableRoleDirective(novelMode: boolean): string {
  return novelMode
    ? "你是一个专业的小说写作助手。请根据提供的小说上下文包和章节内容，协助用户进行小说创作。"
    : "你是一个专业的资料库问答助手。请基于下方提供的资料内容回答问题。"
}

/** 小说章节输出规则（资料库模式无此段）。 */
export function buildStableChapterOutputRules(novelMode: boolean): string {
  if (!novelMode) return ""
  return [
    "## 小说章节输出规则",
    "- 如果用户要求生成、续写或改写章节，只输出可直接放入章节库的小说正文。",
    "- 正文第一行必须是章节标题，格式为：# 第X章 标题名（标题4-12字，概括本章核心内容）。",
    "- 不要输出资料说明、创作说明、免责声明、后续建议、引用列表或隐藏 cited 注释。",
    "- 不要在小说正文里写 [[资料名]]、[1]、[2] 这类资料引用标记。",
    "- 资料只作为内部参考，不能把资料库缺失、基于现有资料等元信息写进章节。",
  ].join("\n")
}

/** 回答规则：小说模式禁解释性回答，资料库模式要求编号引用 + 隐藏 cited 注释。 */
export function buildStableAnswerRules(novelMode: boolean): string {
  return novelMode
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
      ].join("\n")
}

/** Markdown 格式要求（两种模式共用）。 */
export const STABLE_PREFIX_FORMAT_HINT = "请使用清晰的 Markdown 格式。"

/** 「继续未完成」的角色定位（断点续写语义，文本与拆分前逐字一致）。 */
export const CONTINUE_UNFINISHED_ROLE_DIRECTIVE = [
  "你是专业小说写作助手。用户正在继续一次已中断的深度章节生成，请严格基于已有思考和阶段内容往后完成，不要从头重跑已完成阶段。",
  "如果上方恢复上下文里没有正文草稿，就从正文生成阶段继续；如果已经有正文草稿，就继续审查、返修、简单审查、去AI味或补全正文。",
  "不要把“继续未完成”当作原始章节需求；原始章节需求必须以恢复上下文中的原始用户请求为准。",
].join("\n")

/** 技能段标题（QM-QUAI 技能块的前缀行）。 */
export const STABLE_SKILL_SECTION_HEADER = "## QM-QUAI 技能"

function renderSkillPrompt(skillPrompt: string): string {
  const trimmed = skillPrompt.trim()
  return trimmed ? `${STABLE_SKILL_SECTION_HEADER}\n${skillPrompt}` : ""
}

/** chat 主组装点（chat-panel-context-assembly.ts）的稳定字段。 */
export function buildChatStablePrefixFields(input: {
  novelMode: boolean
  skillPrompt: string
  /** G6：世界规则项目级基线（跨章字节一致）→ 进缓存段。 */
  canonRulesBase?: string
}): StablePrefixFields {
  return {
    skillPrompt: renderSkillPrompt(input.skillPrompt),
    roleDirective: buildStableRoleDirective(input.novelMode),
    canonRulesBase: input.canonRulesBase ?? "",
    chapterOutputRules: buildStableChapterOutputRules(input.novelMode),
    answerRules: buildStableAnswerRules(input.novelMode),
    formatHint: STABLE_PREFIX_FORMAT_HINT,
  }
}

/** chat 主组装点的稳定前缀（默认字段顺序：技能 → 角色 → 章节规则 → 规则 → 格式）。 */
export function buildChatStablePrefix(input: {
  novelMode: boolean
  skillPrompt: string
  /** G6：世界规则项目级基线（跨章字节一致）→ 进缓存段。 */
  canonRulesBase?: string
}): StablePrefix {
  return buildStablePrefix(buildChatStablePrefixFields(input))
}

/**
 * 「继续未完成」组装点（chat-panel-continue-unfinished.ts）的稳定字段。
 *
 * 与 chat 主组装点同源同版本：它只是换了 roleDirective、不产出章节输出规则 /
 * Markdown 提示（这两个字段留空，不进渲染）。第二组装点因此没有独立版本，
 * 不会出现「双轨」。
 */
export function buildContinueUnfinishedStablePrefixFields(input: {
  skillPrompt: string
}): StablePrefixFields {
  return {
    skillPrompt: renderSkillPrompt(input.skillPrompt),
    roleDirective: CONTINUE_UNFINISHED_ROLE_DIRECTIVE,
    // G6 未覆盖该路径：CONTINUE_UNFINISHED_FIELD_ORDER 不含 canonRulesBase，
    // 所以续写未完成路径的 canonRules 仍整块在动态段（跨章前缀不稳定）。
    // 这是有意的范围裁剪；若要收益需同时改 FIELD_ORDER 与组装点，并补基线。
    canonRulesBase: "",
    chapterOutputRules: "",
    answerRules: "",
    formatHint: "",
  }
}

/**
 * 「继续未完成」组装点的稳定前缀（角色定位在技能段之前，见
 * CONTINUE_UNFINISHED_FIELD_ORDER）。
 */
export function buildContinueUnfinishedStablePrefix(input: {
  skillPrompt: string
}): StablePrefix {
  return buildStablePrefix(
    buildContinueUnfinishedStablePrefixFields(input),
    CONTINUE_UNFINISHED_FIELD_ORDER,
  )
}

/**
 * 字段文本按版本登记的基线（sha256）。**bump 版本时必须同时补一条**。
 *
 * 键集合必须与 STABLE_PREFIX_VERSIONED_TEXTS 完全一致（spec 双向校验）：
 * 新增一个会被缓存的字段却不登记，等于让它的抖动绕过版本约束。
 */
export const STABLE_PREFIX_TEXT_BASELINE: Readonly<Record<number, Readonly<Record<string, string>>>> = {
  1: {
    "answerRules:novel": "b9d9710465b9f668b6fe57e29780d2bb9da6d214f12d65d8f29a160ed55c5172",
    "answerRules:wiki": "c0ac72901ef2246e9e9caf700e567cdf84243fed35ac7a69a2d1cba3e107849b",
    "chapterOutputRules:novel": "c7e2414f72b4a651d60be40f68b3d6cbcaf63bfd5997a60b901cf5efa045010b",
    "continueUnfinished:roleDirective": "f36629854f68dc7581d364e38e1004c8446bdeab0cecf03f2b3c0e5eb467c586",
    "formatHint": "4e6222dfa8393107ca6913007615dd6ebff43fc88d45b4b117d6f67784a4a372",
    "roleDirective:novel": "922274b404e157d4dbf67e3717d9bf368bfad6fa8c369ccfcac7da962dba1892",
    "roleDirective:wiki": "9f05a6e733d0e2f64a9300906931a848517ea1e4e24e231d62daad275034e5fb",
  },
  // v2：G6 把 canonRulesBase 加进缓存段（常量文本未变，digest 与 v1 一致）。
  2: {
    "answerRules:novel": "b9d9710465b9f668b6fe57e29780d2bb9da6d214f12d65d8f29a160ed55c5172",
    "answerRules:wiki": "c0ac72901ef2246e9e9caf700e567cdf84243fed35ac7a69a2d1cba3e107849b",
    "chapterOutputRules:novel": "c7e2414f72b4a651d60be40f68b3d6cbcaf63bfd5997a60b901cf5efa045010b",
    "continueUnfinished:roleDirective": "f36629854f68dc7581d364e38e1004c8446bdeab0cecf03f2b3c0e5eb467c586",
    "formatHint": "4e6222dfa8393107ca6913007615dd6ebff43fc88d45b4b117d6f67784a4a372",
    "roleDirective:novel": "922274b404e157d4dbf67e3717d9bf368bfad6fa8c369ccfcac7da962dba1892",
    "roleDirective:wiki": "9f05a6e733d0e2f64a9300906931a848517ea1e4e24e231d62daad275034e5fb",
  },
}

/** 基线键 → 当前文本（基线用例靠它重算摘要，比对「文本变了但版本没 bump」）。 */
export const STABLE_PREFIX_VERSIONED_TEXTS: Readonly<Record<string, () => string>> = {
  "roleDirective:novel": () => buildStableRoleDirective(true),
  "roleDirective:wiki": () => buildStableRoleDirective(false),
  "chapterOutputRules:novel": () => buildStableChapterOutputRules(true),
  "answerRules:novel": () => buildStableAnswerRules(true),
  "answerRules:wiki": () => buildStableAnswerRules(false),
  "formatHint": () => STABLE_PREFIX_FORMAT_HINT,
  "continueUnfinished:roleDirective": () => CONTINUE_UNFINISHED_ROLE_DIRECTIVE,
}

/**
 * 白名单取值 → 渲染。
 *
 * 未知键被丢弃（不抛错）：装配点常有 `...maybeUndefined` 之类的展开，
 * 静默丢弃比崩掉更安全，而且「多传的键不进缓存」正是我们要的保证。
 */
export function buildStablePrefix(
  input: StablePrefixFieldInput = {},
  order: readonly StablePrefixFieldName[] = STABLE_PREFIX_FIELD_ORDER,
): StablePrefix {
  const fields = {} as StablePrefixFields
  // 先把白名单全部置空，保证 fields 形状完整（自定义 order 时也不会缺键）
  for (const name of STABLE_PREFIX_FIELD_ORDER) fields[name] = ""
  const parts: string[] = []
  for (const name of order) {
    const raw = input[name]
    const value = typeof raw === "string" ? raw : ""
    fields[name] = value
    if (value.length > 0) parts.push(value)
  }
  return {
    version: STABLE_PREFIX_VERSION,
    order,
    fields,
    parts,
    text: parts.join("\n"),
  }
}

function isStablePrefix(value: StablePrefix | StablePrefixFieldInput): value is StablePrefix {
  return (
    typeof (value as StablePrefix).version === "number"
    && typeof (value as StablePrefix).text === "string"
    && typeof (value as StablePrefix).fields === "object"
    && (value as StablePrefix).fields !== null
  )
}

/** 哈希的规范序列化：版本 + 实际渲染顺序上的字段值（顺序固定，不受对象键序影响）。 */
export function canonicalizeStablePrefix(prefix: StablePrefix): string {
  return JSON.stringify({
    version: prefix.version,
    fields: prefix.order.map((name) => [name, prefix.fields[name] ?? ""]),
  })
}

/**
 * 稳定前缀哈希（64 位 hex，可直接落到 trace 的 `prefixFingerprint`）。
 *
 * 版本参与哈希：同文本不同版本 → 不同哈希，于是 trace 里的前缀指纹天然带版本，
 * 不需要新增字段。
 */
export async function hashStablePrefix(input: StablePrefix | StablePrefixFieldInput): Promise<string> {
  const prefix = isStablePrefix(input) ? input : buildStablePrefix(input)
  return sha256Text(canonicalizeStablePrefix(prefix))
}

/**
 * 生成可直接并入 llm-request-trace 的既有字段（不新增 trace 结构）。
 *
 * `prefixFingerprint` = 版本 + 稳定字段的哈希；`prefixEstimatedTokens` = 稳定段 token 估算。
 */
export async function buildStablePrefixTraceFields(
  input: StablePrefix | StablePrefixFieldInput,
): Promise<{ prefixFingerprint: string; prefixEstimatedTokens: number }> {
  const prefix = isStablePrefix(input) ? input : buildStablePrefix(input)
  return {
    prefixFingerprint: await hashStablePrefix(prefix),
    prefixEstimatedTokens: estimateTokens(prefix.text),
  }
}

/**
 * 把稳定段与动态段拼成两个 system 块：稳定段带 cacheControl，动态段永不缓存。
 *
 * 拼起来与拆分前的 `[...stable, ...dynamic].filter(Boolean).join("\n")` **逐字节等价**
 * （稳定段末尾补一个 `\n` 当分隔符），所以拆块不会改变发给模型的文本语义。
 */
export function composeStableSystemBlocks(
  prefix: StablePrefix,
  dynamicParts: string[],
): Array<{ type: "text"; text: string; cacheControl?: boolean }> {
  const dynamicText = dynamicParts.filter((part) => part.length > 0).join("\n")
  const blocks: Array<{ type: "text"; text: string; cacheControl?: boolean }> = []
  if (prefix.text.length > 0) {
    blocks.push({
      type: "text",
      text: dynamicText.length > 0 ? `${prefix.text}\n` : prefix.text,
      cacheControl: true,
    })
  }
  if (dynamicText.length > 0) {
    blocks.push({ type: "text", text: dynamicText })
  }
  return blocks
}
