// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Plus, Trash2 } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import {
  listPreferences,
  addPreferenceForProject,
  deletePreferenceForProject,
} from "@/lib/user-memory/session"
import type { UserPreference } from "@/lib/user-memory/types"

/**
 * 人类可读标签 → 内部 key 前缀映射（PR8 录入门槛：普通作者零内部记号暴露）。
 * 标签即下拉选项；value 由用户输入（数值/文本）。
 */
const PREFERENCE_PRESETS: Array<{ labelKey: string; key: string; category: UserPreference["category"]; hintKey: string }> = [
  { labelKey: "settings.sections.novel.writingPreference.presets.factsWeight", key: "dim:facts", category: "review", hintKey: "settings.sections.novel.writingPreference.presets.factsWeightHint" },
  { labelKey: "settings.sections.novel.writingPreference.presets.plotWeight", key: "dim:plot", category: "review", hintKey: "settings.sections.novel.writingPreference.presets.plotWeightHint" },
  { labelKey: "settings.sections.novel.writingPreference.presets.characterWeight", key: "dim:character", category: "review", hintKey: "settings.sections.novel.writingPreference.presets.characterWeightHint" },
  { labelKey: "settings.sections.novel.writingPreference.presets.pacingWeight", key: "dim:pacing", category: "review", hintKey: "settings.sections.novel.writingPreference.presets.pacingWeightHint" },
  { labelKey: "settings.sections.novel.writingPreference.presets.continuityWeight", key: "dim:continuity", category: "review", hintKey: "settings.sections.novel.writingPreference.presets.continuityWeightHint" },
  { labelKey: "settings.sections.novel.writingPreference.presets.pullWeight", key: "dim:pull", category: "review", hintKey: "settings.sections.novel.writingPreference.presets.pullWeightHint" },
  { labelKey: "settings.sections.novel.writingPreference.presets.vocabBoost", key: "deai_boost:词汇", category: "vocabulary", hintKey: "settings.sections.novel.writingPreference.presets.boostHint" },
  { labelKey: "settings.sections.novel.writingPreference.presets.sentenceBoost", key: "deai_boost:句式", category: "vocabulary", hintKey: "settings.sections.novel.writingPreference.presets.boostHint" },
  { labelKey: "settings.sections.novel.writingPreference.presets.narrativeBoost", key: "deai_boost:叙事", category: "vocabulary", hintKey: "settings.sections.novel.writingPreference.presets.boostHint" },
  { labelKey: "settings.sections.novel.writingPreference.presets.rhythmBoost", key: "deai_boost:节奏", category: "vocabulary", hintKey: "settings.sections.novel.writingPreference.presets.boostHint" },
  { labelKey: "settings.sections.novel.writingPreference.presets.dialogBoost", key: "deai_boost:对白", category: "vocabulary", hintKey: "settings.sections.novel.writingPreference.presets.boostHint" },
  { labelKey: "settings.sections.novel.writingPreference.presets.psychBoost", key: "deai_boost:心理", category: "vocabulary", hintKey: "settings.sections.novel.writingPreference.presets.boostHint" },
  { labelKey: "settings.sections.novel.writingPreference.presets.sceneBoost", key: "deai_boost:场景", category: "vocabulary", hintKey: "settings.sections.novel.writingPreference.presets.boostHint" },
  { labelKey: "settings.sections.novel.writingPreference.presets.avoidWords", key: "avoid_words", category: "vocabulary", hintKey: "settings.sections.novel.writingPreference.presets.avoidWordsHint" },
]

/** 写作偏好区块：平铺列表 + 新增/删除（编辑降级为删后重建，GLM Q2 最小形态）。 */
export function WritingPreferenceSection() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const [prefs, setPrefs] = useState<UserPreference[]>([])
  const [selectedPreset, setSelectedPreset] = useState(PREFERENCE_PRESETS[0]!.key)
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)

  const projectPath = project?.path

  const refresh = async () => {
    if (!projectPath) return
    setPrefs(await listPreferences(projectPath))
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath])

  const preset = useMemo(
    /* v8 ignore next -- select 选项恒来自 PREFERENCE_PRESETS，find 恒命中 */
    () => PREFERENCE_PRESETS.find((p) => p.key === selectedPreset) ?? PREFERENCE_PRESETS[0]!,
    [selectedPreset],
  )

  const handleAdd = async () => {
    if (!projectPath || !value.trim()) return
    setBusy(true)
    try {
      await addPreferenceForProject(projectPath, {
        key: preset.key,
        value: value.trim(),
        category: preset.category,
        label: t(preset.labelKey),
      })
      setValue("")
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!projectPath) return
    setBusy(true)
    try {
      await deletePreferenceForProject(projectPath, id)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div>
        <Label>
          {t("settings.sections.novel.writingPreference.title", { defaultValue: "写作偏好" })}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.novel.writingPreference.description", {
            defaultValue: "个性化审查打分与去 AI 味规则（v2.5.0 手动录入版，自动提炼将在 v2.6 提供）。",
          })}
        </p>
      </div>

      <div className="grid gap-4 rounded-lg border p-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1 space-y-1">
            <Label htmlFor="writing-preference-preset" className="text-xs">
              {t("settings.sections.novel.writingPreference.preset", { defaultValue: "偏好类型" })}
            </Label>
            <select
              id="writing-preference-preset"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={selectedPreset}
              onChange={(e) => setSelectedPreset(e.target.value)}
            >
              {PREFERENCE_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>{t(p.labelKey)}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t(preset.hintKey)}</p>
          </div>
          <div className="min-w-40 flex-1 space-y-1">
            <Label htmlFor="writing-preference-value" className="text-xs">
              {t("settings.sections.novel.writingPreference.value", { defaultValue: "取值" })}
            </Label>
            <Input
              id="writing-preference-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={preset.category === "review" ? "0.3" : "仿佛、不禁"}
            />
          </div>
          <Button type="button" size="sm" onClick={() => void handleAdd()} disabled={busy || !value.trim()}>
            <Plus className="mr-1 h-4 w-4" />
            {t("settings.sections.novel.writingPreference.add", { defaultValue: "添加" })}
          </Button>
        </div>

        {prefs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("settings.sections.novel.writingPreference.empty", { defaultValue: "暂无写作偏好，添加一条开始个性化。" })}
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {prefs.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <span className="font-medium">{p.label ?? p.key}</span>
                  <span className="ml-2 text-muted-foreground">{p.value}</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={busy}
                  onClick={() => void handleDelete(p.id)}
                  aria-label={t("settings.sections.novel.writingPreference.delete", { defaultValue: "删除" })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
