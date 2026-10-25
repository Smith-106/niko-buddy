import { normalizeUserSkill, type SkillKind, type SkillStage, type UserSkill } from "./skill-library"
import { SKILL_ROUTE_CATEGORY_IDS } from "./skill-route"
import { validateSkillRouteRegistry } from "./skill-route-registry"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { parseFrontmatter } from "@/lib/frontmatter"

function loadSkillHubModules(): Record<string, string> {
  // NOTE: `import.meta.glob` must be called unconditionally (no typeof guard).
  // Vite inlines eager globs at build time, but the guard itself evaluates to
  // false in the built bundle and would fall through to the Node-only fs walk,
  // crashing module evaluation (white screen). In Node script runtimes (tsx)
  // the glob call throws -> caught -> fs walk below.
  try {
    const globbed = import.meta.glob("../../../skills/SkillHub/**/SKILL.md", {
      eager: true,
      query: "?raw",
      import: "default",
    }) as Record<string, string>
    if (Object.keys(globbed).length > 0) return globbed
  } catch {
    // No glob transform (Node runtime): try fs walk below.
  }
  try {
    const root = new URL("../../../skills/SkillHub/", import.meta.url)
    const modules: Record<string, string> = {}
    const visit = (dir: URL) => {
      for (const name of readdirSync(dir)) {
        const child = new URL(`${name}/`, dir)
        if (statSync(child).isDirectory()) {
          visit(child)
          continue
        }
        if (name === "SKILL.md") {
          modules[child.pathname] = readFileSync(child, "utf8")
        }
      }
    }
    visit(root)
    return modules
  } catch {
    // webview: node:fs is a throwing shim — fail open with empty modules
    // rather than crashing module evaluation (white screen).
    console.warn("[skill-hub-seed] SkillHub modules unavailable, using empty set")
    return {}
  }
}

const skillHubModules = loadSkillHubModules()

// 收敛 canonical frontmatter（arch-risk W3）——私有 regex → parseFrontmatter
// （BOM/容错由 canonical locateFrontmatterBlock 统一处理，不再手写 \\uFEFF regex）。
function parseSkillFrontmatter(content: string): {
  name: string
  description: string
} | null {
  // mock 兼容：spec 可能 mock parseFrontmatter 返回 undefined（review-center-
  // sidebar-panel.spec 顶层 mock 拦截共享模块）。防御性解构降级 null。
  const { frontmatter } = parseFrontmatter(content) ?? { frontmatter: null }
  if (!frontmatter) return null
  const name = (frontmatter.name as string | undefined)?.trim()
  const description = (frontmatter.description as string | undefined)?.trim()
  if (!name || !description) return null
  return { name, description }
}

function getSkillHubFolder(path: string): string {
  return path.replace(/\\/g, "/").match(/SkillHub\/([^/]+)\//)?.[1] ?? ""
}

function getSkillRouteCategory(path: string, name: string): string {
  const folder = getSkillHubFolder(path)
  if (folder === "DagangSkill") return SKILL_ROUTE_CATEGORY_IDS.outline
  if (folder === "ZhanggangSkill") return SKILL_ROUTE_CATEGORY_IDS.outline
  if (folder === "QualitySkill") return SKILL_ROUTE_CATEGORY_IDS.outline
  if (folder === "TicaiSkill") return SKILL_ROUTE_CATEGORY_IDS.topic
  if (folder === "JueseSkill") return SKILL_ROUTE_CATEGORY_IDS.character
  if (folder === "ZhengwenSkill") return SKILL_ROUTE_CATEGORY_IDS.writing
  if (folder === "SheDingSkill") {
    if (name.includes("world-rules")) return SKILL_ROUTE_CATEGORY_IDS.worldbuilding
    if (name.includes("faction")) return SKILL_ROUTE_CATEGORY_IDS.faction
    if (name.includes("foreshadowing")) return SKILL_ROUTE_CATEGORY_IDS.foreshadowing
    if (name.includes("map")) return SKILL_ROUTE_CATEGORY_IDS.map
    return SKILL_ROUTE_CATEGORY_IDS.setting
  }
  return ""
}

function getSkillShape(path: string): {
  kind: SkillKind[]
  stages: SkillStage[]
  priority: number
} {
  const folder = getSkillHubFolder(path)
  if (folder === "DagangSkill") {
    return { kind: ["planning", "structure"], stages: ["planning", "output"], priority: 12 }
  }
  if (folder === "ZhanggangSkill") {
    return { kind: ["planning", "structure"], stages: ["planning", "output"], priority: 14 }
  }
  if (folder === "TicaiSkill") {
    return { kind: ["knowledge", "planning"], stages: ["planning"], priority: 18 }
  }
  if (folder === "QualitySkill") {
    return { kind: ["planning", "output"], stages: ["planning", "output"], priority: 16 }
  }
  if (folder === "ZhengwenSkill") {
    return { kind: ["style", "output"], stages: ["drafting", "output"], priority: 28 }
  }
  return { kind: ["knowledge", "structure"], stages: ["planning"], priority: 24 }
}

export const DEFAULT_SKILL_HUB_SKILLS: UserSkill[] = Object.entries(skillHubModules)
  .map(([path, content]) => {
    const parsed = parseSkillFrontmatter(content)
    if (!parsed) return null
    const shape = getSkillShape(path)
    return normalizeUserSkill({
      id: `skillhub:${parsed.name}`,
      name: parsed.name,
      description: parsed.description,
      kind: shape.kind,
      stages: shape.stages,
      modes: ["standard", "strict"],
      content,
      source: "built-in",
      priority: shape.priority,
      tags: [getSkillHubFolder(path), parsed.name],
      categoryId: getSkillRouteCategory(path, parsed.name),
    })
  })
  .filter((skill): skill is UserSkill => Boolean(skill))
  .sort((left, right) => left.id.localeCompare(right.id))

const SKILL_ROUTE_REGISTRY_MISSING_NAMES = validateSkillRouteRegistry(
  DEFAULT_SKILL_HUB_SKILLS.map((skill) => skill.name),
)

if (SKILL_ROUTE_REGISTRY_MISSING_NAMES.length > 0) {
  // ISS-20260709-050: 脱敏 — 名称清单非密钥但仍收敛为计数+清单字符串（禁错误对象透出）。
  console.error(
    "Skill 路由注册表包含不存在的 SkillHub 名称：",
    `${SKILL_ROUTE_REGISTRY_MISSING_NAMES.length} missing: ${SKILL_ROUTE_REGISTRY_MISSING_NAMES.join(", ")}`,
  )
}
