import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { Clapperboard, X, Wrench } from "lucide-react"
import { ReviewView } from "./review-view"
import { DashboardView } from "@/components/dashboard/dashboard-view"
import { Button } from "@/components/ui/button"
import { CorkboardView } from "@/components/novel/corkboard-view"
import { PlotgridView } from "@/components/novel/plotgrid-view"
import { TimelineView } from "@/components/novel/timeline-view"
import { ArcWorkbench } from "@/components/novel/craft/arc-workbench"
import { ThrillDashboard } from "@/components/novel/craft/thrill-dashboard"
import { TechniquePanel } from "@/components/novel/craft/technique-panel"
import { WishDrive } from "@/components/novel/wish-drive"
import type { WishDriveProfile } from "@/components/novel/wish-drive"
import { queryCanonBatch } from "@/components/canon-editor/canon-editor-client"
import { isArcStage } from "@/lib/novel"
import { readFile } from "@/commands/fs"
import { startSixDimensionReviewRun, SIX_REVIEW_DIMENSION_ORDER } from "@/lib/novel"
import type { SixReviewDimensionKey } from "@/lib/novel"

function isSixReviewDimensionKey(value: string | null): value is SixReviewDimensionKey {
  return SIX_REVIEW_DIMENSION_ORDER.includes(value as SixReviewDimensionKey)
}

// F-010: storyboard 可视化子面板 tab（不新增 activeView，opt-in 默认隐藏）
type StoryboardTab = "corkboard" | "plotgrid" | "timeline"

const STORYBOARD_TABS: Array<{ key: StoryboardTab; labelKey: string }> = [
  { key: "corkboard", labelKey: "reviewCenter.storyboard.corkboard" },
  { key: "plotgrid", labelKey: "reviewCenter.storyboard.plotgrid" },
  { key: "timeline", labelKey: "reviewCenter.storyboard.timeline" },
]

// T29a: craft 子面板 tab（F-06 弧光工作台 / F-07 爽点仪表盘 / F-08 技法面板）
// F8 (Round-8 断链修复): + wish-drive 卡文引导 tab（F-27/T29b 装配可见；props-DI + null 空态安全，
//   数据源走 canon_query_batch motivation/arc 边投影→WishDriveProfile；零 IO/零 invoke 由 canon-editor-client 承载，
//   本组件只做只读投影映射；关闭/空数据时零行为变化）。
type CraftTab = "arc-workbench" | "thrill-dashboard" | "technique-panel" | "wish-drive"

const CRAFT_TABS: Array<{ key: CraftTab; labelKey: string }> = [
  { key: "arc-workbench", labelKey: "reviewCenter.craftTabs.arcWorkbench" },
  { key: "thrill-dashboard", labelKey: "reviewCenter.craftTabs.thrillDashboard" },
  { key: "technique-panel", labelKey: "reviewCenter.craftTabs.techniquePanel" },
  { key: "wish-drive", labelKey: "reviewCenter.craftTabs.wishDrive" },
]

export interface WishDriveEdgeProjection {
  edge_kind: string
  predicate: string
  target_id: string
}

/**
 * F8 wish-drive 数据源投影：canon motivation/arc 边 → WishDriveProfile（只读映射，fail-open）。
 * 边缺字段/空集 → 返回 null（WishDrive 空态，不拦其余 tab）。wish 取 motivation 边 predicate 首句；
 * motive 取 motivation 边 target_id 非空去重；wmaAction 暂无专列边→空（A-22.6 自洽第3条仅在承诺后段要求行动证据，
 * 空数组语义=无证据而非缺省值）；arcStage 取 arc 边 predicate 经 isArcStage 兜底（脏值→null→arc_stage_invalid 门拦下）。
 */
export function projectWishDriveProfile(edges: WishDriveEdgeProjection[]): WishDriveProfile | null {
  const motivations = edges.filter((e) => e.edge_kind === "motivation")
  const arcs = edges.filter((e) => e.edge_kind === "arc")
  if (motivations.length === 0 && arcs.length === 0) return null
  const wish = motivations.map((e) => e.predicate.split("。")[0]?.trim()).filter((s): s is string => Boolean(s))
  const motive = [...new Set(motivations.map((e) => e.target_id.trim()).filter(Boolean))]
  const rawStage = arcs[0]?.predicate.trim() ?? ""
  return {
    entityId: "canon:protagonist",
    wish: wish.length > 0 ? wish : undefined,
    motive: motive.length > 0 ? motive : undefined,
    wmaAction: [],
    arcStage: (isArcStage(rawStage) ? rawStage : null) as WishDriveProfile["arcStage"],
  }
}

export function ReviewCenterView() {
  const { t } = useTranslation()
  const selectedReviewDimension = useWikiStore((s) => s.selectedReviewDimension)
  const novelMode = useWikiStore((s) => s.novelMode)
  const [storyboardOpen, setStoryboardOpen] = useState(false)
  const [storyboardTab, setStoryboardTab] = useState<StoryboardTab>("corkboard")
  const [craftOpen, setCraftOpen] = useState(false)
  const [craftTab, setCraftTab] = useState<CraftTab>("arc-workbench")
  // F8 wish-drive 数据源：切到卡文引导 tab 时懒取 motivation/arc 边（只读 batch 单 invoke；
  // 失败→空数组→WishDrive 空态，不拦面板与其余 tab；projectId 口径与 CanonEditor 一致用 project.id）。
  const wishProjectId = useWikiStore((s) => s.project?.id ?? "")
  const [wishEdges, setWishEdges] = useState<WishDriveEdgeProjection[] | null>(null)
  useEffect(() => {
    if (!craftOpen || craftTab !== "wish-drive" || wishEdges !== null || !wishProjectId) return
    let cancelled = false
    void queryCanonBatch(wishProjectId, [{ edge_kinds: ["motivation", "arc"] }]).then(
      (res) => {
        if (cancelled) return
        setWishEdges(
          (res.results[0] ?? []).map((e) => ({
            edge_kind: String(e.edge_kind),
            predicate: String(e.predicate ?? ""),
            target_id: String(e.target_id ?? ""),
          })),
        )
      },
      () => {
        if (!cancelled) setWishEdges([])
      },
    )
    return () => {
      cancelled = true
    }
  }, [craftOpen, craftTab, wishEdges, wishProjectId])
  const wishProfile = useMemo(
    () => (wishEdges === null ? null : projectWishDriveProfile(wishEdges)),
    [wishEdges],
  )

  let content: ReactNode
  if (selectedReviewDimension === "ai-review") {
    content = <ReviewView />
  } else if (selectedReviewDimension === "character-report") {
    // F11-3：同文件硬编码收敛（editor/user-r11）：emptyMessage 走 i18n 键。
    content = <ReviewView title={t("reviewCenter.characterHitReport")} emptyMessage={t("reviewCenter.characterEmptyHint")} characterOnly />
  } else if (!selectedReviewDimension || !novelMode) {
    content = <DashboardView headerActions={<ReviewStartButton />} />
  } else if (!isSixReviewDimensionKey(selectedReviewDimension)) {
    content = <DashboardView headerActions={<ReviewStartButton />} />
  } else {
    content = (
      <ReviewView
        title={t(`reviewCenter.dimension.${selectedReviewDimension}`)}
        emptyMessage={t("reviewCenter.noResults")}
        dimensionKey={selectedReviewDimension}
      />
    )
  }

  return (
    <div className="relative h-full min-h-0">
      {content}
      {/* F-010: storyboard opt-in 入口（右下角悬浮按钮，默认隐藏） */}
      {!storyboardOpen && (
        <button
          type="button"
          onClick={() => setStoryboardOpen(true)}
          data-storyboard-toggle="true"
          title={t("reviewCenter.storyboard.title")}
          className="absolute bottom-4 right-4 z-20 flex items-center gap-1.5 rounded-full border bg-background px-3 py-2 text-xs font-medium shadow-md transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Clapperboard className="h-4 w-4" aria-hidden="true" />
          {t("reviewCenter.storyboard.toggle")}
        </button>
      )}
      {storyboardOpen && (
        <aside
          data-storyboard-panel="true"
          aria-label={t("reviewCenter.storyboard.title")}
          className="absolute inset-y-0 right-0 z-30 flex w-[420px] max-w-[90%] flex-col border-l bg-background shadow-xl"
        >
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <div className="flex items-center gap-1">
              {STORYBOARD_TABS.map(({ key, labelKey }) => (
                <button
                  key={key}
                  type="button"
                  data-storyboard-tab={key}
                  onClick={() => setStoryboardTab(key)}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    storyboardTab === key ? "qm-selected" : "text-muted-foreground qm-hover"
                  }`}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setStoryboardOpen(false)}
              data-storyboard-close="true"
              aria-label={t("reviewCenter.storyboard.close")}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {storyboardTab === "corkboard" && <CorkboardView />}
            {storyboardTab === "plotgrid" && <PlotgridView />}
            {storyboardTab === "timeline" && <TimelineView />}
          </div>
        </aside>
      )}
      {/* T29a: craft 子面板入口（右下角第二个悬浮按钮，与 storyboard 并列） */}
      {!craftOpen && (
        <button
          type="button"
          onClick={() => setCraftOpen(true)}
          data-craft-toggle="true"
          title={t("reviewCenter.craftWorkbench")}
          className="absolute bottom-4 right-20 z-20 flex items-center gap-1.5 rounded-full border bg-background px-3 py-2 text-xs font-medium shadow-md transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Wrench className="h-4 w-4" aria-hidden="true" />
          {t("reviewCenter.craftToggle")}
        </button>
      )}
      {craftOpen && (
        <aside
          data-craft-panel="true"
          aria-label={t("reviewCenter.craftWorkbench")}
          className="absolute inset-y-0 right-0 z-30 flex w-[420px] max-w-[90%] flex-col border-l bg-background shadow-xl"
        >
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <div className="flex items-center gap-1">
              {CRAFT_TABS.map(({ key, labelKey }) => (
                <button
                  key={key}
                  type="button"
                  data-craft-tab={key}
                  onClick={() => setCraftTab(key)}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    craftTab === key ? "qm-selected" : "text-muted-foreground qm-hover"
                  }`}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setCraftOpen(false)}
              data-craft-close="true"
              aria-label={t("reviewCenter.closeCraft")}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {craftTab === "arc-workbench" && <ArcWorkbench />}
            {craftTab === "thrill-dashboard" && <ThrillDashboard />}
            {craftTab === "technique-panel" && <TechniquePanel />}
            {craftTab === "wish-drive" && <WishDrive profile={wishProfile} />}
          </div>
        </aside>
      )}
    </div>
  )
}

function ReviewStartButton() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const selectedReviewFilePath = useWikiStore((s) => s.selectedReviewFilePath)
  const reviewRun = useWikiStore((s) => s.reviewRun)
  const cancelReviewRun = useWikiStore((s) => s.cancelReviewRun)
  const isReviewing = reviewRun?.running ?? false
  const canReview = Boolean(project?.path && selectedReviewFilePath) && !isReviewing
  /** 开始审查的前置读取失败（旧实现只 console.error，界面点下去没任何反应）。 */
  const [reviewError, setReviewError] = useState("")

  const handleStartReview = useCallback(() => {
    setReviewError("")
    /* v8 ignore next */
    if (!project?.path || !selectedReviewFilePath || isReviewing) return
    void readFile(selectedReviewFilePath)
      .then((content) => startSixDimensionReviewRun({
        fileContent: content,
        projectPath: project.path,
        selectedFile: selectedReviewFilePath,
        t,
      }))
      .catch((error) => {
        // 只 console.error 时点「开始审查」毫无反应；失败必须让用户看到。
        console.error("[ReviewCenterView] 读取审查章节失败:", error)
        setReviewError(
          // F11-3：去掉中文 fallback 兜底（key 中英在位：zh.json/en.json readFailed）。
          // F13：全宽冒号 → 半宽（en 面零 CJK 标点口径；zh 面渲染等价）。
          `${t("reviewCenter.readFailed")}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      })
  }, [isReviewing, project?.path, selectedReviewFilePath, t])

  if (isReviewing) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={cancelReviewRun}
        title={t("reviewCenter.cancelReview")}
      >
        {t("reviewCenter.cancelReview")}
      </Button>
    )
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="outline"
        size="sm"
        onClick={handleStartReview}
        disabled={!canReview}
        // F11-3：同文件硬编码收敛（editor/user-r11）：title 走 i18n 键。
        title={selectedReviewFilePath ? undefined : t("reviewCenter.selectChapterFirst")}
      >
        {isReviewing ? t("reviewCenter.reviewingAction") : t("reviewCenter.startReview")}
      </Button>
      {reviewError ? (
        <p data-testid="review-start-error" role="alert" className="text-xs text-destructive">
          {reviewError}
        </p>
      ) : null}
    </div>
  )
}
