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
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, PanelRightOpen, RefreshCw, Wrench } from "lucide-react"
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
  // P3: useId 生成稳定 id 关联 button↔region，让 screen reader 可跳转到展开区。
  const reactId = useId()
  const panelId = `inspector-section-${reactId}`
  return (
    <div className="inspector-section border-b border-border/40 pb-2 mb-2">
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded px-1 -mx-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <ChevronDown
          className={`h-3 w-3 transition-transform duration-150 ${open ? "" : "-rotate-90"}`}
        />
        <span>{title}</span>
      </button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label={title}
          className="mt-1 animate-in fade-in slide-in-from-top-1 pl-4 text-xs text-foreground/80 duration-150"
        >
          {children}
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  // P2: 用 oklch 语义 token (success/warning/destructive) 替代硬编码 green/red/yellow，
  // 3 主题统一调校。此前 text-green-600/red-600/yellow-600 绕过 token 体系（PAT-U2 同形）。
  const tone =
    status === "passed" || status === "pass"
      ? "text-success"
      : status === "failed" || status === "fail"
        ? "text-destructive"
        : status === "warning"
          ? "text-warning"
          : "text-muted-foreground"
  return <span className={`font-mono ${tone}`}>{status}</span>
}

export function InspectorPanel({ projectPath, chapterId, refreshKey }: InspectorPanelProps) {
  const { t } = useTranslation()
  const inspectorEnabled = useWikiStore((s) => s.novelConfig.inspectorEnabled)
  const [snapshot, setSnapshot] = useState<InspectorSnapshot | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchSnapshot = useCallback(async () => {
    if (!projectPath) return
    setLoading(true)
    setError(null)
    try {
      const next = await queryInspectorState(projectPath, chapterId)
      setSnapshot(next)
    } catch (err) {
      // PAT-DC1: queryInspectorState 已脱敏 message（防 provider detail 泄露），
      // 故可安全展示给用户。此前静默 catch{} 让 fetch 失败显示陈旧数据或误判无数据。
      setError(err instanceof Error ? err.message : t("novel.inspector.queryFailed", "查询失败"))
    } finally {
      setLoading(false)
    }
  }, [projectPath, chapterId, t])

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
          aria-expanded={false}
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
          aria-expanded={true}
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
        <div
          role="status"
          aria-live="polite"
          className="mb-2 flex items-center gap-1 rounded bg-warning/10 px-2 py-1 text-xs text-warning"
        >
          <Wrench className="h-3 w-3" />
          <span>{t("novel.inspector.staleHint", "草稿已变更，审查缓存可能过期")}</span>
        </div>
      )}

      {error && (
        <div
          role="alert"
          aria-live="assertive"
          className="mb-2 flex items-center justify-between gap-1 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive"
        >
          <span>{error}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1 text-xs text-destructive hover:text-destructive"
            onClick={() => void fetchSnapshot()}
            disabled={loading}
            aria-label={t("novel.inspector.retry", "重试")}
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      )}

      {!snapshot && !loading && !error && (
        <div className="text-xs text-muted-foreground py-2">
          {t("novel.inspector.noData", "暂无 Inspector 数据")}
        </div>
      )}

      {!snapshot && loading && (
        <div className="space-y-2 py-2" aria-hidden="true">
          <div className="h-3 w-full animate-pulse rounded bg-muted/60" />
          <div className="h-3 w-3/4 animate-pulse rounded bg-muted/60" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-muted/60" />
        </div>
      )}

      {snapshot && (
        <>
          {/* 分块 1: cognition-state */}
          <Section title={t("novel.inspector.cognitionState", "认知状态")}>
            {snapshot.cognitionState.characters.length === 0 ? (
              <div className="text-muted-foreground">{t("novel.inspector.noCognition", "无角色认知")}</div>
            ) : (
              <ul className="space-y-1">
                {snapshot.cognitionState.characters.map((c) => (
                  <li key={c.name}>
                    <span className="font-medium">{c.name}</span>
                    {c.knows.length > 0 && <div className="pl-2 text-success">{t("novel.inspector.knows", "知道：")}{c.knows.join("、")}</div>}
                    {c.doesNotKnow.length > 0 && <div className="pl-2 text-destructive">{t("novel.inspector.doesNotKnow", "不知道：")}{c.doesNotKnow.join("、")}</div>}
                  </li>
                ))}
              </ul>
            )}
            {snapshot.cognitionState.readerKnows.length > 0 && (
              <div className="mt-1">{t("novel.inspector.readerKnows", "读者知道：")}{snapshot.cognitionState.readerKnows.join("、")}</div>
            )}
            {snapshot.cognitionState.lastUpdatedChapter !== null && (
              <div className="mt-1 text-muted-foreground">{t("novel.inspector.lastUpdatedChapter", "最后更新章：")}{snapshot.cognitionState.lastUpdatedChapter}</div>
            )}
          </Section>

          {/* 分块 2: draft */}
          <Section title={t("novel.inspector.draft", "草稿")} defaultOpen>
            <div>{t("novel.inspector.draftId", "草稿ID：")}{snapshot.draft.draftId || "—"}</div>
            <div>{t("novel.inspector.status", "状态：")}<StatusBadge status={snapshot.draft.draftStatus} /></div>
            <div className="truncate" title={snapshot.draft.filePath || undefined}>
              {t("novel.inspector.filePath", "路径：")}{snapshot.draft.filePath || "—"}
            </div>
            <div>{t("novel.inspector.updated", "更新：")}{snapshot.draft.updatedAt || "—"}</div>
            {snapshot.draft.contentPreview && (
              <details className="mt-1">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  {t("novel.inspector.preview", "预览（{n} 字）", { n: snapshot.draft.contentPreview.length })}
                </summary>
                <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-1 text-[11px]">
                  {snapshot.draft.contentPreview}
                </pre>
              </details>
            )}
          </Section>

          {/* 分块 3: contextPack */}
          <Section title={t("novel.inspector.contextPack", "上下文包")}>
            <div>{snapshot.contextPack.cognitionSummary}</div>
            <div>{t("novel.inspector.characterCount", "角色数：")}{snapshot.contextPack.characterCount}</div>
            <div>{t("novel.inspector.readerKnowsCount", "读者已知：")}{snapshot.contextPack.readerKnowsCount}</div>
          </Section>

          {/* 分块 4: scene */}
          <Section title={t("novel.inspector.scene", "场景")}>
            <div>{t("novel.inspector.sceneCount", "场景数：")}{snapshot.scene.sceneCount}</div>
            {snapshot.scene.sceneTitles.length > 0 && (
              <ul className="mt-1 list-disc pl-4">
                {snapshot.scene.sceneTitles.map((title, idx) => (
                  <li key={`${idx}-${title.slice(0, 16)}`}>{title}</li>
                ))}
              </ul>
            )}
          </Section>

          {/* 分块 5: review */}
          <Section title={t("novel.inspector.review", "审查")}>
            {snapshot.review.findings.length === 0 ? (
              <div className="text-muted-foreground">{t("novel.inspector.noReviewFindings", "无缓存审查发现")}</div>
            ) : (
              <ul className="space-y-1">
                {snapshot.review.findings.map((f) => (
                  <li key={f.dimensionKey}>
                    <div className="flex items-center gap-1">
                      <span className="font-medium">{f.dimensionLabel}</span>
                      <span className="font-mono text-[11px]">{f.score}/100</span>
                      <StatusBadge status={f.status} />
                    </div>
                    {f.summary && <div className="pl-2 text-muted-foreground">{f.summary}</div>}
                    {f.messages.length > 0 && (
                      <ul className="pl-4 list-disc">
                        {f.messages.slice(0, 5).map((msg, idx) => (
                          <li key={`${idx}-${msg.slice(0, 16)}`} className="text-[11px]">{msg}</li>
                        ))}
                        {f.messages.length > 5 && (
                          <li className="text-[11px] text-muted-foreground">
                            {t("novel.inspector.moreMessages", "…另有 {n} 条", { n: f.messages.length - 5 })}
                          </li>
                        )}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {snapshot.review.reviewedAt && (
              <div className="mt-1 text-muted-foreground">{t("novel.inspector.cachedAt", "缓存于：")}{snapshot.review.reviewedAt}</div>
            )}
            {snapshot.deAiSlopHits.length > 0 ? (
              <div className="mt-1">
                <div className="font-medium">{t("novel.inspector.deAiSlopHits", "静态 de-ai slop 命中：")}</div>
                <ul className="pl-4 list-disc">
                  {snapshot.deAiSlopHits.slice(0, 10).map((hit) => (
                    <li key={hit.word} className="text-[11px]">
                      {hit.word} ×{hit.count}
                    </li>
                  ))}
                  {snapshot.deAiSlopHits.length > 10 && (
                    <li className="text-[11px] text-muted-foreground">
                      {t("novel.inspector.moreSlop", "…及其余 {n} 项", { n: snapshot.deAiSlopHits.length - 10 })}
                    </li>
                  )}
                </ul>
              </div>
            ) : (
              <div className="mt-1 text-success">{t("novel.inspector.noSlop", "无静态 slop 命中")}</div>
            )}
          </Section>

          {/* 分块 6: decision */}
          <Section title={t("novel.inspector.decision", "门控")}>
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-1">
                {t("novel.inspector.consistency", "一致性：")}<StatusBadge status={snapshot.decision.consistency.status} />
                <span className="text-muted-foreground">/</span>
                <StatusBadge status={snapshot.decision.consistency.verdict} />
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {t("novel.inspector.antiAi", "Anti-AI：")}<StatusBadge status={snapshot.decision.anti_ai.status} />
                <span className="text-muted-foreground">/</span>
                <StatusBadge status={snapshot.decision.anti_ai.verdict} />
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {t("novel.inspector.quality", "质量：")}<StatusBadge status={snapshot.decision.quality.status} />
                <span className="text-muted-foreground">/</span>
                <StatusBadge status={snapshot.decision.quality.verdict} />
              </div>
              <div className="mt-1 flex items-center gap-1 rounded bg-muted/40 px-1 py-0.5 font-medium">
                {t("novel.inspector.overall", "总览：")}<StatusBadge status={snapshot.decision.overall} />
              </div>
            </div>
          </Section>
        </>
      )}
    </div>
  )
}
