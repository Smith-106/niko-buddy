import { BookOpen, Sparkles, ShieldCheck } from "lucide-react"

/**
 * 技能库只读视图（SkillHub MVP，2026-08-29）。
 * 展示内置技能（skills/ 目录）的名称/描述/用途；只读浏览，不提供编辑。
 * 后续二期：分类筛选 + 收藏 + 拖拽排序（@dnd-kit）。
 */

interface SkillEntry {
  id: string
  name: string
  description: string
  usage: string
  icon: typeof BookOpen
  files: number
}

const SKILLS: SkillEntry[] = [
  {
    id: "de-ai-writing",
    name: "去 AI 化写作",
    description: "消除机械 AI 味：改写收敛、孪生对拍、影子遥测四因子。",
    usage: "de-ai 批处理 / 草稿改写出口",
    icon: ShieldCheck,
    files: 2,
  },
  {
    id: "good-writing",
    name: "好文笔",
    description: "文笔提升规则集：句式、节奏、感官细节、避免陈词滥调。",
    usage: "写作提示词装配（good-writing 规则）",
    icon: Sparkles,
    files: 2,
  },
  {
    id: "soulskill",
    name: "作品灵魂",
    description: "灵魂 Doc 视角库：Karpathy / 避避咚 / 避谣 等写作人格视角。",
    usage: "角色灵魂装配（Soul Doc + 视角）",
    icon: BookOpen,
    files: 4,
  },
]

export function SkillLibrarySection() {
  return (
    <section className="space-y-4" aria-label="技能库">
      <div>
        <h2 className="text-lg font-semibold">技能库</h2>
        <p className="text-sm text-muted-foreground">
          内置写作技能（只读浏览）。技能随版本发布，编辑与自定义将在后续版本开放。
        </p>
      </div>
      <div className="grid gap-3">
        {SKILLS.map((skill) => {
          const Icon = skill.icon
          return (
            <div
              key={skill.id}
              className="flex items-start gap-3 rounded-lg border p-3"
            >
              <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-medium">{skill.name}</h3>
                  <span className="text-xs text-muted-foreground">
                    {skill.files} 文件
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {skill.description}
                </p>
                <p className="mt-1 text-xs text-muted-foreground/80">
                  用途：{skill.usage}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
