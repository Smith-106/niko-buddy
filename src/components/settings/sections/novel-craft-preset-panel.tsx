// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  BUILT_IN_CRAFT_PRESETS,
  applyCraftPresetToProject,
  computeMissingPresetSkills,
  computeRuntimeSkillBudgetTokens,
  loadCraftPresetJournal,
  loadCustomCraftPresets,
  loadUserSkillConfig,
  parseCustomCraftPresetsJson,
  resolveEnabledWritingSkills,
  rollbackLastCraftPreset,
  saveCustomCraftPresets,
  type CraftPresetDefinition,
  type CraftPresetJournalEntry,
  type UserSkill,
} from "@/lib/novel"
import { estimateTokens } from "@/lib/token-estimator"
import { toErrorMessage } from "@/lib/utils"
import { toast } from "@/lib/toast"
import type { NovelConfig, TaskPromptKey } from "@/stores/wiki-store"
import { NOVEL_GROUP_HEADING_CLASS } from "./novel-section-style"

export interface NovelCraftPresetPanelProps {
  projectPath?: string
  novelConfig: NovelConfig
  availableSkills?: readonly UserSkill[]
  windowTokens?: number
  onPresetApplied: (nextNovelConfig: NovelConfig) => void
  onRollbackApplied: () => Promise<void>
}

export function NovelCraftPresetPanel({
  projectPath,
  novelConfig,
  availableSkills,
  onPresetApplied,
  onRollbackApplied,
}: NovelCraftPresetPanelProps) {
  const { t } = useTranslation()
  const [customPresets, setCustomPresets] = useState<CraftPresetDefinition[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState<string>(
    novelConfig.activeCraftPresetId || BUILT_IN_CRAFT_PRESETS[0].id,
  )
  const [busy, setBusy] = useState(false)
  const [journalEntries, setJournalEntries] = useState<CraftPresetJournalEntry[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const allPresets = useMemo(() => {
    const byId = new Map<string, CraftPresetDefinition>()
    for (const p of BUILT_IN_CRAFT_PRESETS) byId.set(p.id, p)
    for (const p of customPresets) byId.set(p.id, p)
    return [...byId.values()]
  }, [customPresets])

  const lastCommitted = useMemo(
    () => [...journalEntries].reverse().find((e) => e.status === "committed") ?? null,
    [journalEntries],
  )

  useEffect(() => {
    if (novelConfig.activeCraftPresetId) {
      setSelectedPresetId(novelConfig.activeCraftPresetId)
    }
  }, [novelConfig.activeCraftPresetId])

  useEffect(() => {
    if (!projectPath) {
      setJournalEntries([])
      setCustomPresets([])
      return
    }
    let cancelled = false
    loadCraftPresetJournal(projectPath)
      .then((journal) => {
        if (!cancelled) setJournalEntries(journal.entries)
      })
      .catch(() => {
        if (!cancelled) setJournalEntries([])
      })
    loadCustomCraftPresets(projectPath)
      .then((loaded) => {
        if (!cancelled) setCustomPresets(loaded)
      })
      .catch(() => {
        if (!cancelled) setCustomPresets([])
      })
    return () => {
      cancelled = true
    }
  }, [projectPath, novelConfig.activeCraftPresetId])

  const selectedPreset = useMemo(
    () => allPresets.find((p) => p.id === selectedPresetId) ?? allPresets[0] ?? BUILT_IN_CRAFT_PRESETS[0],
    [allPresets, selectedPresetId],
  )

  const missingSkills = useMemo(() => {
    if (!availableSkills) return []
    return computeMissingPresetSkills(selectedPreset, availableSkills)
  }, [selectedPreset, availableSkills])

  async function handleApply() {
    if (!projectPath || busy) return
    setBusy(true)
    try {
      const result = await applyCraftPresetToProject(projectPath, selectedPreset, {
        baseNovelConfig: novelConfig,
      })
      onPresetApplied(result.updatedNovelConfig)
      const journal = await loadCraftPresetJournal(projectPath)
      setJournalEntries(journal.entries)
      toast.success(
        t("novel.craftPreset.applySuccess", {
          name: selectedPreset.name,
          defaultValue: "已原子应用流派预设「{{name}}」",
        }),
      )
    } catch (err) {
      toast.error(toErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleRollback() {
    if (!projectPath || busy || !lastCommitted) return
    setBusy(true)
    try {
      const res = await rollbackLastCraftPreset(projectPath)
      await onRollbackApplied()
      const journal = await loadCraftPresetJournal(projectPath)
      setJournalEntries(journal.entries)
      toast.success(
        t("novel.craftPreset.rollbackSuccess", {
          name: res.presetName,
          defaultValue: "已回滚流派预设「{{name}}」",
        }),
      )
    } catch (err) {
      toast.error(toErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleImportJsonFile(file: File | null | undefined) {
    if (!file) return
    try {
      const raw = await file.text()
      const imported = parseCustomCraftPresetsJson(raw)
      const mergedMap = new Map<string, CraftPresetDefinition>()
      for (const p of customPresets) mergedMap.set(p.id, p)
      for (const p of imported) mergedMap.set(p.id, p)
      const nextCustom = [...mergedMap.values()]
      setCustomPresets(nextCustom)
      setSelectedPresetId(imported[0].id)
      if (projectPath) {
        await saveCustomCraftPresets(projectPath, nextCustom)
      }
      toast.success(
        t("novel.craftPreset.importSuccess", {
          count: imported.length,
          defaultValue: "已导入 {{count}} 套自定义工艺预设",
        }),
      )
    } catch (err) {
      toast.error(toErrorMessage(err))
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid="novel-craft-preset-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className={NOVEL_GROUP_HEADING_CLASS}>
            {t("novel.craftPreset.title", { defaultValue: "流派工艺预设（四文件原子事务 + 一键回滚）" })}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("novel.craftPreset.description", {
              defaultValue: "一键配置主副写作专家、任务技能名单、围栏无损附加提示与默认书籍规则，并自动在 .niko-buddy/preset-backups 留存快照。",
            })}
          </p>
        </div>
        {novelConfig.activeCraftPresetId ? (
          <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
            {t("novel.craftPreset.activeBadge", {
              id: novelConfig.activeCraftPresetId,
              defaultValue: "当前激活：{{id}}",
            })}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          data-testid="craft-preset-select"
          aria-label={t("novel.craftPreset.selectAria", { defaultValue: "流派工艺预设" })}
          value={selectedPresetId}
          onChange={(e) => setSelectedPresetId(e.target.value)}
          className="h-9 min-w-[260px] flex-1 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          {allPresets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          data-testid="craft-preset-apply"
          disabled={!projectPath || busy}
          onClick={() => void handleApply()}
        >
          {busy
            ? t("novel.craftPreset.applying", { defaultValue: "应用中..." })
            : t("novel.craftPreset.apply", { defaultValue: "一键应用预设" })}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="craft-preset-rollback"
          disabled={!projectPath || busy || !lastCommitted}
          onClick={() => void handleRollback()}
        >
          {t("novel.craftPreset.rollback", { defaultValue: "回滚上次预设" })}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="craft-preset-import"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
        >
          {t("novel.craftPreset.importJson", { defaultValue: "导入预设 JSON" })}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          data-testid="craft-preset-import-input"
          className="hidden"
          onChange={(e) => void handleImportJsonFile(e.target.files?.[0])}
        />
      </div>

      <div className="space-y-1 rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
        <div>
          <strong className="text-foreground">{t("novel.craftPreset.genresLabel", { defaultValue: "适配题材：" })}</strong>
          {selectedPreset.genres.join(" / ")}
        </div>
        <div>
          <strong className="text-foreground">{t("novel.craftPreset.expertsLabel", { defaultValue: "主副专家：" })}</strong>
          {selectedPreset.primaryExpert}{selectedPreset.secondaryExpert ? ` + ${selectedPreset.secondaryExpert}` : ""}
        </div>
        <div>
          <strong className="text-foreground">{t("novel.craftPreset.writingSkillsLabel", { defaultValue: "写作技能：" })}</strong>
          {selectedPreset.taskSkillNames.writing.join(", ")}
        </div>
        <div>
          <strong className="text-foreground">{t("novel.craftPreset.hintLabel", { defaultValue: "围栏提示：" })}</strong>
          {selectedPreset.extraPromptHint}
        </div>
      </div>

      {missingSkills.length > 0 ? (
        <div
          data-testid="craft-preset-missing-skills"
          className="space-y-1 rounded-md border border-warning/60 bg-warning/10 p-3 text-xs text-warning-foreground"
        >
          <div className="font-medium">
            {t("novel.craftPreset.missingSkillsTitle", {
              count: missingSkills.length,
              defaultValue: "当前项目技能库缺少本预设依赖的 {{count}} 项技能：",
            })}
          </div>
          <div className="font-mono break-words">{missingSkills.join(", ")}</div>
          <div>
            {t("novel.craftPreset.missingSkillsHint", {
              defaultValue: "请先前往「技能库 → 技能包」导入对应的 v2 .nbskill.json 或 .nbskill.zip 技能包，否则运行时将跳过缺失技能并在回放面板记录缺口。",
            })}
          </div>
        </div>
      ) : null}

      {journalEntries.length > 0 ? (
        <details
          data-testid="craft-preset-history"
          className="rounded-md border bg-muted/10 px-3 py-2 text-xs text-muted-foreground"
        >
          <summary className="cursor-pointer font-medium text-foreground">
            {t("novel.craftPreset.historyTitle", {
              count: journalEntries.length,
              defaultValue: "预设应用与回滚历史（共 {{count}} 条）",
            })}
          </summary>
          <ul className="mt-2 space-y-1.5">
            {[...journalEntries].reverse().slice(0, 10).map((entry) => (
              <li
                key={entry.txId}
                className="flex flex-wrap items-center justify-between gap-2 border-t pt-1.5"
              >
                <span className="truncate font-medium text-foreground">{entry.presetName}</span>
                <span className="flex items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[11px] ${
                      entry.status === "committed"
                        ? "bg-success/15 text-success-foreground"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {entry.status === "committed"
                      ? t("novel.craftPreset.statusCommitted", { defaultValue: "已生效" })
                      : t("novel.craftPreset.statusRolledBack", { defaultValue: "已回滚" })}
                  </span>
                  <span className="font-mono text-[11px]">{entry.appliedAt.slice(0, 19).replace("T", " ")}</span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}

export interface TaskSkillChipPickerProps {
  taskKey: TaskPromptKey
  selectedNames: readonly string[]
  availableSkills: readonly UserSkill[]
  windowTokens?: number
  onChange: (nextNames: string[]) => void
}

export function TaskSkillChipPicker({
  taskKey,
  selectedNames,
  availableSkills,
  windowTokens,
  onChange,
}: TaskSkillChipPickerProps) {
  const { t } = useTranslation()
  const [search, setSearch] = useState("")

  const stageForBudget =
    taskKey === "outline"
      ? "outline"
      : taskKey === "review"
        ? "review"
        : taskKey === "summary"
          ? "summary"
          : taskKey === "extract"
            ? "extract"
            : "writing"
  const budgetTokens = computeRuntimeSkillBudgetTokens(stageForBudget, windowTokens)

  const skillByName = useMemo(() => {
    const map = new Map<string, UserSkill>()
    for (const s of availableSkills) {
      if (!map.has(s.name)) map.set(s.name, s)
    }
    return map
  }, [availableSkills])

  const estimatedUsedTokens = useMemo(() => {
    let total = 0
    for (const name of selectedNames) {
      const skill = skillByName.get(name)
      const body = skill?.content?.trim() || skill?.contentCache?.trim() || ""
      total += body ? estimateTokens(`### ${name}\n${body}`) : 350
    }
    return total
  }, [selectedNames, skillByName])

  const filteredCandidates = useMemo(() => {
    const q = search.trim().toLowerCase()
    return availableSkills
      .filter((skill) => {
        if (!q) return true
        return (
          skill.name.toLowerCase().includes(q)
          || skill.description.toLowerCase().includes(q)
          || skill.tags.some((tag) => tag.toLowerCase().includes(q))
        )
      })
      .slice(0, 16)
  }, [availableSkills, search])

  const overBudget = estimatedUsedTokens > budgetTokens

  function toggleName(name: string) {
    if (selectedNames.includes(name)) {
      onChange(selectedNames.filter((n) => n !== name))
    } else {
      onChange([...selectedNames, name])
    }
  }

  return (
    <div className="space-y-2 rounded-md border bg-muted/10 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-xs font-normal text-muted-foreground">
          {t("novel.craftPreset.chipPickerTitle", { defaultValue: "快速勾选技能芯片（支持搜索）" })}
        </span>
        <span
          data-testid={`task-skill-budget-${taskKey}`}
          className={overBudget ? "font-medium text-destructive" : "text-muted-foreground"}
        >
          {t("novel.craftPreset.budgetUsage", {
            used: estimatedUsedTokens,
            budget: budgetTokens,
            defaultValue: "估算占用：{{used}} / {{budget}} tokens",
          })}
          {overBudget ? t("novel.craftPreset.budgetOver", { defaultValue: "（超出预算将按序截断）" }) : ""}
        </span>
      </div>

      {selectedNames.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selectedNames.map((name) => {
            const exists = skillByName.has(name)
            return (
              <button
                key={name}
                type="button"
                onClick={() => toggleName(name)}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
                  exists
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-warning/60 bg-warning/10 text-warning-foreground"
                }`}
                title={
                  exists
                    ? t("novel.craftPreset.removeSkillTitle", { defaultValue: "点击移除该技能" })
                    : t("novel.craftPreset.missingSkillChipTitle", { defaultValue: "技能库中未找到此名称（请确认拼写或先导入）" })
                }
              >
                <span>{name}</span>
                <span aria-hidden="true">×</span>
              </button>
            )
          })}
        </div>
      ) : null}

      {availableSkills.length > 0 ? (
        <div className="space-y-1.5">
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("novel.craftPreset.searchSkillPlaceholder", { defaultValue: "搜索技能名 / 标签以点击添加..." })}
            className="h-7 text-xs"
          />
          <div className="flex flex-wrap gap-1">
            {filteredCandidates.map((skill) => {
              const active = selectedNames.includes(skill.name)
              return (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => toggleName(skill.name)}
                  className={`rounded border px-2 py-0.5 text-xs transition-colors ${
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "bg-background text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  {active ? "✓ " : "+ "}
                  {skill.name}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function useProjectAvailableWritingSkills(projectPath?: string): UserSkill[] {
  const [skills, setSkills] = useState<UserSkill[]>([])
  useEffect(() => {
    let cancelled = false
    loadUserSkillConfig(projectPath)
      .then((cfg) => {
        if (!cancelled) setSkills(resolveEnabledWritingSkills(cfg))
      })
      .catch(() => {
        if (!cancelled) setSkills([])
      })
    return () => {
      cancelled = true
    }
  }, [projectPath])
  return skills
}
