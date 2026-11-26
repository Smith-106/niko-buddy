/**
 * model-routes-view.tsx — 写作模型分工视图（响应式订阅 + 快捷跳转设置）。
 *
 * ## 职责
 *   - 响应式订阅 `useWikiStore`（切设置返回立即同步，不留陈旧缓存）；
 *   - 使用 `@/lib/novel` 的 `resolveNovelModel` 真实解析四条核心写作任务路由：
 *     正文写作（writing）、章节审稿（review）、剧情摘要（summary）、记忆提取（extract），
 *     明确标出「专用覆盖」或「跟随主模型」；
 *   - 若已开启多模型共识，展示写作共识与审稿共识席位；
 *   - 提供「前往模型设置」「前往写作路由设置」快捷入口。
 *
 * 中文 UI；只读展示（修改统一前往设置页）。
 *
 * @license MIT © Niko Buddy
 */

import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Cpu, Settings2, Users } from "lucide-react"
import { ReportCallout, ReportPage, ReportSection } from "./report-page"
import { Button } from "@/components/ui/button"
import { resolveNovelModel, type NovelTaskType } from "@/lib/novel"
import {
  useWikiStore,
  type LlmConfig,
  type NovelConfig,
  type ProviderConfigs,
} from "@/stores/wiki-store"

/** 四条核心写作任务路由（与 model-resolver.ts 的真实解析对齐）。 */
export type CoreNovelRouteTask = Extract<NovelTaskType, "writing" | "review" | "summary" | "extract">

const CORE_ROUTE_TASKS: readonly {
  readonly task: CoreNovelRouteTask
  readonly labelKey: string
  readonly defaultLabel: string
}[] = [
  { task: "writing", labelKey: "novel.modelRoutes.taskWriting", defaultLabel: "正文写作" },
  { task: "review", labelKey: "novel.modelRoutes.taskReview", defaultLabel: "章节审稿" },
  { task: "summary", labelKey: "novel.modelRoutes.taskSummary", defaultLabel: "剧情摘要" },
  { task: "extract", labelKey: "novel.modelRoutes.taskExtract", defaultLabel: "记忆提取" },
]

export interface CoreModelRouteRow {
  readonly task: CoreNovelRouteTask
  readonly labelKey: string
  readonly defaultLabel: string
  readonly configuredModel: string
  readonly resolvedModel: string
  readonly isOverride: boolean
}

export interface ModelSourceRow {
  readonly id: string
  readonly label: string
  readonly savedModelCount: number
}

export interface ConsensusSeatSummary {
  readonly enabled: boolean
  readonly draftModels: readonly string[]
  readonly reviewGroups: ReadonlyArray<{ readonly dimension: string; readonly models: readonly string[] }>
  readonly debateRounds: number
}

export interface ModelRoutesSnapshot {
  readonly primaryModelId: string
  readonly defaultLlmModel: string
  readonly aiChatModel: string
  readonly routes: readonly CoreModelRouteRow[]
  readonly consensus: ConsensusSeatSummary
  readonly sources: readonly ModelSourceRow[]
}

/** 装载输入（全局 store 切片；显式传参以便脱离 Tauri 单元测试）。 */
export interface ModelRoutesStoreSlice {
  readonly llmConfig: LlmConfig
  readonly novelConfig: NovelConfig
  readonly defaultLlmModel: string
  readonly aiChatModel: string
  readonly providerConfigs: ProviderConfigs
}

/**
 * 纯装载：基于真实 `resolveNovelModel` 解析四条写作任务路由 + 多模型共识席位 + 已配置服务商摘要。
 * 主模型与所有任务覆盖均为空 → 返回 null（诚实「未配置」，不编造绑定）。
 */
export function loadModelRoutesSnapshot(slice: ModelRoutesStoreSlice): ModelRoutesSnapshot | null {
  const aiChat = slice.aiChatModel.trim()
  const defaultModel = slice.defaultLlmModel.trim()
  const baseConfigModel = slice.llmConfig.model.trim()
  const primaryModelId = aiChat || defaultModel || baseConfigModel

  const taskOverrides: Record<CoreNovelRouteTask, string> = {
    writing: "",
    review: slice.novelConfig.reviewModel.trim(),
    summary: slice.novelConfig.summaryModel.trim(),
    extract: slice.novelConfig.extractModel.trim(),
  }

  const hasAnyModel =
    primaryModelId !== "" ||
    Object.values(taskOverrides).some((m) => m !== "")
  if (!hasAnyModel) return null

  const storeSnapshot = {
    providerConfigs: slice.providerConfigs,
    defaultLlmModel: slice.defaultLlmModel,
    aiChatModel: slice.aiChatModel,
  }

  const routes: readonly CoreModelRouteRow[] = CORE_ROUTE_TASKS.map((entry) => {
    const override = taskOverrides[entry.task]
    const resolved = resolveNovelModel(slice.llmConfig, slice.novelConfig, entry.task, storeSnapshot)
    const resolvedLabel = override || resolved.model?.trim() || primaryModelId
    return {
      task: entry.task,
      labelKey: entry.labelKey,
      defaultLabel: entry.defaultLabel,
      configuredModel: override,
      resolvedModel: resolvedLabel,
      isOverride: override !== "",
    }
  })

  const draftModels = (slice.novelConfig.consensusWritingModels ?? [])
    .map((m) => m.trim())
    .filter(Boolean)
  const reviewGroups = Object.entries(slice.novelConfig.consensusReviewModels ?? {})
    .map(([dimension, models]) => ({
      dimension,
      models: (models ?? []).map((m) => m.trim()).filter(Boolean),
    }))
    .filter((group) => group.models.length > 0)

  const sources: readonly ModelSourceRow[] = Object.entries(slice.providerConfigs).map(
    ([id, override]) => ({
      id,
      label: override.label?.trim() || id,
      savedModelCount: override.savedModels?.length ?? 0,
    }),
  )

  return {
    primaryModelId,
    defaultLlmModel: slice.defaultLlmModel,
    aiChatModel: slice.aiChatModel,
    routes,
    consensus: {
      enabled: Boolean(slice.novelConfig.consensusEnabled),
      draftModels,
      reviewGroups,
      debateRounds: slice.novelConfig.consensusDebateRounds ?? 1,
    },
    sources,
  }
}

export interface ModelRoutesViewProps {
  /** 项目根路径（统一签名；本视图展示全局模型分工，未指定时显示空态）。 */
  readonly projectPath: string
}

export function ModelRoutesView({ projectPath }: ModelRoutesViewProps) {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const novelConfig = useWikiStore((s) => s.novelConfig)
  const defaultLlmModel = useWikiStore((s) => s.defaultLlmModel)
  const aiChatModel = useWikiStore((s) => s.aiChatModel)
  const providerConfigs = useWikiStore((s) => s.providerConfigs)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setActiveSettingsCategory = useWikiStore((s) => s.setActiveSettingsCategory)

  const snapshot = useMemo(() => {
    if (projectPath === "") return null
    return loadModelRoutesSnapshot({
      llmConfig,
      novelConfig,
      defaultLlmModel,
      aiChatModel,
      providerConfigs,
    })
  }, [aiChatModel, defaultLlmModel, llmConfig, novelConfig, projectPath, providerConfigs])

  const openLlmSettings = () => {
    setActiveSettingsCategory("llm")
    setActiveView("settings")
  }

  const openNovelRouteSettings = () => {
    setActiveSettingsCategory("novel")
    setActiveView("settings")
  }

  const hasOverride = snapshot?.routes.some((row) => row.isOverride) ?? false

  return (
    <ReportPage
      testId="model-routes-view"
      title={t("novel.modelRoutes.title", { defaultValue: "模型分工" })}
      description={t("novel.modelRoutes.description", {
        defaultValue: "查看正文写作、章节审稿、剧情摘要与记忆提取各自使用的模型。调整请前往设置页。",
      })}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="model-routes-open-llm-settings"
          onClick={openLlmSettings}
        >
          <Settings2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t("novel.modelRoutes.openLlmSettings", { defaultValue: "前往模型设置" })}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="model-routes-open-novel-settings"
          onClick={openNovelRouteSettings}
        >
          <Settings2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t("novel.modelRoutes.openNovelSettings", { defaultValue: "前往写作路由设置" })}
        </Button>
      </div>

      {snapshot === null ? (
        <ReportCallout testId="model-routes-empty" tone="neutral">
          {projectPath === ""
            ? t("novel.modelRoutes.noProject", { defaultValue: "未指定项目路径，打开任意项目后查看全局模型分工" })
            : t("novel.modelRoutes.noModelConfigured", {
                defaultValue: "尚未配置可用模型，请先前往模型设置完成接入",
              })}
        </ReportCallout>
      ) : (
        <>
          <ReportSection title={t("novel.modelRoutes.nextStepTitle", { defaultValue: "当前状态" })}>
            <p className="text-sm font-medium text-foreground">
              {hasOverride
                ? t("novel.modelRoutes.hasOverridesSummary", {
                    defaultValue: "部分环节已指定专用模型，其余环节跟随主模型运行。",
                  })
                : t("novel.modelRoutes.allFollowPrimarySummary", {
                    defaultValue: "四个核心写作环节目前均跟随主模型运行，可在写作设置中为审稿、摘要或提取单独指定模型。",
                  })}
            </p>
          </ReportSection>

          <div data-testid="model-routes-base" className="rounded-md border border-border bg-background px-3 py-2">
            <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
              {t("novel.modelRoutes.primarySectionTitle", { defaultValue: "当前主模型" })}
            </div>
            <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <div className="flex gap-1">
                <dt>{t("novel.modelRoutes.primaryModelLabel", { defaultValue: "生效主模型：" })}</dt>
                <dd data-testid="model-routes-base-id" className="font-mono text-foreground">
                  {snapshot.primaryModelId || t("novel.modelRoutes.notConfigured", { defaultValue: "未配置" })}
                </dd>
              </div>
              <div className="flex gap-1">
                <dt>{t("novel.modelRoutes.chatModelLabel", { defaultValue: "会话模型：" })}</dt>
                <dd className="font-mono">
                  {snapshot.aiChatModel.trim() || t("novel.modelRoutes.notConfigured", { defaultValue: "未配置" })}
                </dd>
              </div>
              <div className="flex gap-1">
                <dt>{t("novel.modelRoutes.defaultModelLabel", { defaultValue: "全局默认模型：" })}</dt>
                <dd className="font-mono">
                  {snapshot.defaultLlmModel.trim() || t("novel.modelRoutes.notConfigured", { defaultValue: "未配置" })}
                </dd>
              </div>
            </dl>
          </div>

          <div data-testid="model-routes-roles" className="rounded-md border border-border bg-background px-3 py-2">
            <p className="text-sm font-medium text-foreground">
              {t("novel.modelRoutes.coreRoutesTitle", { defaultValue: "核心写作环节分工" })}
            </p>
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {snapshot.routes.map((row) => (
                <li
                  key={row.task}
                  data-testid={`model-route-${row.task}`}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
                >
                  <span className="font-medium text-foreground">
                    {t(row.labelKey, { defaultValue: row.defaultLabel })}
                  </span>
                  <span className="font-mono text-foreground">
                    {row.resolvedModel || t("novel.modelRoutes.notConfigured", { defaultValue: "未配置" })}
                  </span>
                  <span
                    className={
                      row.isOverride
                        ? "rounded bg-primary/10 px-1.5 py-0.5 text-primary"
                        : "rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
                    }
                  >
                    {row.isOverride
                      ? t("novel.modelRoutes.badgeOverride", { defaultValue: "专用覆盖" })
                      : t("novel.modelRoutes.badgeFollowPrimary", { defaultValue: "跟随主模型" })}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {snapshot.consensus.enabled ? (
            <div data-testid="model-routes-consensus" className="rounded-md border border-border bg-background px-3 py-2">
              <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <Users className="h-3.5 w-3.5" aria-hidden="true" />
                {t("novel.modelRoutes.consensusTitle", { defaultValue: "多模型协同席位（已开启）" })}
              </div>
              <div className="mt-1.5 space-y-1.5 text-xs text-muted-foreground">
                <div>
                  <span className="font-medium text-foreground">
                    {t("novel.modelRoutes.consensusWritingLabel", { defaultValue: "写作协同席位：" })}
                  </span>
                  {snapshot.consensus.draftModels.length > 0 ? (
                    <span className="font-mono">{snapshot.consensus.draftModels.join("、")}</span>
                  ) : (
                    <span>{t("novel.modelRoutes.consensusFallbackPrimary", { defaultValue: "跟随主模型（未单独配置席位）" })}</span>
                  )}
                </div>
                <div>
                  <span className="font-medium text-foreground">
                    {t("novel.modelRoutes.consensusReviewLabel", { defaultValue: "审稿协同席位：" })}
                  </span>
                  {snapshot.consensus.reviewGroups.length > 0 ? (
                    <ul className="mt-1 space-y-0.5 pl-3">
                      {snapshot.consensus.reviewGroups.map((group) => (
                        <li key={group.dimension}>
                          <span>{group.dimension}：</span>
                          <span className="font-mono">{group.models.join("、")}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span>{t("novel.modelRoutes.consensusFallbackReview", { defaultValue: "跟随章节审稿模型" })}</span>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          <div data-testid="model-routes-providers" className="rounded-md border border-border bg-background px-3 py-2">
            <p className="text-sm font-medium text-foreground">
              {t("novel.modelRoutes.sourcesTitle", {
                count: snapshot.sources.length,
                defaultValue: `已配置的模型服务（共 ${snapshot.sources.length} 个）`,
              })}
            </p>
            {snapshot.sources.length === 0 ? (
              <p data-testid="model-routes-no-providers" className="mt-1 text-xs text-muted-foreground">
                {t("novel.modelRoutes.noSources", { defaultValue: "尚未保存任何模型服务配置" })}
              </p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {snapshot.sources.map((source) => (
                  <li
                    key={source.id}
                    data-testid={`model-provider-${source.id}`}
                    className="flex flex-wrap gap-x-2 text-xs text-muted-foreground"
                  >
                    <span className="font-medium text-foreground">{source.label}</span>
                    <span>
                      {t("novel.modelRoutes.savedModelsCount", {
                        count: source.savedModelCount,
                        defaultValue: `已保存模型 ${source.savedModelCount} 个`,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </ReportPage>
  )
}
