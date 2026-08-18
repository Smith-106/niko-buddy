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
const PREFERENCE_PRESETS: Array<{ label: string; key: string; category: UserPreference["category"]; hint: string }> = [
  { label: "事实一致性权重", key: "dim:facts", category: "review", hint: "0–1 数值，越高越重视事实一致性" },
  { label: "情节权重", key: "dim:plot", category: "review", hint: "0–1 数值，越高越重视情节" },
  { label: "人物权重", key: "dim:character", category: "review", hint: "0–1 数值，越高越重视人物" },
  { label: "节奏权重", key: "dim:pacing", category: "review", hint: "0–1 数值，越高越重视节奏" },
  { label: "连续性权重", key: "dim:continuity", category: "review", hint: "0–1 数值，越高越重视连续性" },
  { label: "拉力权重", key: "dim:pull", category: "review", hint: "0–1 数值，越高越重视阅读拉力" },
  { label: "词汇增强系数", key: "deai_boost:词汇", category: "vocabulary", hint: ">1 加强，<1 减弱" },
  { label: "句式增强系数", key: "deai_boost:句式", category: "vocabulary", hint: ">1 加强，<1 减弱" },
  { label: "叙事增强系数", key: "deai_boost:叙事", category: "vocabulary", hint: ">1 加强，<1 减弱" },
  { label: "节奏增强系数", key: "deai_boost:节奏", category: "vocabulary", hint: ">1 加强，<1 减弱" },
  { label: "对白增强系数", key: "deai_boost:对白", category: "vocabulary", hint: ">1 加强，<1 减弱" },
  { label: "心理描写增强系数", key: "deai_boost:心理", category: "vocabulary", hint: ">1 加强，<1 减弱" },
  { label: "场景增强系数", key: "deai_boost:场景", category: "vocabulary", hint: ">1 加强，<1 减弱" },
  { label: "避用词", key: "avoid_words", category: "vocabulary", hint: "逗号分隔，生成时禁用" },
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
        label: preset.label,
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
                <option key={p.key} value={p.key}>{p.label}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{preset.hint}</p>
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
