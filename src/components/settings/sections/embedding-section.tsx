// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useId, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useWikiStore } from "@/stores/wiki-store"
import {
  dropLegacyVectorTable,
  embedAllPages,
  getEmbeddingCount,
  getLastEmbeddingError,
  getLastReconcileOutcome,
  legacyVectorRowCount,
  type EmbeddingReconcileOutcome,
} from "@/lib/embedding"
import { fetchEmbeddingModelList } from "@/lib/settings-model-list"
import { testSettingsEmbeddingModel } from "@/lib/settings-model-test"
import { ModelSelectInput } from "../model-select-input"
import { ResourceLink } from "../resource-link"
import { SettingsSwitch } from "../settings-widgets"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import { toErrorMessage } from "@/lib/utils"

const SILICONFLOW_RESOURCE_URL = "https://cloud.siliconflow.cn/i/1lKTd7hi"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

type ReindexState =
  | { kind: "idle" }
  | { kind: "running"; done: number; total: number }
  | { kind: "done"; count: number }

function parsePositiveInteger(value: string): number | undefined {
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n)
}

export function EmbeddingSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const ids = useId()
  const panelId = `${ids}-panel`
  const project = useWikiStore((s) => s.project)
  const embeddingConfig = useWikiStore((s) => s.embeddingConfig)
  const offlineMode = useWikiStore((s) => s.offlineMode)
  const setOfflineMode = useWikiStore((s) => s.setOfflineMode)

  const [expanded, setExpanded] = useState(false)
  const [chunkCount, setChunkCount] = useState<number | null>(null)
  const [legacyCount, setLegacyCount] = useState<number>(0)
  const [lastError, setLastError] = useState<string | null>(null)
  const [reindex, setReindex] = useState<ReindexState>({ kind: "idle" })
  /** 重索引尾部的对账结果（B4）；失败/跳过都要可见，不得静默。 */
  const [reconcileOutcome, setReconcileOutcome] = useState<EmbeddingReconcileOutcome | null>(null)
  const [legacyDropped, setLegacyDropped] = useState(false)
  const [testState, setTestState] = useState<{
    loading: boolean
    success: boolean
    message: string
  } | null>(null)
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [modelListState, setModelListState] = useState<{
    loading: boolean
    success: boolean
    message: string
  } | null>(null)

  const refreshStats = useCallback(async () => {
    if (!project) return
    try {
      const [chunks, legacy] = await Promise.all([
        getEmbeddingCount(project.path),
        legacyVectorRowCount(project.path),
      ])
      setChunkCount(chunks)
      setLegacyCount(legacy)
    } catch {
      setChunkCount(null)
    }
    setLastError(getLastEmbeddingError())
  }, [project])

  useEffect(() => {
    void refreshStats()
  }, [refreshStats])

  useEffect(() => {
    setModelOptions([])
    setModelListState(null)
  }, [draft.embeddingEndpoint, draft.embeddingApiKey])

  const handleReindex = useCallback(async () => {
    /* v8 ignore next */
    if (!project) return
    setReindex({ kind: "running", done: 0, total: 0 })
    setReconcileOutcome(null)
    const count = await embedAllPages(project.path, embeddingConfig, (done, total) => {
      setReindex({ kind: "running", done, total })
    })
    setReindex({ kind: "done", count })
    setReconcileOutcome(getLastReconcileOutcome())
    await refreshStats()
  }, [project, embeddingConfig, refreshStats])

  const handleDropLegacy = useCallback(async () => {
    /* v8 ignore next */
    if (!project) return
    try {
      await dropLegacyVectorTable(project.path)
      setLegacyCount(0)
      setLegacyDropped(true)
    } catch (error) {
      // vector_drop_legacy 无本地 catch：此处承接，否则裸 await  rejection
      // 沿 onClick 冒泡为 unhandled rejection 且用户无反馈。
      setLastError(toErrorMessage(error))
    }
  }, [project])

  const showLegacyMigration =
    legacyCount > 0 && (chunkCount === null || chunkCount === 0)
  const hasConfig = Boolean(draft.embeddingEndpoint || draft.embeddingModel)
  const reconcileReport = reconcileOutcome?.status === "ran" ? reconcileOutcome.report : null

  const handleOpenPanel = useCallback(() => {
    setExpanded((prev) => !prev)
  }, [])

  const handleTestModel = useCallback(async () => {
    const hasModel = draft.embeddingModel.trim().length > 0

    if (hasModel) {
      setTestState({
        loading: true,
        success: false,
        message: t("settings.sections.shared.testing"),
      })

      try {
        const result = await testSettingsEmbeddingModel({
          enabled: true,
          endpoint: draft.embeddingEndpoint,
          apiKey: draft.embeddingApiKey,
          model: draft.embeddingModel,
          outputDimensionality: draft.embeddingOutputDimensionality,
          maxChunkChars: draft.embeddingMaxChunkChars,
          overlapChunkChars: draft.embeddingOverlapChunkChars,
        })
        setTestState({
          loading: false,
          success: true,
          message: t("settings.sections.embedding.testSuccessWithDimensions", {
            model: result.model,
            dimensions: result.dimensions,
          }),
        })
      } catch (error) {
        const message = toErrorMessage(error)
        setTestState({
          loading: false,
          success: false,
          message: t("settings.sections.shared.testFailed", {
            message,
          }),
        })
        return
      }
    } else {
      setTestState(null)
    }

    setModelListState({
      loading: true,
      success: false,
      message: t("settings.sections.shared.loadingModels"),
    })

    try {
      const modelList = await fetchEmbeddingModelList({
        enabled: true,
        endpoint: draft.embeddingEndpoint,
        apiKey: draft.embeddingApiKey,
        model: draft.embeddingModel,
        outputDimensionality: draft.embeddingOutputDimensionality,
        maxChunkChars: draft.embeddingMaxChunkChars,
        overlapChunkChars: draft.embeddingOverlapChunkChars,
      })
      setModelOptions(modelList.models)
      setModelListState({
        loading: false,
        success: true,
        message: t("settings.sections.shared.modelListSuccess", { count: modelList.models.length }),
      })
    } catch (error) {
      setModelListState({
        loading: false,
        success: false,
        message: t("settings.sections.shared.modelListFailed", {
          message: toErrorMessage(error),
        }),
      })
    }
  }, [
    draft.embeddingApiKey,
    draft.embeddingEndpoint,
    draft.embeddingMaxChunkChars,
    draft.embeddingModel,
    draft.embeddingOutputDimensionality,
    draft.embeddingOverlapChunkChars,
    t,
  ])

  const isBusy = testState?.loading || modelListState?.loading

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.embedding.title")}</h2>
      </div>

      {/* G10 (39 号修复): 统一离线模式开关 — 短路 embedding/rerank 等可选网络依赖 */}
      <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{t("settings.sections.embedding.offlineMode")}</span>
          <span id={`${ids}-offline-hint`} className="text-xs text-muted-foreground">
            {t("settings.sections.embedding.offlineModeHint")}
          </span>
        </div>
        <SettingsSwitch
          checked={offlineMode}
          onCheckedChange={(next) => setOfflineMode(next)}
          label={t("settings.sections.embedding.offlineMode")}
          describedBy={`${ids}-offline-hint`}
        />
      </div>

      <div
        className={`rounded-lg border transition-colors ${
          draft.embeddingEnabled ? "border-primary/60 bg-primary/5" : "border-border"
        }`}
      >
        <div className="flex items-center gap-3 px-3 py-2.5">
          {/* 单一展开按钮：chevron 只是装饰图标，不再单独占一个 Tab 停靠点 */}
          <button
            type="button"
            onClick={handleOpenPanel}
            aria-expanded={expanded}
            aria-controls={panelId}
            title={expanded ? t("settings.sections.llm.collapse") : t("settings.sections.llm.expand")}
            className="flex min-w-0 flex-1 items-start gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground" aria-hidden="true">
              {expanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </span>
            <span className="block min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{t("settings.sections.embedding.enableLabel")}</span>
              {hasConfig && !draft.embeddingEnabled && (
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {t("settings.sections.llm.configuredBadge")}
                </span>
              )}
              {draft.embeddingEnabled && (
                <span className="shrink-0 rounded-full bg-primary/20 px-1.5 py-0.5 text-xs font-medium text-primary">
                  {t("settings.sections.llm.activeBadge")}
                </span>
              )}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {t("settings.sections.embedding.enableHint")}
            </span>
            </span>
          </button>

          <SettingsSwitch
            checked={draft.embeddingEnabled}
            onCheckedChange={(next) => {
              setDraft("embeddingEnabled", next)
              if (next) setExpanded(true)
            }}
            label={t("settings.sections.embedding.enableLabel")}
          />
        </div>

        {expanded && (
          <div id={panelId} className="space-y-4 border-t bg-background/50 px-4 py-3">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor={`${ids}-endpoint`}>{t("settings.sections.embedding.endpoint")}</Label>
                <ResourceLink
                  href={SILICONFLOW_RESOURCE_URL}
                  title={t("settings.sections.embedding.siliconHint")}
                >
                  {t("settings.sections.embedding.siliconLink")}
                </ResourceLink>
              </div>
              <Input
                id={`${ids}-endpoint`}
                aria-describedby={`${ids}-endpoint-hint`}
                value={draft.embeddingEndpoint}
                onChange={(e) => setDraft("embeddingEndpoint", e.target.value)}
                placeholder="http://127.0.0.1:1234/v1/embeddings"
              />
              <p id={`${ids}-endpoint-hint`} className="text-xs text-muted-foreground">
                {t("settings.sections.embedding.endpointHint")}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${ids}-key`}>{t("settings.sections.embedding.apiKey")}</Label>
              <Input
                id={`${ids}-key`}
                type="password"
                value={draft.embeddingApiKey}
                onChange={(e) => setDraft("embeddingApiKey", e.target.value)}
                placeholder={t("settings.sections.embedding.apiKeyPlaceholder")}
              />
            </div>

            <div className="space-y-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void handleTestModel()}
                disabled={isBusy}
              >
                {isBusy
                  ? t("settings.sections.shared.testing")
                  : t("settings.sections.shared.testModel")}
              </Button>
              {testState?.message ? (
                <p className={`text-xs ${testState.success ? "text-success-foreground" : "text-destructive"}`}>
                  {testState.message}
                </p>
              ) : null}
              {modelListState?.message ? (
                <p className={`text-xs ${modelListState.success ? "text-success-foreground" : "text-destructive"}`}>
                  {modelListState.message}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${ids}-model`}>{t("settings.sections.embedding.model")}</Label>
              <ModelSelectInput
                id={`${ids}-model`}
                value={draft.embeddingModel}
                options={modelOptions}
                onChange={(value) => setDraft("embeddingModel", value)}
                selectPlaceholder={t("settings.sections.shared.modelSelectPlaceholder")}
                inputPlaceholder={t("settings.sections.shared.modelManualPlaceholder")}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${ids}-dims`}>{t("settings.sections.embedding.outputDimensionality")}</Label>
              <Input
                id={`${ids}-dims`}
                aria-describedby={`${ids}-dims-hint`}
                type="number"
                min={1}
                step={1}
                value={draft.embeddingOutputDimensionality ?? ""}
                onChange={(e) => {
                  setDraft("embeddingOutputDimensionality", parsePositiveInteger(e.target.value))
                }}
                placeholder="768"
              />
              <p id={`${ids}-dims-hint`} className="text-xs text-muted-foreground">
                {t("settings.sections.embedding.outputDimensionalityHint")}
              </p>
            </div>

            <div className="space-y-3 rounded-md border p-3">
              <div className="text-sm font-medium">
                {t("settings.sections.embedding.chunking")}
              </div>

              <div className="space-y-2">
                <Label htmlFor={`${ids}-chunk`}>{t("settings.sections.embedding.maxChunkChars")}</Label>
                <Input
                  id={`${ids}-chunk`}
                  aria-describedby={`${ids}-chunk-hint`}
                  type="number"
                  min={200}
                  step={100}
                  value={draft.embeddingMaxChunkChars ?? ""}
                  onChange={(e) => {
                    const v = e.target.value.trim()
                    setDraft(
                      "embeddingMaxChunkChars",
                      v === "" ? undefined : Number(v),
                    )
                  }}
                  placeholder="1000"
                />
                <p id={`${ids}-chunk-hint`} className="text-xs text-muted-foreground">
                  {t("settings.sections.embedding.maxChunkCharsHint")}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor={`${ids}-overlap`}>{t("settings.sections.embedding.overlapChunkChars")}</Label>
                <Input
                  id={`${ids}-overlap`}
                  aria-describedby={`${ids}-overlap-hint`}
                  type="number"
                  min={0}
                  step={50}
                  value={draft.embeddingOverlapChunkChars ?? ""}
                  onChange={(e) => {
                    const v = e.target.value.trim()
                    setDraft(
                      "embeddingOverlapChunkChars",
                      v === "" ? undefined : Number(v),
                    )
                  }}
                  placeholder="200"
                />
                <p id={`${ids}-overlap-hint`} className="text-xs text-muted-foreground">
                  {t("settings.sections.embedding.overlapChunkCharsHint")}
                </p>
              </div>
            </div>

            {showLegacyMigration && (
              <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                <div className="text-sm font-medium text-destructive">
                  {t("settings.sections.embedding.legacyPromptTitle")}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("settings.sections.embedding.legacyPromptBody", { count: legacyCount })}
                </p>
              </div>
            )}

            <div className="space-y-3 rounded-md border p-3">
              <div className="text-sm font-medium">
                {t("settings.sections.embedding.statsHeading")}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.embedding.chunkCount", { count: chunkCount ?? 0 })}
              </p>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReindex}
                  disabled={reindex.kind === "running" || !project}
                >
                  {reindex.kind === "running"
                    ? t("settings.sections.embedding.reindexing", {
                        done: reindex.done,
                        total: reindex.total,
                      })
                    : t("settings.sections.embedding.reindexAll")}
                </Button>

                {legacyCount > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDropLegacy}
                    disabled={!project}
                  >
                    {t("settings.sections.embedding.dropLegacy")}
                  </Button>
                )}
              </div>

              {reindex.kind === "done" && (
                <p className="text-xs text-muted-foreground">
                  {t("settings.sections.embedding.reindexDone", { count: reindex.count })}
                </p>
              )}

              {reconcileReport !== null &&
                (reconcileReport.skipped ? (
                  <p className="text-xs text-muted-foreground">
                    {t("settings.sections.embedding.reconcileSkippedEmpty")}
                  </p>
                ) : reconcileReport.failed_pages.length > 0 ? (
                  <p className="text-xs text-destructive">
                    {t("settings.sections.embedding.reconcileFailedPages", {
                      deleted: reconcileReport.deleted_pages.length,
                      failed: reconcileReport.failed_pages.length,
                      drifted: reconcileReport.drifted,
                    })}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t("settings.sections.embedding.reconcileDone", {
                      deleted: reconcileReport.deleted_pages.length,
                      upserted: reconcileReport.upserted_pages.length,
                      unchanged: reconcileReport.unchanged_pages.length,
                      drifted: reconcileReport.drifted,
                    })}
                  </p>
                ))}

              {reconcileOutcome?.status === "skipped" && (
                <p className="text-xs text-muted-foreground">
                  {t("settings.sections.embedding.reconcileSkipped", {
                    count: reconcileOutcome.failedPageIds.length,
                  })}
                </p>
              )}

              {reconcileOutcome?.status === "failed" && (
                <p className="text-xs text-destructive">
                  {t("settings.sections.embedding.reconcileFailed", {
                    message: reconcileOutcome.error,
                  })}
                </p>
              )}

              {legacyDropped && (
                <p className="text-xs text-muted-foreground">
                  {t("settings.sections.embedding.dropLegacyDone")}
                </p>
              )}

              {lastError && (
                <div className="space-y-1">
                  <div className="text-xs font-medium">
                    {t("settings.sections.embedding.lastErrorHeading")}
                  </div>
                  <pre className="max-h-32 overflow-auto rounded bg-muted/50 p-2 text-xs leading-snug text-muted-foreground">
                    {lastError}
                  </pre>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
