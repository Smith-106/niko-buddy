/**
 * Track B skill hooks (mid-loop) — NovelForge-shaped hang points, not a migration.
 *
 * Deep-chapter stays the sole generation stage machine. Skills may attach as
 * optional prompt/context transformers at named stages. Default registry is empty
 * (no behavior change). Product hard gates never come from skill scores.
 *
 * ADR: .workflow/harvest-staging/adr-skill-hooks-track-b-20260809.md
 */
export const NOVEL_SKILL_HOOKS_SCHEMA = "novel-skill-hooks/1.0" as const

/**
 * Stages mirror deep-chapter lifecycle (hang points only).
 * Do not invent parallel generation engines.
 */
export type NovelSkillStage =
  | "pre_outline_soft_gate"
  | "pre_write_prompt"
  | "post_draft_light_check"
  | "pre_six_dim_review"
  | "post_gate_literary_polish"

export interface NovelSkillContext {
  projectPath: string
  chapterNumber?: number
  stage: NovelSkillStage
  /** Mutable bag — skills may add promptFragments / notes only. */
  bag: {
    promptFragments: string[]
    notes: string[]
  }
}

export interface NovelSkillHook {
  id: string
  /** Human label */
  title: string
  stages: NovelSkillStage[]
  /** Track B only — must not claim Track A authority */
  track: "B"
  enabled?: boolean
  /**
   * Pure-ish transform: append fragments/notes. Must not throw into hard fail.
   * Async allowed for future loaders; default hooks are sync-compatible.
   */
  run: (ctx: NovelSkillContext) => void | Promise<void>
}

export interface NovelSkillHookRegistry {
  schemaVersion: typeof NOVEL_SKILL_HOOKS_SCHEMA
  hooks: NovelSkillHook[]
}

const defaultRegistry: NovelSkillHookRegistry = {
  schemaVersion: NOVEL_SKILL_HOOKS_SCHEMA,
  hooks: [],
}

let activeRegistry: NovelSkillHookRegistry = defaultRegistry

export function getNovelSkillHookRegistry(): NovelSkillHookRegistry {
  return activeRegistry
}

/** Test / app bootstrap: replace registry (immutable-friendly copy). */
export function setNovelSkillHookRegistry(registry: NovelSkillHookRegistry | null): void {
  activeRegistry = registry ?? defaultRegistry
}

export function registerNovelSkillHook(hook: NovelSkillHook): void {
  if (hook.track !== "B") {
    throw new Error("novel skill hooks must be Track B only")
  }
  const hooks = activeRegistry.hooks.filter((h) => h.id !== hook.id)
  activeRegistry = {
    schemaVersion: NOVEL_SKILL_HOOKS_SCHEMA,
    hooks: [...hooks, hook],
  }
}

export function listNovelSkillHooksForStage(stage: NovelSkillStage): NovelSkillHook[] {
  return activeRegistry.hooks.filter((h) => h.enabled !== false && h.stages.includes(stage))
}

/**
 * Run all enabled hooks for a stage. Failures are isolated (soft).
 */
export async function runNovelSkillHooks(
  stage: NovelSkillStage,
  input: Omit<NovelSkillContext, "stage" | "bag"> & { bag?: NovelSkillContext["bag"] },
): Promise<NovelSkillContext> {
  const ctx: NovelSkillContext = {
    projectPath: input.projectPath,
    chapterNumber: input.chapterNumber,
    stage,
    bag: input.bag ?? { promptFragments: [], notes: [] },
  }
  for (const hook of listNovelSkillHooksForStage(stage)) {
    try {
      await hook.run(ctx)
    } catch (error) {
      ctx.bag.notes.push(
        `skill-hook ${hook.id} failed soft: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return ctx
}

/** Built-in optional hook: inject gold-scale readiness note at pre_six_dim_review. */
export function createGoldScaleReadinessHook(promptHint: string): NovelSkillHook {
  return {
    id: "builtin.gold-scale-readiness",
    title: "Gold scale readiness note",
    stages: ["pre_six_dim_review"],
    track: "B",
    enabled: true,
    run: (ctx) => {
      if (promptHint.trim()) {
        ctx.bag.promptFragments.push(promptHint.trim())
        ctx.bag.notes.push("gold-scale readiness injected")
      }
    },
  }
}

/**
 * Soft CED consistency-density report from precomputed ContinuityFinding[].
 * Never a product hard gate; does not replace Consistency ADR behavior.
 */
export function createCedSoftReportHook(options: {
  findings?: import("./deterministic-continuity-engine").ContinuityFinding[]
  textForWordCount?: string
  styleIssueCount?: number
  stages?: NovelSkillStage[]
}): NovelSkillHook {
  const stages = options.stages ?? (["pre_six_dim_review"] as NovelSkillStage[])
  return {
    id: "builtin.ced-soft-report",
    title: "CED soft consistency density (not hard gate)",
    stages,
    track: "B",
    enabled: true,
    run: async (ctx) => {
      try {
        const { computeCedReport, formatCedReportPromptFragment } = await import("./ced-report")
        const report = computeCedReport({
          findings: options.findings ?? [],
          textForWordCount: options.textForWordCount,
          styleIssueCount: options.styleIssueCount,
        })
        ctx.bag.notes.push(report.summaryLine)
        const frag = formatCedReportPromptFragment(report)
        if (frag) ctx.bag.promptFragments.push(frag)
      } catch (error) {
        ctx.bag.notes.push(
          `ced soft report failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
  }
}

/**
 * Track B hang for avoid-ai:
 * 1) Chinese mechanical slop (`slopScore`)
 * 2) Full vendored avoid-ai-writing `patterns.cjs` (English-heavy)
 * Never a product hard gate; injects soft prompt notes only.
 */
export function createAvoidAiMechanicalSlopHook(options: {
  /** Draft text to score; empty/absent → no-op. */
  text?: string
  /** Default: post_draft_light_check + pre_six_dim_review */
  stages?: NovelSkillStage[]
  /** Run full patterns.js engine (default true). */
  includeFullPatterns?: boolean
}): NovelSkillHook {
  const stages = options.stages ?? (["post_draft_light_check", "pre_six_dim_review"] as NovelSkillStage[])
  const includeFullPatterns = options.includeFullPatterns !== false
  return {
    id: "builtin.avoid-ai-mechanical-slop",
    title: "Avoid-AI mechanical slop + full patterns (Track B soft)",
    stages,
    track: "B",
    enabled: true,
    run: async (ctx) => {
      const text = (options.text ?? "").trim()
      if (!text) {
        ctx.bag.notes.push("avoid-ai slop: skipped (empty text)")
        return
      }
      const { slopScore, classifySlop, slopReportToText } = await import("./mechanical-slop-detector")
      const report = slopScore(text)
      const verdict = classifySlop(report)
      const reportText = slopReportToText(report)
      ctx.bag.notes.push(
        `avoid-ai slop: verdict=${verdict} penalty=${report.slopPenalty.toFixed(1)} (Track B soft; not product hard gate)`,
      )
      if (reportText.trim()) {
        ctx.bag.promptFragments.push(
          [
            "【Track B · 机械去AI味软提示（非产品硬门）】",
            `slopVerdict=${verdict} penalty=${report.slopPenalty.toFixed(1)}`,
            reportText.trim(),
            "请优先替换高密度 AI 套话与机械转折，勿为抬 thril 牺牲人设与设定。",
          ].join("\n"),
        )
      } else if (verdict === "clean") {
        ctx.bag.notes.push("avoid-ai slop: clean (no fragment)")
      }

      if (includeFullPatterns) {
        try {
          const {
            analyzeAvoidAiPatterns,
            formatAvoidAiPatternsSummary,
            formatAvoidAiPatternsPromptFragment,
          } = await import("./avoid-ai-patterns")
          const full = analyzeAvoidAiPatterns(text)
          ctx.bag.notes.push(formatAvoidAiPatternsSummary(full))
          const frag = formatAvoidAiPatternsPromptFragment(full)
          if (frag) ctx.bag.promptFragments.push(frag)
        } catch (error) {
          ctx.bag.notes.push(
            `avoid-ai full patterns soft-failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    },
  }
}

/**
 * Wave C: de-AI dual-pass soft hook (score + remediation notes).
 * Never product hard gate.
 */
export function createDeAiDualPassHook(options: {
  text?: string
  stages?: NovelSkillStage[]
  baselineScores?: readonly number[]
}): NovelSkillHook {
  const stages = options.stages ?? (["post_draft_light_check", "pre_six_dim_review"] as NovelSkillStage[])
  return {
    id: "builtin.de-ai-dual-pass",
    title: "De-AI dual-pass soft (Wave C Track B)",
    stages,
    track: "B",
    enabled: true,
    run: async (ctx) => {
      const text = (options.text ?? "").trim()
      if (!text) {
        ctx.bag.notes.push("de-ai dual-pass: skipped (empty text)")
        return
      }
      try {
        const { runDeAiDualPass, formatDualPassSummary } = await import("./de-ai-dual-pass")
        const report = runDeAiDualPass(text, { baselineScores: options.baselineScores })
        ctx.bag.notes.push(formatDualPassSummary(report))
        if (report.pass2.promptFragment.trim()) {
          ctx.bag.promptFragments.push(report.pass2.promptFragment.trim())
        }
      } catch (error) {
        ctx.bag.notes.push(
          `de-ai dual-pass soft-failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
  }
}

/** Wave C: statistical AI signature experimental soft hook. */
export function createStatisticalAiSignatureHook(options: {
  text?: string
  stages?: NovelSkillStage[]
}): NovelSkillHook {
  const stages = options.stages ?? (["pre_six_dim_review"] as NovelSkillStage[])
  return {
    id: "builtin.statistical-ai-signature",
    title: "Statistical AI signature (Wave C experimental Track B)",
    stages,
    track: "B",
    enabled: true,
    run: async (ctx) => {
      const text = (options.text ?? "").trim()
      if (!text) {
        ctx.bag.notes.push("statistical-ai-signature: skipped (empty)")
        return
      }
      try {
        const {
          scoreStatisticalAiSignature,
          formatStatisticalAiSignatureFragment,
        } = await import("./statistical-ai-signature")
        const sig = scoreStatisticalAiSignature(text)
        ctx.bag.notes.push(
          `statistical-ai-signature: score=${sig.score0to1.toFixed(3)} band=${sig.band} experimental (not hard gate)`,
        )
        const frag = formatStatisticalAiSignatureFragment(sig)
        if (frag) ctx.bag.promptFragments.push(frag)
      } catch (error) {
        ctx.bag.notes.push(
          `statistical-ai-signature soft-failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
  }
}

