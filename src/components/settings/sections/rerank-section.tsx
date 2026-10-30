// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useEffect, useId, useMemo, useState } from "react"
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useWikiStore } from "@/stores/wiki-store"
import { fetchRerankModelList } from "@/lib/settings-model-list"
import { testSettingsRerankModel } from "@/lib/settings-model-test"
import { normalizeEndpoint } from "@/lib/endpoint-normalizer"
import { ModelSelectInput } from "../model-select-input"
import { ResourceLink } from "../resource-link"
import { CommitNumberInput, SettingsSwitch } from "../settings-widgets"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import type { CustomApiMode, LlmConfig, RerankConfig, SearchRecipeId } from "@/stores/wiki-store"
import { toErrorMessage } from "@/lib/utils"

const SILICONFLOW_RESOURCE_URL = "https://cloud.siliconflow.cn/i/1lKTd7hi"

function normalizeRerankEndpoint(raw: string, mode: CustomApiMode) {
  /* v8 ignore next */
  const trimmed = (raw ?? "").trim()
  if (/^https?:\/\//i.test(trimmed) && /\/rerank\/?$/i.test(trimmed)) {
    const normalized = trimmed.replace(/\/+$/, "")
    return {
      normalized,
      changed: normalized !== trimmed,
      warning: undefined,
    }
  }
  return normalizeEndpoint(raw, mode)
}

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

const PROVIDER_OPTIONS: Array<{ value: LlmConfig["provider"]; label: string }> = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" },
  { value: "ollama", label: "Ollama" },
  // 展示文案在渲染时走 i18n（settings.sections.rerank.providerCustom）
  { value: "custom", label: "custom" },
  { value: "minimax", label: "MiniMax" },
  { value: "claude-code", label: "Claude Code CLI" },
  { value: "codex-cli", label: "Codex CLI" },
]

export function RerankSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const ids = useId()
  const panelId = `${ids}-panel`
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const config = draft.rerankConfig
  const [expanded, setExpanded] = useState(false)
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

  const updateRerankConfig = (patch: Partial<RerankConfig>) => {
    setDraft("rerankConfig", { ...config, ...patch })
  }

  const needsApiKey =
    config.provider !== "ollama" &&
    config.provider !== "claude-code" &&
    config.provider !== "codex-cli"
  const hasConfig = config.useMainLlm || Boolean(config.model || config.customEndpoint || config.ollamaUrl)

  function handleOpenPanel() {
    setExpanded((prev) => !prev)
  }

  useEffect(() => {
    setModelOptions([])
    setModelListState(null)
  }, [config.useMainLlm, config.provider, config.apiKey, config.customEndpoint, config.ollamaUrl, config.apiMode])

  const isBusy = testState?.loading || modelListState?.loading

  async function handleTestModel() {
    const hasModel = config.useMainLlm
      ? llmConfig.model.trim().length > 0
      : config.model.trim().length > 0

    if (hasModel) {
      setTestState({
        loading: true,
        success: false,
        message: t("settings.sections.shared.testing"),
      })

      try {
        const result = await testSettingsRerankModel(llmConfig, config)
        setTestState({
          loading: false,
          success: true,
          message: result.usedMainLlm
            ? t("settings.sections.rerank.testSuccessUsingMainModel", { model: result.model })
            : t("settings.sections.shared.testSuccessWithModel", { model: result.model }),
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
      const modelList = await fetchRerankModelList(llmConfig, config)
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
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.rerank.title")}</h2>
      </div>

      <div
        className={`rounded-lg border transition-colors ${
          config.enabled ? "border-primary/60 bg-primary/5" : "border-border"
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
              <span className="truncate text-sm font-medium">{t("settings.sections.rerank.enableLabel")}</span>
              {hasConfig && !config.enabled && (
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {t("settings.sections.llm.configuredBadge")}
                </span>
              )}
              {config.enabled && (
                <span className="shrink-0 rounded-full bg-primary/20 px-1.5 py-0.5 text-xs font-medium text-primary">
                  {t("settings.sections.llm.activeBadge")}
                </span>
              )}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {t("settings.sections.rerank.enableHint")}
            </span>
            </span>
          </button>

          <SettingsSwitch
            checked={config.enabled}
            onCheckedChange={(next) => {
              updateRerankConfig({ enabled: next })
              if (next) setExpanded(true)
            }}
            label={t("settings.sections.rerank.enableLabel")}
          />
        </div>

        {expanded && (
          <div id={panelId} className="space-y-4 border-t bg-background/50 px-4 py-3">
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.rerank.description")}
            </p>

            <div className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div>
                <Label id={`${ids}-use-main`}>{t("settings.sections.rerank.useMainLlm")}</Label>
                <p id={`${ids}-use-main-hint`} className="text-xs text-muted-foreground">
                  {t("settings.sections.rerank.useMainLlmHint")}
                </p>
              </div>
              <SettingsSwitch
                checked={config.useMainLlm}
                onCheckedChange={(next) => updateRerankConfig({ useMainLlm: next })}
                labelledBy={`${ids}-use-main`}
                describedBy={`${ids}-use-main-hint`}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${ids}-max`}>{t("settings.sections.rerank.maxCandidates")}</Label>
              <CommitNumberInput
                id={`${ids}-max`}
                describedBy={`${ids}-max-hint`}
                min={3}
                max={30}
                value={config.maxCandidates}
                onCommit={(maxCandidates) => updateRerankConfig({ maxCandidates })}
                className="w-24"
              />
              <p id={`${ids}-max-hint`} className="text-xs text-muted-foreground">
                {t("settings.sections.rerank.maxCandidatesHint")}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${ids}-recipe`}>{t("settings.sections.rerank.recipe")}</Label>
              <select
                id={`${ids}-recipe`}
                aria-describedby={`${ids}-recipe-hint`}
                value={config.recipe ?? "default"}
                onChange={(e) => updateRerankConfig({ recipe: e.target.value as SearchRecipeId })}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                <option value="default">{t("settings.sections.rerank.recipeDefault")}</option>
                <option value="diverse">{t("settings.sections.rerank.recipeDiverse")}</option>
                <option value="local">{t("settings.sections.rerank.recipeLocal")}</option>
                <option value="balanced">{t("settings.sections.rerank.recipeBalanced")}</option>
              </select>
              <p id={`${ids}-recipe-hint`} className="text-xs text-muted-foreground">
                {t("settings.sections.rerank.recipeHint")}
              </p>
            </div>

            {!config.useMainLlm && (
              <>
                <div className="space-y-2">
                  <Label htmlFor={`${ids}-provider`}>{t("settings.sections.rerank.provider")}</Label>
                  <select
                    id={`${ids}-provider`}
                    value={config.provider}
                    onChange={(e) => updateRerankConfig({ provider: e.target.value as LlmConfig["provider"] })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    {PROVIDER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.value === "custom" ? t("settings.sections.rerank.providerCustom") : option.label}
                      </option>
                    ))}
                  </select>
                </div>

                {config.provider === "custom" && (
                  <div className="space-y-2">
                    <Label>{t("settings.sections.rerank.apiMode")}</Label>
                    <div className="flex flex-wrap gap-2">
                      {(
                        [
                          { value: "chat_completions", labelKey: "settings.sections.rerank.wireOpenAi" },
                          { value: "anthropic_messages", labelKey: "settings.sections.rerank.wireAnthropic" },
                        ] as const
                      ).map((mode) => {
                        const active = (config.apiMode ?? "chat_completions") === mode.value
                        return (
                          <button
                            key={mode.value}
                            type="button"
                            onClick={() => updateRerankConfig({ apiMode: mode.value as CustomApiMode })}
                            aria-pressed={active}
                            className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                              active
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border hover:bg-accent"
                            }`}
                          >
                            {t(mode.labelKey)}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {config.provider === "custom" && (
                  <RerankEndpointField
                    value={config.customEndpoint}
                    mode={config.apiMode ?? "chat_completions"}
                    placeholder="https://your-api.example.com/v1"
                    onChange={(value) => updateRerankConfig({ customEndpoint: value })}
                  />
                )}

                {config.provider === "ollama" && (
                  <div className="space-y-2">
                    <Label htmlFor={`${ids}-ollama`}>{t("settings.sections.rerank.endpoint")}</Label>
                    <Input
                      id={`${ids}-ollama`}
                      value={config.ollamaUrl}
                      onChange={(e) => updateRerankConfig({ ollamaUrl: e.target.value })}
                      placeholder="http://127.0.0.1:11434"
                    />
                  </div>
                )}

                {needsApiKey && (
                  <div className="space-y-2">
                    <Label htmlFor={`${ids}-key`}>{t("settings.sections.rerank.apiKey")}</Label>
                    <Input
                      id={`${ids}-key`}
                      type="password"
                      value={config.apiKey}
                      onChange={(e) => updateRerankConfig({ apiKey: e.target.value })}
                      placeholder={t("settings.sections.rerank.apiKeyPlaceholder")}
                    />
                  </div>
                )}

                <div className="space-y-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={isBusy}
                    onClick={() => void handleTestModel()}
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
                  <Label htmlFor={`${ids}-model`}>{t("settings.sections.rerank.model")}</Label>
                  <ModelSelectInput
                    id={`${ids}-model`}
                    value={config.model}
                    options={modelOptions}
                    onChange={(value) => updateRerankConfig({ model: value })}
                    selectPlaceholder={t("settings.sections.shared.modelSelectPlaceholder")}
                    inputPlaceholder={t("settings.sections.shared.modelManualPlaceholder")}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("settings.sections.rerank.modelHint")}
                  </p>
                </div>
              </>
            )}

            {config.useMainLlm && (
              <div className="space-y-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={isBusy}
                  onClick={() => void handleTestModel()}
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
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function RerankEndpointField({
  value,
  mode,
  placeholder,
  onChange,
}: {
  value: string
  mode: CustomApiMode
  placeholder: string
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const inputId = useId()
  const preview = useMemo(() => normalizeRerankEndpoint(value, mode), [mode, value])

  function handleBlur() {
    if (preview.changed && preview.normalized !== value.trim()) {
      onChange(preview.normalized)
    }
  }

  const showHint = value.trim().length > 0 && (preview.changed || preview.warning)

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={inputId}>{t("settings.sections.rerank.endpoint")}</Label>
        <ResourceLink
          href={SILICONFLOW_RESOURCE_URL}
          title={t("settings.sections.rerank.siliconHint")}
        >
          {t("settings.sections.rerank.siliconLink")}
        </ResourceLink>
      </div>
      <Input
        id={inputId}
        aria-describedby={showHint ? `${inputId}-hint` : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={handleBlur}
        placeholder={placeholder}
      />
      {showHint ? (
        <div
          id={`${inputId}-hint`}
          className={`flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${
            preview.changed
              ? "border-warning/40 bg-warning/5 text-warning-foreground"
              : "border-info/40 bg-info/5 text-info"
          }`}
        >
          {preview.changed ? (
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1 space-y-0.5">
            {preview.changed ? (
              <div>
                {t("settings.sections.llm.endpointPreviewWillUse")}{" "}
                <span className="break-all font-mono">{preview.normalized}</span>
              </div>
            ) : null}
            {preview.warning ? <div>{preview.warning}</div> : null}
            {preview.changed ? <div>{t("settings.sections.llm.endpointPreviewAutoApply")}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
