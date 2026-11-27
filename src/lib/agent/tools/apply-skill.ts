import type { Tool } from "../types"
import { getAllDeAiSkills, resolveSkillReference } from "@/lib/novel"
import type { DeAiSkillConfig, UserSkill } from "@/lib/novel"

export function createApplySkillTool(
  getConfig: () => DeAiSkillConfig | null,
  getUserSkills?: () => UserSkill[] | null,
): Tool {
  const getAvailableSkills = () => {
    const config = getConfig()
    let deAiSkills: ReturnType<typeof getAllDeAiSkills> = []
    if (config) {
      try {
        deAiSkills = getAllDeAiSkills(config)
      } catch {
        // 某些宿主只加载通用 Skill，不提供去 AI 味技能库；工具仍可正常列出通用 Skill。
      }
    }
    return [
      ...(getUserSkills?.() ?? []),
      ...deAiSkills,
    ]
  }
  const availableNames = [...new Set(getAvailableSkills().map((skill) => skill.name))].sort()
  const availableNamesText = availableNames.length > 0
    ? `本轮可用名称：${availableNames.join("、")}。`
    : "本轮没有已加载的 Skill。"
  return {
    name: "apply_skill",
    description: `应用写作 Skill。仅支持 Skill ID、完整名称或受控 UI 别名，不支持模糊子串；省略参数时列出当前可用 Skill。${availableNamesText}`,
    category: "action",
    parameters: {
      skillName: { type: "string", description: `Skill 完整名称或受控 UI 别名（与 skillId 均留空时返回可用列表）。${availableNamesText}` },
      skillId: { type: "string", description: "Skill ID，可选，与 skillName 二选一" },
    },
    execute: async (params) => {
      const name = typeof params.skillName === "string" ? params.skillName.trim() : ""
      const id = typeof params.skillId === "string" ? params.skillId.trim() : ""
      const userSkills = getUserSkills?.() ?? []
      const config = getConfig()

      if (!config && userSkills.length === 0) return "错误：技能库配置未加载"

      if (!name && !id) {
        const skills = getAvailableSkills()
        if (skills.length === 0) {
          return "当前没有可用的写作 Skill。"
        }
        const seen = new Set<string>()
        const sorted = skills
          .filter((skill) => {
            const key = `${skill.id}::${skill.name}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
          .sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id))
          .map((skill) => `- ${skill.name}（id: ${skill.id}）`)
        return `未指定 skillName 或 skillId。当前可用写作 Skill（共 ${sorted.length} 个）：\n${sorted.join("\n")}\n\n请传入 skillName 或 skillId 重新调用 apply_skill。`
      }

      const userSkill = resolveSkillReference(userSkills, {
        id: id || undefined,
        name: name || undefined,
      })
      if (userSkill) {
        return `Skill「${userSkill.name}」的写作模板:\n\n${userSkill.content}`
      }

      let deAiSkills: ReturnType<typeof getAllDeAiSkills> = []
      if (config) {
        try {
          deAiSkills = getAllDeAiSkills(config)
        } catch {
          deAiSkills = []
        }
      }
      const skill = resolveSkillReference(deAiSkills, {
        id: id || undefined,
        name: name || undefined,
      })
      if (!skill) return `错误：未找到 Skill「${name || id}」`
      return `Skill「${skill.name}」的写作模板:\n\n${skill.content}`
    },
  }
}
