/**
 * EPIC-004 / ADR-33 / TASK-009: Inspector 实时只读面板。
 *
 * Chat 主链旁渲染的只读查询消费者面板，26 维分块展示 context-engine / session
 * 中间态。S-002 共识：只读、不写、不触 LLM、isStale 期间灰显 + "修复中" 提示。
 *
 * 设计决策（ADR-33）：
 * - 默认收起（不干扰写作，defaultCollapsed）。
 * - 26 维分 6 块：cognition-state / draft / contextPack / scene / review / decision。
 * - isStale 期间灰显 + "修复中" 提示（缓存非实时，防误判为门控）。
 * - queryInspectorState 防抖 ≥500ms（PAT-DC2 防 O(N²) onUpdate 放大）。
 * - inspectorEnabled flag（NovelConfig，默认 true）控制面板启用。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, ChevronRight, PanelRightOpen, RefreshCw, Wrench } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { queryInspectorState, type InspectorSnapshot } from "@/lib/novel/inspector-query"

/** PAT-DC2 防抖阈值（≥500ms，防 O(N²) onUpdate 放大）。 */
const INSPECTOR_DEBOUNCE_MS = 500

interface InspectorPanelProps {
  /** 项目根路径。 */
  projectPath: string
  /** 当前章节标识（用于 scene-breakdown 数据源，EPIC-002 未落地时忽略）。 */
  chapterId: string
  /** 触发刷新的依赖（如草稿内容版本号）；变化时触发防抖刷新。 */
  refreshKey?: string | number
}

interface SectionProps {
  title: string
  defaultOpen?: boolean
  children: ReactNode
}

function Section({ title, defaultOpen = false, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  return (
    <div className="inspector-section border-b border-border/40 pb-2 mb-2">
      <button
        type="button"
        className="flex w-full items-center gap-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>{title}</span>
      </button>
      {open && <div className="mt-1 pl-4 text-xs text-foreground/80">{children}</div>}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "passed" || status === "pass"
      ? "text-green-600 dark:text-green-400"
      : status === "failed" || status === "fail"
        ? "text-red-600 dark:text-red-400"
        : status === "warning"
          ? "text-yellow-600 dark:text-yellow-400"
          : "text-muted-foreground"
  return <span className={`font-mono ${tone}`}>{status}</span>
}

export function InspectorPanel({ projectPath, chapterId, refreshKey }: InspectorPanelProps) {
  const { t } = useTranslation()
  const inspectorEnabled = useWikiStore((s) => s.novelConfig.inspectorEnabled)
  const [snapshot, setSnapshot] = useState<InspectorSnapshot | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  const [loading, setLoading] = useState(false)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchSnapshot = useCallback(async () => {
    if (!projectPath) return
    setLoading(true)
    try {
      const next = await queryInspectorState(projectPath, chapterId)
      setSnapshot(next)
    } catch {
      // PAT-DC1: queryInspectorState 已脱敏；静默不更新。
    } finally {
      setLoading(false)
    }
  }, [projectPath, chapterId])

  // PAT-DC2: 防抖 ≥500ms 防 O(N²) onUpdate 放大。
  useEffect(() => {
    if (!inspectorEnabled || collapsed) return
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => {
      void fetchSnapshot()
    }, INSPECTOR_DEBOUNCE_MS)
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
    }
  }, [inspectorEnabled, collapsed, fetchSnapshot, refreshKey])

  if (!inspectorEnabled) return null

  if (collapsed) {
    return (
      <div className="inspector-panel-collapsed flex items-center gap-1 border-b border-border/40 px-2 py-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setCollapsed(false)}
          aria-label={t("novel.inspector.expand", "展开 Inspector")}
        >
          <PanelRightOpen className="h-3 w-3 mr-1" />
          {t("novel.inspector.title", "Inspector")}
        </Button>
      </div>
    )
  }

  const isStale = snapshot?.isStale === true

  return (
    <div
      className={`inspector-panel border-b border-border/40 px-2 py-2 ${isStale ? "opacity-50" : ""}`}
      data-stale={isStale ? "true" : "false"}
    >
      <div className="flex items-center justify-between mb-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs font-medium"
          onClick={() => setCollapsed(true)}
          aria-label={t("novel.inspector.collapse", "收起 Inspector")}
        >
          <PanelRightOpen className="h-3 w-3 mr-1 rotate-180" />
          {t("novel.inspector.title", "Inspector")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={() => void fetchSnapshot()}
          disabled={loading}
          aria-label={t("novel.inspector.refresh", "刷新")}
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {isStale && (
        <div className="mb-2 flex items-center gap-1 rounded bg-yellow-500/10 px-2 py-1 text-xs text-yellow-700 dark:text-yellow-300">
          <Wrench className="h-3 w-3" />
          <span>修复中</span>
        </div>
      )}

      {!snapshot && !loading && (
        <div className="text-xs text-muted-foreground py-2">
          {t("novel.inspector.noData", "暂无 Inspector 数据")}
        </div>
      )}

      {snapshot && (
        <>
          {/* 分块 1: cognition-state */}
          <Section title={t("novel.inspector.cognitionState", "认知状态")}>
            {snapshot.cognitionState.characters.length === 0 ? (
              <div className="text-muted-foreground">无角色认知</div>
            ) : (
              <ul className="space-y-1">
                {snapshot.cognitionState.characters.map((c) => (
                  <li key={c.name}>
                    <span className="font-medium">{c.name}</span>
                    {c.knows.length > 0 && <div className="pl-2 text-green-700 dark:text-green-300">知道：{c.knows.join("、")}</div>}
                    {c.doesNotKnow.length > 0 && <div className="pl-2 text-red-700 dark:text-red-300">不知道：{c.doesNotKnow.join("、")}</div>}
                  </li>
                ))}
              </ul>
            )}
            {snapshot.cognitionState.readerKnows.length > 0 && (
              <div className="mt-1">读者知道：{snapshot.cognitionState.readerKnows.join("、")}</div>
            )}
            {snapshot.cognitionState.lastUpdatedChapter !== null && (
              <div className="mt-1 text-muted-foreground">最后更新章：{snapshot.cognitionState.lastUpdatedChapter}</div>
            )}
          </Section>

          {/* 分块 2: draft */}
          <Section title={t("novel.inspector.draft", "草稿")} defaultOpen>
            <div>草稿ID：{snapshot.draft.draftId || "—"}</div>
            <div>状态：<StatusBadge status={snapshot.draft.draftStatus} /></div>
            <div>路径：{snapshot.draft.filePath || "—"}</div>
            <div>更新：{snapshot.draft.updatedAt || "—"}</div>
            {snapshot.draft.contentPreview && (
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-1 text-[11px]">
                {snapshot.draft.contentPreview}
              </pre>
            )}
          </Section>

          {/* 分块 3: contextPack */}
          <Section title={t("novel.inspector.contextPack", "上下文包")}>
            <div>{snapshot.contextPack.cognitionSummary}</div>
            <div>角色数：{snapshot.contextPack.characterCount}</div>
            <div>读者已知：{snapshot.contextPack.readerKnowsCount}</div>
          </Section>

          {/* 分块 4: scene */}
          <Section title={t("novel.inspector.scene", "场景")}>
            <div>场景数：{snapshot.scene.sceneCount}</div>
            {snapshot.scene.sceneTitles.length > 0 && (
              <ul className="mt-1 list-disc pl-4">
                {snapshot.scene.sceneTitles.map((title, idx) => (
                  <li key={idx}>{title}</li>
                ))}
              </ul>
            )}
          </Section>

          {/* 分块 5: review */}
          <Section title={t("novel.inspector.review", "审查")}>
            {snapshot.review.findings.length === 0 ? (
              <div className="text-muted-foreground">无缓存审查发现</div>
            ) : (
              <ul className="space-y-1">
                {snapshot.review.findings.map((f) => (
                  <li key={f.dimensionKey}>
                    <div className="flex items-center gap-1">
                      <span className="font-medium">{f.dimensionLabel}</span>
                      <span className="font-mono text-[11px]">{f.score}</span>
                      <StatusBadge status={f.status} />
                    </div>
                    {f.summary && <div className="pl-2 text-muted-foreground">{f.summary}</div>}
                    {f.messages.length > 0 && (
                      <ul className="pl-4 list-disc">
                        {f.messages.slice(0, 5).map((msg, idx) => (
                          <li key={idx} className="text-[11px]">{msg}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {snapshot.review.reviewedAt && (
              <div className="mt-1 text-muted-foreground">缓存于：{snapshot.review.reviewedAt}</div>
            )}
            {snapshot.deAiSlopHits.length > 0 && (
              <div className="mt-1">
                <div className="font-medium">静态 de-ai slop 命中：</div>
                <ul className="pl-4 list-disc">
                  {snapshot.deAiSlopHits.map((hit) => (
                    <li key={hit.word} className="text-[11px]">
                      {hit.word} ×{hit.count}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>

          {/* 分块 6: decision */}
          <Section title={t("novel.inspector.decision", "门控")}>
            <div>一致性：<StatusBadge status={snapshot.decision.consistency.status} /> / <StatusBadge status={snapshot.decision.consistency.verdict} /></div>
            <div>Anti-AI：<StatusBadge status={snapshot.decision.anti_ai.status} /> / <StatusBadge status={snapshot.decision.anti_ai.verdict} /></div>
            <div>质量：<StatusBadge status={snapshot.decision.quality.status} /> / <StatusBadge status={snapshot.decision.quality.verdict} /></div>
            <div>总览：<StatusBadge status={snapshot.decision.overall} /></div>
          </Section>
        </>
      )}
    </div>
  )
}
