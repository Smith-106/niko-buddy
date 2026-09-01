import { useState, useMemo, useEffect } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { ArrowLeft, BarChart3, Clock, Zap } from "lucide-react"
import type { SimulationBranch, DirectorScore } from "@/lib/novel/story-simulation/types"
import { actionTypeShortLabel } from "@/lib/novel/story-simulation/action-type-utils"
import { Button } from "@/components/ui/button"
import { useSimulationWorker } from "./use-simulation-worker"

interface BranchCompareViewProps {
  branches: SimulationBranch[]
  compareBranchIds: string[]
  onBack: () => void
}

const DIMENSION_KEYS: (keyof DirectorScore)[] = [
  "tension",
  "pace",
  "characterUtilization",
  "characterArc",
  "infoDensity",
  "emotionalResonance",
  "logicConsistency",
]

function dimensionLabel(key: keyof DirectorScore, t: TFunction): string {
  switch (key) {
    case "tension":
      return t("storySimulation.dimensionTension")
    case "pace":
      return t("storySimulation.dimensionPace")
    case "characterUtilization":
      return t("storySimulation.dimensionCharacterUtilization")
    case "characterArc":
      return t("storySimulation.dimensionCharacterArc")
    case "infoDensity":
      return t("storySimulation.dimensionInfoDensity")
    case "emotionalResonance":
      return t("storySimulation.dimensionEmotionalResonance")
    case "logicConsistency":
      return t("storySimulation.dimensionLogicConsistency")
    default:
      return String(key)
  }
}

const BRANCH_COLORS = [
  "#3b82f6",
  "#f97316",
  "#10b981",
]

function getAvgDirectorScore(branch: SimulationBranch): DirectorScore {
  if (branch.directorEvaluations.length === 0) {
    return {
      tension: 3.0,
      pace: 3.0,
      characterUtilization: 3.0,
      characterArc: 3.0,
      infoDensity: 3.0,
      emotionalResonance: 3.0,
      logicConsistency: 3.0,
    }
  }
  const sum: DirectorScore = {
    tension: 0,
    pace: 0,
    characterUtilization: 0,
    characterArc: 0,
    infoDensity: 0,
    emotionalResonance: 0,
    logicConsistency: 0,
  }
  for (const ev of branch.directorEvaluations) {
    for (const key of DIMENSION_KEYS) {
      sum[key] += ev.scores[key]
    }
  }
  const n = branch.directorEvaluations.length
  const avg: DirectorScore = { ...sum }
  for (const key of DIMENSION_KEYS) {
    avg[key] = Math.round((avg[key] / n) * 10) / 10
  }
  return avg
}

function RadarChart({
  branches,
  size = 320,
}: {
  branches: SimulationBranch[]
  size?: number
}) {
  const { t } = useTranslation()
  const center = size / 2
  const radius = size * 0.38
  const levels = 3
  const angleStep = (Math.PI * 2) / DIMENSION_KEYS.length

  const scoresList = branches.map((b) => getAvgDirectorScore(b))

  const getPoint = (angle: number, r: number) => ({
    x: center + r * Math.sin(angle),
    y: center - r * Math.cos(angle),
  })

  const gridPolygons = []
  for (let i = 1; i <= levels; i++) {
    const r = (radius * i) / levels
    const points = DIMENSION_KEYS.map((_, idx) => {
      const { x, y } = getPoint(angleStep * idx, r)
      return `${x},${y}`
    }).join(" ")
    gridPolygons.push(
      <polygon
        key={`grid-${i}`}
        points={points}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.15}
        strokeWidth={1}
      />,
    )
  }

  const axisLines = DIMENSION_KEYS.map((_, idx) => {
    const { x, y } = getPoint(angleStep * idx, radius)
    return (
      <line
        key={`axis-${idx}`}
        x1={center}
        y1={center}
        x2={x}
        y2={y}
        stroke="currentColor"
        strokeOpacity={0.15}
        strokeWidth={1}
      />
    )
  })

  const labelElements = DIMENSION_KEYS.map((key, idx) => {
    const { x, y } = getPoint(angleStep * idx, radius + 24)
    return (
      <text
        key={`label-${idx}`}
        x={x}
        y={y}
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-current text-[11px] text-foreground"
      >
        {dimensionLabel(key, t)}
      </text>
    )
  })

  const dataPolygons = scoresList.map((scores, bIdx) => {
    const points = DIMENSION_KEYS.map((key, idx) => {
      const value = Math.max(0, Math.min(5, scores[key]))
      const r = (radius * value) / 5
      const { x, y } = getPoint(angleStep * idx, r)
      return `${x},${y}`
    }).join(" ")
    return (
      <polygon
        key={`data-${bIdx}`}
        points={points}
        fill={BRANCH_COLORS[bIdx]}
        fillOpacity={0.15}
        stroke={BRANCH_COLORS[bIdx]}
        strokeWidth={2}
      />
    )
  })

  const dataDots = scoresList.map((scores, bIdx) =>
    DIMENSION_KEYS.map((key, idx) => {
      const value = Math.max(0, Math.min(5, scores[key]))
      const r = (radius * value) / 5
      const { x, y } = getPoint(angleStep * idx, r)
      return (
        <circle
          key={`dot-${bIdx}-${idx}`}
          cx={x}
          cy={y}
          r={3}
          fill={BRANCH_COLORS[bIdx]}
        />
      )
    }),
  )

  return (
    <svg width={size} height={size} className="text-foreground">
      {gridPolygons}
      {axisLines}
      {labelElements}
      {dataPolygons}
      {dataDots}
    </svg>
  )
}

function ScoreCompareTab({ branches }: { branches: SimulationBranch[] }) {
  const { t } = useTranslation()
  const scoresList = branches.map((b) => getAvgDirectorScore(b))

  return (
    <div className="space-y-6">
      <div className="flex justify-center">
        <RadarChart branches={branches} size={360} />
      </div>

      <div className="flex justify-center gap-4 flex-wrap">
        {branches.map((b, idx) => (
          <div key={b.id} className="flex items-center gap-2">
            <div
              className="h-3 w-3 rounded-full"
              style={{ backgroundColor: BRANCH_COLORS[idx] }}
            />
            <span className="text-xs">{b.name}</span>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b">
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t("storySimulation.dimensionHeader")}</th>
              {branches.map((b) => (
                <th key={b.id} className="px-3 py-2 text-center font-medium">
                  {b.name}
                </th>
              ))}
              <th className="px-3 py-2 text-center font-medium text-muted-foreground">{t("storySimulation.maxDiff")}</th>
            </tr>
          </thead>
          <tbody>
            {DIMENSION_KEYS.map((key) => {
              const values = scoresList.map((s) => s[key])
              const max = Math.max(...values)
              const min = Math.min(...values)
              const diff = Math.round((max - min) * 10) / 10
              return (
                <tr key={key} className="border-b hover:bg-muted/30">
                  <td className="px-3 py-2">{dimensionLabel(key, t)}</td>
                  {values.map((v, idx) => (
                    <td key={idx} className="px-3 py-2 text-center font-medium">
                      <span
                        style={{ color: v === max ? BRANCH_COLORS[idx] : undefined }}
                      >
                        {v.toFixed(1)}
                      </span>
                    </td>
                  ))}
                  <td className="px-3 py-2 text-center text-muted-foreground">
                    {diff > 0 ? `+${diff}` : "-"}
                  </td>
                </tr>
              )
            })}
            <tr className="border-t-2 border-primary/30 bg-primary/5 font-medium">
              <td className="px-3 py-2">{t("storySimulation.overallScoreLabel")}</td>
              {branches.map((b) => (
                <td key={b.id} className="px-3 py-2 text-center text-primary">
                  {b.overallScore.toFixed(1)}
                </td>
              ))}
              <td className="px-3 py-2 text-center text-muted-foreground">
                +{(Math.max(...branches.map((b) => b.overallScore)) - Math.min(...branches.map((b) => b.overallScore))).toFixed(1)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

function TimelineCompareTab({ branches }: { branches: SimulationBranch[] }) {
  const { t } = useTranslation()
  const groupedList = branches.map((b) => {
    const groups = new Map<number, typeof b.timelineEvents>()
    for (const ev of b.timelineEvents) {
      if (!groups.has(ev.round)) groups.set(ev.round, [])
      groups.get(ev.round)!.push(ev)
    }
    return {
      branch: b,
      rounds: Array.from(groups.entries())
        .sort(([a], [b]) => a - b)
        .map(([round, events]) => ({ round, events })),
    }
  })

  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${branches.length}, minmax(0, 1fr))` }}>
      {groupedList.map(({ branch, rounds }, bIdx) => (
        <div key={branch.id} className="flex min-h-0 flex-col rounded-lg border bg-muted/20">
          <div className="border-b px-3 py-2 text-center">
            <div className="text-sm font-medium">{branch.name}</div>
            <div className="text-xs text-primary">{t("storySimulation.overallScorePoints", { score: branch.overallScore.toFixed(1) })}</div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {rounds.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">
                {t("storySimulation.noEvents")}
              </div>
            ) : (
              <div className="space-y-3">
                {rounds.map(({ round, events }) => (
                  <div key={round} className="space-y-1.5">
                    <div className="text-[11px] font-medium text-muted-foreground">
                      {t("storySimulation.roundEventsSummary", { round: round + 1, count: events.length })}
                    </div>
                    {events.map((ev) => (
                      <div
                        key={ev.id}
                        className="rounded-md border bg-background/70 p-2 text-xs leading-relaxed"
                      >
                        <div className="mb-0.5">
                          <span className="font-medium" style={{ color: BRANCH_COLORS[bIdx] }}>
                            {ev.actorName}
                          </span>
                          <span className="text-muted-foreground">
                            {" "}
                            {ev.targetName ? t("storySimulation.targetPrefix", { name: ev.targetName }) : ""} · {actionTypeShortLabel(ev.actionType)}
                          </span>
                        </div>
                        <div className="line-clamp-3 text-muted-foreground">
                          {ev.content}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function KeyDifferencesTab({ branches }: { branches: SimulationBranch[] }) {
  const { t } = useTranslation()
  const { calcBranchDiff } = useSimulationWorker()
  const [diffResult, setDiffResult] = useState<{
    dimensionDiffs: { key: string; diff: number; maxBranchName: string; maxValue: number; minValue: number }[]
    eventCounts: number[]
    characterCounts: number[]
    topSentimentDiffs: { charId: string; charName: string; maxDiff: number; maxBranch: string; values: number[] }[]
    divergenceRound: number
    bestBranchIdx: number
  } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (branches.length < 2) {
      setLoading(false)
      return
    }
    setLoading(true)
    calcBranchDiff(branches[0], branches[1]).then((result) => {
      setDiffResult(result)
      setLoading(false)
    })
  }, [branches, calcBranchDiff])

  if (loading || !diffResult) {
    return (
      <div className="flex h-40 items-center justify-center">
        <div className="text-sm text-muted-foreground">{t("storySimulation.analyzing")}</div>
      </div>
    )
  }

  const { dimensionDiffs: rawDimensionDiffs, eventCounts, characterCounts, topSentimentDiffs, divergenceRound, bestBranchIdx } = diffResult

  const dimensionDiffs = rawDimensionDiffs.map((d) => ({
    ...d,
    label: dimensionLabel(d.key as keyof DirectorScore, t),
  }))

  const bestBranch = branches[bestBranchIdx]
  const secondBestIdx = branches.findIndex((_, i) => i !== bestBranchIdx)
  const secondBest = secondBestIdx >= 0 ? branches[secondBestIdx] : null

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border bg-muted/20 p-4">
          <h3 className="mb-3 text-sm font-medium">{t("storySimulation.topDimensionDiffs")}</h3>
          <div className="space-y-2">
            {dimensionDiffs.map((d, idx) => (
              <div key={d.key} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {idx + 1}. {d.label}
                </span>
                <span className="font-medium">
                  {t("storySimulation.dimensionLeader", {
                    branch: d.maxBranchName,
                    max: d.maxValue.toFixed(1),
                    min: d.minValue.toFixed(1),
                  })}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border bg-muted/20 p-4">
          <h3 className="mb-3 text-sm font-medium">{t("storySimulation.basicDataCompare")}</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("storySimulation.eventCountLabel")}</span>
              <span className="font-medium">
                {t("storySimulation.countItems", { count: eventCounts.join(" / ") })}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("storySimulation.characterCountLabel")}</span>
              <span className="font-medium">
                {t("storySimulation.countPeople", { count: characterCounts.join(" / ") })}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("storySimulation.divergenceRoundLabel")}</span>
              <span className="font-medium">
                {divergenceRound > 0 ? t("storySimulation.divergenceFrom", { round: divergenceRound }) : t("storySimulation.noDivergence")}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-muted/20 p-4">
        <h3 className="mb-3 text-sm font-medium">{t("storySimulation.topSentimentDiffsTitle")}</h3>
        {topSentimentDiffs.length === 0 ? (
          <div className="text-sm text-muted-foreground">{t("storySimulation.noData")}</div>
        ) : (
          <div className="space-y-2">
            {topSentimentDiffs.map((d, idx) => (
              <div key={d.charId} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {idx + 1}. {d.charName}
                </span>
                <span className="font-medium">
                  {t("storySimulation.sentimentHighest", {
                    branch: d.maxBranch,
                    values: d.values.map((v) => v.toFixed(0)).join(" / "),
                  })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
        <h3 className="mb-2 text-sm font-medium text-primary">
          {t("storySimulation.recommendationConclusion", { name: bestBranch.name })}
        </h3>
        <div className="text-sm text-muted-foreground">
          <div className="mb-1 font-medium text-foreground">{t("storySimulation.mainAdvantages")}</div>
          <div className="space-y-1">
            {dimensionDiffs.slice(0, 3).map((d, idx) => (
              <div key={d.key}>
                {t("storySimulation.dimensionBetter", {
                  index: idx + 1,
                  label: d.label,
                  max: d.maxValue.toFixed(1),
                  min: d.minValue.toFixed(1),
                })}
              </div>
            ))}
            {eventCounts[bestBranchIdx] >= (secondBest ? eventCounts[secondBestIdx] : 0) && (
              <div>
                {t("storySimulation.moreEvents", {
                  index: dimensionDiffs.length + 1,
                  count: eventCounts[bestBranchIdx],
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export function BranchCompareView({
  branches,
  compareBranchIds,
  onBack,
}: BranchCompareViewProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<"score" | "timeline" | "differences">("score")

  const compareBranches = useMemo(() => {
    return compareBranchIds
      .map((id) => branches.find((b) => b.id === id))
      .filter((b): b is SimulationBranch => !!b)
  }, [branches, compareBranchIds])

  if (compareBranches.length < 2) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-sm text-muted-foreground">
          {t("storySimulation.selectAtLeastTwoBranches")}
        </div>
      </div>
    )
  }

  const tabs = [
    { key: "score" as const, label: t("storySimulation.tabScoreCompare"), icon: BarChart3 },
    { key: "timeline" as const, label: t("storySimulation.tabTimelineCompare"), icon: Clock },
    { key: "differences" as const, label: t("storySimulation.tabKeyDifferences"), icon: Zap },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="h-8"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t("storySimulation.backToBranchManagement")}
        </Button>
        <div className="flex items-center gap-2">
          {compareBranches.map((b, idx) => (
            <span
              key={b.id}
              className="rounded-full px-2.5 py-1 text-xs font-medium"
              style={{
                backgroundColor: `${BRANCH_COLORS[idx]}20`,
                color: BRANCH_COLORS[idx],
              }}
            >
              {b.name}
            </span>
          ))}
        </div>
        <div className="ml-auto">
          <div className="inline-flex rounded-md border bg-muted/40 p-0.5 text-xs">
            {tabs.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                className={`flex items-center gap-1.5 rounded px-3 py-1.5 ${
                  activeTab === key
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setActiveTab(key)}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {activeTab === "score" && <ScoreCompareTab branches={compareBranches} />}
        {activeTab === "timeline" && <TimelineCompareTab branches={compareBranches} />}
        {activeTab === "differences" && <KeyDifferencesTab branches={compareBranches} />}
      </div>
    </div>
  )
}
