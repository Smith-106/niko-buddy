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
