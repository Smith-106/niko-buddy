// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  useWikiStore,
  type SearchApiConfig,
  type SearchProvider,
  type SearchProviderOverride,
} from "@/stores/wiki-store"
import { SEARXNG_CATEGORY_OPTIONS, SERPAPI_ENGINE_OPTIONS, resolveSearchConfig } from "@/lib/web-search"

/** Supported search provider definitions. */
const SEARCH_PROVIDERS = [
  {
    id: "tavily",
    label: "Tavily",
    hint: "General web search for Deep Research",
    keyPlaceholder: "Enter your Tavily API key (tavily.com)",
    needsApiKey: true,
  },
  {
    id: "serpapi",
    label: "SerpApi",
    hint: "Google, Bing, DuckDuckGo, Scholar, News, Images, Videos, YouTube",
    keyPlaceholder: "Enter your SerpApi API key (serpapi.com)",
    needsApiKey: true,
  },
  {
    id: "searxng",
    label: "SearXNG",
    hint: "Self-hosted metasearch via the SearXNG JSON API",
    urlPlaceholder: "https://search.example.com",
    needsApiKey: false,
  },
] as const

/**
 * Web search provider configuration section for Deep Research.
 * Supports Tavily, SerpApi, and self-hosted SearXNG instances.
 */
export function WebSearchSection() {
  const { t } = useTranslation()
  const searchApiConfig = useWikiStore((s) => s.searchApiConfig)
  const setSearchApiConfig = useWikiStore((s) => s.setSearchApiConfig)
  const resolvedConfig = resolveSearchConfig(searchApiConfig)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [savedId, setSavedId] = useState<string | null>(null)

  /** Persist updated search config to store and disk. */
  async function persist(next: SearchApiConfig) {
    const { saveSearchApiConfig } = await import("@/lib/project-store")
    setSearchApiConfig(next)
    await saveSearchApiConfig(next)
  }

  /** Update a single provider's override settings. */
  function updateProvider(id: Exclude<SearchProvider, "none">, patch: SearchProviderOverride) {
    /* v8 ignore next */
    const currentConfigs = resolvedConfig.providerConfigs ?? {}
    const merged = { ...(currentConfigs[id] ?? {}), ...patch }
    const nextConfigs = { ...currentConfigs, [id]: merged }
    const next = resolveSearchConfig({
      ...resolvedConfig,
      providerConfigs: nextConfigs,
    })
    persist(next).catch(() => {})
    setSavedId(id)
    setTimeout(() => setSavedId((cur) => (cur === id ? null : cur)), 1500)
  }

  /** Toggle a provider between active and inactive. */
  function toggleActive(id: Exclude<SearchProvider, "none">) {
    const nextProvider = resolvedConfig.provider === id ? "none" : id
    persist(resolveSearchConfig({ ...resolvedConfig, provider: nextProvider })).catch(() => {})
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.webSearch.title")} (Deep Research)</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.webSearch.description")}
        </p>
      </div>

      <div className="space-y-2">
        {SEARCH_PROVIDERS.map((provider) => {
          const override = resolvedConfig.providerConfigs?.[provider.id]
          const isActive = resolvedConfig.provider === provider.id
          const hasConfig = provider.id === "searxng"
            ? !!override?.searXngUrl
            : !!override?.apiKey
          const isExpanded = !!expanded[provider.id]
          return (
            <div
              key={provider.id}
              className={`rounded-lg border transition-colors ${
                isActive ? "border-primary/60 bg-primary/5" : "border-border"
              }`}
            >
              {/* Provider header row */}
              <div className="flex items-center gap-3 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => setExpanded((prev) => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent"
                  title={isExpanded ? t("settings.sections.webSearch.collapse") : t("settings.sections.webSearch.expand")}
                >
                  {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>

                <button
                  type="button"
                  onClick={() => setExpanded((prev) => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{provider.label}</span>
                    {hasConfig && !isActive && (
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {t("settings.sections.webSearch.configuredBadge")}
                      </span>
                    )}
                    {isActive && (
                      <span className="shrink-0 rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        {t("settings.sections.webSearch.activeBadge")}
                      </span>
                    )}
                    {savedId === provider.id && (
                      <span className="shrink-0 text-[10px] text-emerald-600">
                        {t("settings.sections.webSearch.savedBadge")}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {provider.hint}
                  </div>
                </button>

                {/* Toggle switch */}
                <button
                  type="button"
                  onClick={() => toggleActive(provider.id)}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
                    isActive
                      ? "border-primary bg-primary"
                      : "border-muted-foreground/30 bg-muted-foreground/20 hover:bg-muted-foreground/30"
                  }`}
                  aria-label={isActive ? t("settings.sections.webSearch.deactivate") : t("settings.sections.webSearch.activate")}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm ring-1 ring-black/10 transition-transform ${
                      isActive ? "translate-x-4" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>

              {/* Expanded config panel */}
              {isExpanded && (
                <div className="space-y-4 border-t bg-background/50 px-4 py-3">
                  {provider.needsApiKey ? (
                    <div className="space-y-2">
                      <Label>{t("settings.apiKey")}</Label>
                      <Input
                        type="password"
                        value={override?.apiKey ?? ""}
                        onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value })}
                        placeholder={provider.keyPlaceholder}
                      />
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label>{t("settings.sections.webSearch.instanceUrl")}</Label>
                      <Input
                        /* v8 ignore next */
                        value={override?.searXngUrl ?? resolvedConfig.searXngUrl ?? ""}
                        onChange={(e) => updateProvider("searxng", { searXngUrl: e.target.value })}
                        placeholder={provider.urlPlaceholder}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("settings.sections.webSearch.searxngJsonHint")}
                      </p>
                    </div>
                  )}

                  {provider.id === "serpapi" && (
                    <SerpApiEnginePicker
                      /* v8 ignore next */
                      value={override?.serpApiEngine ?? resolvedConfig.serpApiEngine ?? "google"}
                      onChange={(serpApiEngine) => updateProvider("serpapi", { serpApiEngine })}
                    />
                  )}

                  {provider.id === "searxng" && (
                    <SearXngCategoryPicker
                      /* v8 ignore next */
                      value={override?.searXngCategories ?? resolvedConfig.searXngCategories ?? ["general"]}
                      onChange={(searXngCategories) => updateProvider("searxng", { searXngCategories })}
                    />
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** SearXNG category multi-select picker. */
function SearXngCategoryPicker({
  value,
  onChange,
}: {
  value: string[]
  onChange: (value: string[]) => void
}) {
  const { t } = useTranslation()
  const selected = value.length > 0 ? value : ["general"]

  function toggle(category: string) {
    const next = selected.includes(category)
      ? selected.filter((item) => item !== category)
      : [...selected, category]
    onChange(next.length > 0 ? next : ["general"])
  }

  return (
    <div className="space-y-2">
      <Label>{t("settings.sections.webSearch.searchCategories")}</Label>
      <div className="flex flex-wrap gap-1.5">
        {SEARXNG_CATEGORY_OPTIONS.map((category) => (
          <button
            key={category.value}
            type="button"
            onClick={() => toggle(category.value)}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              selected.includes(category.value)
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:bg-accent"
            }`}
            title={category.hint}
          >
            {category.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("settings.sections.webSearch.searxngCategoriesHint")}
      </p>
    </div>
  )
}

/** SerpApi search engine picker with custom URL support. */
function SerpApiEnginePicker({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const isCustom = value.length > 0 && !SERPAPI_ENGINE_OPTIONS.some((e) => e.value === value)

  return (
    <div className="space-y-2">
      <Label>{t("settings.sections.webSearch.searchEngine")}</Label>
      <div className="flex flex-wrap gap-1.5">
        {SERPAPI_ENGINE_OPTIONS.map((engine) => (
          <button
            key={engine.value}
            type="button"
            onClick={() => onChange(engine.value)}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              value === engine.value
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:bg-accent"
            }`}
            title={engine.hint}
          >
            {engine.label}
          </button>
        ))}
      </div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("settings.sections.webSearch.customSerpApiPlaceholder")}
      />
      {isCustom && (
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.webSearch.customSerpApiHint")}
        </p>
      )}
    </div>
  )
}
