/**
 * model-routes-view.tsx — 模型路由配置只读视图。
 *
 * ## 职责
 *   - 全局模型路由只读展示：基准模型（审查/默认/会话模型三源回退）+
 *     五角色路由解析（writer/critic/reviser/arbiter/judge）+ provider 配置摘要；
 *   - 不提供任何写回（路由/密钥修改请走设置页），本页只读。
 *
 * ## 数据源（全部经 barrel `@/lib/novel`，已 grep 确认存在）
 *   - `resolveReviewModel()`（model-resolver：读全局 novelConfig.reviewModel）；
 *   - `normalizeRoutePolicy` + `resolveRouteModel`（scheduling-gate：本地 RoutePolicy
 *     规范化与角色解析，纯函数）；
 *   - provider 配置摘要直读 `useWikiStore` 全局 `providerConfigs`（store 允许
 *     app 侧直接消费； novel 域边界仅约束 `@/lib/novel` 深导入）。
 *
 * ## 缺口记录（2026-10-19）
 *   - barrel 未导出 `WritingRole` / `ALL_WRITING_ROLES`（仅 scheduling-gate 内部
 *     引用 `@/lib/llm/model-resolver`），组件不得深导入该模块，故下方
 *     `ModelRouteRole` 是与 T33 同形的本地镜像联合类型（writer/critic/reviser/
 *     arbiter/judge，顺序按管线）；barrel 补齐导出后应切回。
 *   - 仓库内无持久化的 RoutePolicy 真源（wiki-store 无 routePolicy 字段）：
 *     本视图以「审查/默认/会话模型」为基准模型现场组装空绑定 policy
 *     （roleBindings={}），各角色如实显示「走兜底」，绝不编造绑定关系。
 *   - provider 配置为全局设置（非项目级）：`projectPath === ""` 时仍按统一签名
 *     显示空态，不展示全局数据。
 *
 * 中文 UI；只读。
 *
 * @license MIT © Niko Buddy
 */

import { useEffect, useState } from "react"
import { Cpu, Loader2 } from "lucide-react"
import { ReportCallout, ReportPage, ReportSection } from "./report-page"
import {
  normalizeRoutePolicy,
  resolveReviewModel,
  resolveRouteModel,
  type RoutePolicy,
  type RouteResolution,
} from "@/lib/novel"
import { useWikiStore, type ProviderConfigs } from "@/stores/wiki-store"

/** 五角色（本地镜像，见文件头缺口记录；与 T33 WritingRole 同形同序）。 */
export type ModelRouteRole = "writer" | "critic" | "reviser" | "arbiter" | "judge"

const MODEL_ROUTE_ROLES: readonly { readonly role: ModelRouteRole; readonly label: string }[] = [
  { role: "writer", label: "写作" },
  { role: "critic", label: "批评" },
  { role: "reviser", label: "改写" },
  { role: "arbiter", label: "仲裁" },
  { role: "judge", label: "终审" },
]

export interface ModelRouteResolutionRow {
  readonly role: ModelRouteRole
  readonly label: string
  readonly resolution: RouteResolution
}

export interface ModelProviderRow {
  readonly id: string
  readonly label: string
  readonly savedModelCount: number
}

export interface ModelRoutesSnapshot {
  readonly baseModelId: string
  readonly reviewModel: string
  readonly defaultLlmModel: string
  readonly aiChatModel: string
  readonly policy: RoutePolicy
  readonly resolutions: readonly ModelRouteResolutionRow[]
  readonly providers: readonly ModelProviderRow[]
}

/** 装载输入（全局 store 切片；显式传参以便脱离 Tauri 单元测试）。 */
export interface ModelRoutesStoreSlice {
  readonly reviewModel: string
  readonly defaultLlmModel: string
  readonly aiChatModel: string
  readonly providerConfigs: ProviderConfigs
}

/**
 * 纯装载：全局路由快照。
 *
 * 基准模型回退链 = 审查模型 > 默认模型 > 会话模型（与 resolveDefaultModel
 * 的 defaultLlmModel > aiChatModel 优先级同向，审查优先是本视图的展示选择）。
 * 三源全空 → 返回 null（诚实「未配置」，不编造 policy）。
 */
export function loadModelRoutesSnapshot(slice: ModelRoutesStoreSlice): ModelRoutesSnapshot | null {
  const baseModelId =
    slice.reviewModel.trim() || slice.defaultLlmModel.trim() || slice.aiChatModel.trim()
  if (baseModelId === "") return null
  const policy = normalizeRoutePolicy({
    version: "route-policy/1.0",
    defaultModelId: baseModelId,
    roleBindings: {},
  })
  const resolutions: readonly ModelRouteResolutionRow[] = MODEL_ROUTE_ROLES.map((entry) => ({
    role: entry.role,
    label: entry.label,
    resolution: resolveRouteModel(policy, entry.role),
  }))
  const providers: readonly ModelProviderRow[] = Object.entries(slice.providerConfigs).map(
    ([id, override]) => ({
      id,
      label: override.label?.trim() || id,
      savedModelCount: override.savedModels?.length ?? 0,
    }),
  )
  return {
    baseModelId,
    reviewModel: slice.reviewModel,
    defaultLlmModel: slice.defaultLlmModel,
    aiChatModel: slice.aiChatModel,
    policy,
    resolutions,
    providers,
  }
}

export interface ModelRoutesViewProps {
  /** 项目根路径（统一签名；本视图展示的是全局路由，未指定时显示空态）。 */
  readonly projectPath: string
}

export function ModelRoutesView({ projectPath }: ModelRoutesViewProps) {
  const [snapshot, setSnapshot] = useState<ModelRoutesSnapshot | null>(null)
  const [loading, setLoading] = useState(projectPath !== "")

  useEffect(() => {
    if (projectPath === "") {
      setSnapshot(null)
      setLoading(false)
      return
    }
    const state = useWikiStore.getState()
    setSnapshot(
      loadModelRoutesSnapshot({
        reviewModel: resolveReviewModel(),
        defaultLlmModel: state.defaultLlmModel,
        aiChatModel: state.aiChatModel,
        providerConfigs: state.providerConfigs,
      }),
    )
    setLoading(false)
  }, [projectPath])

  return (
    <ReportPage
      testId="model-routes-view"
      title="模型路由"
      description="这里只看每个角色用哪个模型。要改，去设置页。"
    >
      {loading ? (
        <p data-testid="model-routes-loading" className="flex items-center gap-1 text-sm text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          正在读取模型路由配置…
        </p>
      ) : snapshot === null ? (
        <ReportCallout testId="model-routes-empty" tone="neutral">
          {projectPath === "" ? "未指定项目路径，打开任意项目后查看全局配置" : "全局未配置可用模型（审查/默认/会话模型均为空），请先在设置页配置模型"}
        </ReportCallout>
      ) : (
        <>
          <ReportSection title="下一步">
            <p className="text-base font-medium text-foreground">
              {snapshot.resolutions.every((row) => row.resolution.usedDefault)
                ? "角色绑定表为空，五个角色目前都走兜底模型。要改模型，去设置页。"
                : "有角色已经指定了模型。要改，去设置页。"}
            </p>
          </ReportSection>
          <div data-testid="model-routes-base" className="rounded-md border border-border bg-background px-3 py-2">
            <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Cpu className="h-3.5 w-3.5" />
              基准模型
            </div>
            <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <div className="flex gap-1">
                <dt>基准：</dt>
                <dd data-testid="model-routes-base-id" className="font-mono">
                  {snapshot.baseModelId}
                </dd>
              </div>
              <div className="flex gap-1">
                <dt>审查模型：</dt>
                <dd className="font-mono">{snapshot.reviewModel.trim() || "未配置"}</dd>
              </div>
              <div className="flex gap-1">
                <dt>默认模型：</dt>
                <dd className="font-mono">{snapshot.defaultLlmModel.trim() || "未配置"}</dd>
              </div>
              <div className="flex gap-1">
                <dt>会话模型：</dt>
                <dd className="font-mono">{snapshot.aiChatModel.trim() || "未配置"}</dd>
              </div>
            </dl>

          </div>

          <div data-testid="model-routes-roles" className="rounded-md border border-border bg-background px-3 py-2">
            <p className="text-sm font-medium text-foreground">五角色路由解析</p>
            <ul className="mt-1 flex flex-col gap-1">
              {snapshot.resolutions.map((row) => (
                <li
                  key={row.role}
                  data-testid={`model-route-${row.role}`}
                  className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground"
                >
                  <span className="font-medium text-foreground">{row.label}</span>
                  <span className="sr-only">{row.role}</span>
                  <span className="font-mono">{row.resolution.modelId}</span>
                  {row.resolution.usedDefault ? (
                    <span className="rounded bg-muted px-1.5 py-0.5">走兜底</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>

          <div data-testid="model-routes-providers" className="rounded-md border border-border bg-background px-3 py-2">
            <p className="text-sm font-medium text-foreground">
              模型来源（全局，共 {snapshot.providers.length} 个）
            </p>
            {snapshot.providers.length === 0 ? (
              <p data-testid="model-routes-no-providers" className="mt-1 text-xs text-muted-foreground">
                暂无 provider 配置
              </p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {snapshot.providers.map((provider) => (
                  <li
                    key={provider.id}
                    data-testid={`model-provider-${provider.id}`}
                    className="flex flex-wrap gap-x-2 text-xs text-muted-foreground"
                  >
                    <span className="font-medium text-foreground">{provider.label}</span>
                    <span className="font-mono">{provider.id}</span>
                    <span>已保存模型 {provider.savedModelCount} 个</span>
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
