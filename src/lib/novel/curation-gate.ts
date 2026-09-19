/**
 * curation-gate.ts — R1-d 策展闸门首版（债分制）。
 *
 * 共识来源：批准计划 r2 §R1-d（planHandoffKey 738a75141a5a6b2386f8b38eef21ef600dedf9461eca4972037b2f0b68f55113）；
 * 输入 = 生成器产物（kb-routing-view.generated.json / REFERENCE-KB-VIEW.json 的条目面）。
 *
 * 计债规则（首版；债分越低越健康，上限 = CURATION_DEBT_CAP）：
 *   - missing_field（+2/条）：8 字段（name/collection/title/lang/domain/query_intent/trust/summary）任一缺失或为空；
 *   - no_provenance（+1/条）：无出处——upstream 为 UNKNOWN/空且无 contentDigest(sha256-)；
 *   - short_summary（+1/条）：summary 短于 50 字（不足以支撑检索消费）；
 *   - theme_vacant（+3/题材）：expectThemes 中题材在 expectCollections 内零命中（题材空置，P0#3 症状）；
 *   - collection_vacant（+3/collection）：expectCollections 中声明的 collection 零条目。
 *
 * 机械层（ADR-19）：纯函数 + zod，零 IO / 零时钟；读产物由调用方（脚本/spec）负责。
 * 生成器管线接入：`Niko Buddy/scripts/check-curation-debt.mjs`（IO 层，exit 0/2/3）+ sync --check 串联。
 *
 * @license MIT © Niko Buddy
 */

import { z } from "zod"

/** 债分上限（首版严格：任何债分即超限）。 */
export const CURATION_DEBT_CAP = 0

/** 债分权重（单一真源；mjs 门禁以字面同步自检防漂移）。 */
export const CURATION_DEBT_WEIGHTS = {
  missing_field: 2,
  no_provenance: 1,
  short_summary: 1,
  theme_vacant: 3,
  collection_vacant: 3,
} as const

export type CurationDebtReason = keyof typeof CURATION_DEBT_WEIGHTS

/** 8 字段契约（缺一即 missing_field）。 */
export const CURATION_REQUIRED_FIELDS = [
  "name",
  "collection",
  "title",
  "lang",
  "domain",
  "query_intent",
  "trust",
  "summary",
] as const

/** summary 最短长度（L1 生成器同口径）。 */
export const CURATION_MIN_SUMMARY_CHARS = 50

/** 条目（strict；缺字段由计债规则外显，故字段全 optional）。 */
export const CURATION_ENTRY_SCHEMA = z
  .object({
    name: z.string().optional(),
    collection: z.string().optional(),
    title: z.string().optional(),
    lang: z.string().optional(),
    era: z.string().optional(),
    domain: z.array(z.string()).optional(),
    query_intent: z.array(z.string()).optional(),
    trust: z.string().optional(),
    summary: z.string().optional(),
    contentDigest: z.string().optional(),
    upstream: z.string().optional(),
    author: z.string().optional(),
    /** 投影面（sync-kb-view-to-niko-buddy.mjs COLLECTION_ENTRY_FIELDS）与 hub 全量面附加字段。 */
    purpose: z.string().optional(),
    category: z.string().optional(),
    license: z.string().optional(),
    adr: z.string().optional(),
    entryHash: z.string().optional(),
    titleSource: z.string().optional(),
  })
  .strict()

export type CurationEntry = z.infer<typeof CURATION_ENTRY_SCHEMA>

/** 批次契约（strict）。 */
export const CURATION_BATCH_SCHEMA = z
  .object({
    schemaVersion: z.literal(1),
    source: z.string().min(1),
    /**
     * 期望题材面（题材空置判据）：每条声明题材 + 必须承载它的 collection 集。
     * collection 粒度而非全局——P0#3 症状正是「world_ref 对修仙题材空置」，
     * 而全局题材覆盖会因 lexicon 命中而假阴性。
     */
    expectThemes: z
      .array(
        z
          .object({
            theme: z.string().min(1),
            collections: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
    /** 期望 collection（collection 空置判据；如 ["world_ref","lexicon","craft","corpus"]）。 */
    expectCollections: z.array(z.string().min(1)),
    entries: z.array(CURATION_ENTRY_SCHEMA),
  })
  .strict()

export type CurationBatch = z.infer<typeof CURATION_BATCH_SCHEMA>

/** 债分发现项。 */
export interface CurationFinding {
  reason: CurationDebtReason
  debt: number
  /** 条目级发现时的条目名；collection/theme 级发现为 undefined。 */
  name?: string
  /** theme/collection 级发现的标的。 */
  target?: string
  detail: string
}

/** 批次评分结果。 */
export interface CurationBatchScore {
  totalDebt: number
  cap: number
  withinCap: boolean
  byReason: Record<CurationDebtReason, number>
  findings: CurationFinding[]
  entryCount: number
}

/** 策展闸门错误（契约非法 / 债分超限，一律 fail-loud）。 */
export class CurationGateError extends Error {
  constructor(message: string) {
    super(`[curation-gate] ${message}`)
    this.name = "CurationGateError"
  }
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === "string") return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * 批次债分评分（纯函数）：条目级（缺字段/无出处/摘要过短）+ 集合级（题材空置/collection 空置）。
 * 输入非法 fail-loud（不静默降级）。
 */
export function scoreCurationBatch(batch: CurationBatch): CurationBatchScore {
  const parsed = CURATION_BATCH_SCHEMA.safeParse(batch)
  if (!parsed.success) {
    throw new CurationGateError(`批次契约非法：${parsed.error.message}`)
  }
  const { entries, expectThemes, expectCollections } = parsed.data
  const findings: CurationFinding[] = []

  for (const entry of entries) {
    const label = entry.name ?? "(未命名条目)"
    const missing = CURATION_REQUIRED_FIELDS.filter((field) => isEmpty(entry[field]))
    if (missing.length > 0) {
      findings.push({
        reason: "missing_field",
        debt: CURATION_DEBT_WEIGHTS.missing_field,
        name: label,
        detail: `缺字段：${missing.join("/")}`,
      })
    }
    const upstream = (entry.upstream ?? "").trim()
    const digest = (entry.contentDigest ?? "").trim()
    if ((upstream.length === 0 || upstream === "UNKNOWN") && !digest.startsWith("sha256-")) {
      findings.push({
        reason: "no_provenance",
        debt: CURATION_DEBT_WEIGHTS.no_provenance,
        name: label,
        detail: "无出处：upstream UNKNOWN/空 且无 contentDigest",
      })
    }
    const summary = (entry.summary ?? "").trim()
    if (summary.length > 0 && summary.length < CURATION_MIN_SUMMARY_CHARS) {
      findings.push({
        reason: "short_summary",
        debt: CURATION_DEBT_WEIGHTS.short_summary,
        name: label,
        detail: `摘要过短：${summary.length} < ${CURATION_MIN_SUMMARY_CHARS}`,
      })
    }
  }

  const collectionOf = (name: string): string => name
  for (const collection of expectCollections) {
    const members = entries.filter((e) => collectionOf(e.collection ?? "") === collection)
    if (members.length === 0) {
      findings.push({
        reason: "collection_vacant",
        debt: CURATION_DEBT_WEIGHTS.collection_vacant,
        target: collection,
        detail: `collection 空置：${collection} 零条目`,
      })
    }
  }

  const scoped = entries.filter(
    (e) => expectCollections.length === 0 || expectCollections.includes(e.collection ?? ""),
  )
  for (const scope of expectThemes) {
    for (const collection of scope.collections) {
      const hit = scoped.some((entry) => {
        if ((entry.collection ?? "") !== collection) return false
        const hay = [
          entry.name ?? "",
          entry.title ?? "",
          (entry.domain ?? []).join(" "),
          entry.summary ?? "",
        ]
          .join(" ")
          .toLowerCase()
        return hay.includes(scope.theme.toLowerCase())
      })
      if (!hit) {
        findings.push({
          reason: "theme_vacant",
          debt: CURATION_DEBT_WEIGHTS.theme_vacant,
          target: `${scope.theme}@${collection}`,
          detail: `题材空置：${scope.theme} 在 ${collection} 内零命中`,
        })
      }
    }
  }

  const byReason = Object.fromEntries(
    (Object.keys(CURATION_DEBT_WEIGHTS) as CurationDebtReason[]).map((reason) => [
      reason,
      findings.filter((f) => f.reason === reason).reduce((sum, f) => sum + f.debt, 0),
    ]),
  ) as Record<CurationDebtReason, number>
  const totalDebt = findings.reduce((sum, f) => sum + f.debt, 0)

  return {
    totalDebt,
    cap: CURATION_DEBT_CAP,
    withinCap: totalDebt <= CURATION_DEBT_CAP,
    byReason,
    findings,
    entryCount: entries.length,
  }
}

/** 债分上限断言（超限 fail-loud；生成器 --check 消费）。 */
export function assertCurationDebtWithinCap(score: CurationBatchScore): void {
  if (!score.withinCap) {
    const detail = score.findings
      .map((f) => `  - [${f.reason}+${f.debt}] ${f.target ?? f.name ?? "-"}：${f.detail}`)
      .join("\n")
    throw new CurationGateError(
      `债分超限：${score.totalDebt} > 上限 ${score.cap}（${score.entryCount} 条）\n${detail}`,
    )
  }
}
