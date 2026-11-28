import { useState, useEffect, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, writeFileAtomic } from "@/commands/fs"
import { join } from "@tauri-apps/api/path"

// 从新的skill文件导入默认规则
import defaultDeAiSkill from "../../../skills/de-ai-writing/SKILL.md?raw"
import {
  TIERED_DEAI_TABLE,
  computeTieredDeAiStats,
  createEmptyDeAiTieredOverrides,
  loadDeAiTieredOverrides,
  saveDeAiTieredOverrides,
} from "@/lib/novel"
import type { TieredDeAiCategory, TieredDeAiEntry, TieredDeAiTier } from "@/lib/novel"

const DEFAULT_DE_AI_SKILL = defaultDeAiSkill.trim()

/** 编辑模式: 结构化分级表 / 自由文本 */
type EditorTab = "tiered" | "free-text"

/** 单条分级表编辑状态 */
interface EditableTieredEntry {
  index: number
  term: string
  tier: TieredDeAiTier
  category: string
  weight: number
  suggestion: string
  /** 是否已修改 (视觉标记) */
  dirty: boolean
  /** 是否已在项目中豁免/禁用该词条 */
  disabled: boolean
  /** 是否为用户自定义新增词条（非内置 112 词） */
  isCustom: boolean
}

/** 将只读表转为可编辑状态 */
function toEditableEntries(table: readonly TieredDeAiEntry[]): EditableTieredEntry[] {
  return table.map((e, i) => ({
    index: i,
    term: e.term,
    tier: e.tier,
    category: e.category,
    weight: e.weight,
    suggestion: e.suggestion,
    dirty: false,
    disabled: false,
    isCustom: false,
  }))
}

export function DeAiSkillEditor() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const [activeTab, setActiveTab] = useState<EditorTab>("free-text")
  // 自由文本状态
  const [content, setContent] = useState("")
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [isDefault, setIsDefault] = useState(true)
  // 结构化分级状态
  const [entries, setEntries] = useState<EditableTieredEntry[]>(() => toEditableEntries(TIERED_DEAI_TABLE))
  const [filterTier, setFilterTier] = useState<TieredDeAiTier | "all">("all")
  const [searchTerm, setSearchTerm] = useState("")
  // 新增自定义词条表单状态
  const [newTerm, setNewTerm] = useState("")
  const [newTier, setNewTier] = useState<TieredDeAiTier>("1A")
  const [newCategory, setNewCategory] = useState<string>("AI特征词")
  const [newWeight, setNewWeight] = useState<number>(0.9)
  const [newSuggestion, setNewSuggestion] = useState("")

  const baseStats = useMemo(() => computeTieredDeAiStats(), [])
  const activeStats = useMemo(() => {
    const active = entries.filter((e) => !e.disabled)
    return {
      totalEntries: active.length,
      disabledCount: entries.length - active.length,
      customCount: entries.filter((e) => e.isCustom).length,
      tierCounts: {
        "1A": active.filter((e) => e.tier === "1A").length,
        "1B": active.filter((e) => e.tier === "1B").length,
        "3": active.filter((e) => e.tier === "3").length,
      },
      weightRange: baseStats.weightRange,
    }
  }, [entries, baseStats.weightRange])

  const filteredEntries = useMemo(() => {
    let result = entries
    if (filterTier !== "all") {
      result = result.filter((e) => e.tier === filterTier)
    }
    if (searchTerm.trim()) {
      const q = searchTerm.trim().toLowerCase()
      result = result.filter(
        (e) =>
          e.term.toLowerCase().includes(q) ||
          e.category.toLowerCase().includes(q) ||
          e.suggestion.toLowerCase().includes(q),
      )
    }
    return result
  }, [entries, filterTier, searchTerm])

  useEffect(() => {
    if (!project) return
    void loadSkill()
    void loadTieredOverrides()
  }, [project?.path])

  async function loadSkill() {
    /* v8 ignore next */
    if (!project) return
    try {
      const skillPath = await join(project.path, "de-ai-skill.txt")
      const skillContent = await readFile(skillPath)
      setContent(skillContent)
      setIsDefault(false)
    } catch {
      setContent(DEFAULT_DE_AI_SKILL)
      setIsDefault(true)
    }
  }

  async function loadTieredOverrides() {
    /* v8 ignore next */
    if (!project) return
    const overrides = await loadDeAiTieredOverrides(project.path)
    if (!overrides) {
      setEntries(toEditableEntries(TIERED_DEAI_TABLE))
      return
    }
    const disabledSet = new Set(overrides.disabledTerms)
    const customByTerm = new Map(overrides.customEntries.map((c) => [c.term, c]))
    const baseByTerm = new Map(TIERED_DEAI_TABLE.map((e) => [e.term, e]))
    const nextRows: EditableTieredEntry[] = []

    // 保留全部内置词条（含已豁免项，方便在 UI 一键重新启用）
    for (const base of TIERED_DEAI_TABLE) {
      const custom = customByTerm.get(base.term)
      const overriddenTier = overrides.tierOverrides[base.term]
      const tier = custom?.tier ?? overriddenTier ?? base.tier
      const weight = custom?.weight ?? base.weight
      const suggestion = custom?.suggestion ?? base.suggestion
      const category = custom?.category ?? base.category
      const disabled = disabledSet.has(base.term)
      const dirty = disabled || tier !== base.tier || weight !== base.weight || suggestion !== base.suggestion
      nextRows.push({
        index: nextRows.length,
        term: base.term,
        tier,
        category,
        weight,
        suggestion,
        dirty,
        disabled,
        isCustom: false,
      })
    }

    // 追加用户自定义新增词条
    for (const custom of overrides.customEntries) {
      if (baseByTerm.has(custom.term)) continue
      nextRows.push({
        index: nextRows.length,
        term: custom.term,
        tier: custom.tier,
        category: custom.category,
        weight: custom.weight,
        suggestion: custom.suggestion,
        dirty: true,
        disabled: disabledSet.has(custom.term),
        isCustom: true,
      })
    }

    setEntries(nextRows)
  }

  async function handleSave() {
    if (!project) return
    setSaving(true)
    try {
      const skillPath = await join(project.path, "de-ai-skill.txt")
      await writeFileAtomic(skillPath, content)
      setMessage("保存成功")
      setIsDefault(false)
    } catch {
      setMessage("保存失败，请稍后重试")
    } finally {
      setSaving(false)
      setTimeout(() => setMessage(""), 2000)
    }
  }

  async function handleReset() {
    setContent(DEFAULT_DE_AI_SKILL)
    setMessage("已重置为默认规则")
    setTimeout(() => setMessage(""), 2000)
  }

  function handleTierChange(index: number, newTierVal: TieredDeAiTier) {
    setEntries((prev) =>
      prev.map((e) => (e.index === index ? { ...e, tier: newTierVal, dirty: true } : e)),
    )
  }

  function handleWeightChange(index: number, newWeightVal: number) {
    const clamped = Math.round(Math.max(0, Math.min(1, newWeightVal)) * 100) / 100
    setEntries((prev) =>
      prev.map((e) => (e.index === index ? { ...e, weight: clamped, dirty: true } : e)),
    )
  }

  function handleSuggestionChange(index: number, newSuggestionVal: string) {
    setEntries((prev) =>
      prev.map((e) => (e.index === index ? { ...e, suggestion: newSuggestionVal, dirty: true } : e)),
    )
  }

  function handleToggleDisabled(index: number) {
    setEntries((prev) =>
      prev.map((e) => (e.index === index ? { ...e, disabled: !e.disabled, dirty: true } : e)),
    )
  }

  function handleRemoveCustomEntry(index: number) {
    setEntries((prev) =>
      prev
        .filter((e) => !(e.index === index && e.isCustom))
        .map((e, idx) => ({ ...e, index: idx })),
    )
  }

  function handleAddCustomTerm() {
    const term = newTerm.trim()
    if (!term) {
      setMessage(t("novel.deai.termRequired", { defaultValue: "请输入要新增的禁用词/短语" }))
      setTimeout(() => setMessage(""), 2000)
      return
    }
    if (entries.some((e) => e.term === term)) {
      setMessage(t("novel.deai.termDuplicate", { term, defaultValue: "词条「{{term}}」已存在" }))
      setTimeout(() => setMessage(""), 2000)
      return
    }
    const clampedWeight = Math.round(Math.max(0, Math.min(1, newWeight)) * 100) / 100
    const nextEntry: EditableTieredEntry = {
      index: entries.length,
      term,
      tier: newTier,
      category: newCategory.trim() || "AI特征词",
      weight: clampedWeight,
      suggestion: newSuggestion.trim() || "删掉或改写为具体动作与感官描写",
      dirty: true,
      disabled: false,
      isCustom: true,
    }
    setEntries((prev) => [nextEntry, ...prev].map((e, idx) => ({ ...e, index: idx })))
    setNewTerm("")
    setNewSuggestion("")
    setMessage(t("novel.deai.termAddedPendingSave", { term, defaultValue: "已添加词条「{{term}}」，点击保存后生效" }))
    setTimeout(() => setMessage(""), 2500)
  }

  async function handleSaveTable() {
    if (!project) return
    setSaving(true)
    try {
      const baseByTerm = new Map(TIERED_DEAI_TABLE.map((e) => [e.term, e]))
      const tierOverrides: Record<string, TieredDeAiTier> = {}
      const customEntries: TieredDeAiEntry[] = []
      const disabledTerms: string[] = []
      for (const entry of entries) {
        if (entry.disabled) {
          disabledTerms.push(entry.term)
        }
        const base = baseByTerm.get(entry.term)
        if (!base) {
          customEntries.push({
            term: entry.term,
            tier: entry.tier,
            category: entry.category as TieredDeAiCategory,
            weight: entry.weight,
            suggestion: entry.suggestion,
          })
          continue
        }
        if (entry.tier !== base.tier) {
          tierOverrides[entry.term] = entry.tier
        }
        if (entry.weight !== base.weight || entry.suggestion !== base.suggestion) {
          customEntries.push({
            term: entry.term,
            tier: entry.tier,
            category: entry.category as TieredDeAiCategory,
            weight: entry.weight,
            suggestion: entry.suggestion,
          })
        }
      }
      await saveDeAiTieredOverrides(project.path, {
        ...createEmptyDeAiTieredOverrides(),
        tierOverrides,
        customEntries,
        disabledTerms,
      })
      setEntries((prev) => prev.map((e) => ({ ...e, dirty: false })))
      setMessage(t("novel.deai.tieredSaveSuccess", { defaultValue: "分级表覆盖已保存并生效" }))
    } catch {
      setMessage(t("novel.deai.tieredSaveFailed", { defaultValue: "分级表保存失败，请稍后重试" }))
    } finally {
      setSaving(false)
      setTimeout(() => setMessage(""), 2500)
    }
  }

  function handleResetTable() {
    setEntries(toEditableEntries(TIERED_DEAI_TABLE))
    if (project) {
      void saveDeAiTieredOverrides(project.path, createEmptyDeAiTieredOverrides()).catch(() => {})
    }
    setMessage("已重置分级表为默认")
    setTimeout(() => setMessage(""), 2000)
  }

  const dirtyCount = entries.filter((e) => e.dirty).length

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <Label>{t("novel.soul.deaiSkill")}</Label>
        <p className="text-sm text-muted-foreground mt-1">
          自定义去AI味规则，将应用到全局所有去AI味功能（章节去AI味、选中文本去AI味、AI会话深度思考阶段6）
        </p>
        {isDefault && activeTab === "free-text" && (
          <p className="text-xs text-warning-foreground mt-2">
            当前使用系统默认skill（de-AI-writing - 12项硬门槛 + 24项AI痕迹检测）。保存后将创建项目自定义规则文件，优先级最高。
          </p>
        )}
      </div>

      {/* 切换标签 */}
      <div className="flex gap-1 border-b">
        <button
          type="button"
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "free-text"
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("free-text")}
        >
          自由文本
        </button>
        <button
          type="button"
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "tiered"
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("tiered")}
        >
          结构化分级
          {dirtyCount > 0 && (
            <span className="ml-2 text-xs text-warning-foreground">({dirtyCount}改)</span>
          )}
        </button>
      </div>

      {activeTab === "free-text" && (
        <>
          <Textarea
            className="min-h-[400px] font-mono text-sm"
            placeholder={t("novel.deai.rulePlaceholder")}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button onClick={handleSave} disabled={saving || content.trim() === ""}>
              {saving ? "保存中..." : "保存"}
            </Button>
            <Button onClick={handleReset} variant="outline" disabled={saving}>
              重置为默认
            </Button>
            {message && <span className="text-sm text-muted-foreground">{message}</span>}
          </div>
          <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
            <div className="font-medium mb-2">{t("novel.deai.usageTips")}</div>
            <ul className="space-y-1 list-disc list-inside">
              <li>{t("novel.deai.tipSave")}</li>
              <li>{t("novel.deai.tipDefault")}</li>
              <li>{t("novel.deai.tipMultiline")}</li>
              <li>{t("novel.deai.tipFile")}</li>
              <li>{t("novel.deai.tipFullSystem")}</li>
            </ul>
          </div>
        </>
      )}

      {activeTab === "tiered" && (
        <>
          {/* 统计概览 */}
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span>共 {activeStats.totalEntries} 词</span>
            <span>1A 高 {activeStats.tierCounts["1A"]}</span>
            <span>1B 低 {activeStats.tierCounts["1B"]}</span>
            <span>3 弱 {activeStats.tierCounts["3"]}</span>
            {activeStats.customCount > 0 ? <span>自定义 +{activeStats.customCount}</span> : null}
            {activeStats.disabledCount > 0 ? <span>已豁免 {activeStats.disabledCount}</span> : null}
            <span>权重范围 {activeStats.weightRange.min}-{activeStats.weightRange.max}</span>
            <span className="text-warning-foreground">{t("novel.deai.signalWarning")}</span>
          </div>

          {/* 过滤器 */}
          <div className="flex items-center gap-2">
            <select
              className="h-8 rounded border bg-background px-2 text-xs"
              value={filterTier}
              onChange={(e) => setFilterTier(e.target.value as TieredDeAiTier | "all")}
            >
              <option value="all">{t("novel.deai.allGrades")}</option>
              <option value="1A">{t("novel.deai.grade1A")}</option>
              <option value="1B">{t("novel.deai.grade1B")}</option>
              <option value="3">{t("novel.deai.grade3")}</option>
            </select>
            <Input
              className="h-8 w-48 text-xs"
              placeholder={t("novel.deai.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <span className="text-xs text-muted-foreground">
              显示 {filteredEntries.length}/{entries.length} 条
            </span>
          </div>

          {/* 分级表 */}
          <div className="overflow-auto max-h-[500px] border rounded-md">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                <tr className="border-b">
                  <th className="px-2 py-1.5 text-left font-medium w-28">{t("novel.deai.term")}</th>
                  <th className="px-2 py-1.5 text-left font-medium w-16">{t("novel.deai.grade")}</th>
                  <th className="px-2 py-1.5 text-left font-medium w-20">分类</th>
                  <th className="px-2 py-1.5 text-left font-medium w-16">{t("graph.weight")}</th>
                  <th className="px-2 py-1.5 text-left font-medium">{t("novel.deai.rewriteSuggestion")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredEntries.map((entry) => (
                  <tr
                    key={entry.term}
                    className={`border-b hover:bg-muted/30 ${
                      entry.disabled
                        ? "opacity-55 bg-muted/20"
                        : entry.dirty
                          ? "bg-warning dark:bg-warning/20"
                          : ""
                    }`}
                  >
                    <td className={`px-2 py-1.5 font-mono ${entry.disabled ? "line-through" : ""}`}>
                      {entry.term}
                      {entry.isCustom ? (
                        <span className="ml-1 rounded bg-primary/10 px-1 text-[10px] text-primary">自定义</span>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5">
                      <select
                        className={`h-7 w-14 rounded border bg-background px-1 text-xs font-medium ${
                          entry.tier === "1A"
                            ? "text-destructive"
                            : entry.tier === "1B"
                              ? "text-warning-foreground"
                              : "text-info"
                        }`}
                        value={entry.tier}
                        disabled={entry.disabled}
                        onChange={(e) => handleTierChange(entry.index, e.target.value as TieredDeAiTier)}
                      >
                        <option value="1A">1A</option>
                        <option value="1B">1B</option>
                        <option value="3">3</option>
                      </select>
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">{entry.category}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1">
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.1"
                          className="w-12 h-3"
                          disabled={entry.disabled}
                          value={entry.weight}
                          onChange={(e) => handleWeightChange(entry.index, parseFloat(e.target.value))}
                        />
                        <span className="w-5 text-right">{entry.weight.toFixed(1)}</span>
                      </div>
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <input
                          className="flex-1 bg-transparent border-b border-dashed border-muted-foreground/30 text-xs px-1 py-0.5 focus:outline-none focus:border-primary"
                          disabled={entry.disabled}
                          value={entry.suggestion}
                          onChange={(e) => handleSuggestionChange(entry.index, e.target.value)}
                        />
                        <button
                          type="button"
                          data-testid={`deai-toggle-disabled-${entry.term}`}
                          className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] ${
                            entry.disabled
                              ? "border-primary/40 bg-primary/10 text-primary"
                              : "border-muted-foreground/30 text-muted-foreground hover:text-foreground"
                          }`}
                          onClick={() => handleToggleDisabled(entry.index)}
                        >
                          {entry.disabled
                            ? t("novel.deai.restoreTerm", { defaultValue: "恢复" })
                            : t("novel.deai.exemptTerm", { defaultValue: "豁免" })}
                        </button>
                        {entry.isCustom ? (
                          <button
                            type="button"
                            data-testid={`deai-remove-custom-${entry.term}`}
                            className="shrink-0 rounded border border-destructive/40 px-1.5 py-0.5 text-[11px] text-destructive"
                            onClick={() => handleRemoveCustomEntry(entry.index)}
                          >
                            {t("novel.deai.deleteTerm", { defaultValue: "删" })}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 新增自定义禁词 */}
          <div
            data-testid="deai-add-term-form"
            className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/15 p-2.5 text-xs"
          >
            <Input
              data-testid="deai-new-term-input"
              className="h-8 w-36 text-xs"
              placeholder={t("novel.deai.addTermPlaceholder", { defaultValue: "新增禁词/短语..." })}
              value={newTerm}
              onChange={(e) => setNewTerm(e.target.value)}
            />
            <select
              data-testid="deai-new-tier-select"
              className="h-8 rounded border bg-background px-2 text-xs"
              value={newTier}
              onChange={(e) => setNewTier(e.target.value as TieredDeAiTier)}
            >
              <option value="1A">1A</option>
              <option value="1B">1B</option>
              <option value="3">3</option>
            </select>
            <Input
              className="h-8 w-24 text-xs"
              placeholder={t("novel.deai.categoryPlaceholder", { defaultValue: "分类" })}
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
            />
            <Input
              type="number"
              min="0"
              max="1"
              step="0.1"
              className="h-8 w-16 text-xs"
              value={newWeight}
              onChange={(e) => setNewWeight(parseFloat(e.target.value) || 0)}
            />
            <Input
              data-testid="deai-new-suggestion-input"
              className="h-8 min-w-[160px] flex-1 text-xs"
              placeholder={t("novel.deai.addSuggestionPlaceholder", { defaultValue: "改写建议（可选）" })}
              value={newSuggestion}
              onChange={(e) => setNewSuggestion(e.target.value)}
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-testid="deai-add-term-btn"
              onClick={handleAddCustomTerm}
            >
              {t("novel.deai.addTermButton", { defaultValue: "+ 新增禁词" })}
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" data-testid="deai-save-table-btn" onClick={() => void handleSaveTable()} disabled={saving || !project}>
              {saving
                ? t("novel.deai.saving", { defaultValue: "保存中..." })
                : t("novel.deai.saveTieredOverrides", { defaultValue: "保存分级覆盖" })}
            </Button>
            <Button variant="outline" size="sm" onClick={handleResetTable} disabled={saving}>
              重置分级表
            </Button>
            {message && <span className="text-sm text-muted-foreground">{message}</span>}
          </div>

          <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
            <div className="font-medium mb-2">{t("novel.deai.gradeNote")}</div>
            <ul className="space-y-1 list-disc list-inside">
              <li>
                <span className="text-destructive font-medium">{t("novel.deai.grade1A")}</span> — 强 AI 信号（总结腔/解释腔/模板句首/机械公式），共 {activeStats.tierCounts["1A"]} 词
              </li>
              <li>
                <span className="text-warning-foreground font-medium">{t("novel.deai.grade1B")}</span> — 弱 AI 信号（装饰副词/模糊限制/机械过渡），仅轻提示不升压，共 {activeStats.tierCounts["1B"]} 词
              </li>
              <li>
                <span className="text-info font-medium">{t("novel.deai.grade3")}</span> — 边缘信号（轻度 AI 腔/弱解释），仅参考不断，共 {activeStats.tierCounts["3"]} 词
              </li>
              <li className="text-warning-foreground">
                保持「信号非证据」立场，误报率 &gt;60%，1B 不升级为 Anti-AI(P1) 硬门控
              </li>
              <li>{t("novel.deai.fallbackNote")}</li>
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
