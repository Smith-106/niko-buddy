import { useEffect, useState, useRef } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "@/lib/toast"
import { useWikiStore, type ProviderOverride } from "@/stores/wiki-store"
import { LLM_PRESETS } from "@/lib/llm-config/llm-presets"
import { resolveConfig } from "@/lib/llm-config/preset-resolver"
import { CliProbeStrip } from "./cli-probe-strip"
import { PresetRow } from "./llm-provider-widgets"
import { CustomProviderCards } from "./custom-provider-cards"
import { LlmCacheStatsCard } from "../llm-cache-stats-card"
import { toErrorMessage } from "@/lib/utils"

export function LlmProviderSection() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const providerConfigs = useWikiStore((s) => s.providerConfigs)
  const setProviderConfigs = useWikiStore((s) => s.setProviderConfigs)
  const activePresetId = useWikiStore((s) => s.activePresetId)
  const setActivePresetId = useWikiStore((s) => s.setActivePresetId)
  const setLlmConfig = useWikiStore((s) => s.setLlmConfig)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const aiChatModel = useWikiStore((s) => s.aiChatModel)
  const setAiChatModel = useWikiStore((s) => s.setAiChatModel)
  const defaultLlmModel = useWikiStore((s) => s.defaultLlmModel)
  const setDefaultLlmModel = useWikiStore((s) => s.setDefaultLlmModel)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setActiveSettingsCategory = useWikiStore((s) => s.setActiveSettingsCategory)

  const legacyAntigravityOverride = providerConfigs["antigravity-cli"]
  const hasLegacyAntigravityConfig =
    llmConfig.provider === "antigravity-cli" ||
    activePresetId === "antigravity-cli" ||
    legacyAntigravityOverride?.enabled === true ||
    (legacyAntigravityOverride?.savedModels?.length ?? 0) > 0 ||
    (typeof aiChatModel === "string" && aiChatModel.startsWith("antigravity-cli/")) ||
    (typeof defaultLlmModel === "string" && defaultLlmModel.startsWith("antigravity-cli/"))

  function dismissLegacyAntigravityConfig() {
    const nextConfigs = { ...providerConfigs }
    delete nextConfigs["antigravity-cli"]
    const nextActive = activePresetId === "antigravity-cli" ? null : activePresetId
    const hasValidActivePreset =
      nextActive !== null && LLM_PRESETS.some((preset) => preset.id === nextActive)
    const shouldClearLlmConfig = llmConfig.provider === "antigravity-cli" && !hasValidActivePreset
    const clearedLlm = shouldClearLlmConfig
      ? { ...llmConfig, provider: "openai" as const, apiKey: "", model: "" }
      : null
    const shouldClearChatModel =
      typeof aiChatModel === "string" && aiChatModel.startsWith("antigravity-cli/")
    const shouldClearDefaultModel =
      typeof defaultLlmModel === "string" && defaultLlmModel.startsWith("antigravity-cli/")

    setProviderConfigs(nextConfigs)
    setActivePresetId(nextActive)
    if (clearedLlm) {
      setLlmConfig(clearedLlm)
    }
    if (shouldClearChatModel) {
      setAiChatModel("")
    }
    if (shouldClearDefaultModel) {
      setDefaultLlmModel("")
    }
    persist(nextConfigs, nextActive)
      .then(async () => {
        if (clearedLlm || shouldClearChatModel || shouldClearDefaultModel) {
          const { saveLlmConfig, saveAiChatModel, saveDefaultLlmModel } = await import(
            "@/lib/project-store"
          )
          if (clearedLlm) await saveLlmConfig(clearedLlm)
          if (shouldClearChatModel) await saveAiChatModel("")
          if (shouldClearDefaultModel) await saveDefaultLlmModel("")
        }
      })
      .catch((err) => {
        toast.error(t("settings.sections.llm.saveFailed", { message: toErrorMessage(err) }))
      })
  }

  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [savedId, setSavedId] = useState<string | null>(null)
  // savedId 徽标 1.5s 后自动清除。定时器必须在卸载时清理：否则回调会在组件树
  // （及其 DOM 环境）拆除后才触发 setState，React 调度器会去访问 window 并抛
  // ReferenceError: window is not defined（CI node 环境下表现为未处理错误 → 退出码 1）。
  const savedIdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (savedIdTimer.current !== null) clearTimeout(savedIdTimer.current)
    },
    [],
  )

  function toggleExpand(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  async function persist(newConfigs: typeof providerConfigs, newActive: string | null) {
    const { saveProviderConfigs, saveActivePresetId, saveLlmConfig } = await import(
      "@/lib/project-store"
    )
    await saveProviderConfigs(newConfigs)
    await saveActivePresetId(newActive)
    if (newActive) {
      const preset = LLM_PRESETS.find((p) => p.id === newActive)
      if (preset) {
        const resolved = resolveConfig(preset, newConfigs[newActive], llmConfig)
        setLlmConfig(resolved)
        await saveLlmConfig(resolved)
      }
    }
  }

  function updateOverride(id: string, patch: ProviderOverride) {
    const merged: ProviderOverride = { ...(providerConfigs[id] ?? {}), ...patch }
    const next = { ...providerConfigs, [id]: merged }
    setProviderConfigs(next)
    persist(next, activePresetId).catch((err) => {
      toast.error(t("settings.sections.llm.saveFailed", { message: toErrorMessage(err) }))
    })
    // If this preset is active, refresh the resolved LlmConfig live.
    if (id === activePresetId) {
      const preset = LLM_PRESETS.find((p) => p.id === id)
      /* v8 ignore next */
      if (preset) setLlmConfig(resolveConfig(preset, merged, llmConfig))
    }
    setSavedId(id)
    if (savedIdTimer.current !== null) clearTimeout(savedIdTimer.current)
    savedIdTimer.current = setTimeout(() => setSavedId((cur) => (cur === id ? null : cur)), 1500)
  }

  /* v8 ignore start -- PresetRow intentionally does not expose active-preset toggling. */
  function toggleActive(id: string) {
    const next = id === activePresetId ? null : id
    setActivePresetId(next)
    /* v8 ignore next -- PresetRow intentionally drops this unused callback. */
    persist(providerConfigs, next).catch((err) => {
      toast.error(t("settings.sections.llm.saveFailed", { message: toErrorMessage(err) }))
    })
  }
  /* v8 ignore stop */

  function toggleEnabled(id: string) {
    const current = providerConfigs[id]
    const currentEnabled = current?.enabled === true
    const merged: ProviderOverride = { ...(current ?? {}), enabled: !currentEnabled }
    const next = { ...providerConfigs, [id]: merged }
    setProviderConfigs(next)
    persist(next, activePresetId).catch((err) => {
      toast.error(t("settings.sections.llm.saveFailed", { message: toErrorMessage(err) }))
    })
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.llm.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.llm.description")}
        </p>
      </div>

      {!project && (
        <div
          role="status"
          data-testid="llm-global-config-banner"
          className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground"
        >
          <div className="font-medium text-foreground">
            {t("settings.sections.llm.noProjectGlobalTitle", "当前未打开项目：正在配置全局模型服务")}
          </div>
          <p className="mt-1">
            {t(
              "settings.sections.llm.noProjectGlobalDesc",
              "此处保存的 API Key 与默认模型为全局生效，创建或打开任意小说项目后即可直接使用；如需使用 Antigravity (ACP) 或本机 MCP，请先创建或打开项目。",
            )}
          </p>
        </div>
      )}

      {/* 合规迁移引导：检测到旧版 antigravity-cli 配置时显式提示，不静默失败 */}
      {hasLegacyAntigravityConfig ? (
        <div
          role="status"
          data-testid="antigravity-legacy-migration-banner"
          className="rounded-lg border border-warning/50 bg-warning/10 p-4 space-y-2"
        >
          <div className="text-sm font-semibold">
            {t("settings.sections.llm.antigravityMigration.title")}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.llm.antigravityMigration.description")}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              disabled={!project}
              title={!project ? t("settings.sections.llm.antigravityGuide.requiresProject") : undefined}
              data-testid="antigravity-migration-open-acp"
              onClick={() => setActiveView("antigravityAcp")}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("settings.sections.llm.antigravityMigration.openAcp")}
            </button>
            <button
              type="button"
              disabled={!project}
              title={!project ? t("settings.sections.llm.antigravityGuide.requiresProject") : undefined}
              data-testid="antigravity-migration-open-mcp"
              onClick={() => setActiveSettingsCategory("external-control")}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("settings.sections.llm.antigravityMigration.openMcp")}
            </button>
            <button
              type="button"
              data-testid="antigravity-migration-clear"
              onClick={() => dismissLegacyAntigravityConfig()}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
            >
              {t("settings.sections.llm.antigravityMigration.clearLegacy")}
            </button>
          </div>
          {!project && (
            <p
              data-testid="antigravity-migration-requires-project-hint"
              className="text-xs text-muted-foreground"
            >
              {t("settings.sections.llm.antigravityGuide.requiresProject")}
            </p>
          )}
        </div>
      ) : (
        <div
          role="region"
          aria-label={t("settings.sections.llm.antigravityGuide.title")}
          data-testid="antigravity-subscription-info-card"
          className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-2"
        >
          <div className="text-sm font-semibold">
            {t("settings.sections.llm.antigravityGuide.title")}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.llm.antigravityGuide.description")}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              disabled={!project}
              title={!project ? t("settings.sections.llm.antigravityGuide.requiresProject") : undefined}
              data-testid="antigravity-guide-open-acp"
              onClick={() => setActiveView("antigravityAcp")}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("settings.sections.llm.antigravityGuide.openAcp")}
            </button>
            <button
              type="button"
              disabled={!project}
              title={!project ? t("settings.sections.llm.antigravityGuide.requiresProject") : undefined}
              data-testid="antigravity-guide-open-mcp"
              onClick={() => setActiveSettingsCategory("external-control")}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("settings.sections.llm.antigravityGuide.openMcp")}
            </button>
          </div>
          {!project && (
            <p
              data-testid="antigravity-guide-requires-project-hint"
              className="text-xs text-muted-foreground"
            >
              {t("settings.sections.llm.antigravityGuide.requiresProject")}
            </p>
          )}
        </div>
      )}

      {/* Custom Provider Cards - 放在顶部 */}
      <CustomProviderCards />

      {/* 本地 CLI 四探针统一状态条（第二波范围A，只读诊断） */}
      <CliProbeStrip />

      {/* Built-in Presets - 内置预设，过滤掉通用的"自定义模型"预设 */}
      <div className="space-y-2">
        {LLM_PRESETS.filter((p) => p.id !== "custom").map((preset) => {
          const ov = providerConfigs[preset.id]
          /* v8 ignore next -- PresetRow intentionally drops this unused callback. */
          const onToggleActive = () => toggleActive(preset.id)
          return (
            <PresetRow
              key={preset.id}
              preset={preset}
              override={ov}
              isActive={activePresetId === preset.id}
              isEnabled={ov?.enabled === true}
              isExpanded={!!expanded[preset.id]}
              savedHere={savedId === preset.id}
              onToggleActive={onToggleActive}
              onToggleEnabled={() => toggleEnabled(preset.id)}
              onToggleExpand={() => toggleExpand(preset.id)}
              onChange={(patch) => updateOverride(preset.id, patch)}
            />
          )
        })}
      </div>

      {/* 会话内 Prompt 缓存命中诊断 */}
      <LlmCacheStatsCard />
    </div>
  )
}
export { HttpTimeoutControls, ReasoningControls } from "./llm-provider-widgets"
