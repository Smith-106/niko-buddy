import type { UserSkillConfig, UserSkill, SkillKind, SkillStage, SkillMode } from "@/lib/novel"

export function resolveInitialSkillId(config: UserSkillConfig, requested: string | null): string | null {
  if (requested && config.skills.some((skill) => skill.id === requested)) return requested
  return config.selectedSkillId ?? config.skills[0]?.id ?? null
}

export function hasDraftChanged(
  skill: UserSkill,
  name: string,
  description: string,
  content: string,
  kind: SkillKind[],
  stages: SkillStage[],
  modes: SkillMode[],
  priority: number,
  tags: string[],
  categoryId: string,
): boolean {
  return name.trim() !== skill.name
    || description.trim() !== skill.description
    || content.trim() !== skill.content
    || kind.join("|") !== skill.kind.join("|")
    || stages.join("|") !== skill.stages.join("|")
    || modes.join("|") !== skill.modes.join("|")
    || priority !== skill.priority
    || tags.join("|") !== skill.tags.join("|")
    || categoryId !== skill.categoryId
}

export function toggleValue<T extends string>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value]
}
