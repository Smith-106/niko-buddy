// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useState, useRef } from "react"
import { useTranslation } from "react-i18next"
import { RefreshCw, Download, CheckCircle, AlertCircle } from "lucide-react"
import { allChangelog } from "@/lib/changelog"
import { isTauri } from "@/lib/platform"
import { formatUpdateErrorMessage } from "@/lib/update-error-message"

type UpdateStatus = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "ready" | "error"
const COLLAPSED_CHANGELOG_ITEM_COUNT = 5

/**
 * Changelog and auto-update section.
 * Displays version history, checks for updates, and handles
 * download + install via the Tauri updater plugin.
 */
export function ChangelogSection() {
  const { t, i18n } = useTranslation()
  const lang: "en" | "zh" = i18n.language?.startsWith("zh") ? "zh" : "en"
  const entries = allChangelog()
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(() => new Set())
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle")
  const [latestVersion, setLatestVersion] = useState("")
  const [updateNotes, setUpdateNotes] = useState("")
  const [errorMessage, setErrorMessage] = useState("")
  const [downloadProgress, setDownloadProgress] = useState(0)
  const updateHandleRef = useRef<unknown>(null)

  /** Check for available updates via Tauri updater. */
  async function handleCheckUpdate() {
    if (!isTauri()) {
      setUpdateStatus("error")
      setErrorMessage(t("settings.sections.changelog.desktopOnly"))
      return
    }
    setUpdateStatus("checking")
    setErrorMessage("")
    setDownloadProgress(0)
    try {
      const { check } = await import("@tauri-apps/plugin-updater")
      const update = await check()
      if (!update) {
        setUpdateStatus("up-to-date")
      } else {
        setUpdateStatus("available")
        setLatestVersion(update.version)
        setUpdateNotes(update.body?.trim() ?? "")
        updateHandleRef.current = update
      }
    } catch (err) {
      setUpdateStatus("error")
      setErrorMessage(formatUpdateErrorMessage(err))
    }
  }

  /** Download the discovered update with progress tracking. */
  async function handleDownloadUpdate() {
    /* v8 ignore next */
    if (!updateHandleRef.current) return
    setUpdateStatus("downloading")
    setDownloadProgress(0)
    try {
      const update = updateHandleRef.current as {
        download: (onEvent?: (event: { event: string; data: { contentLength?: number; chunkLength?: number } }) => void) => Promise<void>
        install: () => Promise<void>
      }
      let totalSize = 0
      let downloaded = 0
      await update.download((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          totalSize = event.data.contentLength
          downloaded = 0
        } else if (event.event === "Progress" && event.data.chunkLength) {
          downloaded += event.data.chunkLength
          if (totalSize > 0) {
            setDownloadProgress(Math.min(Math.round((downloaded / totalSize) * 100), 99))
          } else {
            setDownloadProgress((prev) => Math.min(prev + 1, 99))
          }
        } else if (event.event === "Finished") {
          setDownloadProgress(100)
        }
      })
      // Download complete — wait for user to confirm install.
      setUpdateStatus("ready")
      setDownloadProgress(100)
    } catch (err) {
      setUpdateStatus("error")
      setErrorMessage(formatUpdateErrorMessage(err))
    }
  }

  /** Install the downloaded update (triggers app restart). */
  async function handleInstallNow() {
    /* v8 ignore next */
    if (!updateHandleRef.current) return
    try {
      const update = updateHandleRef.current as { install: () => Promise<void> }
      await update.install()
    } catch {
      // Expected: app restarts during install
    }
  }

  return (
    <div className="space-y-6">
      {/* Header with current version */}
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.changelog.title", { defaultValue: "软件更新日志" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.changelog.currentVersion", { version: __APP_VERSION__ })}
        </p>
      </div>

      {/* Update check area */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleCheckUpdate()}
            disabled={updateStatus === "checking" || updateStatus === "downloading"}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${updateStatus === "checking" ? "animate-spin" : ""}`} />
            {updateStatus === "checking" ? t("settings.sections.changelog.checking") : t("settings.sections.changelog.checkUpdate")}
          </button>

          {updateStatus === "up-to-date" && (
            <span role="status" className="inline-flex items-center gap-1.5 text-sm text-success-foreground">
              <CheckCircle className="h-4 w-4" aria-hidden="true" />
              {t("settings.sections.changelog.upToDate")}
            </span>
          )}

          {updateStatus === "error" && (
            /* v8 ignore start */
            <span role="alert" className="inline-flex items-center gap-1.5 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              {errorMessage || t("settings.sections.changelog.checkFailed")}
            </span>
            /* v8 ignore stop */
          )}
        </div>

        {/* Update available banner */}
        {updateStatus === "available" && (
          <div role="status" className="mt-3 rounded-md border border-warning/60 bg-warning/10 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t("settings.sections.changelog.updateAvailable", { version: latestVersion })}
                </p>
                {updateNotes && (
                  <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{updateNotes}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => void handleDownloadUpdate()}
                className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                {t("settings.sections.changelog.download")}
              </button>
            </div>
          </div>
        )}

        {/* Download progress bar */}
        {updateStatus === "downloading" && (
          <div className="mt-3 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t("settings.sections.changelog.downloading")}</span>
              <span className="font-medium">{downloadProgress}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${downloadProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* Ready to install banner */}
        {updateStatus === "ready" && (
          <div role="status" className="mt-3 rounded-md border border-success/60 bg-success/10 p-3">
            <p className="flex items-start gap-1.5 text-sm font-medium text-foreground">
              <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-success-foreground" aria-hidden="true" />
              <span>{t("settings.sections.changelog.readyToInstall")}</span>
            </p>
            <button
              type="button"
              onClick={() => void handleInstallNow()}
              className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              {t("settings.sections.changelog.installNow")}
            </button>
          </div>
        )}
      </div>

      {/* Full version history */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground">{t("settings.sections.changelog.history")}</h3>
        {entries.map((entry) => {
          const lines = entry.highlights[lang]
          const isExpanded = expandedVersions.has(entry.version)
          const hiddenCount = Math.max(0, lines.length - COLLAPSED_CHANGELOG_ITEM_COUNT)
          const visibleLines = isExpanded ? lines : lines.slice(0, COLLAPSED_CHANGELOG_ITEM_COUNT)
          return (
            <div
              key={entry.version}
              data-changelog-version={entry.version}
              className="rounded-lg border border-border/60 bg-muted/20 p-4"
            >
              <div className="flex items-baseline gap-3">
                <span className={`rounded px-2 py-0.5 text-sm font-semibold ${
                  entry.version === __APP_VERSION__
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground"
                }`}>
                  v{entry.version}
                </span>
                <span className="text-xs text-muted-foreground">{entry.date}</span>
                {entry.version === __APP_VERSION__ && (
                  <span className="text-xs text-success-foreground">{t("settings.sections.changelog.current")}</span>
                )}
              </div>
              <ul className="mt-3 space-y-2 text-sm leading-relaxed text-foreground/90">
                {visibleLines.map((line, i) => (
                  <li key={`changelog-${line.slice(0, 32)}-${i}`} className="flex gap-2">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
              {hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setExpandedVersions((current) => {
                      const next = new Set(current)
                      if (next.has(entry.version)) {
                        next.delete(entry.version)
                      } else {
                        next.add(entry.version)
                      }
                      return next
                    })
                  }}
                  aria-expanded={isExpanded}
                  className="mt-3 inline-flex min-h-6 items-center rounded-sm text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {isExpanded ? t("settings.sections.changelog.collapse") : t("settings.sections.changelog.showMore", { hidden: hiddenCount })}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
