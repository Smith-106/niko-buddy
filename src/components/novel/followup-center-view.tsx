/**
 * followup-center-view.tsx — 导演跟进中心视图（返修任务＋阻塞队列）。
 *
 * 数据源（只读派生＋本地 store，零写账本）：
 *   - 返修任务：@/stores/review-store 的 useReviewStore（items / novelReviewEntries）。
 *     单条完成/忽略走 resolveItem / dismissItem / dismissNovelReviewEntry；
 *     一键完成跳过矛盾项。清空已解决只删已解决条目，未解决的章节审查留下；
 *     回到正文：章节文件里对得上原句才高亮那一句，对不上只打开章并说明；
 *   - 阻塞队列：运行事件账本经 buildBlockingQueue 派生——真实位置是
 *     @/lib/novel/director-followup.ts（非 dashboard-evidence.ts），签名
 *     (ledger: RunEventLedger) => readonly BlockingQueueItem[]，经 @/lib/novel
 *     barrel 导出；门阻塞横幅经 buildDashboardEvidenceSnapshot 派生；
 *   - 账本装载：props.ledger 显式注入优先，否则经 loadRunEventLedgerStore(
 *     createFsRunEventLedgerStoreDeps(), projectPath) 只读加载。
 *
 * 诚实面：返修清单与阻塞队列均为空 → data-testid="followup-empty" 空态，
 * 不渲染 followup-items / followup-blocking；账本缺失/读取失败 → 门状态未知，
 * 仅展示本地返修任务，不臆造门状态。
 *
 * 纪律：仅经 @/lib/novel barrel 导入 novel 能力（T18 窄接口门禁），
 * 不 deep import @/lib/novel/*；所需符号 barrel 均已导出，无缺口。
 *
 * @license MIT © Niko Buddy
 */

import { useEffect, useState } from "react"
import { readFile } from "@/commands/fs"
import { findReviewRewriteAnchors } from "@/lib/review-rewrite-plan"
import { ReportCallout, ReportPage, ReportSection } from "./report-page"
import {
  buildBlockingQueue,
  buildDashboardEvidenceSnapshot,
  createFsRunEventLedgerStoreDeps,
  createRunEventLedger,
  findChapterFileByNumber,
  loadRunEventLedgerStore,
  type BlockingQueueItem,
  type EvidenceSnapshot,
  type RunEventLedger,
  type RunEventLedgerStoreDeps,
} from "@/lib/novel"
import { useReviewStore, type NovelReviewEntry, type ReviewItem } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

export interface FollowupCenterViewProps {
  readonly projectPath: string
  /** 显式注入账本（测试/预览；优先于磁盘装载）。 */
  readonly ledger?: RunEventLedger | null
  /** deps 注入（jsdom 测试；缺省生产 deps）。 */
  readonly deps?: RunEventLedgerStoreDeps
}

const REVIEW_TYPE_LABELS: Record<ReviewItem["type"], string> = {
  contradiction: "矛盾",
  duplicate: "重复",
  "missing-page": "缺页",
  confirm: "待确认",
  suggestion: "建议",
}

/**
 * 门中文名（本视图刻意展示变体：一致性/反 AI/质量＋调用处“门”后缀，spec 锁定；
 * 键空间与 audit-taxonomy GateKey 一致，未知键回退原文。MINOR-5 定案）。
 */
function gateLabel(gate: string): string {
  if (gate === "consistency") return "一致性"
  if (gate === "anti_ai") return "反 AI"
  if (gate === "quality") return "质量"
  return gate
}

export function FollowupCenterView({ projectPath, ledger, deps }: FollowupCenterViewProps) {
  const items = useReviewStore((s) => s.items)
  const novelReviewEntries = useReviewStore((s) => s.novelReviewEntries)
  const resolveItem = useReviewStore((s) => s.resolveItem)
  const dismissItem = useReviewStore((s) => s.dismissItem)
  const dismissNovelReviewEntry = useReviewStore((s) => s.dismissNovelReviewEntry)

  const [loaded, setLoaded] = useState<RunEventLedger | null>(ledger ?? null)
  const [loadedDeps, setLoadedDeps] = useState(false)
  const [failed, setFailed] = useState(false)
  const [openNote, setOpenNote] = useState<string | null>(null)

  useEffect(() => {
    if (ledger !== undefined && ledger !== null) {
      setLoaded(ledger)
      setLoadedDeps(true)
      return
    }
    if (ledger !== undefined) {
      // 显式 null：跳过磁盘装载（预览态，诚实未评估）
      setLoaded(null)
      setLoadedDeps(true)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const file = await loadRunEventLedgerStore(deps ?? createFsRunEventLedgerStoreDeps(), projectPath)
        if (cancelled) return
        setLoaded(file)
      } catch {
        // 诚实面：装载失败 → 门状态未知，仅展示本地返修任务，不臆造门状态
        if (!cancelled) {
          setFailed(true)
          setLoaded(null)
        }
      } finally {
        if (!cancelled) setLoadedDeps(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectPath, ledger, deps])

  const snapshot: EvidenceSnapshot | null = failed
    ? buildDashboardEvidenceSnapshot(createRunEventLedger())
    : loaded === null
      ? null
      : buildDashboardEvidenceSnapshot(loaded)
  const queue: readonly BlockingQueueItem[] = loaded === null ? [] : buildBlockingQueue(loaded)

  const pendingItems = items.filter((item) => !item.resolved)
  const resolvedItems = items.filter((item) => item.resolved)
  const pendingEntries = novelReviewEntries.filter((entry) => !entry.resolved)
  const resolvedEntries = novelReviewEntries.filter((entry) => entry.resolved)
  const pendingCount = pendingItems.length + pendingEntries.length
  const resolvedCount = resolvedItems.length + resolvedEntries.length

  const hasReview = items.length > 0 || novelReviewEntries.length > 0
  const hasBlocking = queue.length > 0
  const isEmpty = !hasReview && !hasBlocking

  // 批量操作：经 getState() 直接调用 store action（一键完成全部待处理；
  // 章节审查条目无单条删除语义，完成即 dismissNovelReviewEntry 标 resolved）。
  function handleResolveAllPending(): void {
    const state = useReviewStore.getState()
    for (const item of state.items) {
      if (item.resolved || item.type === "contradiction") continue
      state.resolveItem(item.id, item.options[0]?.action ?? "accept")
    }
    for (const entry of state.novelReviewEntries) {
      if (!entry.resolved) state.dismissNovelReviewEntry(entry.id)
    }
  }

  function handleClearResolved(): void {
    useReviewStore.getState().clearResolved()
    useReviewStore.setState((prev) => ({
      novelReviewEntries: prev.novelReviewEntries.filter((entry) => !entry.resolved),
    }))
  }

  async function openEntryInChapter(entry: NovelReviewEntry): Promise<void> {
    if (projectPath === "") {
      setOpenNote("没有项目，不能回到正文。")
      return
    }
    const path = await findChapterFileByNumber(projectPath, entry.chapterNumber)
    if (!path) {
      setOpenNote("找不到这一章，没有可以跳的句子。")
      return
    }
    const wiki = useWikiStore.getState()
    wiki.setSelectedFile(path)
    wiki.setActiveView("wiki")
    let markdown = ""
    try {
      markdown = await readFile(path)
    } catch {
      setOpenNote("章节打不开，没有跳到句子。")
      return
    }
    const anchor = findReviewRewriteAnchors(
      markdown,
      entry.results.map((result) => result.evidence),
    )[0]
    if (!anchor) {
      wiki.setPendingEditorHighlight(null)
      setOpenNote("没有对得上的原句，只打开了这一章。")
      return
    }
    wiki.setPendingEditorHighlight({
      path,
      text: anchor.selection.text,
      nonce: Date.now(),
    })
    setOpenNote(null)
  }

  return (
    <ReportPage
      testId="followup-center-view"
      title="跟进中心"
      description="返修任务和阻塞队列。账本读不到时只显示本地返修，不编造门状态。"
    >
      {!loadedDeps ? (
        <p className="text-sm text-muted-foreground" data-testid="followup-loading">
          跟进数据装载中…
        </p>
      ) : (
        <>
          <ReportSection title="下一步">
            <p className="text-base font-medium">
              {snapshot !== null && snapshot.blocked
                ? "先处理被挡住的门，再看返修。"
                : isEmpty
                  ? "现在没有要跟进的，可以继续写下一章。"
                  : "先完成下面待处理的返修。"}
            </p>
          </ReportSection>
          {failed ? (
            <ReportCallout tone="warn" testId="followup-ledger-failed">
              账本装载失败（断网/账本不可读）：门状态未知，仅展示本地返修任务
            </ReportCallout>
          ) : null}
          {snapshot !== null && snapshot.blocked ? (
            <ReportCallout tone="error" testId="followup-blocked-banner">
              当前被{gateLabel(snapshot.blockingGate ?? "")}门阻塞：先处理首要阻塞项
            </ReportCallout>
          ) : null}
          {isEmpty ? (
            <p className="text-xs text-muted-foreground" data-testid="followup-empty">
              暂无跟进任务：返修清单和阻塞队列都是空的。审稿发现问题后，返修任务会出现在这里。
            </p>
          ) : null}
          {hasReview ? (
            <div className="mb-3" data-testid="followup-items">
              <h3 className="mb-1 text-xs font-semibold">
                返修任务（待处理 {pendingCount} / 已解决 {resolvedCount}）
              </h3>
              <div className="mb-2">
                <button
                  type="button"
                  className="rounded border border-border bg-background px-2 py-1 text-xs disabled:opacity-40"
                  data-testid="followup-resolve-all"
                  disabled={pendingCount === 0}
                  onClick={handleResolveAllPending}
                >
                  一键完成全部待处理
                </button>
              </div>
              <div className="mb-3">
                <button
                  type="button"
                  className="rounded border border-border bg-background px-2 py-1 text-xs disabled:opacity-40"
                  data-testid="followup-clear-resolved"
                  disabled={resolvedItems.length === 0 && resolvedEntries.length === 0}
                  onClick={handleClearResolved}
                >
                  清空已解决
                </button>
              </div>
              {pendingItems.length > 0 ? (
                <div className="mb-2">
                  <h4 className="mb-1 text-xs font-medium">待处理（{pendingItems.length}）</h4>
                  <ul className="space-y-1.5">
                    {pendingItems.map((item) => (
                      <li
                        key={item.id}
                        data-testid={`followup-item-${item.id}`}
                        className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs"
                      >
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {REVIEW_TYPE_LABELS[item.type]}
                        </span>
                        <span className="font-medium">{item.title}</span>
                        <span className="text-muted-foreground">{item.description}</span>
                        {item.type === "contradiction" ? (
                          item.options.map((option) => (
                            <button
                              key={option.action}
                              type="button"
                              className="rounded border border-border bg-background px-2 py-1 text-xs"
                              data-testid={`followup-option-${item.id}-${option.action}`}
                              onClick={() => resolveItem(item.id, option.action)}
                            >
                              {option.label}
                            </button>
                          ))
                        ) : (
                          <button
                            type="button"
                            className="rounded border border-border bg-background px-2 py-1 text-xs disabled:opacity-40"
                            data-testid={`followup-resolve-${item.id}`}
                            onClick={() => resolveItem(item.id, item.options[0]?.action ?? "accept")}
                          >
                            完成
                          </button>
                        )}
                        <button
                          type="button"
                          className="rounded border border-border bg-background px-2 py-1 text-xs disabled:opacity-40"
                          data-testid={`followup-dismiss-${item.id}`}
                          onClick={() => dismissItem(item.id)}
                        >
                          忽略
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {novelReviewEntries.length > 0 ? (
                <div className="mb-2">
                  <h4 className="mb-1 text-xs font-medium">章节审查记录（{novelReviewEntries.length}）</h4>
                  <ul className="space-y-1.5">
                    {novelReviewEntries.map((entry) => (
                      <li
                        key={entry.id}
                        data-testid={`followup-entry-${entry.id}`}
                        className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs"
                      >
                        <span className="font-medium">第 {entry.chapterNumber} 章审查</span>
                        <span className="text-muted-foreground">{entry.results.length} 条意见</span>
                        <span className="text-muted-foreground">{entry.resolved ? "已完成" : "待处理"}</span>
                        <button
                          type="button"
                          className="rounded border border-border bg-background px-2 py-1 text-xs"
                          data-testid={`followup-entry-open-${entry.id}`}
                          onClick={() => void openEntryInChapter(entry)}
                        >
                          回到正文
                        </button>
                        {!entry.resolved ? (
                          <button
                            type="button"
                            className="rounded border border-border bg-background px-2 py-1 text-xs disabled:opacity-40"
                            data-testid={`followup-entry-resolve-${entry.id}`}
                            onClick={() => dismissNovelReviewEntry(entry.id)}
                          >
                            标记完成
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {openNote ? (
                    <p className="mt-1 text-xs text-muted-foreground" data-testid="followup-open-note">
                      {openNote}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {resolvedItems.length > 0 ? (
                <div>
                  <h4 className="mb-1 text-xs font-medium">已解决（{resolvedItems.length}）</h4>
                  <ul className="space-y-1.5">
                    {resolvedItems.map((item) => (
                      <li
                        key={item.id}
                        data-testid={`followup-item-${item.id}`}
                        className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs"
                      >
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {REVIEW_TYPE_LABELS[item.type]}
                        </span>
                        <span className="font-medium">{item.title}</span>
                        <span className="text-muted-foreground">
                          已解决{item.resolvedAction !== undefined ? `（${item.resolvedAction}）` : null}
                        </span>
                        <button
                          type="button"
                          className="rounded border border-border bg-background px-2 py-1 text-xs disabled:opacity-40"
                          data-testid={`followup-dismiss-${item.id}`}
                          onClick={() => dismissItem(item.id)}
                        >
                          移除
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
          {hasBlocking ? (
            <div data-testid="followup-blocking">
              <h3 className="mb-1 text-xs font-semibold">阻塞队列（{queue.length}）</h3>
              <ul className="space-y-1.5">
                {queue.map((entry) => (
                  <li
                    key={entry.gate}
                    data-testid={`followup-blocking-item-${entry.gate}`}
                    className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs"
                  >
                    <span className="font-medium">{gateLabel(entry.gate)}门</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      优先级 P{entry.priority}
                    </span>
                    <span className="text-muted-foreground">
                      {entry.blockedBy === null ? "首要阻塞（可优先处理）" : `被${gateLabel(entry.blockedBy)}门阻塞`}
                    </span>
                    {entry.evidenceCount > 0 ? (
                      <span className="ml-auto text-xs text-muted-foreground">证据 {entry.evidenceCount}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </ReportPage>
  )
}
