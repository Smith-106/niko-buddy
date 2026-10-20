import { useEffect, useMemo, useState } from "react"
import {
  DE_AI_STRUCTURED_RULES,
  getAllDeAiSkills,
  loadDeAiSkillConfig,
  saveDeAiSkillConfig,
  setDeAiSkillEnabled,
  type DeAiSkill,
  type DeAiSkillConfig,
} from "@/lib/novel"
import { toErrorMessage } from "@/lib/utils"

export interface AntiAiRulesViewProps {
  readonly projectPath: string
}

/**
 * 反AI规则视图：7 类规则只读展示 + 技能启用/禁用开关（写盘）+ 生效预览统计。
 *
 * 数据源：
 * - 规则分类经 barrel 的 DE_AI_STRUCTURED_RULES 派生（保持 7 类只读展示一致）。
 * - 技能配置经 barrel 的 loadDeAiSkillConfig / saveDeAiSkillConfig /
 *   setDeAiSkillEnabled / getAllDeAiSkills（.niko-buddy/de-ai-skills.json，
 *   内部走 @/commands/fs + @tauri-apps/api/path）。
 *
 * barrel 缺口（已记下，未 deep import）：
 * - DE_AI_CATEGORIES / DeAiCategory / DE_AI_SEVERITIES 未在 @/lib/novel barrel 导出，
 *   本文件不从 @/lib/novel/de-ai-rules deep import，类别顺序从
 *   DE_AI_STRUCTURED_RULES 按首次出现顺序派生（期望 7 类）。
 */
export function AntiAiRulesView({ projectPath }: AntiAiRulesViewProps) {
  const [config, setConfig] = useState<DeAiSkillConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)

  // 7 类顺序：从结构化规则按首次出现派生（barrel 未导出 DE_AI_CATEGORIES 的替代）。
  const categories = useMemo(() => {
    const ordered: string[] = []
    for (const item of DE_AI_STRUCTURED_RULES) {
      if (!ordered.includes(item.category)) {
        ordered.push(item.category)
      }
    }
    return ordered
  }, [])

  const rulesByCategory = useMemo(() => {
    const grouped = new Map<string, typeof DE_AI_STRUCTURED_RULES>()
    for (const category of categories) {
      grouped.set(
        category,
        DE_AI_STRUCTURED_RULES.filter((item) => item.category === category),
      )
    }
    return grouped
  }, [categories])

  useEffect(() => {
    if (!projectPath) {
      setConfig(null)
      setLoading(false)
      setLoadError("未选择项目路径")
      return
    }
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setSaveError(null)
    void loadDeAiSkillConfig(projectPath)
      .then((loaded) => {
        if (!cancelled) {
          setConfig(loaded)
          setLoading(false)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const message = toErrorMessage(error)
          setConfig(null)
          setLoadError(`加载失败：${message}`)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const skills: readonly DeAiSkill[] = useMemo(
    () => (config ? getAllDeAiSkills(config) : []),
    [config],
  )
  const disabledIds = useMemo(
    () => new Set(config?.disabledSkillIds ?? []),
    [config],
  )
  const enabledCount = useMemo(
    () => skills.filter((skill) => !disabledIds.has(skill.id)).length,
    [skills, disabledIds],
  )
  const disabledCount = skills.length - enabledCount

  async function handleToggle(skill: DeAiSkill, enabled: boolean): Promise<void> {
    if (!config || savingId !== null) return
    const next = setDeAiSkillEnabled(config, skill.id, !enabled)
    setSavingId(skill.id)
    setSaveError(null)
    try {
      await saveDeAiSkillConfig(projectPath, next)
      setConfig(next)
    } catch (error: unknown) {
      const message = toErrorMessage(error)
      setSaveError(`保存失败：${skill.name}切换失败，请重试（${message}）`)
    } finally {
      setSavingId(null)
    }
  }

  return (
    <section data-testid="anti-ai-rules-view" className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-foreground">反AI规则</h2>
        <p className="text-xs text-muted-foreground">
          7 类规则为只读说明；技能开关切换后即写盘保存到 .niko-buddy/de-ai-skills.json。
        </p>
      </div>

      <p data-testid="anti-ai-preview" className="text-sm text-foreground">
        {loading
          ? "正在统计生效技能…"
          : `当前启用 ${enabledCount} 个技能，禁用 ${disabledCount} 个，共 ${skills.length} 个`}
      </p>

      {loadError ? (
        <p data-testid="anti-ai-load-error" className="text-sm text-red-700 dark:text-red-300">
          {loadError}
        </p>
      ) : null}
      {saveError ? (
        <p data-testid="anti-ai-save-error" className="text-sm text-red-700 dark:text-red-300">
          {saveError}
        </p>
      ) : null}

      <div data-testid="anti-ai-categories" className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">规则分类（{categories.length} 类 · 只读）</h3>
        <ul className="flex flex-col gap-2">
            {categories.map((category) => {
              const rules = rulesByCategory.get(category) ?? []
              return (
                <li
                  key={category}
                  data-testid={`anti-ai-category-${category}`}
                  className="rounded-md border border-border bg-background px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">{category}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {rules.length} 条
                    </span>
                  </div>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                    {rules.map((item, index) => (
                      <li key={`${category}-${index}`}>
                        <span className="mr-1 rounded bg-muted px-1 text-[11px]">{item.severity}</span>
                        {item.rule}
                      </li>
                    ))}
                  </ul>
                </li>
              )
            })}
          </ul>
      </div>

      <div data-testid="anti-ai-skills" className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">技能开关</h3>
        {loading ? (
          <p className="text-xs text-muted-foreground">正在读取技能配置…</p>
        ) : skills.length === 0 ? (
          <p data-testid="anti-ai-empty" className="text-xs text-muted-foreground">
            暂无可用技能
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {skills.map((skill) => {
              const enabled = !disabledIds.has(skill.id)
              const saving = savingId === skill.id
              return (
                <li
                  key={skill.id}
                  data-testid={`anti-ai-skill-${skill.id}`}
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-foreground">{skill.name}</span>
                    {skill.description ? (
                      <span className="text-xs text-muted-foreground">{skill.description}</span>
                    ) : null}
                    <span className="font-mono text-[11px] text-muted-foreground">{skill.id}</span>
                    <span
                      data-testid={`anti-ai-skill-status-${skill.id}`}
                      className="text-xs text-muted-foreground"
                    >
                      {enabled ? "已启用" : "已禁用"}
                    </span>
                  </div>
                  <button
                    type="button"
                    data-testid={`anti-ai-toggle-${skill.id}`}
                    aria-label={enabled ? `禁用 ${skill.name}` : `启用 ${skill.name}`}
                    disabled={savingId !== null}
                    onClick={() => void handleToggle(skill, enabled)}
                    className="shrink-0 rounded border border-border px-2 py-1 text-xs"
                  >
                    {saving ? "保存中…" : enabled ? "禁用" : "启用"}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
