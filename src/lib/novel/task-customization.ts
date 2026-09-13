import type { NovelConfig, TaskPromptKey } from "@/stores/wiki-store"

/**
 * 任务级自定义（task customization）：每任务（writing/outline/review/summary/extract）
 * 的追加提示词与技能名单覆盖。全部纯函数、零 LLM。
 *
 * 等价性契约：配置为空（默认）时所有返回值为空串/空数组 → 注入点不产生任何段落，
 * 行为与现状逐字节一致。
 */

/** 解析任务追加提示词：空安全，trim 后为空返回 ""（注入点判空跳过）。 */
export function resolveTaskExtraPrompt(
  novelConfig: Pick<NovelConfig, "taskPrompts"> | undefined,
  key: TaskPromptKey,
): string {
  const extra = novelConfig?.taskPrompts?.[key]?.extra
  return typeof extra === "string" ? extra.trim() : ""
}

/** 解析任务技能名单：trim、去空、去重保序。 */
export function resolveTaskSkillNames(
  novelConfig: Pick<NovelConfig, "taskSkillNames"> | undefined,
  key: TaskPromptKey,
): string[] {
  const names = novelConfig?.taskSkillNames?.[key]
  if (!Array.isArray(names)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of names) {
    const name = typeof raw === "string" ? raw.trim() : ""
    if (!name || seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }
  return result
}

export interface TaskSkillOverrideResult {
  /** 最终名单：用户非空且至少一个存在 → 用户名单（仅存在的项）；否则默认名单原样 */
  names: string[]
  /** 用户名单中在技能池里找不到的项（进诊断/missingSkillNames） */
  missing: string[]
  /** 用户配置是否实际生效（非空且至少一项存在） */
  applied: boolean
}

/**
 * 任务技能名单覆盖：用户名单非空 → 仅保留技能池中存在的项；全部缺失或用户空 →
 * 原样返回默认名单（等价直通）。availableNames 为技能池的全部可用名称集合。
 */
export function applyTaskSkillOverride(
  defaultNames: string[],
  userNames: string[],
  availableNames: ReadonlySet<string>,
): TaskSkillOverrideResult {
  if (userNames.length === 0) {
    return { names: defaultNames, missing: [], applied: false }
  }
  const present: string[] = []
  const missing: string[] = []
  for (const name of userNames) {
    if (availableNames.has(name)) present.push(name)
    else missing.push(name)
  }
  if (present.length === 0) {
    return { names: defaultNames, missing, applied: false }
  }
  return { names: present, missing, applied: true }
}

/** 任务键是否合法（设置 UI 输入防线）。 */
export function isTaskPromptKey(value: string): value is TaskPromptKey {
  return (["writing", "outline", "review", "summary", "extract"] as const).includes(
    value as TaskPromptKey,
  )
}
