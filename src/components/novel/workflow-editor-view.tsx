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
import { Loader2, ScrollText } from "lucide-react"
import { ReportCallout, ReportPage, ReportSection } from "./report-page"
import {
  createFsRunEventLedgerStoreDeps,
  groupWorkflowTemplates,
  listWorkflowTemplateRegistry,
  loadRunEventLedgerStore,
  type RunEventLedger,
  type WorkflowTemplateEntry,
  type WorkflowTemplateGroup,
} from "@/lib/novel"

const EVENT_KIND_LABEL: Record<string, string> = {
  "gate-run": "门控运行",
  retrieval: "检索",
  generate: "生成",
  accept: "接受",
  retry: "重试",
  quota: "配额",
  "kb-rebuild": "重建资料",
  error: "出错",
  stage: "阶段",
}

const EVENT_ACTOR_LABEL: Record<string, string> = {
  system: "系统",
  writer: "写手",
  critic: "审稿",
  reviser: "修订",
  arbiter: "仲裁",
  judge: "裁决",
  user: "用户",
}

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
        /* v8 ignore next -- 台账 workflow-editor-view.tsx L148：loadWorkflowSnapshot（L82-116）整体包在 try/catch 内，任何读盘/解析失败都在内部转成带 ledgerError 的快照返回，永不 reject；此处是第二道防线 */
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
    <ReportPage
      testId="workflow-editor-view"
      title="运行模板与记录（只读）"
      description="查看系统内置的章节与大纲模板，以及本项目最近的写作与审稿运行记录。本页仅供查看，不会改动你的文稿。"
    >
      {loading ? (
        <p data-testid="workflow-loading" className="flex items-center gap-1 text-sm text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          正在读取模板与运行记录…
        </p>
      ) : snapshot === null ? (
        <ReportSection title="下一步">
          <p className="text-base font-medium">先打开一个项目，即可查看模板和最近运行记录。</p>
          <ReportCallout testId="workflow-empty" tone="neutral">
            未指定项目路径
          </ReportCallout>
        </ReportSection>
      ) : (
        <>
          <ReportSection title="说明">
            <p className="text-base font-medium">
              {snapshot.ledgerError !== null
                ? "运行记录读取失败，下方内置模板仍可正常查看。"
                : snapshot.ledgerEventCount === 0
                  ? "下方为系统内置写作模板；本项目目前还没有运行记录。"
                  : "下方展示内置模板与最近的生成、审稿运行记录（只读）。"}
            </p>
          </ReportSection>
          <div data-testid="workflow-templates" className="rounded-md border border-border bg-background px-3 py-2">
            <p className="text-sm font-medium text-foreground">
              内置模板清单（共 {snapshot.templates.length} 项）
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
                      {group.kind === "chapter"
                        ? "章节"
                        : group.kind === "volume"
                          ? "卷"
                          : group.kind === "skill-stage"
                            ? "技能阶段"
                            : group.kind === "enum"
                              ? "分类项"
                              : group.kind}
                      （{group.entries.length} 项）
                      <span className="sr-only">{group.kind}</span>
                    </p>
                    <ul className="mt-0.5 flex flex-wrap gap-1.5">
                      {group.entries.map((entry, index) => {
                        const visible = entry.title.split("（")[0].replace(/stage：.*/, "").trim() || "模板"
                        const repeated = visible === "技能挂点" && index > 0
                        return (
                        <li
                          key={entry.id}
                          data-testid={`workflow-template-${entry.id}`}
                          title={entry.title}
                          className={repeated ? "sr-only" : "rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"}
                        >
                          {repeated ? null : visible}
                          <span className="sr-only">{entry.title}</span>
                        </li>
                        )
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div data-testid="workflow-ledger" className="rounded-md border border-border bg-background px-3 py-2">
            <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <ScrollText className="h-3.5 w-3.5" />
              运行记录
            </div>
            {snapshot.ledgerError !== null ? (
              <p data-testid="workflow-ledger-error" role="alert" className="mt-1 text-xs text-destructive">
                运行记录读取失败：{snapshot.ledgerError}
              </p>
            ) : snapshot.ledgerEventCount === 0 ? (
              <p data-testid="workflow-ledger-empty" className="mt-1 text-xs text-muted-foreground">
                暂无运行记录（共 0 条）
              </p>
            ) : (
              <>
                <p data-testid="workflow-ledger-count" className="mt-1 text-xs text-muted-foreground">
                  共 {snapshot.ledgerEventCount} 条记录（仅展示最近 {snapshot.recentEvents.length} 条）
                </p>
                <ul className="mt-1 flex flex-col gap-1">
                  {snapshot.recentEvents.map((event) => (
                    <li
                      key={event.eventId}
                      data-testid={`workflow-event-${event.seq}`}
                      className="flex flex-wrap gap-x-2 font-mono text-xs text-muted-foreground"
                    >
                      <span>#{event.seq}</span>
                      <span>{EVENT_KIND_LABEL[event.kind] ?? "事件"}</span>
                      <span className="sr-only">{event.kind}</span>
                      <span>{EVENT_ACTOR_LABEL[event.actor] ?? "执行角色"}</span>
                      <span className="sr-only">{event.actor}</span>
                      <span>{event.ts}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </>
      )}
    </ReportPage>
  )
}
