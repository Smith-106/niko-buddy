/**
 * ChapterStructurePlan — runtime thril-pacing structure plan (medium redesign).
 *
 * Distinct from Scene[] inventory (scene-breakdown.ts): this encodes ordered
 * pressure→release beats, agency pivots, end-hook, and FIX-1 non-spoiler for
 * structure-first rewrite. Pure module: no I/O.
 *
 * Source: L9 arch swarm medium redesign 20260811 + analyze 20260812.
 */

import {
  THRILL_CHECKPOINT_LABELS,
  THRILL_CHECKPOINT_ORDER,
  type ThrillCheckpointId,
} from "./outline-thrill-checkpoints"

export type StructureBeatPurpose =
  | "opening_pressure"
  | "pressure_escalation"
  | "agency_turn"
  | "release"
  | "end_hook"
  | "other"

export interface StructureBeat {
  id: string
  label: string
  purpose: StructureBeatPurpose
  /** Optional free-text pressure / cost note for the beat. */
  pressure?: string
  /** Optional protagonist agency note. */
  agency?: string
  /** Optional forward hook for the next beat/chapter. */
  hook?: string
  /** Soft link to outline thril checkpoint taxonomy (validation only). */
  thrilCheckpointId?: ThrillCheckpointId
}

export type ChapterStructurePlanSource = "manual" | "llm" | "campaign"

export interface ChapterStructurePlan {
  schemaVersion: "chapter-structure-plan/1.0"
  chapterNumber?: number
  beats: StructureBeat[]
  /** Soft target length; structure-first residual rewrites should preserve length. */
  lengthBudgetChars?: number
  /** Which thril checkpoints this plan claims to cover. */
  thrilCheckpointCoverage: ThrillCheckpointId[]
  /** Always true for literary plans — mechanism/Offer spoilers forbidden. */
  fix1NonSpoiler: true
  source: ChapterStructurePlanSource
  notes?: string[]
}

export interface StructurePlanValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
}

const END_HOOK_PURPOSES: StructureBeatPurpose[] = ["end_hook"]

export function createEmptyChapterStructurePlan(
  overrides: Partial<ChapterStructurePlan> = {},
): ChapterStructurePlan {
  return {
    schemaVersion: "chapter-structure-plan/1.0",
    chapterNumber: overrides.chapterNumber,
    beats: overrides.beats ?? [],
    lengthBudgetChars: overrides.lengthBudgetChars,
    thrilCheckpointCoverage:
      overrides.thrilCheckpointCoverage ?? [...THRILL_CHECKPOINT_ORDER],
    fix1NonSpoiler: true,
    source: overrides.source ?? "manual",
    notes: overrides.notes,
  }
}

export type ResidualDimMediansInput = Partial<
  Record<"thrill" | "pacing" | "character" | "pull" | "consistency" | "continuity", number>
>

export type StructureEmphasis = "thril" | "pacing_safe" | "balanced"

export interface DimAwarePlanOptions {
  chapterNumber?: number
  /** Optional truepack dim medians; weakest dim selects emphasis. */
  dimMedians?: ResidualDimMediansInput
}

function baseDefaultBeats(): StructureBeat[] {
  return [
    {
      id: "beat-1",
      label: "开篇压迫",
      purpose: "opening_pressure",
      thrilCheckpointId: "crisis_info_early",
      pressure: "前 40% 内给出可感危机/代价，非纯说明",
    },
    {
      id: "beat-2",
      label: "压抑链",
      purpose: "pressure_escalation",
      thrilCheckpointId: "pressure_release",
      pressure: "至少一条可指认的压抑→升级链条",
    },
    {
      id: "beat-3",
      label: "能动转折",
      purpose: "agency_turn",
      thrilCheckpointId: "protagonist_agency",
      agency: "主角选择推动局面，非纯旁观",
    },
    {
      id: "beat-4",
      label: "释放与代价",
      purpose: "release",
      thrilCheckpointId: "pressure_release",
    },
    {
      id: "beat-5",
      label: "章末钩",
      purpose: "end_hook",
      thrilCheckpointId: "chapter_end_hook",
      hook: "下一阶段具体期待；不提前揭 Offer/机制名",
    },
  ]
}

/**
 * Dim-aware structure thril-pacing plan (roadmap M1).
 * - thrill weakest → agency/opening-pressure emphasis (Ch2 style)
 * - pacing weakest → pacing-safe: single escalation chain, light end-hook
 *   stacking (Ch5 lesson: extra window/countdown stakes hurt pacing)
 * - otherwise balanced default template
 */
export function createDimAwareStructureThrilPacingPlan(
  options: DimAwarePlanOptions = {},
): ChapterStructurePlan {
  const dims = options.dimMedians ?? {}
  const entries: Array<[string, number]> = Object.entries(dims).filter(
    ([, v]) => typeof v === "number" && Number.isFinite(v),
  ) as Array<[string, number]>

  let emphasis: StructureEmphasis = "balanced"
  if (entries.length > 0) {
    entries.sort((a, b) => a[1] - b[1])
    const weakest = entries[0][0]
    if (weakest === "thrill") emphasis = "thril"
    else if (weakest === "pacing") emphasis = "pacing_safe"
  } else {
    // chapter fallback heuristics from live residual matrix
    const ch = options.chapterNumber
    if (ch === 2) emphasis = "thril"
    else if (ch === 5 || ch === 1 || ch === 3) emphasis = "pacing_safe"
  }

  const beats: StructureBeat[] =
    emphasis === "pacing_safe"
      ? [
          {
            id: "beat-1",
            label: "开篇压迫（克制）",
            purpose: "opening_pressure",
            thrilCheckpointId: "crisis_info_early",
            pressure: "前 40% 内给出可感危机/代价，但不堆叠倒计时/窗口类悬念",
          },
          {
            id: "beat-2",
            label: "单一压抑链",
            purpose: "pressure_escalation",
            thrilCheckpointId: "pressure_release",
            pressure: "只保留一条主压抑→升级链条；新增 stakes 须替换旧 stakes，防 pacing 回落",
          },
          {
            id: "beat-3",
            label: "能动转折",
            purpose: "agency_turn",
            thrilCheckpointId: "protagonist_agency",
            agency: "主角选择推动局面，非纯旁观；选择代价当场可见",
          },
          {
            id: "beat-4",
            label: "释放与代价",
            purpose: "release",
            thrilCheckpointId: "pressure_release",
          },
          {
            id: "beat-5",
            label: "章末钩（轻）",
            purpose: "end_hook",
            thrilCheckpointId: "chapter_end_hook",
            hook: "下一阶段具体期待；不提前揭 Offer/机制名；不新开大窗口悬念",
          },
        ]
      : emphasis === "thril"
        ? [
            {
              id: "beat-1",
              label: "开篇即压",
              purpose: "opening_pressure",
              thrilCheckpointId: "crisis_info_early",
              pressure: "开场直接压上可见代价/死亡风险，不用长说明",
            },
            {
              id: "beat-2",
              label: "代价升级",
              purpose: "pressure_escalation",
              thrilCheckpointId: "pressure_release",
              pressure: "代价以主角在意之物为单位升级",
            },
            {
              id: "beat-3",
              label: "主动下注",
              purpose: "agency_turn",
              thrilCheckpointId: "protagonist_agency",
              agency: "主角主动押注/自担风险，造成局面反转",
            },
            {
              id: "beat-4",
              label: "反转代价",
              purpose: "release",
              thrilCheckpointId: "pressure_release",
            },
            {
              id: "beat-5",
              label: "章末钩",
              purpose: "end_hook",
              thrilCheckpointId: "chapter_end_hook",
              hook: "下一轮风险具体点名；不提前揭 Offer/机制名",
            },
          ]
        : baseDefaultBeats()

  return createEmptyChapterStructurePlan({
    chapterNumber: options.chapterNumber,
    source: "campaign",
    thrilCheckpointCoverage: [...THRILL_CHECKPOINT_ORDER],
    beats,
    notes: [
      `structure_thril_pacing dim-aware emphasis=${emphasis}; length-preserving residual rewrite`,
    ],
  })
}

/**
 * Minimal Ch6-style length-preserving structure thril-pacing template.
 * Campaign waves used opening pressure → agency → end hook proportions.
 * Kept for compat; dim-aware factory (M1) is preferred for residual campaigns.
 */
export function createDefaultStructureThrilPacingPlan(
  chapterNumber?: number,
): ChapterStructurePlan {
  return createDimAwareStructureThrilPacingPlan({ chapterNumber })
}

export function validateChapterStructurePlan(
  plan: ChapterStructurePlan | null | undefined,
): StructurePlanValidation {
  const errors: string[] = []
  const warnings: string[] = []

  if (!plan) {
    return { ok: false, errors: ["plan is null/undefined"], warnings }
  }
  if (plan.schemaVersion !== "chapter-structure-plan/1.0") {
    errors.push(`unsupported schemaVersion: ${String(plan.schemaVersion)}`)
  }
  if (plan.fix1NonSpoiler !== true) {
    errors.push("fix1NonSpoiler must be true")
  }
  if (!Array.isArray(plan.beats) || plan.beats.length === 0) {
    errors.push("beats must be a non-empty array")
  } else {
    const hasEndHook = plan.beats.some((b) => END_HOOK_PURPOSES.includes(b.purpose))
    if (!hasEndHook) {
      errors.push("beats must include at least one end_hook purpose")
    }
    for (const beat of plan.beats) {
      if (!beat?.id?.trim()) errors.push("each beat requires non-empty id")
      if (!beat?.label?.trim()) errors.push(`beat ${beat?.id ?? "?"} requires label`)
      if (beat?.thrilCheckpointId && !(beat.thrilCheckpointId in THRILL_CHECKPOINT_LABELS)) {
        errors.push(`unknown thrilCheckpointId on beat ${beat.id}`)
      }
    }
  }

  const coverage = plan.thrilCheckpointCoverage ?? []
  if (!coverage.includes("fix1_no_conflict")) {
    warnings.push("thrilCheckpointCoverage omits fix1_no_conflict")
  }
  if (!coverage.includes("chapter_end_hook")) {
    warnings.push("thrilCheckpointCoverage omits chapter_end_hook")
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** Prompt block for task_brief / residual rewrite injection. */
export function buildStructurePlanPromptBlock(
  plan: ChapterStructurePlan,
): string {
  const v = validateChapterStructurePlan(plan)
  if (!v.ok) {
    return [
      "【ChapterStructurePlan — 无效】",
      ...v.errors.map((e) => `- ${e}`),
    ].join("\n")
  }

  const lines: string[] = [
    "【ChapterStructurePlan — structure-first thril-pacing】",
    plan.chapterNumber != null ? `- 章节：${plan.chapterNumber}` : "- 章节：（未指定）",
    plan.lengthBudgetChars != null
      ? `- 长度预算：约 ${plan.lengthBudgetChars} 字（优先保长，禁止 short-compress 当主杠杆）`
      : "- 长度：优先保长（structure thril-pacing，非 short-compress）",
    "- FIX-1：禁止 Offer/最终存活者/机制名提前揭穿（fix1NonSpoiler=true）",
    "- 节拍（按序执行，非 densify 堆料）：",
  ]

  for (const beat of plan.beats) {
    const thril =
      beat.thrilCheckpointId != null
        ? ` [thril:${beat.thrilCheckpointId}]`
        : ""
    lines.push(`  ${beat.id}. ${beat.label} (${beat.purpose})${thril}`)
    if (beat.pressure?.trim()) lines.push(`     压迫：${beat.pressure.trim()}`)
    if (beat.agency?.trim()) lines.push(`     能动：${beat.agency.trim()}`)
    if (beat.hook?.trim()) lines.push(`     钩：${beat.hook.trim()}`)
  }

  if (plan.thrilCheckpointCoverage?.length) {
    lines.push("- thril 覆盖：" + plan.thrilCheckpointCoverage.join(", "))
  }
  for (const n of plan.notes ?? []) {
    if (n?.trim()) lines.push(`- 注：${n.trim()}`)
  }

  return lines.join("\n")
}
