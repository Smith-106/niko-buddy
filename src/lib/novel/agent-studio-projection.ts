// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * agent-studio-projection.ts — EPIC「代理工作室设置规范化」只读投影。
 *
 * 定位（步骤①：审计 + 投影，**零写盘**）：
 *   把「哪些设置决定哪个 agent / 哪个角色用哪个模型」这条链路盘点成一张可断言的表，
 *   而不是再引入第四个真源。本模块是**纯函数 + 纯数据**：
 *     - 无 IO / 无网络 / 无模型调用 / 无 store 依赖；
 *     - 不读也不写任何配置文件；文件存在性由调用方经 `AgentStudioSourceProbe` 注入
 *       （与 `resolveRoleModel` 的 DI 风格一致，便于 spec 断言）。
 *
 * 为什么要它：
 *   现有「代理/模型路由」设置面横跨 6 个物理位置（store 类型、store 初值、
 *   project-store normalize、settings UI、preset-resolver、agent/novel 执行层），
 *   同一口径在多处手写。本投影把这些位置固化成一张表，任何新增副本都会让
 *   `duplicatedIn` 变长，从而在 spec 里**可失败**，而不是靠人眼巡检。
 *
 * 真源引用格式：`sourceFile` / `duplicatedIn` 一律为 `"<仓库相对路径>:<行号>"`
 * （见 `AGENT_STUDIO_SETTING_CATALOG`）。文件存在性判定用 `sourceFilePath()`
 * 去掉行号后缀后的路径。这样一行证据既能被人直接点开，也能被探针校验。
 *
 * 排序口径：所有输出数组按 **Unicode 码点**升序（`compareCodePoints`），
 * 不使用默认的 UTF-16 code-unit 排序 —— 两者对星平面字符（如 U+1F600）
 * 结果相反，码点序才是「按字符」的稳定口径。
 *
 * @license MIT © Niko Buddy
 */

// ── 类型 ─────────────────────────────────────────────────────────────────────────

/** 单个设置项的规范化状态。 */
export type AgentStudioSettingStatus =
  /** 真源存在，且全仓只有一处声明。 */
  | "ok"
  /** 真源存在，但同一口径在别处被重复声明（口径漂移风险）。 */
  | "duplicated"
  /** 真源文件在本仓不存在（设置无落点）。 */
  | "missing"

/** 一行盘点结果（代理工作室设置面）。 */
export interface AgentStudioSettingRow {
  /** 稳定标识，形如 `llm.apiMode`。 */
  readonly id: string
  /** 中文可读名（直接写在代码里，不走 i18n）。 */
  readonly label: string
  /** 主真源引用，格式 `<仓库相对路径>:<行号>`。 */
  readonly sourceFile: string
  /** 是否存在显式默认值。 */
  readonly hasDefault: boolean
  /** 同一声明被复制的其它位置（`<路径>:<行号>`），按码点排序；空数组 = 单点真源。 */
  readonly duplicatedIn: readonly string[]
  /** 规范化状态。 */
  readonly status: AgentStudioSettingStatus
}

/** 明确「不适用」的审计项（不是缺失，而是按语义无落点/无意义）。 */
export interface AgentStudioNotApplicableItem {
  readonly id: string
  readonly label: string
  readonly reason: string
}

/** 文件存在性探针（由调用方注入；本模块不做任何 IO）。 */
export interface AgentStudioSourceProbe {
  /** 当前仓库中确实存在的文件路径（仓库相对、posix 分隔）。 */
  readonly existingFiles: readonly string[]
}

/** 投影汇总计数。 */
export interface AgentStudioProjectionTotals {
  readonly total: number
  readonly ok: number
  readonly duplicated: number
  readonly missing: number
}

/** 只读投影结果。 */
export interface AgentStudioProjection {
  /** 全部设置行，按 id 码点升序。 */
  readonly rows: readonly AgentStudioSettingRow[]
  /** 状态为 missing 的行所对应的文件路径（去重 + 码点升序）。 */
  readonly missingSources: readonly string[]
  /** 存在重复真源的行 id（码点升序）。 */
  readonly duplicateRowIds: readonly string[]
  /** 明确不适用项（码点升序）。 */
  readonly notApplicable: readonly AgentStudioNotApplicableItem[]
  /** id → 默认值字面量；仅收录 `hasDefault && defaultValue !== null` 的项。 */
  readonly defaultsById: Readonly<Record<string, string>>
  /** 计数汇总。 */
  readonly totals: AgentStudioProjectionTotals
}

/** 盘点表条目（= 行的静态形态 + 默认值字面量）。 */
export interface AgentStudioCatalogEntry {
  readonly id: string
  readonly label: string
  readonly sourceFile: string
  readonly hasDefault: boolean
  /** 默认值字面量；`null` = 无默认值（与 hasDefault=false 配对）。 */
  readonly defaultValue: string | null
  readonly duplicatedIn: readonly string[]
}

// ── 码点排序 ─────────────────────────────────────────────────────────────────────

/**
 * 按 Unicode 码点比较两个字符串。
 *
 * 与 `a < b`（UTF-16 code-unit 序）的区别仅在星平面字符：例如
 * `"\u{1F600}"` 的码点是 128512，`"\uFFFF"` 的码点是 65535，码点序判定
 * U+FFFF 在前；而 UTF-16 code-unit 序判定代理对 `"\uD83D"`(55357) 在前。
 * 本模块统一使用码点序。
 *
 * 纯函数。
 */
export function compareCodePoints(a: string, b: string): number {
  const ax = Array.from(a)
  const bx = Array.from(b)
  const shared = Math.min(ax.length, bx.length)
  for (let i = 0; i < shared; i += 1) {
    const ca = ax[i].codePointAt(0) ?? 0
    const cb = bx[i].codePointAt(0) ?? 0
    if (ca !== cb) return ca < cb ? -1 : 1
  }
  return ax.length - bx.length
}

function sortByCodePoints(values: readonly string[]): string[] {
  return [...values].sort(compareCodePoints)
}

// ── 真源引用工具 ─────────────────────────────────────────────────────────────────

/**
 * 从 `"<路径>:<行号>"` 取出路径部分。
 *
 * 只剥离「冒号 + 纯数字（可带 `-` 行区间）」后缀，避免误伤含冒号的路径
 * （如 Windows 盘符 `C:/...`：其后缀不是纯数字，故原样保留）。
 *
 * 纯函数。
 */
export function sourceFilePath(ref: string): string {
  const idx = ref.lastIndexOf(":")
  if (idx <= 0) return ref
  const suffix = ref.slice(idx + 1)
  return /^[0-9]+(?:-[0-9]+)?$/.test(suffix) ? ref.slice(0, idx) : ref
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "")
}

// ── 盘点表（唯一真源：本表就是审计结论的可执行形态） ──────────────────────────────

/**
 * 代理工作室设置面盘点表。
 *
 * 每条 `sourceFile` 是**主真源**（类型声明或默认值声明处），`duplicatedIn` 是
 * 同一口径在别处被复制的确切位置。维护规则：
 *   - 新增副本 → 追加到 `duplicatedIn`（spec 会因此看到 duplicated 状态）；
 *   - 删除副本 → 从 `duplicatedIn` 移除，状态自动回落 `ok`；
 *   - 新增设置项 → 追加一条（缺文件的行会被 `missing` 捕获）。
 */
export const AGENT_STUDIO_SETTING_CATALOG: readonly AgentStudioCatalogEntry[] = [
  {
    id: "llm.provider",
    label: "全局 LLM 提供方",
    sourceFile: "src/stores/wiki-store.ts:112",
    hasDefault: true,
    defaultValue: "openai",
    duplicatedIn: [
      "src/stores/wiki-store.ts:860",
      "src/lib/env-llm-defaults.ts:33",
    ],
  },
  {
    id: "llm.model",
    label: "全局 LLM 模型",
    sourceFile: "src/stores/wiki-store.ts:114",
    hasDefault: true,
    defaultValue: '""',
    duplicatedIn: [
      "src/stores/wiki-store.ts:863",
      "src/lib/env-llm-defaults.ts:35",
      "src/lib/llm-config/llm-presets.ts:48",
    ],
  },
  {
    id: "llm.apiMode",
    label: "自定义端点 wire 协议",
    sourceFile: "src/stores/wiki-store.ts:128",
    hasDefault: true,
    defaultValue: '"chat_completions"',
    duplicatedIn: [
      "src/lib/env-llm-defaults.ts:39",
      "src/lib/llm-config/llm-presets.ts:60",
      "src/lib/llm-config/preset-resolver.ts:74",
      "src/components/settings/sections/custom-provider-cards.tsx:52",
      "src/components/settings/sections/custom-provider-cards.tsx:72",
      "src/components/settings/sections/rerank-section.tsx:315",
      "src/components/settings/sections/llm-provider-section.tsx:176",
    ],
  },
  {
    id: "llm.maxContextSize",
    label: "上下文窗口（字符数）",
    sourceFile: "src/stores/wiki-store.ts:119",
    hasDefault: true,
    defaultValue: "204800",
    duplicatedIn: [
      "src/stores/wiki-store.ts:862",
      "src/components/settings/settings-view.tsx:118",
      "src/lib/env-llm-defaults.ts:17",
      "src/components/settings/sections/llm-provider-section.tsx:180",
    ],
  },
  {
    id: "llm.reasoning",
    label: "全局推理配置（mode/budgetTokens）",
    sourceFile: "src/stores/wiki-store.ts:129",
    hasDefault: true,
    defaultValue: '{ mode: "auto" }',
    duplicatedIn: [
      "src/stores/wiki-store.ts:868",
      "src/lib/llm-config/preset-resolver.ts:48",
      "src/lib/env-llm-defaults.ts:40",
      "src/components/settings/sections/llm-provider-section.tsx:181",
    ],
  },
  {
    id: "llm.explicitProviderSelection",
    label: "提供方为「显式选择」标记",
    sourceFile: "src/stores/wiki-store.ts:147",
    hasDefault: true,
    defaultValue: "false（缺省视同未显式选择）",
    duplicatedIn: [],
  },
  {
    id: "llm.functionCallingEnabled",
    label: "函数调用（工具）总开关",
    sourceFile: "src/lib/agent/config.ts:67",
    hasDefault: true,
    defaultValue: "true（`!== false`）",
    duplicatedIn: [],
  },
  {
    id: "providerConfigs.apiMode",
    label: "按提供方覆盖的 wire 协议",
    sourceFile: "src/stores/wiki-store.ts:563",
    hasDefault: true,
    defaultValue: "undefined（回退 llm.apiMode）",
    duplicatedIn: [
      "src/lib/env-llm-defaults.ts:50",
      "src/lib/llm-config/preset-resolver.ts:74",
    ],
  },
  {
    id: "store.aiChatModel",
    label: "AI 会话当前模型",
    sourceFile: "src/stores/wiki-store.ts:696",
    hasDefault: true,
    defaultValue: '""',
    duplicatedIn: [
      "src/stores/wiki-store.ts:871",
      "src/lib/novel/model-resolver.ts:88",
    ],
  },
  {
    id: "store.defaultLlmModel",
    label: "后台任务默认模型",
    sourceFile: "src/stores/wiki-store.ts:698",
    hasDefault: true,
    defaultValue: '""',
    duplicatedIn: [
      "src/stores/wiki-store.ts:872",
      "src/lib/novel/model-resolver.ts:87",
    ],
  },
  {
    id: "novel.writingModel",
    label: "写作模型（已声明移除但仍接线）",
    sourceFile: "src/stores/wiki-store.ts:321",
    hasDefault: true,
    defaultValue: '""',
    duplicatedIn: [
      "src/stores/wiki-store.ts:440",
      "src/lib/project-store.ts:694",
      "src/lib/llm/model-resolver.ts:34",
      "src/lib/novel/deep-chapter-generation.ts:372",
      "src/lib/novel/premium-execution.ts:463",
    ],
  },
  {
    id: "novel.reviewModel",
    label: "审稿模型",
    sourceFile: "src/stores/wiki-store.ts:322",
    hasDefault: true,
    defaultValue: '""',
    duplicatedIn: [
      "src/stores/wiki-store.ts:441",
      "src/lib/project-store.ts:695",
      "src/lib/llm/model-resolver.ts:35",
      "src/components/settings/sections/novel-section.tsx:159",
    ],
  },
  {
    id: "novel.summaryModel",
    label: "摘要模型",
    sourceFile: "src/stores/wiki-store.ts:323",
    hasDefault: true,
    defaultValue: '""',
    duplicatedIn: [
      "src/stores/wiki-store.ts:442",
      "src/lib/project-store.ts:696",
      "src/components/settings/sections/novel-section.tsx:160",
    ],
  },
  {
    id: "novel.extractModel",
    label: "资料提取模型",
    sourceFile: "src/stores/wiki-store.ts:324",
    hasDefault: true,
    defaultValue: '""',
    duplicatedIn: [
      "src/stores/wiki-store.ts:443",
      "src/lib/project-store.ts:697",
      "src/components/settings/sections/novel-section.tsx:163",
    ],
  },
  {
    id: "novel.reviewReasoningEffort",
    label: "审稿推理档位",
    sourceFile: "src/stores/wiki-store.ts:320",
    hasDefault: true,
    defaultValue: '"high"',
    duplicatedIn: [
      "src/stores/wiki-store.ts:439",
      "src/components/settings/sections/novel-section.tsx:472",
    ],
  },
  {
    id: "novel.consensusWritingModels",
    label: "写作共识模型组",
    sourceFile: "src/stores/wiki-store.ts:330",
    hasDefault: true,
    defaultValue: "[]",
    duplicatedIn: [
      "src/stores/wiki-store.ts:446",
      "src/components/settings/sections/novel-section.tsx:780",
    ],
  },
  {
    id: "novel.consensusReviewModels",
    label: "审查共识分维模型组",
    sourceFile: "src/stores/wiki-store.ts:328",
    hasDefault: true,
    defaultValue: "{}",
    duplicatedIn: [
      "src/stores/wiki-store.ts:445",
      "src/components/settings/sections/novel-section.tsx:815",
    ],
  },
  {
    id: "judge.judgePool",
    label: "判官池（多判官路由）",
    sourceFile: "src/lib/llm/model-resolver.ts:159",
    hasDefault: false,
    defaultValue: null,
    duplicatedIn: [
      "src/lib/llm/model-resolver.ts:59",
      "src/lib/llm/model-resolver.ts:179",
    ],
  },
  {
    id: "premium.fallbackChains",
    label: "精品模式角色 fallback 链",
    sourceFile: "src/lib/novel/premium-config.ts:119",
    hasDefault: true,
    defaultValue: "{}",
    duplicatedIn: [
      "src/lib/llm/model-resolver.ts:167",
    ],
  },
  {
    id: "agent.maxRounds",
    label: "Agent 最大轮次",
    sourceFile: "src/lib/agent/types.ts:67",
    hasDefault: true,
    defaultValue: "15",
    duplicatedIn: [
      "src/lib/agent/types.ts:222",
    ],
  },
  {
    id: "embedding.model",
    label: "向量模型",
    sourceFile: "src/stores/wiki-store.ts:199",
    hasDefault: true,
    defaultValue: '""',
    duplicatedIn: [
      "src/components/settings/settings-view.tsx:125",
      "src/components/settings/settings-view.tsx:334",
    ],
  },
  {
    id: "rerank.model",
    label: "重排模型",
    sourceFile: "src/stores/wiki-store.ts:215",
    hasDefault: true,
    defaultValue: '""',
    duplicatedIn: [
      "src/lib/project-store.ts:753",
      "src/components/settings/settings-view.tsx:341",
    ],
  },
  {
    id: "multimodal.model",
    label: "多模态视觉模型",
    sourceFile: "src/stores/wiki-store.ts:501",
    hasDefault: true,
    defaultValue: '""',
    duplicatedIn: [
      "src/components/settings/settings-view.tsx:134",
      "src/components/settings/settings-view.tsx:349",
    ],
  },
  {
    id: "modelRoutes.view",
    label: "模型路由视图（modelRoutes）",
    sourceFile: "src/components/novel/model-routes-view.tsx",
    hasDefault: false,
    defaultValue: null,
    duplicatedIn: [
      "src/components/layout/planned-views.ts:36",
      "src/components/layout/workbench-view.tsx:78",
    ],
  },
] as const

/**
 * 明确「不适用」的审计项。
 *
 * 与 `status: "missing"` 的区别：missing = 应该有落点却找不到；不适用 = 语义上
 * 在该配置组合下根本不参与路由（或本 EPIC 明确不交付）。
 */
export const AGENT_STUDIO_NOT_APPLICABLE: readonly AgentStudioNotApplicableItem[] = [
  {
    id: "llm.apiMode.nonCustom",
    label: "apiMode（非 custom 提供方）",
    reason:
      "apiMode 只在 provider === \"custom\" 时参与 wire 协议选择；settings-view 保存时对非 custom 提供方显式写 undefined（src/components/settings/settings-view.tsx:326）。",
  },
  {
    id: "judge.judgePool.singleJudge",
    label: "judgePool（单判官回退）",
    reason:
      "无 judgePool 配置时 resolveJudgePool 回退 [resolveRoleModel(\"judge\")]（单判官现状），此时该设置不参与路由（src/lib/llm/model-resolver.ts:201）。",
  },
  {
    id: "premium.fallbackChains.premiumOff",
    label: "fallbackChains（精品模式关闭）",
    reason:
      "DEFAULT_PREMIUM_CONFIG.fallbackChains 为空对象且 premiumMode 默认 false；关闭时链不参与路由（src/lib/novel/premium-config.ts:119）。",
  },
  {
    id: "novel.consensusModels.consensusOff",
    label: "共识模型组（共识关闭）",
    reason:
      "consensusEnabled 默认 false，共识执行器不启用，consensusReviewModels/consensusWritingModels 不参与路由（src/stores/wiki-store.ts:326）。",
  },
  {
    id: "agentStudio.panelMount",
    label: "代理工作室面板挂载（UI 路由）",
    reason:
      "本 EPIC 只交付只读投影与只读面板，不接入 activeView，也不新增持久化面；modelRoutes 视图仍是计划态占位（src/components/layout/planned-views.ts:36）。",
  },
] as const

// ── 投影 ─────────────────────────────────────────────────────────────────────────

/**
 * 由盘点表 + 文件存在性探针投影出只读设置清单。
 *
 * 纯函数：不做 IO、不写盘、不读 store；同输入必得同输出。
 *
 * 状态判定：
 *   1. `sourceFile` 的路径不在 `probe.existingFiles` → `"missing"`，
 *      并把该路径写入 `missingSources`；
 *   2. 否则 `duplicatedIn` 非空 → `"duplicated"`（重复真源**显式暴露**，不隐藏）；
 *   3. 否则 → `"ok"`。
 *
 * 输出排序：`rows` / `notApplicable` 按 id 码点升序，`duplicatedIn` /
 * `missingSources` / `duplicateRowIds` 按码点升序。
 */
export function projectAgentStudioSettings(
  probe: AgentStudioSourceProbe,
): AgentStudioProjection {
  const existing = new Set(probe.existingFiles.map(normalizePath))
  const rows: AgentStudioSettingRow[] = []
  const missing = new Set<string>()
  const defaultsById: Record<string, string> = {}

  for (const entry of AGENT_STUDIO_SETTING_CATALOG) {
    const path = sourceFilePath(entry.sourceFile)
    const present = existing.has(normalizePath(path))
    const duplicatedIn = sortByCodePoints(entry.duplicatedIn)
    const status: AgentStudioSettingStatus = !present
      ? "missing"
      : duplicatedIn.length > 0
        ? "duplicated"
        : "ok"

    if (!present) missing.add(path)
    if (entry.hasDefault && entry.defaultValue !== null) {
      defaultsById[entry.id] = entry.defaultValue
    }

    rows.push({
      id: entry.id,
      label: entry.label,
      sourceFile: entry.sourceFile,
      hasDefault: entry.hasDefault,
      duplicatedIn,
      status,
    })
  }

  rows.sort((a, b) => compareCodePoints(a.id, b.id))

  const duplicateRowIds = sortByCodePoints(
    rows.filter((row) => row.duplicatedIn.length > 0).map((row) => row.id),
  )
  const notApplicable = [...AGENT_STUDIO_NOT_APPLICABLE].sort((a, b) =>
    compareCodePoints(a.id, b.id),
  )

  return {
    rows,
    missingSources: sortByCodePoints([...missing]),
    duplicateRowIds,
    notApplicable,
    defaultsById,
    totals: {
      total: rows.length,
      ok: rows.filter((row) => row.status === "ok").length,
      duplicated: rows.filter((row) => row.status === "duplicated").length,
      missing: rows.filter((row) => row.status === "missing").length,
    },
  }
}

/**
 * 盘点表里出现的全部真源文件路径（去重 + 码点升序，不含行号）。
 *
 * 供调用方构造 `AgentStudioSourceProbe`（本模块自身不做 IO，存在性由调用方查）。
 * 纯函数。
 */
export function agentStudioSourcePaths(): readonly string[] {
  const paths = new Set<string>()
  for (const entry of AGENT_STUDIO_SETTING_CATALOG) {
    paths.add(normalizePath(sourceFilePath(entry.sourceFile)))
    for (const duplicate of entry.duplicatedIn) {
      paths.add(normalizePath(sourceFilePath(duplicate)))
    }
  }
  return sortByCodePoints([...paths])
}
