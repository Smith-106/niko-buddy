// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useId } from "react"
import { useTranslation } from "react-i18next"
import { Label } from "@/components/ui/label"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

/** Supported UI language options（语言名用各自母语书写，不随界面语言翻译）。 */
const UI_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
]

/** Font size scale presets（labelKey 走 i18n，defaultLabel 为中文兜底）。 */
const FONT_SIZE_PRESETS = [
  { labelKey: "small", defaultLabel: "小", value: 0.9 },
  { labelKey: "default", defaultLabel: "默认", value: 1 },
  { labelKey: "large", defaultLabel: "大", value: 1.15 },
  { labelKey: "extraLarge", defaultLabel: "特大", value: 1.3 },
]

const CHOICE_FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

/**
 * Interface settings section: UI language and font size configuration.
 */
export function InterfaceSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const scalePercent = Math.round(draft.uiFontSizeScale * 100)
  const ids = useId()
  const languageLabelId = `${ids}-language`
  const fontSliderId = `${ids}-font-size`
  const fontHintId = `${ids}-font-hint`

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
        <span id={languageLabelId} className="block text-sm leading-none font-medium">
          {t("settings.sections.interface.uiLanguage")}
        </span>
        <div role="group" aria-labelledby={languageLabelId} className="flex flex-wrap gap-2">
          {UI_LANGUAGES.map((lang) => {
            const isActive = draft.uiLanguage === lang.value
            return (
              <button
                key={lang.value}
                type="button"
                lang={lang.value}
                aria-pressed={isActive}
                onClick={() => setDraft("uiLanguage", lang.value)}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${CHOICE_FOCUS} ${
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
          <Label htmlFor={fontSliderId}>{t("settings.sections.interface.fontSize")}</Label>
          <span className="text-xs text-muted-foreground">{scalePercent}%</span>
        </div>
        <input
          id={fontSliderId}
          type="range"
          min={85}
          max={130}
          step={5}
          value={scalePercent}
          onChange={(e) => setDraft("uiFontSizeScale", Number(e.target.value) / 100)}
          className="w-full accent-primary"
          aria-describedby={fontHintId}
        />
        <div
          role="group"
          aria-label={t("settings.sections.interface.fontSizePresets", { defaultValue: "字号预设" })}
          className="flex flex-wrap gap-2"
        >
          {FONT_SIZE_PRESETS.map((preset) => {
            const isActive = Math.abs(draft.uiFontSizeScale - preset.value) < 0.001
            return (
              <button
                key={preset.value}
                type="button"
                aria-pressed={isActive}
                onClick={() => setDraft("uiFontSizeScale", preset.value)}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${CHOICE_FOCUS} ${
                  isActive
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-accent"
                }`}
              >
                {t(`settings.sections.interface.fontPresets.${preset.labelKey}`, { defaultValue: preset.defaultLabel })}
              </button>
            )
          })}
        </div>
        <p id={fontHintId} className="text-xs text-muted-foreground">
          {t("settings.sections.interface.fontSizeHint", { defaultValue: "调整整个应用的字号，保存后立即生效。" })}
        </p>
      </div>
    </div>
  )
}
