// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { DEFAULT_MAX_CONTEXT_TOKENS } from "@/lib/llm-context-limits"
import {
  Bot,
  BookOpen,
  Database,
  ListFilter,
  Palette,
  Network,
  History,
  Wrench,
  HelpCircle,
  MessageCircle,
  HeartHandshake,
  Archive,
  Plug,
  Loader2,
  Image as ImageIcon,
  Globe,
  Languages,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import i18n from "@/i18n"
import { Button } from "@/components/ui/button"
import { PanelHeaderWithHelp } from "@/components/layout/panel-header-with-help"
import { useWikiStore } from "@/stores/wiki-store"
import { isTauri } from "@/lib/platform"
import { toast } from "@/lib/toast"
import { toErrorMessage } from "@/lib/utils"
import { useChatStore } from "@/stores/chat-store"
import { loadSourceWatchConfig, loadNovelConfig, loadRerankConfig } from "@/lib/project-store"
import type { SettingsDraft, DraftSetter } from "./settings-types"
import { normalizeSourceWatchConfig } from "@/lib/source-watch-config"
import {
  SETTINGS_DOMAIN_DRAFT_KEYS,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SAVE_MODE,
  type SettingsDomain,
} from "./settings-nav-config"
import { dirtySettingsDomains, mergeResyncedDraft } from "./settings-view-helpers"
// B7 挂载覆盖门：sections/ 下每个非 spec 模块必须在这里（含传递 import）挂载，
// 或列入 settings-sections-mount-coverage.spec.ts 的显式 legacy 清单（含原因/恢复条件）。
// 新增孤立 section 会被该 spec 拦红；历史隐藏区（source watch / scheduled import 等）
// 与其余未挂载 section 的登记见 docs/decision-log/2026-10-16-b7-unmounted-capabilities-ledger.md。
import { LlmProviderSection } from "./sections/llm-provider-section"
import { EmbeddingSection } from "./sections/embedding-section"
import { RerankSection } from "./sections/rerank-section"
import { InterfaceSection } from "./sections/interface-section"
import { NovelSection } from "./sections/novel-section"
import { NetworkSection } from "./sections/network-section"
import { ChangelogSection } from "./sections/changelog-section"
import { MaintenanceSection } from "./sections/maintenance-section"
import { FeedbackSection } from "./sections/feedback-section"
import { UsageGuideSection } from "./sections/usage-guide-section"
import { SkillLibrarySection } from "./sections/skill-library-section"
import { McpSection } from "./sections/mcp-section"
import { ContactSupportSection } from "./sections/contact-support-section"
import { DataManagementSection } from "./sections/data-management-section"
import { MultimodalSection } from "./sections/multimodal-section"
import { WebSearchSection } from "./sections/web-search-section"
import { OutputSection } from "./sections/output-section"

type CategoryId =
  | "llm"
  | "rerank"
  | "embedding"
  | "network"
  | "interface"
  | "novel"
  | "usage-guide"
  | "maintenance"
  | "data-management"
  | "feedback"
  | "contact-support"
  | "changelog"
  | "skill-library"
  | "mcp"
  | "multimodal"
  | "web-search"
  | "output"

export type { SettingsDomain } from "./settings-nav-config"

export const SETTINGS_DOMAIN_OF: Record<CategoryId, SettingsDomain> = {
  llm: "model",
  rerank: "model",
  embedding: "model",
  mcp: "model",
  "skill-library": "model",
  multimodal: "model",
  "web-search": "model",
  network: "storage",
  novel: "storage",
  maintenance: "storage",
  "data-management": "storage",
  interface: "interface",
  output: "interface",
  "usage-guide": "interface",
  feedback: "interface",
  "contact-support": "interface",
  changelog: "interface",
}

export function settingsDomainOf(category: CategoryId): SettingsDomain {
  return SETTINGS_DOMAIN_OF[category]
}

interface Category {
  id: CategoryId
  labelKey: string
  icon: typeof Bot
}

const CATEGORIES: Category[] = [
  { id: "llm", labelKey: "settings.categories.llm", icon: Bot },
  { id: "rerank", labelKey: "settings.categories.rerank", icon: ListFilter },
  { id: "embedding", labelKey: "settings.categories.embedding", icon: Database },
  { id: "network", labelKey: "settings.categories.network", icon: Network },
  { id: "interface", labelKey: "settings.categories.interface", icon: Palette },
  { id: "novel", labelKey: "settings.categories.novel", icon: BookOpen },
  { id: "usage-guide", labelKey: "settings.categories.usageGuide", icon: HelpCircle },
  { id: "skill-library", labelKey: "settings.categories.skillLibrary", icon: BookOpen },
  { id: "mcp", labelKey: "settings.categories.mcp", icon: Plug },
  { id: "multimodal", labelKey: "settings.categories.multimodal", icon: ImageIcon },
  { id: "web-search", labelKey: "settings.categories.webSearch", icon: Globe },
  { id: "output", labelKey: "settings.categories.output", icon: Languages },
  { id: "maintenance", labelKey: "settings.categories.maintenance", icon: Wrench },
  { id: "data-management", labelKey: "settings.categories.dataManagement", icon: Archive },
  { id: "feedback", labelKey: "settings.categories.feedback", icon: MessageCircle },
  { id: "contact-support", labelKey: "settings.categories.contactSupport", icon: HeartHandshake },
  { id: "changelog", labelKey: "settings.categories.changelog", icon: History },
]

function initialDraft(
  llm: ReturnType<typeof useWikiStore.getState>["llmConfig"],
  embed: ReturnType<typeof useWikiStore.getState>["embeddingConfig"],
  rerank: ReturnType<typeof useWikiStore.getState>["rerankConfig"],
  multimodal: ReturnType<typeof useWikiStore.getState>["multimodalConfig"],
  outputLanguage: ReturnType<typeof useWikiStore.getState>["outputLanguage"],
  proxy: ReturnType<typeof useWikiStore.getState>["proxyConfig"],
  scheduledImport: ReturnType<typeof useWikiStore.getState>["scheduledImportConfig"],
  sourceWatch: ReturnType<typeof useWikiStore.getState>["sourceWatchConfig"],
  revisionFeedbackWindowConfig: ReturnType<typeof useWikiStore.getState>["revisionFeedbackWindowConfig"],
  novelConfig: ReturnType<typeof useWikiStore.getState>["novelConfig"],
  maxHistoryMessages: number,
  uiLanguage: string,
  uiFontSizeScale: number,
  projectPath?: string,
): SettingsDraft {
  let displayPath = scheduledImport.path || ""
  if (!displayPath && projectPath) {
    displayPath = `${projectPath}/raw/sources`
  } else if (displayPath && projectPath && !displayPath.startsWith("/") && !displayPath.match(/^[a-zA-Z]:[/\\]/)) {
    displayPath = `${projectPath}/${displayPath}`
  }

  return {
    provider: llm.provider,
    apiKey: llm.apiKey,
    model: llm.model,
    ollamaUrl: llm.ollamaUrl,
    customEndpoint: llm.customEndpoint,
    azureApiVersion: llm.azureApiVersion ?? "2024-10-21",
    azureModelFamily: llm.azureModelFamily ?? "auto",
    maxContextSize: llm.maxContextSize ?? DEFAULT_MAX_CONTEXT_TOKENS,
    apiMode: llm.apiMode,
    reasoning: llm.reasoning,
    localCliIsolation: llm.localCliIsolation === true,
    embeddingEnabled: embed.enabled,
    embeddingEndpoint: embed.endpoint,
    embeddingApiKey: embed.apiKey,
    embeddingModel: embed.model,
    embeddingOutputDimensionality: embed.outputDimensionality,
    embeddingMaxChunkChars: embed.maxChunkChars,
    embeddingOverlapChunkChars: embed.overlapChunkChars,
    rerankConfig: rerank,
    multimodalEnabled: multimodal.enabled,
    multimodalUseMainLlm: multimodal.useMainLlm,
    multimodalProvider: multimodal.provider,
    multimodalApiKey: multimodal.apiKey,
    multimodalModel: multimodal.model,
    multimodalOllamaUrl: multimodal.ollamaUrl,
    multimodalCustomEndpoint: multimodal.customEndpoint,
    multimodalAzureApiVersion: multimodal.azureApiVersion ?? "2024-10-21",
    multimodalAzureModelFamily: multimodal.azureModelFamily ?? "auto",
    multimodalApiMode: multimodal.apiMode,
    multimodalConcurrency: multimodal.concurrency,
    outputLanguage,
    maxHistoryMessages,
    proxyEnabled: proxy.enabled,
    proxyUrl: proxy.url,
    proxyBypassLocal: proxy.bypassLocal,
    scheduledImportEnabled: scheduledImport.enabled,
    scheduledImportPath: displayPath,
    scheduledImportInterval: scheduledImport.interval,
    sourceWatchConfig: normalizeSourceWatchConfig(sourceWatch),
    revisionFeedbackWindowConfig,
    novelConfig,
    uiLanguage,
    uiFontSizeScale,
  }
}

export function SettingsView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const activeSettingsCategory = useWikiStore((s) => s.activeSettingsCategory)
  const setActiveSettingsCategory = useWikiStore((s) => s.setActiveSettingsCategory)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setLlmConfig = useWikiStore((s) => s.setLlmConfig)
  const embeddingConfig = useWikiStore((s) => s.embeddingConfig)
  const setEmbeddingConfig = useWikiStore((s) => s.setEmbeddingConfig)
  const rerankConfig = useWikiStore((s) => s.rerankConfig)
  const setRerankConfig = useWikiStore((s) => s.setRerankConfig)
  const multimodalConfig = useWikiStore((s) => s.multimodalConfig)
  const setMultimodalConfig = useWikiStore((s) => s.setMultimodalConfig)
  const outputLanguage = useWikiStore((s) => s.outputLanguage)
  const setOutputLanguage = useWikiStore((s) => s.setOutputLanguage)
  const proxyConfig = useWikiStore((s) => s.proxyConfig)
  const setProxyConfig = useWikiStore((s) => s.setProxyConfig)
  const scheduledImportConfig = useWikiStore((s) => s.scheduledImportConfig)
  const setScheduledImportConfig = useWikiStore((s) => s.setScheduledImportConfig)
  const sourceWatchConfig = useWikiStore((s) => s.sourceWatchConfig)
  const setSourceWatchConfig = useWikiStore((s) => s.setSourceWatchConfig)
  const revisionFeedbackWindowConfig = useWikiStore((s) => s.revisionFeedbackWindowConfig)
  const setRevisionFeedbackWindowConfig = useWikiStore((s) => s.setRevisionFeedbackWindowConfig)
  const novelConfig = useWikiStore((s) => s.novelConfig)
  const setNovelConfig = useWikiStore((s) => s.setNovelConfig)
  const maxHistoryMessages = useChatStore((s) => s.maxHistoryMessages)
  const setMaxHistoryMessages = useChatStore((s) => s.setMaxHistoryMessages)
  const uiFontSizeScale = useWikiStore((s) => s.uiFontSizeScale)
  const setUiFontSizeScale = useWikiStore((s) => s.setUiFontSizeScale)

  const [active, setActive] = useState<CategoryId>("llm")
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 保存进行中及刚结束时的本域草稿键：其基线变化时直接采用新基线（见 mergeResyncedDraft）。
  const adoptKeysRef = useRef<ReadonlySet<keyof SettingsDraft> | null>(null)
  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
  }, [])
  const uiLanguageNow = i18n.language
  // store 当前值折算成的草稿基线：未改动的字段应等于它。
  const base = useMemo(
    () =>
      initialDraft(
        llmConfig,
        embeddingConfig,
        rerankConfig,
        multimodalConfig,
        outputLanguage,
        proxyConfig,
        scheduledImportConfig,
        sourceWatchConfig,
        revisionFeedbackWindowConfig,
        novelConfig,
        maxHistoryMessages,
        uiLanguageNow,
        uiFontSizeScale,
        project?.path,
      ),
    [
      llmConfig,
      embeddingConfig,
      rerankConfig,
      multimodalConfig,
      outputLanguage,
      proxyConfig,
      scheduledImportConfig,
      sourceWatchConfig,
      revisionFeedbackWindowConfig,
      novelConfig,
      maxHistoryMessages,
      uiLanguageNow,
      uiFontSizeScale,
      project?.path,
    ],
  )
  const [draft, setDraftState] = useState<SettingsDraft>(base)
  // 用户经 setDraft 改过的键；保存成功后按域清除。
  const [touched, setTouched] = useState<ReadonlySet<keyof SettingsDraft>>(() => new Set())

  // Sync active category from store (e.g. deep-link navigation)
  useEffect(() => {
    if (!activeSettingsCategory) return
    if (CATEGORIES.some((category) => category.id === activeSettingsCategory)) {
      setActive(activeSettingsCategory)
    }
    setActiveSettingsCategory(null)
  }, [activeSettingsCategory, setActiveSettingsCategory])

  // Load project-specific configs on project change
  useEffect(() => {
    let cancelled = false
    loadSourceWatchConfig(project?.id).then((config) => {
      if (cancelled) return
      const normalized = normalizeSourceWatchConfig(config)
      setSourceWatchConfig(normalized)
      setDraftState((prev) => ({ ...prev, sourceWatchConfig: normalized }))
    }).catch(() => {
      if (cancelled) return
      const fallback = normalizeSourceWatchConfig()
      setSourceWatchConfig(fallback)
      setDraftState((prev) => ({ ...prev, sourceWatchConfig: fallback }))
    })
    return () => {
      cancelled = true
    }
  }, [project?.id, setSourceWatchConfig])

  useEffect(() => {
    let cancelled = false
    loadNovelConfig(project?.id, project?.path).then((config) => {
      if (cancelled || !config) return
      setNovelConfig(config)
      setDraftState((prev) => ({ ...prev, novelConfig: config }))
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [project?.id, project?.path, setNovelConfig])

  useEffect(() => {
    let cancelled = false
    loadRerankConfig(project?.id, project?.path).then((config) => {
      if (cancelled || !config) return
      setRerankConfig(config)
      setDraftState((prev) => ({ ...prev, rerankConfig: config }))
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [project?.id, project?.path, setRerankConfig])

  // store 变化时重同步草稿。
  // - 切换项目：整份按新基线重建（保留待定的界面语言），清空改动标记。
  // - 同一项目内（如某个开关自动保存）：只更新用户没改过的字段，
  //   其它页尚未保存的改动保留，不再被整份重建冲掉。
  const baseRef = useRef(base)
  const projectKey = `${project?.id ?? ""}\u0000${project?.path ?? ""}`
  const projectKeyRef = useRef(projectKey)
  useEffect(() => {
    const prevBase = baseRef.current
    const projectChanged = projectKeyRef.current !== projectKey
    baseRef.current = base
    projectKeyRef.current = projectKey
    if (prevBase === base && !projectChanged) return
    if (projectChanged) {
      setDraftState((prev) => ({ ...base, uiLanguage: prev.uiLanguage }))
      setTouched(new Set())
      return
    }
    const adoptKeys = adoptKeysRef.current ?? undefined
    setDraftState((prev) => ({ ...mergeResyncedDraft(prev, prevBase, base, adoptKeys), uiLanguage: prev.uiLanguage }))
  }, [base, projectKey])

  const setDraft: DraftSetter = useCallback((key, value) => {
    setDraftState((prev) => ({ ...prev, [key]: value }))
    setTouched((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
  }, [])

  const dirtyDomains = useMemo(() => dirtySettingsDomains(draft, base, touched), [draft, base, touched])

  // B 波三域分存：每个持久化助手只读写自己域的 store + 落盘键。
  // active 域变更时只存该域；其它域的 draft 照常保留在内存，不丢失、不串写。
  // 每个子配置先落盘、成功后再写 store：落盘失败时 store 仍是旧值，
  // 该字段保持"未保存"，不会出现界面显示已保存而磁盘没写入。
  const persistModelDomain = useCallback(async () => {
    const {
      saveLlmConfig,
      saveEmbeddingConfig,
      saveRerankConfig,
      saveMultimodalConfig,
    } = await import("@/lib/project-store")

    const newLlm = {
      provider: draft.provider,
      apiKey: draft.apiKey,
      model: draft.model,
      ollamaUrl: draft.ollamaUrl,
      customEndpoint: draft.customEndpoint,
      azureApiVersion: draft.provider === "azure" ? draft.azureApiVersion.trim() : undefined,
      azureModelFamily: draft.provider === "azure" ? draft.azureModelFamily : undefined,
      maxContextSize: draft.maxContextSize,
      apiMode: draft.provider === "custom" ? draft.apiMode : undefined,
      reasoning: draft.reasoning,
      localCliIsolation: draft.localCliIsolation,
    }
    const newEmbed = {
      enabled: draft.embeddingEnabled,
      endpoint: draft.embeddingEndpoint,
      apiKey: draft.embeddingApiKey,
      model: draft.embeddingModel,
      outputDimensionality: draft.embeddingOutputDimensionality,
      maxChunkChars: draft.embeddingMaxChunkChars,
      overlapChunkChars: draft.embeddingOverlapChunkChars,
    }
    const newRerank = {
      ...draft.rerankConfig,
      apiMode: draft.rerankConfig.provider === "custom" ? draft.rerankConfig.apiMode : undefined,
      maxCandidates: Math.max(3, Math.min(30, draft.rerankConfig.maxCandidates || 12)),
    }
    const newMultimodal = {
      enabled: draft.multimodalEnabled,
      useMainLlm: draft.multimodalUseMainLlm,
      provider: draft.multimodalProvider,
      apiKey: draft.multimodalApiKey,
      model: draft.multimodalModel,
      ollamaUrl: draft.multimodalOllamaUrl,
      customEndpoint: draft.multimodalCustomEndpoint,
      azureApiVersion: draft.multimodalProvider === "azure" ? draft.multimodalAzureApiVersion.trim() : undefined,
      azureModelFamily: draft.multimodalProvider === "azure" ? draft.multimodalAzureModelFamily : undefined,
      apiMode: draft.multimodalProvider === "custom" ? draft.multimodalApiMode : undefined,
      concurrency: Math.max(1, Math.min(16, draft.multimodalConcurrency || 4)),
    }

    await saveLlmConfig(newLlm)
    setLlmConfig(newLlm)
    await saveEmbeddingConfig(newEmbed)
    setEmbeddingConfig(newEmbed)
    await saveRerankConfig(newRerank, project?.id, project?.path)
    setRerankConfig(newRerank)
    await saveMultimodalConfig(newMultimodal)
    setMultimodalConfig(newMultimodal)
  }, [
    draft,
    project,
    setLlmConfig,
    setEmbeddingConfig,
    setRerankConfig,
    setMultimodalConfig,
  ])

  const persistStorageDomain = useCallback(async () => {
    const {
      saveProxyConfig,
      saveScheduledImportConfig,
      saveSourceWatchConfig,
      saveRevisionFeedbackWindowConfig,
      saveNovelConfig,
    } = await import("@/lib/project-store")

    const newProxy = {
      enabled: draft.proxyEnabled,
      url: draft.proxyUrl.trim(),
      bypassLocal: draft.proxyBypassLocal,
    }
    await saveProxyConfig(newProxy)
    setProxyConfig(newProxy)
    const newSourceWatch = normalizeSourceWatchConfig(draft.sourceWatchConfig)
    await saveSourceWatchConfig(newSourceWatch, project?.id, project?.path)
    setSourceWatchConfig(newSourceWatch)
    if (project) {
      const { startProjectFileSync, stopProjectFileSync } = await import("@/lib/project-file-sync")
      if (newSourceWatch.enabled) {
        await startProjectFileSync(project, newSourceWatch).catch((err) =>
          console.error("Failed to start project file sync:", err)
        )
      } else {
        await stopProjectFileSync()
      }
    }
    // Apply proxy env vars live so the next request picks them up
    try {
      if (isTauri()) {
        const { invoke } = await import("@tauri-apps/api/core")
        const summary = await invoke<string>("set_proxy_env", { config: newProxy })
        if (typeof summary === "string" && summary.startsWith("disabled (")) {
          toast.error(summary === "disabled (empty url)"
            ? t("settings.proxyToast.emptyUrl")
            : t("settings.proxyToast.notApplied", { summary }))
        }
      }
    } catch (err) {
      console.warn("[settings] live network update failed; restart will still apply:", err)
      toast.error(t("settings.proxyToast.applyFailed", { error: toErrorMessage(err) }))
    }

    const newScheduledImport = {
      enabled: draft.scheduledImportEnabled,
      path: draft.scheduledImportPath,
      interval: Math.max(1, Math.min(1440, draft.scheduledImportInterval || 60)),
      lastScan: scheduledImportConfig.lastScan,
    }
    if (project) {
      await saveScheduledImportConfig(project.path, newScheduledImport)
    }
    setScheduledImportConfig(newScheduledImport)
    if (project) {
      const { startScheduledImport, stopScheduledImport } = await import("@/lib/scheduled-import")
      if (
        newScheduledImport.enabled &&
        newScheduledImport.path &&
        newScheduledImport.interval > 0
      ) {
        startScheduledImport(project, newScheduledImport)
      } else {
        stopScheduledImport()
      }
    }

    await saveRevisionFeedbackWindowConfig(draft.revisionFeedbackWindowConfig, project?.id, project?.path)
    setRevisionFeedbackWindowConfig(draft.revisionFeedbackWindowConfig)

    await saveNovelConfig(draft.novelConfig, project?.id, project?.path)
    setNovelConfig(draft.novelConfig)

    // 对话历史长度在"小说"页编辑，按项目落盘，归存储域；
    // 之前归界面域，导致在小说页点保存不会写入。
    const { saveMaxHistoryMessages } = await import("@/lib/project-store")
    await saveMaxHistoryMessages(draft.maxHistoryMessages, project?.id, project?.path)
    setMaxHistoryMessages(draft.maxHistoryMessages)
  }, [
    draft,
    project,
    setProxyConfig,
    setScheduledImportConfig,
    setSourceWatchConfig,
    setRevisionFeedbackWindowConfig,
    setNovelConfig,
    setMaxHistoryMessages,
    scheduledImportConfig,
  ])

  const persistInterfaceDomain = useCallback(async () => {
    const {
      saveOutputLanguage,
      saveUiFontSizeScale,
      saveLanguage,
    } = await import("@/lib/project-store")

    await saveOutputLanguage(draft.outputLanguage, project?.id)
    setOutputLanguage(draft.outputLanguage)
    await saveUiFontSizeScale(draft.uiFontSizeScale, project?.id, project?.path)
    setUiFontSizeScale(draft.uiFontSizeScale)

    if (draft.uiLanguage !== i18n.language) {
      await i18n.changeLanguage(draft.uiLanguage)
      await saveLanguage(draft.uiLanguage)
    }
  }, [
    draft,
    project,
    setOutputLanguage,
    setUiFontSizeScale,
  ])

  // 按当前分类所属域只存该域：模型域 / 存储域 / 界面域互不串写。
  // 进行中再次点击直接忽略；失败时提示错误并保留草稿与改动标记。
  // 保存期间（及结束后一拍）本域基线变化的字段直接采用新基线，草稿显示实际存下的值。
  const handleSave = useCallback(async () => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    const domain = settingsDomainOf(active)
    adoptKeysRef.current = new Set(SETTINGS_DOMAIN_DRAFT_KEYS[domain])
    try {
      if (domain === "model") await persistModelDomain()
      else if (domain === "storage") await persistStorageDomain()
      else await persistInterfaceDomain()

      const savedKeys = new Set<keyof SettingsDraft>(SETTINGS_DOMAIN_DRAFT_KEYS[domain])
      setTouched((prev) => new Set([...prev].filter((k) => !savedKeys.has(k))))
      setSaved(true)
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      savedTimerRef.current = setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      console.error("[settings] save failed:", err)
      toast.error(t("settings.saveFailed", { error: toErrorMessage(err) }))
    } finally {
      savingRef.current = false
      setSaving(false)
      // 让保存触发的 store 更新先完成重同步，再停止采用
      setTimeout(() => {
        if (!savingRef.current) adoptKeysRef.current = null
      }, 0)
    }
  }, [active, persistModelDomain, persistStorageDomain, persistInterfaceDomain, t])

  const saveMode = SETTINGS_SAVE_MODE[active]
  const activeDomain: SettingsDomain = settingsDomainOf(active)
  const activeDirty = dirtyDomains.has(activeDomain)
  const otherDirty = [...dirtyDomains].filter((d) => d !== activeDomain)

  const body = useMemo(() => {
    switch (active) {
      case "llm":
        return <LlmProviderSection />
      case "rerank":
        return <RerankSection draft={draft} setDraft={setDraft} />
      case "embedding":
        return <EmbeddingSection draft={draft} setDraft={setDraft} />
      case "network":
        return <NetworkSection draft={draft} setDraft={setDraft} />
      case "interface":
        return <InterfaceSection draft={draft} setDraft={setDraft} />
      case "novel":
        return <NovelSection draft={draft} setDraft={setDraft} />
      case "usage-guide":
        return <UsageGuideSection />
      case "skill-library":
        return <SkillLibrarySection />
      case "mcp":
        return <McpSection />
      case "multimodal":
        return <MultimodalSection draft={draft} setDraft={setDraft} />
      case "web-search":
        return <WebSearchSection />
      case "output":
        // 历史消息数已在「小说」页（novel-base-settings-section）编辑，这里只留 AI 回复语言，避免两处入口
        return <OutputSection draft={draft} setDraft={setDraft} showHistory={false} />
      case "maintenance":
        return <MaintenanceSection />
      case "data-management":
        return <DataManagementSection />
      case "feedback":
        return <FeedbackSection />
      case "contact-support":
        return <ContactSupportSection />
      case "changelog":
        return <ChangelogSection />
    }
  }, [active, draft, setDraft])

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/30">
        <div className="flex items-center gap-1.5 px-4 pb-2 pt-4 text-xs font-semibold uppercase tracking-wider">
          <PanelHeaderWithHelp
            title={t("settings.title")}
            helpKey="settings"
            className="cursor-pointer text-muted-foreground transition-colors hover:text-primary"
          />
        </div>
        <nav aria-label={t("settings.title")} className="flex-1 overflow-y-auto px-2 pb-3">
          {SETTINGS_NAV_GROUPS.map((group) => {
            const headingId = `settings-nav-group-${group.id}`
            return (
              <div key={group.id} role="group" aria-labelledby={headingId} className="mb-2 last:mb-0">
                <div
                  id={headingId}
                  className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground"
                >
                  {t(group.labelKey)}
                </div>
                {group.categories.map((id) => {
                  const c = CATEGORIES.find((category) => category.id === id)
                  if (!c) return null
                  const Icon = c.icon
                  const isActive = c.id === active

                  return (
                    <button
                      key={c.id}
                      type="button"
                      data-settings-category={c.id}
                      onClick={() => setActive(c.id)}
                      aria-current={isActive ? "page" : undefined}
                      className={`group mb-0.5 flex min-h-8 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        isActive
                          ? "bg-foreground/[0.08] font-medium text-foreground ring-1 ring-border/70"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                      }`}
                    >
                      <Icon
                        aria-hidden="true"
                        className={`h-4 w-4 shrink-0 transition-colors ${
                          isActive ? "text-primary" : "text-muted-foreground group-hover:text-accent-foreground"
                        }`}
                      />
                      <span className="truncate" title={t(c.labelKey)}>{t(c.labelKey)}</span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </nav>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto px-8 py-6">
          <div className="w-full min-w-0">{body}</div>
        </div>

        {saveMode === "auto" ? (
          <div className="shrink-0 border-t bg-background/80 backdrop-blur px-8 py-3">
            <p className="text-xs text-muted-foreground" data-testid="settings-autosave-hint">
              {t("settings.autoSaveHint")}
            </p>
          </div>
        ) : saveMode === "draft" ? (
          <div className="shrink-0 border-t bg-background/80 backdrop-blur px-8 py-3">
            <div className="flex w-full min-w-0 items-center justify-between gap-4">
              <div className="min-w-0 space-y-0.5" role="status" aria-live="polite">
                <p className={`text-xs ${activeDirty && !saved ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                  {saved
                    ? t("settings.savedTick")
                    : saving
                      ? t("settings.saving")
                      : activeDirty
                        ? t("settings.unsavedHint")
                        : t("settings.changeHint")}
                  {t(`settings.saveScope.${activeDomain}`)}
                </p>
                {otherDirty.length > 0 && (
                  <p className="text-xs text-warning-foreground" data-testid="settings-other-dirty">
                    {t("settings.otherDomainsDirty", {
                      domains: otherDirty.map((d) => t(`settings.domainName.${d}`)).join(t("settings.listSeparator")),
                    })}
                  </p>
                )}
              </div>
              <Button
                onClick={handleSave}
                data-testid="settings-save-domain"
                aria-disabled={saving || undefined}
                aria-busy={saving || undefined}
                variant={activeDirty ? "default" : "outline"}
              >
                {saving && <Loader2 aria-hidden="true" className="mr-1.5 h-4 w-4 animate-spin" />}
                {saved ? t("settings.saved") : t("settings.save")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
