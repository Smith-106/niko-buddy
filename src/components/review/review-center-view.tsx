import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import { useCallback, useState, type ReactNode } from "react"
import { Clapperboard, X } from "lucide-react"
import { ReviewView } from "./review-view"
import { DashboardView } from "@/components/dashboard/dashboard-view"
import { Button } from "@/components/ui/button"
import { CorkboardView } from "@/components/novel/corkboard-view"
import { PlotgridView } from "@/components/novel/plotgrid-view"
import { TimelineView } from "@/components/novel/timeline-view"
import { readFile } from "@/commands/fs"
import { startSixDimensionReviewRun } from "@/lib/novel/start-six-dimension-review-run"
import { SIX_REVIEW_DIMENSION_ORDER, type SixReviewDimensionKey } from "@/lib/novel/dimension-review-adapter"

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

export function ReviewCenterView() {
  const { t } = useTranslation()
  const selectedReviewDimension = useWikiStore((s) => s.selectedReviewDimension)
  const novelMode = useWikiStore((s) => s.novelMode)
  const [storyboardOpen, setStoryboardOpen] = useState(false)
  const [storyboardTab, setStoryboardTab] = useState<StoryboardTab>("corkboard")

  let content: ReactNode
  if (selectedReviewDimension === "ai-review") {
    content = <ReviewView />
  } else if (selectedReviewDimension === "character-report") {
    content = <ReviewView title="角色命中报告" emptyMessage="暂无角色命中报告，请先运行AI审稿。" characterOnly />
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
    </div>
  )
}

function ReviewStartButton() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const selectedReviewFilePath = useWikiStore((s) => s.selectedReviewFilePath)
  const reviewRun = useWikiStore((s) => s.reviewRun)
  const isReviewing = reviewRun?.running ?? false
  const canReview = Boolean(project?.path && selectedReviewFilePath) && !isReviewing

  const handleStartReview = useCallback(() => {
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
        console.error("[ReviewCenterView] 读取审查章节失败:", error)
      })
  }, [isReviewing, project?.path, selectedReviewFilePath, t])

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleStartReview}
      disabled={!canReview}
      title={selectedReviewFilePath ? undefined : "请先在左侧选择审查章节"}
    >
      {isReviewing ? t("reviewCenter.reviewingAction") : t("reviewCenter.startReview")}
    </Button>
  )
}
