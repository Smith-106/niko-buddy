// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useTranslation } from "react-i18next"
import { Label } from "@/components/ui/label"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

/** Supported UI language options. */
const UI_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
]

/** Font size scale presets with Chinese labels. */
const FONT_SIZE_PRESETS = [
  { label: "小", value: 0.9 },
  { label: "默认", value: 1 },
  { label: "大", value: 1.15 },
  { label: "特大", value: 1.3 },
]

/**
 * Interface settings section: UI language and font size configuration.
 */
export function InterfaceSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const scalePercent = Math.round(draft.uiFontSizeScale * 100)

  return (
    <div className="space-y-6">
      {/* Section header */}
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.interface.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.interface.description")}
        </p>
      </div>

      {/* UI language selector */}
      <div className="space-y-2">
        <Label>{t("settings.sections.interface.uiLanguage")}</Label>
        <div className="flex flex-wrap gap-2">
          {UI_LANGUAGES.map((lang) => {
            const isActive = draft.uiLanguage === lang.value
            return (
              <button
                key={lang.value}
                type="button"
                onClick={() => setDraft("uiLanguage", lang.value)}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  isActive
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-accent"
                }`}
              >
                {lang.label}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.interface.uiLanguageHint")}
        </p>
      </div>

      {/* Font size slider + presets */}
      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <Label>界面字号</Label>
          <span className="text-xs text-muted-foreground">{scalePercent}%</span>
        </div>
        <input
          type="range"
          min={85}
          max={130}
          step={5}
          value={scalePercent}
          onChange={(e) => setDraft("uiFontSizeScale", Number(e.target.value) / 100)}
          className="w-full accent-primary"
          aria-label="界面字号"
        />
        <div className="flex flex-wrap gap-2">
          {FONT_SIZE_PRESETS.map((preset) => {
            const isActive = Math.abs(draft.uiFontSizeScale - preset.value) < 0.001
            return (
              <button
                key={preset.value}
                type="button"
                onClick={() => setDraft("uiFontSizeScale", preset.value)}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  isActive
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-accent"
                }`}
              >
                {preset.label}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          调整整个应用的字号，保存后立即生效。
        </p>
      </div>
    </div>
  )
}
