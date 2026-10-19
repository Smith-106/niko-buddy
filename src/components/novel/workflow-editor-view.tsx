/**
 * workflow-editor-view.tsx — 工作流只读视图。
 *
 * ## 职责
 *   - 工作流模板注册表只读登记展示（按 kind 分组）+ 本项目运行事件账本
 *     （run-events.jsonl）尾部事件只读展示；
 *   - 注意：repo 内无可写工作流 DSL，本页只做只读展示，写回一律不做。
 *
 * ## 数据源（全部经 barrel `@/lib/novel`，已 grep 确认存在）
 *   - `listWorkflowTemplateRegistry()` + `groupWorkflowTemplates()`（纯函数，
 *     真源 = outline-templates 常量与渲染函数，零 IO）；
 *   - `loadRunEventLedgerStore(createFsRunEventLedgerStoreDeps(), projectPath)`
 *     （`{projectPath}/.novel/run-events.jsonl`，经 `@/commands/fs` readFile，
 *     缺失 → 空账本；损坏行 → fail-loud 错误，本页诚实展示错误）。
 *
 * ## 缺口记录（2026-10-19）
 *   - 无可写 DSL：不提供模板编辑/事件追加入口（appendRunEventToStore 真实存在
 *     但属于编排面写路径，本视图刻意不接线）。
 *   - 账本损坏行 fail-loud：此时模板区照常渲染，账本区显示读取失败原文。
 *
 * 中文 UI；只读。
 *
 * @license MIT © Niko Buddy
 */

import { useEffect, useState } from "react"
import { GitBranch, Loader2, ScrollText } from "lucide-react"
import {
  createFsRunEventLedgerStoreDeps,
  groupWorkflowTemplates,
  listWorkflowTemplateRegistry,
  loadRunEventLedgerStore,
  type RunEventLedger,
  type WorkflowTemplateEntry,
  type WorkflowTemplateGroup,
} from "@/lib/novel"

export interface RecentWorkflowEvent {
  readonly seq: number
  readonly eventId: string
  readonly kind: string
  readonly actor: string
  readonly ts: string
}

export interface WorkflowSnapshot {
  readonly templates: readonly WorkflowTemplateEntry[]
  readonly groups: readonly WorkflowTemplateGroup[]
  readonly ledgerEventCount: number
  readonly recentEvents: readonly RecentWorkflowEvent[]
  /** null = 账本读取正常（含文件缺失的空账本）；非 null = 损坏行原文。 */
  readonly ledgerError: string | null
}

/**
 * 装载：模板注册表（同步纯函数）+ 运行事件账本（磁盘）。
 * 账本损坏 → ledgerError 落原文，模板区不受影响。
 */
export async function loadWorkflowSnapshot(projectPath: string): Promise<WorkflowSnapshot> {
  const templates = listWorkflowTemplateRegistry()
  const groups = groupWorkflowTemplates(templates)
  try {
    const ledger: RunEventLedger = await loadRunEventLedgerStore(
      createFsRunEventLedgerStoreDeps(),
      projectPath,
    )
    const events = ledger.events
    return {
      templates,
      groups,
      ledgerEventCount: events.length,
      recentEvents: events
        .slice(-5)
        .reverse()
        .map((event) => ({
          seq: event.seq,
          eventId: event.eventId,
          kind: event.kind,
          actor: event.actor,
          ts: event.ts,
        })),
      ledgerError: null,
    }
  } catch (err) {
    return {
      templates,
      groups,
      ledgerEventCount: 0,
      recentEvents: [],
      ledgerError: err instanceof Error && err.message ? err.message : String(err),
    }
  }
}

export interface WorkflowEditorViewProps {
  /** 项目根路径（账本装载用 `{projectPath}/.novel/run-events.jsonl`）。 */
  readonly projectPath: string
  /** 显式注入快照（测试/预览优先；提供后跳过磁盘装载）。 */
  readonly snapshot?: WorkflowSnapshot | null
}

export function WorkflowEditorView({ projectPath, snapshot: snapshotOverride }: WorkflowEditorViewProps) {
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot | null>(snapshotOverride ?? null)
  const [loading, setLoading] = useState(snapshotOverride === undefined && projectPath !== "")

  useEffect(() => {
    if (snapshotOverride !== undefined) {
      setSnapshot(snapshotOverride)
      setLoading(false)
      return
    }
    if (projectPath === "") {
      setSnapshot(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void loadWorkflowSnapshot(projectPath)
      .then((result) => {
        if (!cancelled) setSnapshot(result)
      })
      .catch(() => {
        // 纯函数模板区理论上不抛错；兜底诚实空态，不臆造模板条目。
        if (!cancelled) setSnapshot(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectPath, snapshotOverride])

  return (
    <section data-testid="workflow-editor-view" className="flex flex-col gap-3 p-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <GitBranch className="h-4 w-4" />
        工作流（只读）
      </h2>
      <p className="text-xs text-muted-foreground">
        仓库内无可写工作流 DSL，本页只做只读展示：模板注册表登记 + 运行事件账本尾部；写回一律不做。
      </p>

      {loading ? (
        <p data-testid="workflow-loading" className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          正在读取工作流模板与运行事件…
        </p>
      ) : snapshot === null ? (
        <p data-testid="workflow-empty" className="text-xs text-muted-foreground">
          未指定项目路径
        </p>
      ) : (
        <>
          <div data-testid="workflow-templates" className="rounded-md border border-border bg-background px-3 py-2">
            <p className="text-sm font-medium text-foreground">
              模板注册表（共 {snapshot.templates.length} 项）
            </p>
            {snapshot.groups.length === 0 ? (
              <p data-testid="workflow-templates-empty" className="mt-1 text-xs text-muted-foreground">
                暂无模板登记
              </p>
            ) : (
              <ul className="mt-1 flex flex-col gap-2">
                {snapshot.groups.map((group) => (
                  <li key={group.kind} data-testid={`workflow-group-${group.kind}`}>
                    <p className="text-xs font-medium text-foreground">
                      {group.kind}（{group.entries.length} 项）
                    </p>
                    <ul className="mt-0.5 flex flex-wrap gap-1.5">
                      {group.entries.map((entry) => (
                        <li
                          key={entry.id}
                          data-testid={`workflow-template-${entry.id}`}
                          title={entry.title}
                          className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                        >
                          {entry.title}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div data-testid="workflow-ledger" className="rounded-md border border-border bg-background px-3 py-2">
            <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <ScrollText className="h-3.5 w-3.5" />
              运行事件账本
              <span className="font-mono text-[11px] text-muted-foreground">run-events.jsonl</span>
            </div>
            {snapshot.ledgerError !== null ? (
              <p data-testid="workflow-ledger-error" role="alert" className="mt-1 text-xs text-red-700 dark:text-red-300">
                账本读取失败：{snapshot.ledgerError}
              </p>
            ) : snapshot.ledgerEventCount === 0 ? (
              <p data-testid="workflow-ledger-empty" className="mt-1 text-xs text-muted-foreground">
                暂无运行事件（账本缺失或为空，共 0 条）
              </p>
            ) : (
              <>
                <p data-testid="workflow-ledger-count" className="mt-1 text-xs text-muted-foreground">
                  共 {snapshot.ledgerEventCount} 条事件（仅展示最近 {snapshot.recentEvents.length} 条）
                </p>
                <ul className="mt-1 flex flex-col gap-1">
                  {snapshot.recentEvents.map((event) => (
                    <li
                      key={event.eventId}
                      data-testid={`workflow-event-${event.seq}`}
                      className="flex flex-wrap gap-x-2 font-mono text-xs text-muted-foreground"
                    >
                      <span>#{event.seq}</span>
                      <span>{event.kind}</span>
                      <span>{event.actor}</span>
                      <span>{event.ts}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </>
      )}
    </section>
  )
}
