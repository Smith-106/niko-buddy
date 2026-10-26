import { useEffect, useMemo, useState, useRef } from "react"
import { ChevronDown, ChevronRight, AlertCircle, CheckCircle2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useWikiStore, type ProviderOverride, type ReasoningConfig, type ReasoningMode, type SavedModel } from "@/stores/wiki-store"
import { type LlmPreset } from "@/lib/llm-config/llm-presets"
import { ContextSizeSelector } from "../context-size-selector"
import { clampHttpTimeoutMs, resolveConfig } from "@/lib/llm-config/preset-resolver"
import { normalizeEndpoint } from "@/lib/endpoint-normalizer"
import { AZURE_OPENAI_API_VERSION } from "@/lib/azure-openai"
import { fetchLlmModelList } from "@/lib/settings-model-list"
import { useBatchModelTest } from "../hooks/use-batch-model-test"
import { ModelSelectInput } from "../model-select-input"
import { SavedModelsManager } from "./saved-models-manager"
import { toErrorMessage } from "@/lib/utils"
import {
  AntigravityCliStatusPill,
  ClaudeCliStatusPill,
  CodexCliStatusPill,
  CursorProxyStatusBadge,
} from "./llm-provider-cli-pills"

export type { CursorProxyStatusPayload, DetectResult } from "./llm-provider-cli-pills"
export {
  AntigravityCliStatusPill,
  ClaudeCliStatusPill,
  CodexCliStatusPill,
  CursorProxyStatusBadge,
  proxyEndpointLabel,
} from "./llm-provider-cli-pills"

export interface PresetRowProps {
  preset: LlmPreset
  override: ProviderOverride | undefined
  isActive: boolean
  isEnabled: boolean
  isExpanded: boolean
  savedHere: boolean
  onToggleActive: () => void
  onToggleEnabled: () => void
  onToggleExpand: () => void
  onChange: (patch: ProviderOverride) => void
}

export type ModelActionState =
  | { loading: boolean; success: boolean; message: string }
  | null

export function PresetRow({
  preset,
  override,
  isActive: _isActive,
  isEnabled,
  isExpanded,
  savedHere,
  onToggleActive: _onToggleActive,
  onToggleEnabled,
  onToggleExpand,
  onChange,
}: PresetRowProps) {
  const { t } = useTranslation()
  const ov = override ?? {}
  const model = ov.model?.trim() || preset.defaultModel || ""
  const apiKey = ov.apiKey ?? ""
  const apiMode = ov.apiMode ?? preset.apiMode ?? "chat_completions"
  const baseUrl = ov.baseUrl ?? preset.baseUrl ?? ""
  const azureApiVersion = ov.azureApiVersion ?? preset.azureApiVersion ?? AZURE_OPENAI_API_VERSION
  const azureModelFamily = ov.azureModelFamily ?? preset.azureModelFamily ?? "auto"
  const context = ov.maxContextSize ?? preset.suggestedContextSize ?? 131072
  const reasoning = ov.reasoning ?? { mode: "auto" as const }
  const localCliIsolation = ov.localCliIsolation === true
  const codexCliTimeoutMinutes = Math.max(1, Math.min(240, ov.codexCliTimeoutMinutes ?? 10))
  const isLocalCliProvider = preset.provider === "claude-code" || preset.provider === "codex-cli" || preset.provider === "antigravity-cli"
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [modelListState, setModelListState] = useState<ModelActionState>(null)
  const [isModelSelectionExpanded, setIsModelSelectionExpanded] = useState(false)
  const savedModelsTextareaRef = useRef<HTMLTextAreaElement>(null)
  const { modelTestState, runBatchTest, retryFailed } = useBatchModelTest(t)
  const hasConfig = !!apiKey || !!ov.baseUrl || !!ov.model || !!ov.azureApiVersion || !!ov.azureModelFamily
  // Local CLI providers authenticate via their own existing login state
  // (inherited by the spawned subprocess), so no API key field is shown.
  // Ollama ditto for its local-only model.
  const needsApiKey =
    preset.provider !== "ollama" &&
    preset.provider !== "claude-code" &&
    preset.provider !== "codex-cli" &&
    preset.provider !== "antigravity-cli" &&
    preset.provider !== "cursor-cli"

  const resolvedConfig = useMemo(
    () => resolveConfig(preset, ov, useWikiStore.getState().llmConfig),
    [apiKey, apiMode, azureApiVersion, azureModelFamily, baseUrl, context, model, preset, reasoning, ov],
  )

  useEffect(() => {
    setModelOptions([])
    setModelListState(null)
  }, [apiKey, apiMode, baseUrl, preset.id, preset.provider])

  async function loadModelOptions() {
    setModelListState({
      loading: true,
      success: false,
      message: t("settings.sections.shared.loadingModels"),
    })

    try {
      const result = await fetchLlmModelList(resolvedConfig)
      setModelOptions(result.models)

      // 拉取成功后自动展开模型选择区域
      setIsModelSelectionExpanded(true)

      setModelListState({
        loading: false,
        success: true,
        message: t("settings.sections.shared.modelListSuccess", { count: result.models.length }),
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

  function toggleModelSelection(modelId: string) {
    const currentSaved = ov.savedModels ?? []
    const isSelected = currentSaved.some((m) => m.model === modelId)

    let updatedModels: SavedModel[]

    if (isSelected) {
      updatedModels = currentSaved.filter((m) => m.model !== modelId)
    } else {
      const newModel: SavedModel = {
        id: `model-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: modelId,
        model: modelId,
        apiKey: apiKey,
        customEndpoint: baseUrl,
        createdAt: Date.now(),
      }
      updatedModels = [...currentSaved, newModel]
    }

    onChange({ savedModels: updatedModels })
  }

  async function runSelectedModelTest() {
    const savedModels = ov.savedModels ?? []
    const modelsToTest = savedModels.length > 0
      ? savedModels.map((m) => m.model)
      : [model]
    await runBatchTest(modelsToTest, (modelId) => ({ ...resolvedConfig, model: modelId }))
  }

  return (
    <div
      className={`rounded-lg border transition-colors ${
        isEnabled ? "border-primary/60 bg-primary/5" : "border-border"
      }`}
    >
      {/* Outer row — always visible */}
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={onToggleExpand}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent"
          title={isExpanded ? t("settings.sections.llm.collapse") : t("settings.sections.llm.expand")}
        >
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0" />
          )}
        </button>

        <button
          type="button"
          onClick={onToggleExpand}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate text-sm font-medium min-w-0">{preset.label}</span>
            {hasConfig && !isEnabled && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {t("settings.sections.llm.configuredBadge")}
              </span>
            )}
            {isEnabled && (ov.savedModels ?? []).length > 0 && (
              <span className="shrink-0 rounded-full bg-primary/20 px-1.5 py-0.5 text-xs font-medium text-primary">
                { /* v8 ignore start */ }
                {t("settings.sections.llm.enabledBadge", { count: (ov.savedModels ?? []).length })}
                { /* v8 ignore stop */ }
              </span>
            )}
            {savedHere && (
              <span className="shrink-0 text-xs text-success">{t("settings.sections.llm.savedBadge")}</span>
            )}
          </div>
          {preset.hint && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground min-w-0">
              {preset.hint}
            </div>
          )}
        </button>

        {/* Toggle switch — 启用/停用 */}
        <button
          type="button"
          onClick={onToggleEnabled}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
            isEnabled
              ? "border-primary bg-primary"
              : "border-muted-foreground/30 bg-muted-foreground/20 hover:bg-muted-foreground/30"
          }`}
          title={isEnabled ? t("settings.sections.llm.toggleOff") : t("settings.sections.llm.toggleOn")}
          aria-label={isEnabled ? t("settings.sections.llm.deactivate") : t("settings.sections.llm.activate")}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white elevation-1 ring-1 ring-black/10 transition-transform ${
              isEnabled ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {/* Expanded config panel */}
      {isExpanded && (
        <div className="space-y-4 border-t bg-background/50 px-4 py-3">
          {preset.provider === "custom" && (
            <div className="space-y-2">
              <Label>{t("settings.sections.llm.apiMode")}</Label>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    { value: "chat_completions", labelKey: "settings.sections.llm.wireOpenAi" },
                    { value: "responses", labelKey: "settings.sections.llm.wireResponses" },
                    { value: "anthropic_messages", labelKey: "settings.sections.llm.wireAnthropic" },
                  ] as const
                ).map((m) => {
                  const active = apiMode === m.value
                  return (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => {
                        // When a preset declares different base URLs for
                        // each wire (e.g. Bailian Coding Plan: /v1 for
                        // OpenAI, /apps/anthropic for Anthropic), flip
                        // the URL alongside the mode so users don't have
                        // to know both URLs or edit manually.
                        const patch: ProviderOverride = { apiMode: m.value }
                        const nextBaseUrl = preset.baseUrlByMode?.[m.value]
                        if (nextBaseUrl) patch.baseUrl = nextBaseUrl
                        onChange(patch)
                      }}
                      aria-label={t(m.labelKey)}
                      className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border hover:bg-accent"
                      }`}
                    >
                      {t(m.labelKey)}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {(preset.provider === "custom" || preset.provider === "ollama" || preset.provider === "azure") && (
            <EndpointField
              value={baseUrl}
              mode={preset.provider === "azure" ? "azure" : apiMode}
              placeholder={preset.baseUrl ?? "https://your-api.example.com/v1"}
              onChange={(v) => onChange({ baseUrl: v })}
            />
          )}

          {preset.provider === "azure" && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>{t("settings.sections.llm.azureApiVersion")}</Label>
                <Input
                  value={azureApiVersion}
                  onChange={(e) => onChange({ azureApiVersion: e.target.value })}
                  placeholder="2024-10-21"
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.sections.llm.azureApiVersionHint")}
                </p>
              </div>
              <div className="space-y-2">
                <Label>{t("settings.sections.llm.azureModelFamily")}</Label>
                <select
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={azureModelFamily}
                  onChange={(e) => onChange({ azureModelFamily: e.target.value as typeof azureModelFamily })}
                >
                  <option value="auto">{t("settings.sections.llm.azureModelFamilyAuto")}</option>
                  <option value="gpt5">{t("settings.sections.llm.azureModelFamilyGpt5")}</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  {t("settings.sections.llm.azureModelFamilyHint")}
                </p>
              </div>
            </div>
          )}

          {preset.provider === "claude-code" && <ClaudeCliStatusPill />}
          {preset.provider === "codex-cli" && <CodexCliStatusPill />}
          {preset.provider === "antigravity-cli" && <AntigravityCliStatusPill />}
          {preset.provider === "cursor-cli" && <CursorProxyStatusBadge />}

          {isLocalCliProvider && (
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">
                    {t("settings.sections.llm.localCliIsolation")}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("settings.sections.llm.localCliIsolationHint")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onChange({ localCliIsolation: !localCliIsolation })}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
                    localCliIsolation
                      ? "border-primary bg-primary"
                      : "border-muted-foreground/30 bg-muted-foreground/20 hover:bg-muted-foreground/30"
                  }`}
                  title={
                    localCliIsolation
                      ? t("settings.sections.llm.localCliIsolationOn")
                      : t("settings.sections.llm.localCliIsolationOff")
                  }
                  aria-label={t("settings.sections.llm.localCliIsolation")}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-white elevation-1 ring-1 ring-black/10 transition-transform ${
                      localCliIsolation ? "translate-x-4" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
              <div className="rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
                {localCliIsolation
                  ? t("settings.sections.llm.localCliIsolationOn")
                  : t("settings.sections.llm.localCliIsolationOff")}
              </div>
            </div>
          )}

          {preset.provider === "codex-cli" && (
            <div className="space-y-2 rounded-md border p-3">
              <Label>{t("settings.sections.llm.codexCliTimeout")}</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={240}
                  className="w-28"
                  value={codexCliTimeoutMinutes}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    /* v8 ignore next -- number input 值恒有限，falsy 不可达 */
                    const timeout = Number.isFinite(n)
                      ? Math.max(1, Math.min(240, Math.floor(n)))
                      : undefined
                    onChange({ codexCliTimeoutMinutes: timeout })
                  }}
                />
                <span className="text-xs text-muted-foreground">
                  {t("settings.sections.llm.codexCliTimeoutUnit")}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.llm.codexCliTimeoutHint")}
              </p>
            </div>
          )}

          {needsApiKey && (
            <div className="space-y-2">
              <Label>{t("settings.sections.llm.apiKey")}</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => onChange({ apiKey: e.target.value })}
                placeholder={
                  preset.provider === "custom"
                    ? t("settings.sections.llm.apiKeyPlaceholderCustom")
                    : t("settings.sections.llm.apiKeyPlaceholder")
                }
              />
            </div>
          )}

          <div className="space-y-2">
            <Label>
              {preset.provider === "azure"
                ? t("settings.sections.llm.deploymentName", "Deployment name")
                : t("settings.sections.llm.model")}
            </Label>
            <ModelPicker
              value={model}
              suggestions={preset.suggestedModels ?? []}
              fetchedModels={modelOptions}
              placeholder={preset.defaultModel ?? "e.g. gpt-4o"}
              selectPlaceholder={t("settings.sections.shared.modelSelectPlaceholder")}
              inputPlaceholder={t("settings.sections.shared.modelManualPlaceholder")}
              onChange={(v) => onChange({ model: v })}
            />
          </div>

          {/* 拉取模型后的多选标签区域 */}
          {modelOptions.length > 0 && (
            <div className="space-y-2 border-t pt-4">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setIsModelSelectionExpanded(!isModelSelectionExpanded)}
                  aria-label={`${t("settings.sections.llm.fetchedModelsCount", { count: modelOptions.length })} ${t("settings.sections.llm.selectedModelsCount", { count: (ov.savedModels ?? []).length })}`}
                  className="flex items-center gap-2 text-xs font-medium hover:text-primary"
                >
                  <span>{t("settings.sections.llm.fetchedModelsCount", { count: modelOptions.length })}</span>
                  <span className="text-muted-foreground">{t("settings.sections.llm.selectedModelsCount", { count: (ov.savedModels ?? []).length })}</span>
                </button>
              </div>

              {isModelSelectionExpanded && (
                <>
                  <div className="text-xs text-muted-foreground">
                    {t("settings.sections.llm.toggleModelHint")}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {modelOptions.map((modelId) => {
                      const isSelected = (ov.savedModels ?? []).some((m) => m.model === modelId)
                      return (
                        <button
                          key={modelId}
                          type="button"
                          onClick={() => toggleModelSelection(modelId)}
                          className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                            isSelected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-background hover:bg-accent"
                          }`}
                        >
                          {modelId}
                        </button>
                      )
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {/* 已选模型显示 */}
          {(ov.savedModels ?? []).length > 0 && (() => {
            /* v8 ignore next -- 渲染条件保证 savedModels 非空 */
            const savedModelsText = (ov.savedModels ?? []).map((m) => m.model).join(", ")
            return (
              <div className="space-y-2">
                <Label className="text-xs">{t("settings.sections.llm.selectedModels")}</Label>
                <textarea
                  ref={savedModelsTextareaRef}
                  value={savedModelsText}
                  readOnly
                  placeholder={t("settings.sections.llm.pleaseFetchModels")}
                  className="flex min-h-[40px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
                  rows={1}
                />
              </div>
            )
          })()}

          <SavedModelsManager
            savedModels={ov.savedModels ?? []}
            onChange={(models) => onChange({ savedModels: models })}
          />

          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void loadModelOptions()}
                disabled={modelListState?.loading || modelTestState?.loading}
                aria-label={modelListState?.loading ? t("settings.sections.llm.loadingModels") : t("settings.sections.llm.fetchModels")}
                className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                {modelListState?.loading
                  ? t("settings.sections.llm.loadingModels")
                  : t("settings.sections.llm.fetchModels")}
              </button>
              <button
                type="button"
                onClick={() => void runSelectedModelTest()}
                disabled={modelListState?.loading || modelTestState?.loading}
                aria-label={modelTestState?.loading ? t("settings.sections.shared.testing") : t("settings.sections.shared.testModel")}
                className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                {modelTestState?.loading
                  ? t("settings.sections.shared.testing")
                  : t("settings.sections.shared.testModel")}
              </button>
            </div>
            {modelListState?.message ? (
              <p className={`text-xs ${modelListState.success ? "text-success" : "text-destructive"}`}>
                {modelListState.message}
              </p>
            ) : null}
            {modelTestState?.message ? (
              <div className="space-y-1.5">
                <p className={`text-xs ${modelTestState.success ? "text-success" : "text-destructive"}`}>
                  {modelTestState.message}
                </p>
                {modelTestState.failedModels && modelTestState.failedModels.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">{t("settings.sections.shared.failedModel")}</span>
                    {modelTestState.failedModels.map((failedModel) => (
                      <span
                        key={failedModel}
                        className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive"
                      >
                        {failedModel}
                      </span>
                    ))}
                    <button
                      type="button"
                      onClick={() => void retryFailed((modelId) => ({ ...resolvedConfig, model: modelId }))}
                      disabled={modelTestState.loading}
                      className="rounded-md border border-destructive/30 px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      重试失败模型
                    </button>
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label>{t("settings.sections.llm.contextWindow")}</Label>
            <ContextSizeSelector
              value={context}
              onChange={(v) => onChange({ maxContextSize: v })}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("settings.sections.llm.maxOutputTokens")}</Label>
            <Input
              type="number"
              min={256}
              step={256}
              placeholder="4096"
              value={ov.maxOutputTokens ?? ""}
              onChange={(e) => {
                const raw = e.target.value.trim()
                onChange({ maxOutputTokens: raw === "" ? undefined : Math.max(256, Number(raw) || 4096) })
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.llm.maxOutputTokensHint")}
            </p>
          </div>

          {/* HTTP transport only — subprocess CLI providers never reach the HTTP timeouts. */}
          {!isLocalCliProvider && (
            <HttpTimeoutControls
              value={{
                httpConnectTimeoutMs: ov.httpConnectTimeoutMs,
                httpHeaderTimeoutMs: ov.httpHeaderTimeoutMs,
                httpStreamIdleMs: ov.httpStreamIdleMs,
              }}
              onChange={(patch) => onChange(patch)}
            />
          )}

          <ReasoningControls
            value={reasoning}
            onChange={(reasoning) => onChange({ reasoning })}
          />
        </div>
      )}
    </div>
  )
}

/**
 * HTTP 三档超时输入 (单位: 秒, 存毫秒)。留空 = undefined = 沿用各档硬编码默认。
 * PresetRow 与 CustomProviderCard 共用, 与 ReasoningControls 同级的纯展示组件。
 */

export interface EndpointFieldProps {
  value: string
  mode: "chat_completions" | "responses" | "anthropic_messages" | "azure"
  placeholder: string
  onChange: (value: string) => void
}

/**
 * Endpoint input with live feedback + auto-fix on blur. The hint line
 * below the field tells the user what we'd normalize to (and why) while
 * they're typing; the input doesn't nag — it just shows the preview. On
 * blur, if normalization would change the value, we apply it.
 */
export function EndpointField({ value, mode, placeholder, onChange }: EndpointFieldProps) {
  const { t } = useTranslation()
  const preview = useMemo(() => normalizeEndpoint(value, mode), [value, mode])

  function handleBlur() {
    if (preview.changed && preview.normalized !== value.trim()) {
      onChange(preview.normalized)
    }
  }

  const showHint = value.trim().length > 0 && (preview.changed || preview.warning)

  return (
    <div className="space-y-1.5">
      <Label>{t("settings.sections.llm.endpoint")}</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={handleBlur}
        placeholder={placeholder}
      />
      {showHint && (
        <div
          className={`flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${
            preview.changed
              ? "border-warning/40 bg-warning/5 text-warning"
              : "border-info/40 bg-info/5 text-info"
          }`}
        >
          {preview.changed ? (
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <div className="min-w-0 flex-1 space-y-0.5">
            {preview.changed && (
              <div>
                {t("settings.sections.llm.endpointPreviewWillUse")}{" "}
                <code className="break-all rounded bg-background/60 px-1 py-0.5 font-mono">
                  {preview.normalized || "(empty)"}
                </code>
                <span className="ml-1 text-muted-foreground">
                  {t("settings.sections.llm.endpointPreviewAutoApply")}
                </span>
              </div>
            )}
            {preview.warning && <div>{preview.warning}</div>}
          </div>
        </div>
      )}
    </div>
  )
}

export interface ModelPickerProps {
  value: string
  suggestions: string[]
  fetchedModels: string[]
  placeholder: string
  selectPlaceholder: string
  inputPlaceholder: string
  onChange: (value: string) => void
}

/**
 * Model input with a chip-based suggestion row above it. The input stays
 * free-text so users can always type unlisted models (fine-tunes, preview
 * IDs, local Ollama tags, etc.). Clicking a chip just fills the input.
 *
 * The currently-selected chip (if the value matches one of the suggestions)
 * gets the accent highlight so users can see at a glance which preset
 * model is active without reading the text field. Presets with no
 * `suggestedModels` render the input alone.
 */
export function ModelPicker({
  value,
  suggestions,
  fetchedModels,
  placeholder,
  selectPlaceholder,
  inputPlaceholder,
  onChange,
}: ModelPickerProps) {
  const { t } = useTranslation()
  const hasSuggestions = suggestions.length > 0
  const isCustom = hasSuggestions && value.length > 0 && !suggestions.includes(value)
  const mergedOptions = useMemo(
    () => Array.from(new Set([...fetchedModels, value].map((item) => item.trim()).filter(Boolean))),
    [fetchedModels, value],
  )

  return (
    <div className="space-y-2">
      {hasSuggestions && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((m) => {
            const active = m === value
            return (
              <button
                key={m}
                type="button"
                onClick={() => onChange(m)}
                className={`rounded-md border px-2 py-0.5 text-xs font-mono transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background hover:bg-accent hover:text-accent-foreground"
                }`}
                title={t("settings.sections.llm.useModel", { model: m })}
              >
                {m}
              </button>
            )
          })}
          <button
            type="button"
            onClick={() => onChange("")}
            className={`rounded-md border px-2 py-0.5 text-xs transition-colors ${
              isCustom
                ? "border-primary/60 bg-primary/10 text-primary"
                : "border-dashed border-muted-foreground/40 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            }`}
            title={t("settings.sections.llm.typeCustomModel")}
          >
            {isCustom
              ? t("settings.sections.llm.customModelBadge", { model: value })
              : t("settings.sections.llm.customModel")}
          </button>
        </div>
      )}
      <ModelSelectInput
        value={value}
        options={mergedOptions}
        onChange={onChange}
        selectPlaceholder={selectPlaceholder}
        inputPlaceholder={inputPlaceholder || placeholder}
      />
    </div>
  )
}

export function HttpTimeoutControls({
  value,
  onChange,
}: {
  value: {
    httpConnectTimeoutMs?: number
    httpHeaderTimeoutMs?: number
    httpStreamIdleMs?: number
  }
  onChange: (patch: {
    httpConnectTimeoutMs?: number
    httpHeaderTimeoutMs?: number
    httpStreamIdleMs?: number
  }) => void
}) {
  const { t } = useTranslation()
  const editTimeout = (
    key: "httpConnectTimeoutMs" | "httpHeaderTimeoutMs" | "httpStreamIdleMs",
    raw: string,
  ) => {
    const ms = raw.trim() === "" ? undefined : clampHttpTimeoutMs(Number(raw.trim()) * 1000, key)
    if (key === "httpConnectTimeoutMs") onChange({ httpConnectTimeoutMs: ms })
    else if (key === "httpHeaderTimeoutMs") onChange({ httpHeaderTimeoutMs: ms })
    else onChange({ httpStreamIdleMs: ms })
  }
  const row = (
    key: "httpConnectTimeoutMs" | "httpHeaderTimeoutMs" | "httpStreamIdleMs",
    label: string,
    min: number,
    max: number,
    ms: number | undefined,
  ) => (
    <div key={key} className="flex items-center gap-2">
      <span className="w-16 text-xs text-muted-foreground">{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        className="w-28"
        placeholder="默认"
        value={ms == null ? "" : Math.round(ms / 1000)}
        onChange={(e) => editTimeout(key, e.target.value)}
      />
      <span className="text-xs text-muted-foreground">{t("settings.sections.llm.httpTimeoutUnit")}</span>
    </div>
  )
  return (
    <div className="space-y-2 rounded-md border p-3">
      <Label>{t("settings.sections.llm.httpTimeouts")}</Label>
      {row("httpConnectTimeoutMs", t("settings.sections.llm.httpConnectTimeout"), 5, 300, value.httpConnectTimeoutMs)}
      {row("httpHeaderTimeoutMs", t("settings.sections.llm.httpHeaderTimeout"), 5, 300, value.httpHeaderTimeoutMs)}
      {row("httpStreamIdleMs", t("settings.sections.llm.httpStreamIdleMs"), 30, 600, value.httpStreamIdleMs)}
      <p className="text-xs text-muted-foreground">
        {t("settings.sections.llm.httpTimeoutsHint")}
      </p>
    </div>
  )
}

export function ReasoningControls({
  value,
  onChange,
}: {
  value: ReasoningConfig
  onChange: (value: ReasoningConfig) => void
}) {
  const { t } = useTranslation()
  const modes: { value: ReasoningMode; label: string }[] = [
    { value: "auto", label: t("settings.sections.llm.reasoning.auto") },
    { value: "off", label: t("settings.sections.llm.reasoning.off") },
    { value: "low", label: t("settings.sections.llm.reasoning.low") },
    { value: "medium", label: t("settings.sections.llm.reasoning.medium") },
    { value: "high", label: t("settings.sections.llm.reasoning.high") },
    { value: "max", label: t("settings.sections.llm.reasoning.max") },
    { value: "custom", label: t("settings.sections.llm.reasoning.custom") },
  ]

  return (
    <div className="space-y-2">
      <Label>{t("settings.sections.llm.reasoning.title")}</Label>
      <div className="flex flex-wrap gap-1.5">
        {modes.map((m) => {
          const active = value.mode === m.value
          return (
            <button
              key={m.value}
              type="button"
              onClick={() => onChange({ ...value, mode: m.value })}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border hover:bg-accent"
              }`}
            >
              {m.label}
            </button>
          )
        })}
      </div>
      {value.mode === "custom" && (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            className="w-28"
            value={value.budgetTokens ?? ""}
            onChange={(e) => {
              const raw = e.target.value.trim()
              const n = Number(raw)
              onChange({
                ...value,
                budgetTokens: raw === "" || !Number.isFinite(n) ? undefined : Math.max(0, n),
              })
            }}
            placeholder="1024"
          />
          <span className="text-xs text-muted-foreground">
            {t("settings.sections.llm.reasoning.budgetTokens")}
          </span>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {t("settings.sections.llm.reasoning.hint")}
      </p>
    </div>
  )
}
