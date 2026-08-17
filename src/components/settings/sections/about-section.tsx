// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useTranslation } from "react-i18next"

/**
 * About section displaying application metadata such as version info.
 */
export function AboutSection() {
  const { t } = useTranslation()

  const infoRows: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: t("settings.sections.about.version"), value: `v${__APP_VERSION__}`, mono: true },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.about.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.about.description")}
        </p>
      </div>

      <div className="rounded-md border divide-y">
        {infoRows.map((row) => (
          <div key={row.label} className="flex items-center justify-between px-4 py-2.5">
            <span className="text-sm text-muted-foreground">{row.label}</span>
            <span className={`text-sm ${/* v8 ignore next */ row.mono ? "font-mono" : ""}`}>{row.value}</span>
          </div>
        ))}
      </div>

    </div>
  )
}
