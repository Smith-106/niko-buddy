import { useEffect, useState, useRef } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "@/lib/toast"
import { useWikiStore, type ProviderOverride } from "@/stores/wiki-store"
import { LLM_PRESETS } from "@/lib/llm-config/llm-presets"
import { resolveConfig } from "@/lib/llm-config/preset-resolver"
import { PresetRow } from "./llm-provider-widgets"
import { CustomProviderCards } from "./custom-provider-cards"
import { toErrorMessage } from "@/lib/utils"

export function LlmProviderSection() {
  const { t } = useTranslation()
  const providerConfigs = useWikiStore((s) => s.providerConfigs)
  const setProviderConfigs = useWikiStore((s) => s.setProviderConfigs)
  const activePresetId = useWikiStore((s) => s.activePresetId)
  const setActivePresetId = useWikiStore((s) => s.setActivePresetId)
  const setLlmConfig = useWikiStore((s) => s.setLlmConfig)
  const llmConfig = useWikiStore((s) => s.llmConfig)

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

      {/* Custom Provider Cards - 放在顶部 */}
      <CustomProviderCards />

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
    </div>
  )
}
export { HttpTimeoutControls, ReasoningControls } from "./llm-provider-widgets"
