// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * MainControl 应用内只读零 LLM MCP 门面工具集（TASK-005 + Wave 2 技能桥）。
 *
 * 硬边界：
 * - 全部 8 个工具均为 `category: "read"`、`permission: "auto"`，零 LLM 调用、零磁盘写入；
 * - 序列化输出统一封顶 `<= 12000` 字符并附显式截断提示，防爆 Agent 上下文窗口；
 * - 顶层仅使用 `import type`，所有 `@/lib/mcp/*` 与重型模块均在 `execute()` 内按需动态
 *   `await import(...)`（对齐 `outline-generation.ts:876`），杜绝经 `src/lib/novel/index.ts`
 *   形成静态循环依赖或 TDZ。
 */

import type { Tool } from "@/lib/agent/types"
import type { CharacterReadResult, ForeshadowingListResult } from "@/lib/mcp/atomic-read-tools"
import type { MechanicalGateAnyReport, MechanicalGateInput } from "@/lib/mcp/mechanical-gate"
import type { AuditLongformHealthResult } from "@/lib/mcp/phase3-read-tools"
import type { SkillsGetResult, SkillsListResult } from "@/lib/mcp/skills-read-tools"
import type { WorkflowNextResult } from "@/lib/mcp/workflow-draft-tools"
import type { CanonEdgeFilter, CanonEdgeKind, CanonFact } from "./canon-graph-client"
import type { ChapterSnapshot } from "./chapter-ingest"
import type { ProjectionStatusLedger } from "./projection-status-ledger"
import { toErrorMessage } from "@/lib/utils"

export const MAIN_CONTROL_MCP_TOOL_NAMES = [
  "gate_check_mechanical",
  "audit_longform_health",
  "canon_query",
  "foreshadowing_list",
  "character_read",
  "workflow_next",
  "skills_list",
  "skills_get",
] as const

export type MainControlMcpToolName = (typeof MAIN_CONTROL_MCP_TOOL_NAMES)[number]

/** 单次只读门面返回文本上限（字符），超出时截断并附显式提示。 */
export const MAX_MAIN_CONTROL_MCP_OUTPUT_CHARS = 12_000

const READ_ONLY_META = {
  readOnly: true as const,
  llmCalls: 0 as const,
  diskWrites: 0 as const,
}

const VALID_CANON_EDGE_KINDS = new Set<string>([
  "world_fact",
  "motivation",
  "arc",
  "foreshadow",
  "hook",
  "attribute",
])

const AUDIT_LONGFORM_ALLOWED_KEYS = [
  "currentChapter",
  "chapterStart",
  "chapterEnd",
  "volume",
  "sections",
  "topK",
  "includeDetails",
  "emotionBreakerThreshold",
] as const

const FORESHADOWING_LIST_ALLOWED_KEYS = [
  "status",
  "character",
  "currentChapter",
  "includeDebt",
  "debtLevel",
  "offset",
  "limit",
] as const

const CHARACTER_READ_ALLOWED_KEYS = [
  "name",
  "query",
  "aliveOnly",
  "includeAura",
  "includeState",
  "includeRelationships",
  "offset",
  "limit",
] as const

const WORKFLOW_NEXT_ALLOWED_KEYS = [
  "targetChapter",
  "draftId",
] as const

const SKILLS_LIST_ALLOWED_KEYS = [
  "stage",
  "kind",
  "includeDeAi",
  "includeBuiltin",
  "enabledOnly",
  "query",
  "offset",
  "limit",
] as const

const SKILLS_GET_ALLOWED_KEYS = [
  "ids",
  "names",
  "stage",
  "includeDeAi",
  "includeDisabled",
  "stripFrontmatter",
  "maxCharsPerSkill",
  "maxTotalChars",
] as const

export interface MainControlMcpToolDeps {
  runMechanicalGateForMcp: (input: MechanicalGateInput) => Promise<MechanicalGateAnyReport>
  runAuditLongformHealth: (
    projectPath: string,
    params?: Record<string, unknown>,
  ) => Promise<AuditLongformHealthResult>
  runForeshadowingList: (
    projectPath: string,
    params?: Record<string, unknown>,
  ) => Promise<ForeshadowingListResult>
  runCharacterRead: (
    projectPath: string,
    params?: Record<string, unknown>,
  ) => Promise<CharacterReadResult>
  runWorkflowNext: (
    projectPath: string,
    params?: Record<string, unknown>,
  ) => Promise<WorkflowNextResult>
  runSkillsList: (
    projectPath: string,
    params?: Record<string, unknown>,
  ) => Promise<SkillsListResult>
  runSkillsGet: (
    projectPath: string,
    params?: Record<string, unknown>,
  ) => Promise<SkillsGetResult>
  queryCanonEdges: (projectId: string, filter: CanonEdgeFilter) => Promise<CanonFact[]>
  loadAllSnapshots: (projectPath: string) => Promise<ChapterSnapshot[]>
  loadProjectionStatusLedger: (projectPath: string) => Promise<ProjectionStatusLedger | undefined>
  /** 测试覆写：序列化输出字符上限（默认 12000，且始终不超过 12000）。 */
  maxOutputChars?: number
}

function resolveOutputCap(raw?: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.floor(raw), MAX_MAIN_CONTROL_MCP_OUTPUT_CHARS)
  }
  return MAX_MAIN_CONTROL_MCP_OUTPUT_CHARS
}

/** 安全序列化只读门面结果，超过上限时截断并附显式说明。 */
export function formatMainControlMcpOutput(
  value: unknown,
  maxChars = MAX_MAIN_CONTROL_MCP_OUTPUT_CHARS,
): string {
  const cap = resolveOutputCap(maxChars)
  const serialized = JSON.stringify(value, null, 2) ?? String(value)
  if (serialized.length <= cap) {
    return serialized
  }
  const note = `\n...[输出已截断：原始 ${serialized.length} 字符，上限 ${cap} 字符；请缩小过滤条件或分页重试]`
  if (note.length >= cap) {
    return note.slice(0, cap)
  }
  const keep = cap - note.length
  return `${serialized.slice(0, keep)}${note}`
}

function pickDefinedParams(
  params: Record<string, unknown>,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const key of allowedKeys) {
    if (key in params && params[key] !== undefined && params[key] !== null) {
      picked[key] = params[key]
    }
  }
  return picked
}

function asOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function asOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return undefined
  return value
}

function asOptionalNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined
  return value
}

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return items.length > 0 ? items : undefined
}

interface ParsedCanonQueryParams {
  subject?: string
  entityIds?: string[]
  predicates?: string[]
  knownBy?: string
  edgeKinds?: CanonEdgeKind[]
  validAtChapter?: number
  includeInvalidated?: boolean
  archived?: boolean
  limit: number
  offset: number
}

function parseCanonQueryParams(params: Record<string, unknown>): ParsedCanonQueryParams {
  const nestedFilter =
    params.filter && typeof params.filter === "object" && !Array.isArray(params.filter)
      ? (params.filter as Record<string, unknown>)
      : {}

  const subject = asOptionalNonEmptyString(params.subject)
  const rawEntityIds = asOptionalStringArray(nestedFilter.entityIds ?? params.entityIds)
  const entityIds = rawEntityIds ?? (subject ? [subject] : undefined)

  const singlePredicate = asOptionalNonEmptyString(params.predicate)
  const rawPredicates = asOptionalStringArray(nestedFilter.predicates ?? params.predicates)
  const predicates = rawPredicates ?? (singlePredicate ? [singlePredicate] : undefined)

  const knownBy = asOptionalNonEmptyString(nestedFilter.knownBy ?? params.knownBy)

  const rawEdgeKinds = asOptionalStringArray(nestedFilter.edgeKinds ?? params.edgeKinds)
  const edgeKinds = rawEdgeKinds
    ?.filter((k): k is CanonEdgeKind => VALID_CANON_EDGE_KINDS.has(k))

  const validAtChapter = asOptionalPositiveInt(
    nestedFilter.validAtChapter ?? params.validAtChapter ?? params.chapterNumber,
  )

  const includeInvalidatedVal = nestedFilter.includeInvalidated ?? params.includeInvalidated
  const includeInvalidated = typeof includeInvalidatedVal === "boolean" ? includeInvalidatedVal : undefined

  const archivedVal = nestedFilter.archived ?? params.archived
  const archived = typeof archivedVal === "boolean" ? archivedVal : undefined

  const rawLimit = asOptionalPositiveInt(nestedFilter.limit ?? params.limit) ?? 50
  const limit = Math.min(rawLimit, 200)
  const offset = asOptionalNonNegativeInt(nestedFilter.offset ?? params.offset) ?? 0

  return {
    subject,
    entityIds,
    predicates,
    knownBy,
    edgeKinds: edgeKinds && edgeKinds.length > 0 ? edgeKinds : undefined,
    validAtChapter,
    includeInvalidated,
    archived,
    limit,
    offset,
  }
}

export function createMainControlMcpTools(
  projectPath: string,
  deps?: Partial<MainControlMcpToolDeps>,
): Tool[] {
  const maxOutputChars = resolveOutputCap(deps?.maxOutputChars)

  const gateCheckMechanicalTool: Tool = {
    name: "gate_check_mechanical",
    description:
      "只读零 LLM 机械门控预检（对应 MCP gate.check_mechanical）：对章节草稿正文执行 P0 确定性连续性/书规检查与 P1 去 AI 味/字数指标检查，不修改磁盘。",
    category: "read",
    permission: "auto",
    parameters: {
      text: { type: "string", description: "待检测的章节正文或草稿文本", required: true },
      chapterNumber: { type: "integer", description: "可选章号（>= 1）；传入后启用 P0 确定性连续性预检" },
      genre: { type: "string", description: "可选题材标识（缺省使用项目默认题材）" },
      targetChars: { type: "integer", description: "可选单章目标字数（缺省使用项目默认字数）" },
      detailLevel: {
        type: "string",
        description: "报告详略度：compact（默认，精简高信号）或 full（完整明细）",
        enum: ["compact", "full"],
      },
    },
    execute: async (params) => {
      try {
        const text = typeof params.text === "string" ? params.text : ""
        if (!text.trim()) {
          return "错误：gate_check_mechanical 需要非空的 text 参数"
        }
        const runGate = deps?.runMechanicalGateForMcp
          ?? (await import("@/lib/mcp/mechanical-gate")).runMechanicalGateForMcp
        const input: MechanicalGateInput = {
          projectPath,
          text,
          detailLevel: params.detailLevel === "full" ? "full" : "compact",
          ...(asOptionalPositiveInt(params.chapterNumber) !== undefined
            ? { chapterNumber: asOptionalPositiveInt(params.chapterNumber) }
            : {}),
          ...(asOptionalNonEmptyString(params.genre)
            ? { genre: asOptionalNonEmptyString(params.genre) }
            : {}),
          ...(asOptionalPositiveInt(params.targetChars) !== undefined
            ? { targetChars: asOptionalPositiveInt(params.targetChars) }
            : {}),
        }
        const report = await runGate(input)
        return formatMainControlMcpOutput(report, maxOutputChars)
      } catch (err) {
        return `错误：gate_check_mechanical 执行失败 - ${toErrorMessage(err)}`
      }
    },
  }

  const auditLongformHealthTool: Tool = {
    name: "audit_longform_health",
    description:
      "只读零 LLM 长篇健康审计（对应 MCP audit.longform_health）：跨伏笔债务、追更欠账、情绪熔断、积压草稿与正典连续性风险给出全局体检，不修改磁盘。",
    category: "read",
    permission: "auto",
    parameters: {
      currentChapter: { type: "integer", description: "可选基线当前章号（>= 1）" },
      chapterStart: { type: "integer", description: "可选审计起始章号（与 volume 互斥）" },
      chapterEnd: { type: "integer", description: "可选审计结束章号（与 volume 互斥）" },
      volume: { type: "integer", description: "可选卷号（与 chapterStart/chapterEnd 互斥）" },
      sections: { type: "array", description: "可选审计子项数组（foreshadowing/chaseDebt/emotion/drafts/canonRisk）" },
      topK: { type: "integer", description: "每项返回的最大条数（1-50，默认 10）" },
      includeDetails: { type: "boolean", description: "是否包含详细明细（默认 false）" },
      emotionBreakerThreshold: { type: "number", description: "情绪熔断阈值（-10 到 0）" },
    },
    execute: async (params) => {
      try {
        const runAudit = deps?.runAuditLongformHealth
          ?? (await import("@/lib/mcp/phase3-read-tools")).runAuditLongformHealth
        const cleanParams = pickDefinedParams(params, AUDIT_LONGFORM_ALLOWED_KEYS)
        const report = await runAudit(projectPath, cleanParams)
        return formatMainControlMcpOutput(report, maxOutputChars)
      } catch (err) {
        return `错误：audit_longform_health 执行失败 - ${toErrorMessage(err)}`
      }
    },
  }

  const canonQueryTool: Tool = {
    name: "canon_query",
    description:
      "只读零 LLM 正典事实查询（对应 MCP canon.query）：优先查询 Canon 图边，图不可用或为空时确定性回退已提交章节快照折叠（factsFromCommittedSnapshots + queryFactsAt），不修改磁盘。",
    category: "read",
    permission: "auto",
    parameters: {
      subject: { type: "string", description: "按主体/角色名过滤事实" },
      validAtChapter: { type: "integer", description: "世界时态截点章号（>= 1），仅返回该章仍有效的事实" },
      predicate: { type: "string", description: "按单个谓词过滤（如 持有/位于/状态）" },
      predicates: { type: "array", description: "按谓词数组过滤" },
      entityIds: { type: "array", description: "按实体/角色名数组过滤" },
      knownBy: { type: "string", description: "按 POV 认知轴角色过滤（Canon 图可用时生效）" },
      edgeKinds: { type: "array", description: "按边类别过滤（world_fact/motivation/arc/foreshadow/hook/attribute）" },
      includeInvalidated: { type: "boolean", description: "是否包含已失效的曾成立事实" },
      limit: { type: "integer", description: "返回条数上限（1-200，默认 50）" },
      offset: { type: "integer", description: "分页偏移（>= 0，默认 0）" },
      filter: { type: "object", description: "可选：兼容 MCP canon.query 的嵌套 filter 对象" },
    },
    execute: async (params) => {
      try {
        const parsed = parseCanonQueryParams(params)
        const { buildCanonEdgeFilter, queryCanonEdges: defaultQueryCanonEdges } = await import(
          "./canon-graph-client"
        )
        const queryEdges = deps?.queryCanonEdges ?? defaultQueryCanonEdges
        const filter = buildCanonEdgeFilter({
          entityIds: parsed.entityIds,
          predicates: parsed.predicates,
          knownBy: parsed.knownBy,
          edgeKinds: parsed.edgeKinds,
          validAtChapter: parsed.validAtChapter,
          includeInvalidated: parsed.includeInvalidated,
          archived: parsed.archived,
          limit: parsed.limit,
          offset: parsed.offset,
        })

        let canonError: string | undefined
        let canonFacts: CanonFact[] = []
        try {
          canonFacts = await queryEdges(projectPath, filter)
        } catch (err) {
          canonError = toErrorMessage(err)
        }

        if (canonFacts.length > 0) {
          return formatMainControlMcpOutput(
            {
              source: "canon_graph",
              total: canonFacts.length,
              returned: canonFacts.length,
              facts: canonFacts,
              meta: READ_ONLY_META,
            },
            maxOutputChars,
          )
        }

        // POV 认知隔离红线：指定 knownBy 时绝不回退全知快照，防止泄漏角色不知情的世界事实。
        if (parsed.knownBy) {
          if (canonError === undefined) {
            return formatMainControlMcpOutput(
              {
                source: "canon_graph",
                total: 0,
                returned: 0,
                facts: [],
                query: {
                  knownBy: parsed.knownBy,
                  validAtChapter: parsed.validAtChapter ?? null,
                  subject: parsed.subject ?? null,
                  predicates: parsed.predicates ?? [],
                  offset: parsed.offset,
                  limit: parsed.limit,
                },
                meta: READ_ONLY_META,
              },
              maxOutputChars,
            )
          }
          return formatMainControlMcpOutput(
            {
              source: "canon_graph_unavailable",
              canonGraphError: canonError,
              total: 0,
              returned: 0,
              facts: [],
              notes: [
                `POV isolation: cannot apply knownBy filter ("${parsed.knownBy}") without synced Canon graph; refusing omniscient snapshot fallback.`,
              ],
              query: {
                knownBy: parsed.knownBy,
                validAtChapter: parsed.validAtChapter ?? null,
                subject: parsed.subject ?? null,
                predicates: parsed.predicates ?? [],
                offset: parsed.offset,
                limit: parsed.limit,
              },
              meta: READ_ONLY_META,
            },
            maxOutputChars,
          )
        }

        // 确定性快照回退：Canon 图未就绪或为空（且未请求 knownBy POV 过滤）时，折叠已提交章节快照并用 queryFactsAt 过滤。
        const [
          { factsFromCommittedSnapshots, queryFactsAt },
          snapshots,
          ledger,
        ] = await Promise.all([
          import("./temporal-memory"),
          deps?.loadAllSnapshots
            ? deps.loadAllSnapshots(projectPath)
            : import("./context-engine-temporal").then((m) => m.loadAllSnapshots(projectPath)),
          deps?.loadProjectionStatusLedger
            ? deps.loadProjectionStatusLedger(projectPath).catch(() => undefined)
            : import("./projection-status-ledger")
                .then((m) => m.loadProjectionStatusLedger(projectPath))
                .catch(() => undefined),
        ])

        const allFacts = factsFromCommittedSnapshots(snapshots, ledger)
        const maxChapter = allFacts.reduce((max, fact) => Math.max(max, fact.validFrom), 0)
        const queryChapter = parsed.validAtChapter ?? Math.max(maxChapter, 1)
        const singleSubject =
          parsed.subject ?? (parsed.entityIds?.length === 1 ? parsed.entityIds[0] : undefined)

        let matched = queryFactsAt(queryChapter, singleSubject, allFacts)

        // parseCanonFact 对无分隔符的自由句会退化为整句作 subject；精确匹配未命中时
        // 再对同一时态窗口做一次确定性包含匹配，避免漏召回合法快照事实。
        if (singleSubject && matched.length === 0) {
          const needle = singleSubject.toLowerCase()
          matched = queryFactsAt(queryChapter, undefined, allFacts).filter(
            (fact) =>
              fact.subject.toLowerCase().includes(needle)
              || fact.object.toLowerCase().includes(needle),
          )
        }

        if (!singleSubject && parsed.entityIds && parsed.entityIds.length > 0) {
          const entitySet = new Set(parsed.entityIds.map((e) => e.toLowerCase()))
          matched = matched.filter(
            (fact) =>
              entitySet.has(fact.subject.trim().toLowerCase())
              || entitySet.has(fact.object.trim().toLowerCase()),
          )
        }

        if (parsed.predicates && parsed.predicates.length > 0) {
          const predicateSet = new Set(parsed.predicates.map((p) => p.toLowerCase()))
          matched = matched.filter(
            (fact) =>
              predicateSet.has(fact.predicate.trim().toLowerCase())
              || [...predicateSet].some((p) => fact.object.toLowerCase().includes(p)),
          )
        }

        const page = matched.slice(parsed.offset, parsed.offset + parsed.limit)
        const fallbackNotes: string[] = []
        if (parsed.edgeKinds && parsed.edgeKinds.length > 0) {
          fallbackNotes.push("快照回退模式不支持 edgeKinds 过滤，已返回全部匹配正典事实")
        }

        return formatMainControlMcpOutput(
          {
            source: "committed_snapshots_fallback",
            ...(canonError ? { canonGraphError: canonError } : {}),
            ...(fallbackNotes.length > 0 ? { notes: fallbackNotes } : {}),
            query: {
              validAtChapter: parsed.validAtChapter ?? null,
              subject: singleSubject ?? null,
              predicates: parsed.predicates ?? [],
              offset: parsed.offset,
              limit: parsed.limit,
            },
            total: matched.length,
            returned: page.length,
            hasMore: parsed.offset + page.length < matched.length,
            facts: page,
            meta: READ_ONLY_META,
          },
          maxOutputChars,
        )
      } catch (err) {
        return `错误：canon_query 执行失败 - ${toErrorMessage(err)}`
      }
    },
  }

  const foreshadowingListTool: Tool = {
    name: "foreshadowing_list",
    description:
      "只读零 LLM 伏笔列表与债务查询（对应 MCP foreshadowing.list）：按状态、角色与债务等级检索伏笔条目，不修改磁盘。",
    category: "read",
    permission: "auto",
    parameters: {
      status: {
        type: "string",
        description: "伏笔状态过滤（默认 all）",
        enum: ["all", "active", "planted", "advanced", "resolved", "abandoned", "overdue"],
      },
      character: { type: "string", description: "按关联角色名过滤" },
      currentChapter: { type: "integer", description: "可选当前章号（用于计算逾期债务）" },
      includeDebt: { type: "boolean", description: "是否附带伏笔债务分析报告" },
      debtLevel: {
        type: "string",
        description: "按债务等级过滤",
        enum: ["critical", "warning", "normal"],
      },
      offset: { type: "integer", description: "分页偏移（默认 0）" },
      limit: { type: "integer", description: "每页条数（1-200，默认 50）" },
    },
    execute: async (params) => {
      try {
        const runList = deps?.runForeshadowingList
          ?? (await import("@/lib/mcp/atomic-read-tools")).runForeshadowingList
        const cleanParams = pickDefinedParams(params, FORESHADOWING_LIST_ALLOWED_KEYS)
        const result = await runList(projectPath, cleanParams)
        return formatMainControlMcpOutput(result, maxOutputChars)
      } catch (err) {
        return `错误：foreshadowing_list 执行失败 - ${toErrorMessage(err)}`
      }
    },
  }

  const characterReadTool: Tool = {
    name: "character_read",
    description:
      "只读零 LLM 角色状态与灵魂查询（对应 MCP character.read）：读取角色动态状态投影、关系网、灵魂绑定与人物设定卡，不修改磁盘。",
    category: "read",
    permission: "auto",
    parameters: {
      name: { type: "string", description: "精确角色名（查询单人详档）" },
      query: { type: "string", description: "按名称/别名/简介关键词筛选" },
      aliveOnly: { type: "boolean", description: "是否仅返回存活角色" },
      includeAura: { type: "boolean", description: "是否包含角色灵魂/气场设定" },
      includeState: { type: "boolean", description: "是否包含角色动态状态投影（默认 true）" },
      includeRelationships: { type: "boolean", description: "是否包含角色关系网（默认 true）" },
      offset: { type: "integer", description: "分页偏移（默认 0）" },
      limit: { type: "integer", description: "每页条数（1-200，默认 50）" },
    },
    execute: async (params) => {
      try {
        const runRead = deps?.runCharacterRead
          ?? (await import("@/lib/mcp/atomic-read-tools")).runCharacterRead
        const cleanParams = pickDefinedParams(params, CHARACTER_READ_ALLOWED_KEYS)
        const result = await runRead(projectPath, cleanParams)
        return formatMainControlMcpOutput(result, maxOutputChars)
      } catch (err) {
        return `错误：character_read 执行失败 - ${toErrorMessage(err)}`
      }
    },
  }

  const workflowNextTool: Tool = {
    name: "workflow_next",
    description:
      "只读零 LLM 工作流下一步路由（对应 MCP workflow.next）：结合项目状态、草稿区、导演管线与控制内核给出下一步建议动作，不修改磁盘。",
    category: "read",
    permission: "auto",
    parameters: {
      targetChapter: { type: "integer", description: "可选目标章号（>= 1）" },
      draftId: { type: "string", description: "可选指定待审草稿 ID" },
    },
    execute: async (params) => {
      try {
        const runNext = deps?.runWorkflowNext
          ?? (await import("@/lib/mcp/workflow-draft-tools")).runWorkflowNext
        const cleanParams = pickDefinedParams(params, WORKFLOW_NEXT_ALLOWED_KEYS)
        const result = await runNext(projectPath, cleanParams)
        return formatMainControlMcpOutput(result, maxOutputChars)
      } catch (err) {
        return `错误：workflow_next 执行失败 - ${toErrorMessage(err)}`
      }
    },
  }

  const skillsListTool: Tool = {
    name: "skills_list",
    description:
      "只读零 LLM 技能目录浏览（对应 MCP skills.list）：按阶段、类别、启用状态与关键词检索内置写作技能、项目技能与去 AI 味技能的轻量目录（不含正文），不修改磁盘。",
    category: "read",
    permission: "auto",
    parameters: {
      stage: {
        type: "string",
        description: "按写作阶段或任务键过滤（planning/drafting/review/rewrite/output/outline/writing/summary/extract）",
        enum: ["planning", "drafting", "review", "rewrite", "output", "outline", "writing", "summary", "extract"],
      },
      kind: {
        type: "string",
        description: "技能库类别过滤（writing/de_ai/all，默认 all）",
        enum: ["writing", "de_ai", "all"],
      },
      includeDeAi: { type: "boolean", description: "是否包含去 AI 味技能（默认 true）" },
      includeBuiltin: { type: "boolean", description: "是否包含内置技能（默认 true）" },
      enabledOnly: { type: "boolean", description: "是否仅返回已启用技能（默认 false）" },
      query: { type: "string", description: "按 ID、名称、描述或标签关键词筛选" },
      offset: { type: "integer", description: "分页偏移（默认 0）" },
      limit: { type: "integer", description: "每页条数（1-200，默认 50）" },
    },
    execute: async (params) => {
      try {
        const runList = deps?.runSkillsList
          ?? (await import("@/lib/mcp/skills-read-tools")).runSkillsList
        const cleanParams = pickDefinedParams(params, SKILLS_LIST_ALLOWED_KEYS)
        const result = await runList(projectPath, cleanParams)
        return formatMainControlMcpOutput(result, maxOutputChars)
      } catch (err) {
        return `错误：skills_list 执行失败 - ${toErrorMessage(err)}`
      }
    },
  }

  const skillsGetTool: Tool = {
    name: "skills_get",
    description:
      "只读零 LLM 技能正文按需读取（对应 MCP skills.get）：按 ids、names 或 stage 水合指定技能正文（默认剥离 YAML frontmatter 并按预算截断），不修改磁盘。",
    category: "read",
    permission: "auto",
    parameters: {
      ids: { type: "array", description: "按技能 ID 列表精确获取（1-20 项）" },
      names: { type: "array", description: "按技能名称或路由别名获取（1-20 项）" },
      stage: {
        type: "string",
        description: "按阶段批量获取（planning/drafting/review/rewrite/output/outline/writing/summary/extract）",
        enum: ["planning", "drafting", "review", "rewrite", "output", "outline", "writing", "summary", "extract"],
      },
      includeDeAi: { type: "boolean", description: "是否包含去 AI 味技能池（默认 true）" },
      includeDisabled: { type: "boolean", description: "是否允许返回已禁用技能（默认 false）" },
      stripFrontmatter: { type: "boolean", description: "是否剥离 YAML frontmatter（默认 true）" },
      maxCharsPerSkill: { type: "integer", description: "单条技能正文字符上限（200-20000，默认 6000）" },
      maxTotalChars: { type: "integer", description: "本次返回技能正文总字符上限（500-30000，默认 18000）" },
    },
    execute: async (params) => {
      try {
        const runGet = deps?.runSkillsGet
          ?? (await import("@/lib/mcp/skills-read-tools")).runSkillsGet
        const cleanParams = pickDefinedParams(params, SKILLS_GET_ALLOWED_KEYS)
        const result = await runGet(projectPath, cleanParams)
        return formatMainControlMcpOutput(result, maxOutputChars)
      } catch (err) {
        return `错误：skills_get 执行失败 - ${toErrorMessage(err)}`
      }
    },
  }

  return [
    gateCheckMechanicalTool,
    auditLongformHealthTool,
    canonQueryTool,
    foreshadowingListTool,
    characterReadTool,
    workflowNextTool,
    skillsListTool,
    skillsGetTool,
  ]
}
